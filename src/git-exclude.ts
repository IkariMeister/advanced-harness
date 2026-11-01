import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertSafeFilesystemPath } from './installation-receipt.ts';
import type { Runner } from './harness-version.ts';

/**
 * Harness-local paths kept out of `git status` through Git's local exclude file
 * (`git rev-parse --git-path info/exclude`), never through a tracked .gitignore.
 * Unanchored so a project in a repository subdirectory is covered too. Worktrees and
 * the shared MEMORY.md already live outside the checkout and need no entry.
 */
export const harnessExcludePatterns = ['.harness/', '.harness-state/', '*.harness-*.tmp'] as const;

/** Components that want the block. It is removed only when the last owner uninstalls. */
export type GitExcludeOwner = 'setup' | 'opencode' | 'claude-code' | 'antigravity';

export type GitExcludePlan =
  | { status: 'unavailable'; reason: string }
  | { status: 'current'; path: string }
  | { status: 'change'; path: string; original: string | undefined; updated: string; action: 'add' | 'update' | 'remove' | 'release' };

const startPattern = /^# advanced-harness:exclude:start owners=([a-z,-]*)$/;
const endMarker = '# advanced-harness:exclude:end';

const defaultRun: Runner = (executable, args, options) => execFileSync(executable, args, {
  cwd: options?.cwd,
  timeout: options?.timeout ?? 10000,
  encoding: 'utf8',
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

/** Resolves the exclude file shared by every worktree of the repository containing `root`. */
export function resolveExcludePath(root: string, run: Runner = defaultRun): string | undefined {
  try {
    if (run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root }) !== 'true') return undefined;
    return resolve(root, run('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root }));
  } catch {
    return undefined;
  }
}

type Block = { owners: string[]; start: number; end: number };

function findBlock(lines: readonly string[], path: string): Block | undefined {
  const starts = lines.flatMap((line, index) => startPattern.test(line) ? [index] : []);
  const ends = lines.flatMap((line, index) => line === endMarker ? [index] : []);
  if (!starts.length && !ends.length) return undefined;
  if (starts.length !== 1 || ends.length !== 1 || ends[0]! < starts[0]!) {
    throw new Error(`Malformed advanced-harness markers in ${path}. Fix or remove the marked block manually; nothing was changed.`);
  }
  const owners = startPattern.exec(lines[starts[0]!]!)![1]!.split(',').filter(Boolean);
  return { owners, start: starts[0]!, end: ends[0]! };
}

function renderBlock(owners: readonly string[]): string[] {
  return [
    `# advanced-harness:exclude:start owners=${[...new Set(owners)].sort().join(',')}`,
    '# Harness-local state; lines between these markers are managed by advanced-harness.',
    ...harnessExcludePatterns,
    endMarker,
  ];
}

function plan(root: string, owner: GitExcludeOwner, mode: 'add' | 'remove', run: Runner): GitExcludePlan {
  const path = resolveExcludePath(root, run);
  if (!path) return { status: 'unavailable', reason: 'not inside a Git work tree (or Git is unavailable)' };
  assertSafeFilesystemPath(path, 'file');
  const original = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const eol = original?.includes('\r\n') ? '\r\n' : '\n';
  const lines = original === undefined ? [] : original.split(/\r?\n/);
  if (lines.length && lines.at(-1) === '') lines.pop();
  const block = findBlock(lines, path);

  let next: string[];
  let action: 'add' | 'update' | 'remove' | 'release';
  if (mode === 'add') {
    const rendered = renderBlock([...(block?.owners ?? []), owner]);
    if (block && lines.slice(block.start, block.end + 1).join('\n') === rendered.join('\n')) return { status: 'current', path };
    next = block ? [...lines.slice(0, block.start), ...rendered, ...lines.slice(block.end + 1)] : [...lines, ...rendered];
    action = block ? 'update' : 'add';
  } else {
    if (!block || !block.owners.includes(owner)) return { status: 'current', path };
    const remaining = block.owners.filter(name => name !== owner);
    next = [...lines.slice(0, block.start), ...(remaining.length ? renderBlock(remaining) : []), ...lines.slice(block.end + 1)];
    action = remaining.length ? 'release' : 'remove';
  }
  const updated = next.length ? next.join(eol) + eol : '';
  return { status: 'change', path, original, updated, action };
}

/** Plans adding `owner` (and the harness patterns) to the local exclude block; idempotent. */
export function planGitExclude(root: string, owner: GitExcludeOwner, run: Runner = defaultRun): GitExcludePlan {
  return plan(root, owner, 'add', run);
}

/** Plans releasing `owner`; the block itself is removed only when no other owner remains. */
export function planGitExcludeRemoval(root: string, owner: GitExcludeOwner, run: Runner = defaultRun): GitExcludePlan {
  return plan(root, owner, 'remove', run);
}

export function describeGitExclude(plan: GitExcludePlan): string {
  if (plan.status === 'unavailable') return `Local Git exclude: skipped (${plan.reason}).`;
  if (plan.status === 'current') return `Local Git exclude: ${plan.path} (already current; no change).`;
  const summary = {
    add: `add harness block (${harnessExcludePatterns.join(', ')})`,
    update: `update harness block (${harnessExcludePatterns.join(', ')})`,
    release: 'release this component from the harness block (other owners keep it)',
    remove: 'remove harness block',
  }[plan.action];
  return `Local Git exclude: ${plan.path} (${summary}; untracked, shared by all worktrees; tracked .gitignore files are not changed).`;
}

/**
 * Plans and prints the exclude step for a preview. Planning problems (malformed markers,
 * a linked path) skip only this step, so they never block the command's primary writes.
 */
export function previewGitExclude(root: string | undefined, owner: GitExcludeOwner, output: (message: string) => void, options: { remove?: boolean; run?: Runner } = {}): GitExcludePlan | undefined {
  if (!root) return undefined;
  let result: GitExcludePlan;
  try { result = (options.remove ? planGitExcludeRemoval : planGitExclude)(root, owner, options.run); }
  catch (err) { result = { status: 'unavailable', reason: (err as Error).message.replace(/\.$/, '') }; }
  output(describeGitExclude(result));
  return result;
}

/** Writes the planned exclude file, refusing when it changed since the preview. */
export function applyGitExclude(plan: GitExcludePlan): boolean {
  if (plan.status !== 'change') return false;
  assertSafeFilesystemPath(plan.path, 'file');
  const current = existsSync(plan.path) ? readFileSync(plan.path, 'utf8') : undefined;
  if (current !== plan.original) throw new Error(`${plan.path} changed after the preview; it was left untouched.`);
  mkdirSync(dirname(plan.path), { recursive: true });
  const temporary = `${plan.path}.harness-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, plan.updated, { flag: 'wx' });
    renameSync(temporary, plan.path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return true;
}

/**
 * Applies a confirmed plan after the primary writes. The exclude block is a convenience,
 * so a failure is reported without undoing or failing the completed setup/install/uninstall.
 */
export function finishGitExclude(plan: GitExcludePlan | undefined, output: (message: string) => void, error: (message: string) => void): void {
  if (plan?.status !== 'change') return;
  try {
    applyGitExclude(plan);
    output(`Local Git exclude updated: ${plan.path}`);
  } catch (err) {
    error(`Local Git exclude was not updated: ${(err as Error).message} Rerun the command to retry.`);
  }
}
