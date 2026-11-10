import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PreflightToolError, type BaseSource, type ChangeEntry, type ChangeOrigin, type ChangeStatus, type Changeset } from './types.ts';

function git(worktree: string, args: string[]): Buffer {
  const result = spawnSync('git', ['-C', worktree, '-c', 'core.quotepath=false', '--literal-pathspecs', ...args], { maxBuffer: 256 * 1024 * 1024 });
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

/** Absent → no content; symlink → its target as content; submodule → no content; other non-regular entries → no content. */
function readWorkingFile(worktree: string, path: string): WorkingFile {
  try {
    const full = join(worktree, path);
    const entry = lstatSync(full, { throwIfNoEntry: false });
    if (!entry) return { content: undefined };
    if (entry.isSymbolicLink()) return { kind: 'symlink', content: Buffer.from(readlinkSync(full), 'utf8') };
    if (entry.isDirectory()) {
      if (existsSync(join(full, '.git'))) return { kind: 'submodule', content: undefined };
      return { kind: 'other', content: undefined };
    }
    if (!entry.isFile()) return { kind: 'other', content: undefined };
    return { kind: 'file', content: readFileSync(full) };
  } catch (error) {
    throw new PreflightToolError(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Git blob mode 120000 is a symlink whose blob content is the link target. Mode 160000 is a submodule commit gitlink. */
function blob(worktree: string, spec: string, mode: string | undefined): WorkingFile {
  if (mode === '160000') return { kind: 'submodule', content: undefined };
  return { kind: mode === '120000' ? 'symlink' : 'file', content: git(worktree, ['cat-file', 'blob', spec]) };
}

function modeOf(worktree: string, args: string[], path: string): string | undefined {
  return git(worktree, [...args, '--', path]).toString('utf8').split(/\s/)[0] || undefined;
}

function addedLinesForPath(worktree: string, args: string[], path: string, oldPath?: string): { text: string; lines: number[]; complete: boolean } {
  const paths = oldPath === undefined ? [path] : [oldPath, path];
  const bytes = git(worktree, [...args, '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0', '--', ...paths]);
  const diff = bytes.toString('utf8');
  if (/^Binary files .+ differ\r?$/m.test(diff) || /^GIT binary patch\r?$/m.test(diff)) return { text: '', lines: [], complete: false };
  if (!Buffer.from(diff, 'utf8').equals(bytes)) return { text: '', lines: [], complete: false };
  const result: { text: string; lines: number[] } = { text: '', lines: [] };
  let next = 0;
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) { next = Number(hunk[1]); inHunk = true; continue; }
    if (line.startsWith('diff --git ') || line.startsWith('Index: ')) { inHunk = false; continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      result.text += `${line.slice(1)}\n`; result.lines.push(next++);
    } else if (!line.startsWith('-') && !line.startsWith('\\') && next) next++;
  }
  return { ...result, complete: true };
}

/**
 * Collects `merge-base(base, HEAD)...HEAD` plus staged, unstaged, and untracked
 * files, with contents. Any git failure throws {@link PreflightToolError}.
 */
export function collectChangeset(worktree: string, base: string, baseSource: BaseSource = 'option'): Changeset {
  const top = text(worktree, ['rev-parse', '--show-toplevel']);
  const head = text(top, ['rev-parse', '--verify', 'HEAD^{commit}']);
  let baseCommit: string;
  try { baseCommit = text(top, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]); } catch { throw new PreflightToolError(`Base ref not found: ${base}`); }
  const mergeBase = text(top, ['merge-base', baseCommit, head]);

  const entries: ChangeEntry[] = [];
  for (const entry of parseNameStatus(git(top, ['diff', '--no-ext-diff', '--name-status', '-M', '-z', mergeBase, head]), 'committed')) {
    const kind = entry.status === 'deleted' ? undefined : modeOf(top, ['ls-tree', head], entry.path);
    const added = entry.status === 'deleted' ? undefined : kind === '160000' ? { text: '', lines: [], complete: false } : addedLinesForPath(top, ['diff', mergeBase, head], entry.path, entry.oldPath);
    entries.push({ ...entry, ...(entry.status === 'deleted' ? { content: undefined } : blob(top, `${head}:${entry.path}`, kind)), ...(added ? { addedText: added.text, targetLines: added.lines, addedTextComplete: added.complete } : {}) });
  }
  for (const entry of parseNameStatus(git(top, ['diff', '--no-ext-diff', '--cached', '--name-status', '-M', '-z']), 'staged')) {
    const kind = entry.status === 'deleted' ? undefined : modeOf(top, ['ls-files', '-s'], entry.path);
    const added = entry.status === 'deleted' ? undefined : kind === '160000' ? { text: '', lines: [], complete: false } : addedLinesForPath(top, ['diff', '--cached'], entry.path, entry.oldPath);
    entries.push({ ...entry, ...(entry.status === 'deleted' ? { content: undefined } : blob(top, `:${entry.path}`, kind)), ...(added ? { addedText: added.text, targetLines: added.lines, addedTextComplete: added.complete } : {}) });
  }
  for (const entry of parseNameStatus(git(top, ['diff', '--no-ext-diff', '--name-status', '-M', '-z']), 'unstaged')) {
    if (entry.status === 'deleted') {
      entries.push({ ...entry, content: undefined });
    } else {
      const added = addedLinesForPath(top, ['diff'], entry.path);
      const mode = modeOf(top, ['ls-files', '-s'], entry.path);
      entries.push({ ...entry, ...(mode === '160000' ? { kind: 'submodule', content: undefined } : readWorkingFile(top, entry.path)), addedText: added.text, targetLines: added.lines, addedTextComplete: mode === '160000' ? false : added.complete });
    }
  }
  const untracked = git(top, ['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean);
  for (const path of untracked) {
    const file = readWorkingFile(top, path);
    const candidate = file.content && file.kind === 'file' && !file.content.includes(0) ? file.content.toString('utf8') : undefined;
    const decoded = candidate !== undefined && Buffer.from(candidate, 'utf8').equals(file.content!) ? candidate : undefined;
    const lines = decoded ? decoded.split(/\r?\n/) : [];
    if (decoded?.endsWith('\n')) lines.pop();
    entries.push({ path, status: 'added', origin: 'untracked', ...file, ...(decoded !== undefined ? { addedText: decoded, targetLines: lines.length ? lines.map((_, i) => i + 1) : [], addedTextComplete: true } : { addedTextComplete: false }) });
  }

  return { top, base, baseSource, mergeBase, head, entries };
}
