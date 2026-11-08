import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PreflightToolError, type ChangeEntry, type ChangeOrigin, type ChangeStatus, type Changeset } from './types.ts';

function git(worktree: string, args: string[]): Buffer {
  const result = spawnSync('git', ['-C', worktree, '-c', 'core.quotepath=false', ...args], { maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new PreflightToolError(`git could not be started: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr.toString('utf8').trim().split(/\r?\n/)[0] ?? '';
    throw new PreflightToolError(`git ${args[0]} failed (exit ${result.status})${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

const text = (worktree: string, args: string[]) => git(worktree, args).toString('utf8').trim();

/** Parses `git diff --name-status -z` output. Copies are reported as added files with their source. */
function parseNameStatus(output: Buffer, origin: ChangeOrigin): Omit<ChangeEntry, 'content'>[] {
  const tokens = output.toString('utf8').split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const entries: Omit<ChangeEntry, 'content'>[] = [];
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index++]!;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[index++]!;
      const path = tokens[index++]!;
      entries.push({ path, oldPath, status: letter === 'R' ? 'renamed' : 'added', origin });
      continue;
    }
    const path = tokens[index++]!;
    const status: ChangeStatus | undefined = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : letter === 'M' || letter === 'T' ? 'modified' : undefined;
    if (!status || path === undefined) throw new PreflightToolError(`Unexpected git status code: ${code}`);
    entries.push({ path, status, origin });
  }
  return entries;
}

type WorkingFile = Pick<ChangeEntry, 'content' | 'kind'>;

/** Absent → no content; symlink → its target as content; other non-regular entries → no content. */
function readWorkingFile(worktree: string, path: string): WorkingFile {
  try {
    const full = join(worktree, path);
    const entry = lstatSync(full, { throwIfNoEntry: false });
    if (!entry) return { content: undefined };
    if (entry.isSymbolicLink()) return { kind: 'symlink', content: Buffer.from(readlinkSync(full), 'utf8') };
    if (!entry.isFile()) return { kind: 'other', content: undefined };
    return { kind: 'file', content: readFileSync(full) };
  } catch (error) {
    throw new PreflightToolError(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Git blob mode 120000 is a symlink whose blob content is the link target. */
function blob(worktree: string, spec: string, mode: string | undefined): WorkingFile {
  return { kind: mode === '120000' ? 'symlink' : 'file', content: git(worktree, ['cat-file', 'blob', spec]) };
}

function modeOf(worktree: string, args: string[], path: string): string | undefined {
  return git(worktree, [...args, '--', path]).toString('utf8').split(/\s/)[0] || undefined;
}

/**
 * Collects `merge-base(base, HEAD)...HEAD` plus staged, unstaged, and untracked
 * files, with contents. Any git failure throws {@link PreflightToolError}.
 */
export function collectChangeset(worktree: string, base: string): Changeset {
  const top = text(worktree, ['rev-parse', '--show-toplevel']);
  const head = text(top, ['rev-parse', '--verify', 'HEAD^{commit}']);
  let baseCommit: string;
  try { baseCommit = text(top, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]); } catch { throw new PreflightToolError(`Base ref not found: ${base}`); }
  const mergeBase = text(top, ['merge-base', baseCommit, head]);

  const entries: ChangeEntry[] = [];
  for (const entry of parseNameStatus(git(top, ['diff', '--no-ext-diff', '--name-status', '-M', '-z', mergeBase, head]), 'committed')) {
    entries.push({ ...entry, ...(entry.status === 'deleted' ? { content: undefined } : blob(top, `${head}:${entry.path}`, modeOf(top, ['ls-tree', head], entry.path))) });
  }
  for (const entry of parseNameStatus(git(top, ['diff', '--no-ext-diff', '--cached', '--name-status', '-M', '-z']), 'staged')) {
    entries.push({ ...entry, ...(entry.status === 'deleted' ? { content: undefined } : blob(top, `:${entry.path}`, modeOf(top, ['ls-files', '-s'], entry.path))) });
  }
  for (const entry of parseNameStatus(git(top, ['diff', '--no-ext-diff', '--name-status', '-z']), 'unstaged')) {
    entries.push({ ...entry, ...(entry.status === 'deleted' ? { content: undefined } : readWorkingFile(top, entry.path)) });
  }
  const untracked = git(top, ['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean);
  for (const path of untracked) entries.push({ path, status: 'added', origin: 'untracked', ...readWorkingFile(top, path) });

  return { base, mergeBase, head, entries };
}
