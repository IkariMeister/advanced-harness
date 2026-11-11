import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
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

function gitlinkId(worktree: string, args: string[], path: string): string | undefined {
  const record = git(worktree, [...args, '-z', '--', path]).toString('utf8').split('\0')[0] ?? '';
  const header = record.slice(0, record.indexOf('\t'));
  const [mode, , object] = header.split(' ');
  return mode === '160000' && /^[0-9a-f]{40,64}$/i.test(object ?? '') ? object : undefined;
}

/** Resolves the staged gitlink commit; for an unstaged gitlink change, this is the before-state. */
function indexGitlinkId(worktree: string, path: string): string | undefined {
  const record = git(worktree, ['ls-files', '-s', '-z', '--', path]).toString('utf8').split('\0')[0] ?? '';
  const [mode, object] = record.split(/[ \t]/, 3);
  return mode === '160000' && /^[0-9a-f]{40,64}$/i.test(object ?? '') ? object : undefined;
}

/** Dirty or untracked nested content is never covered by acknowledging commit IDs. */
function nestedContentDirty(worktree: string, path: string): boolean {
  const nested = join(worktree, path);
  try {
    if (!existsSync(nested)) return false;
    if (!existsSync(join(nested, '.git'))) {
      // An empty, deinitialized submodule has no available content to scan.
      // Populated directories without repository metadata are uninspectable.
      return readdirSync(nested).length > 0;
    }
    const result = spawnSync('git', ['-C', nested, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'], { maxBuffer: 16 * 1024 * 1024, timeout: 3000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    return result.error !== undefined || result.status !== 0 || result.stdout.length > 0;
  } catch { return true; }
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
    const oldId = gitlinkId(top, ['ls-tree', mergeBase], entry.oldPath ?? entry.path);
    const newId = gitlinkId(top, ['ls-tree', head], entry.path);
    const added = entry.status === 'deleted' ? undefined : kind === '160000' ? { text: '', lines: [], complete: false } : addedLinesForPath(top, ['diff', mergeBase, head], entry.path, entry.oldPath);
    entries.push({ ...entry, ...(oldId !== undefined || newId !== undefined ? { gitlink: { ...(oldId === undefined ? {} : { oldId }), ...(newId === undefined ? {} : { newId }), ...(kind === '160000' ? { nestedContentDirty: nestedContentDirty(top, entry.path) } : {}) } } : {}), ...(entry.status === 'deleted' ? { content: undefined } : blob(top, `${head}:${entry.path}`, kind)), ...(added ? { addedText: added.text, targetLines: added.lines, addedTextComplete: added.complete } : {}) });
  }
  for (const entry of parseNameStatus(git(top, ['diff', '--no-ext-diff', '--cached', '--name-status', '-M', '-z']), 'staged')) {
    const kind = entry.status === 'deleted' ? undefined : modeOf(top, ['ls-files', '-s'], entry.path);
    const oldId = gitlinkId(top, ['ls-tree', 'HEAD'], entry.oldPath ?? entry.path);
    const newId = kind === '160000' ? (git(top, ['ls-files', '-s', '-z', '--', entry.path]).toString('utf8').split('\0')[0]?.split(' ')[1]) : undefined;
    const added = entry.status === 'deleted' ? undefined : kind === '160000' ? { text: '', lines: [], complete: false } : addedLinesForPath(top, ['diff', '--cached'], entry.path, entry.oldPath);
    entries.push({ ...entry, ...(oldId !== undefined || newId !== undefined ? { gitlink: { ...(oldId === undefined ? {} : { oldId }), ...(newId === undefined ? {} : { newId }), ...(kind === '160000' ? { nestedContentDirty: nestedContentDirty(top, entry.path) } : {}) } } : {}), ...(entry.status === 'deleted' ? { content: undefined } : blob(top, `:${entry.path}`, kind)), ...(added ? { addedText: added.text, targetLines: added.lines, addedTextComplete: added.complete } : {}) });
  }
  for (const entry of parseNameStatus(git(top, ['diff', '--no-ext-diff', '--name-status', '-M', '-z']), 'unstaged')) {
    if (entry.status === 'deleted') {
      entries.push({ ...entry, content: undefined });
    } else {
      const added = addedLinesForPath(top, ['diff'], entry.path);
      const mode = modeOf(top, ['ls-files', '-s'], entry.path);
      const oldId = mode === '160000' ? indexGitlinkId(top, entry.path) : undefined;
      let newId: string | undefined;
      if (mode === '160000') { try { newId = text(join(top, entry.path), ['rev-parse', '--verify', 'HEAD^{commit}']); } catch { /* uninitialized or unavailable gitlink stays incomplete */ } }
      entries.push({ ...entry, ...(oldId !== undefined || newId !== undefined ? { gitlink: { ...(oldId === undefined ? {} : { oldId }), ...(newId === undefined ? {} : { newId }), ...(mode === '160000' ? { nestedContentDirty: nestedContentDirty(top, entry.path) } : {}) } } : {}), ...(mode === '160000' ? { kind: 'submodule', content: undefined } : readWorkingFile(top, entry.path)), addedText: added.text, targetLines: added.lines, addedTextComplete: mode === '160000' ? false : added.complete });
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

  // Git does not report untracked files inside a submodule when its commit ID is
  // unchanged. Surface every dirty indexed gitlink as a separate coverage gap.
  for (const record of git(top, ['ls-files', '-s', '-z']).toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, id] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (mode !== '160000' || !/^[0-9a-f]{40,64}$/i.test(id ?? '') || !nestedContentDirty(top, path)) continue;
    const existing = entries.find(entry => entry.path === path && entry.origin === 'unstaged');
    if (existing) {
      existing.gitlink = { ...(existing.gitlink ?? {}), oldId: existing.gitlink?.oldId ?? id!, newId: existing.gitlink?.newId ?? id!, nestedContentDirty: true };
      existing.addedTextComplete = false;
    } else {
      entries.push({ path, status: 'modified', origin: 'unstaged', kind: 'submodule', content: undefined, addedTextComplete: false, gitlink: { oldId: id!, newId: id!, nestedContentDirty: true } });
    }
  }

  return { top, base, baseSource, mergeBase, head, entries };
}
