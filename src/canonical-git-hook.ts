import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { assertSafeFilesystemPath } from './installation-receipt.ts';
import type { Runner } from './harness-version.ts';

/** Project-scoped hosts that can own the optional canonical-checkout Git hook. */
export type CanonicalHookOwner = 'opencode' | 'claude-code' | 'antigravity';

export const canonicalHookNames = ['pre-commit', 'pre-merge-commit', 'pre-rebase', 'post-checkout'] as const;
export type CanonicalHookName = (typeof canonicalHookNames)[number];

export interface CanonicalHookState {
  version: 1;
  owners: CanonicalHookOwner[];
  previousLocalHooksPath?: string;
  previousEffectiveHooksPath?: string;
  installedHooksPath: string;
  managedFiles: Record<string, string>;
  managedModes?: Record<string, number>;
}

export type CanonicalHookPlan =
  | { status: 'unavailable'; reason: string }
  | { status: 'current'; hookDir: string }
  | {
      status: 'change';
      action: 'install' | 'update' | 'release' | 'remove';
      root: string;
      hookDir: string;
      installedHooksPath: string;
      previousLocalHooksPath: string | undefined;
      previousEffectiveHooksPath: string | undefined;
      expectedLocalHooksPath: string | undefined;
      expectedStateText: string | undefined;
      nextState: CanonicalHookState | undefined;
      scripts: Record<string, string> | undefined;
      restoreHooksPath: boolean;
      warning?: string;
    };

const STATE_FILE = '.state.json';
const HOOKS_DIR_NAME = 'advanced-harness-hooks';

const defaultRun: Runner = (executable, args, options) => execFileSync(executable, args, {
  cwd: options?.cwd,
  timeout: options?.timeout ?? 10000,
  encoding: 'utf8',
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const toForwardSlashes = (value: string) => value.replace(/\\/g, '/');
const sha256 = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isOwnHooksPath(topLevel: string, configured: string | undefined, hookDir: string): boolean {
  if (!configured) return false;
  return samePath(resolve(topLevel, configured), hookDir);
}

function resolveGitRepo(root: string, run: Runner): { commonDir: string; topLevel: string } | undefined {
  try {
    if (run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root }) !== 'true') return undefined;
    const commonDir = run('git', ['rev-parse', '--git-common-dir'], { cwd: root });
    const topLevel = run('git', ['rev-parse', '--show-toplevel'], { cwd: root });
    if (!commonDir || !topLevel) return undefined;
    return { commonDir: resolve(root, commonDir), topLevel: resolve(root, topLevel) };
  } catch {
    return undefined;
  }
}

/** Resolves `<git-common-dir>/advanced-harness-hooks` for the repository containing `root`. */
export function resolveCanonicalHookDir(root: string, run: Runner = defaultRun): string | undefined {
  const repo = resolveGitRepo(root, run);
  return repo ? join(repo.commonDir, HOOKS_DIR_NAME) : undefined;
}

/**
 * Reads a `git config` key. Exit status 1 (key unset) returns `undefined`;
 * any other non-zero exit status or spawn error propagates.
 */
function readGitConfig(root: string, args: string[], run: Runner): string | undefined {
  if (run === defaultRun) {
    const res = spawnSync('git', ['config', ...args], {
      cwd: root,
      timeout: 10000,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error) throw res.error;
    if (res.status === 0) return res.stdout.trim() || undefined;
    if (res.status === 1) return undefined;
    throw new Error(`git config ${args.join(' ')} failed (${res.status}): ${res.stderr.trim()}`);
  }
  try {
    const value = run('git', ['config', ...args], { cwd: root });
    return value || undefined;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) return undefined;
    throw err;
  }
}

function readState(statePath: string): { state: CanonicalHookState; raw: string } | undefined {
  if (!existsSync(statePath)) return undefined;
  assertSafeFilesystemPath(statePath, 'file');
  const raw = readFileSync(statePath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<CanonicalHookState>;
  if (
    parsed.version !== 1
    || !Array.isArray(parsed.owners)
    || typeof parsed.installedHooksPath !== 'string'
    || typeof parsed.managedFiles !== 'object'
    || parsed.managedFiles === null
  ) {
    throw new Error(`Malformed canonical hook state in ${statePath}`);
  }
  return {
    raw,
    state: {
      version: 1,
      owners: [...new Set(parsed.owners)].sort() as CanonicalHookOwner[],
      ...(typeof parsed.previousLocalHooksPath === 'string' && parsed.previousLocalHooksPath
        ? { previousLocalHooksPath: parsed.previousLocalHooksPath }
        : {}),
      ...(typeof parsed.previousEffectiveHooksPath === 'string' && parsed.previousEffectiveHooksPath
        ? { previousEffectiveHooksPath: parsed.previousEffectiveHooksPath }
        : {}),
      installedHooksPath: parsed.installedHooksPath,
      managedFiles: { ...parsed.managedFiles },
      ...(parsed.managedModes && typeof parsed.managedModes === 'object'
        ? { managedModes: { ...parsed.managedModes } }
        : {}),
    },
  };
}

const shellSingleQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function renderChainedLookup(previousHooksPath: string | undefined): string {
  const prevAssignment = previousHooksPath
    ? `prev_hooks_dir=${shellSingleQuote(toForwardSlashes(previousHooksPath))}`
    : `prev_hooks_dir=''`;

  return [
    prevAssignment,
    'if [ -n "$prev_hooks_dir" ]; then',
    '  case "$prev_hooks_dir" in',
    '    /*|[A-Za-z]:/*|[A-Za-z]:\\\\*) ;;',
    '    *)',
    '      toplevel=$(git rev-parse --show-toplevel 2>/dev/null || true)',
    '      [ -n "$toplevel" ] && prev_hooks_dir="$toplevel/$prev_hooks_dir"',
    '      ;;',
    '  esac',
    '  prev_hook="$prev_hooks_dir/$hook_name"',
    'else',
    '  prev_hook="$common_dir/hooks/$hook_name"',
    'fi',
    '',
    'if [ -x "$prev_hook" ]; then',
    '  "$prev_hook" "$@"',
    '  rc=$?',
    '  if [ "$rc" -ne 0 ]; then',
    '    exit "$rc"',
    '  fi',
    'fi',
  ].join('\n');
}

function renderHookScript(hookName: CanonicalHookName, previousHooksPath: string | undefined): string {
  const canonicalAction: Record<CanonicalHookName, string> = {
    'pre-commit': [
      'if [ "$git_dir" = "$common_dir" ]; then',
      '  echo "advanced-harness: commits are blocked in the canonical checkout (ADR-004). Use a task worktree instead." >&2',
      '  exit 1',
      'fi',
    ].join('\n'),
    'pre-merge-commit': [
      'if [ "$git_dir" = "$common_dir" ]; then',
      '  echo "advanced-harness: non-fast-forward merges are blocked in the canonical checkout (ADR-004). Only fast-forward updates (git merge --ff-only) are allowed; use a task worktree for merges." >&2',
      '  exit 1',
      'fi',
    ].join('\n'),
    'pre-rebase': [
      'if [ "$git_dir" = "$common_dir" ]; then',
      '  echo "advanced-harness: rebases are blocked in the canonical checkout (ADR-004). Use a task worktree instead." >&2',
      '  exit 1',
      'fi',
    ].join('\n'),
    'post-checkout': [
      'if [ "$git_dir" = "$common_dir" ] && [ "${3:-}" = "1" ]; then',
      '  echo "advanced-harness: warning: branch switches in the canonical checkout violate ADR-004. Switch back to the base branch and use a task worktree instead." >&2',
      'fi',
    ].join('\n'),
  };

  return [
    '#!/bin/sh',
    '# Managed by advanced-harness (ADR-004 canonical-checkout guardrail).',
    `hook_name=${shellSingleQuote(hookName)}`,
    'git_dir=$(cd "$(git rev-parse --git-dir 2>/dev/null)" 2>/dev/null && pwd -P) || exit 0',
    'common_dir=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P) || exit 0',
    renderChainedLookup(previousHooksPath),
    canonicalAction[hookName],
    'exit 0',
    '',
  ].join('\n');
}

function renderForwardingScript(hookName: string, previousHooksPath: string | undefined): string {
  return [
    '#!/bin/sh',
    '# Forwarding wrapper managed by advanced-harness.',
    `hook_name=${shellSingleQuote(hookName)}`,
    'common_dir=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P) || exit 0',
    renderChainedLookup(previousHooksPath),
    'exit 0',
    '',
  ].join('\n');
}

function discoverExternalHookNames(
  worktreeRoots: readonly string[],
  commonDir: string,
  previousHooksPath: string | undefined
): string[] {
  const sourceDirs = previousHooksPath
    ? (isAbsolute(previousHooksPath)
        ? [previousHooksPath]
        : [...new Set(worktreeRoots.map(wt => resolve(wt, previousHooksPath)))])
    : [join(commonDir, 'hooks')];
  const managed = new Set<string>(canonicalHookNames);
  const names = new Set<string>();
  for (const sourceDir of sourceDirs) {
    if (!existsSync(sourceDir)) continue;
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const name = entry.name;
      if (name.endsWith('.sample') || name === STATE_FILE) continue;
      const full = join(sourceDir, name);
      const stat = lstatSync(full, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symlinked hook ${full}`);
      }
      if (managed.has(name)) continue;
      if (!stat.isFile()) continue;
      if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) continue;
      names.add(name);
    }
  }
  return [...names].sort();
}

function buildScripts(
  worktreeRoots: readonly string[],
  commonDir: string,
  previousHooksPath: string | undefined
): Record<string, string> {
  const scripts: Record<string, string> = {};
  for (const name of canonicalHookNames) {
    scripts[name] = renderHookScript(name, previousHooksPath);
  }
  for (const name of discoverExternalHookNames(worktreeRoots, commonDir, previousHooksPath)) {
    scripts[name] = renderForwardingScript(name, previousHooksPath);
  }
  return scripts;
}

function validateHookDirOwnership(hookDir: string, state: CanonicalHookState | undefined): void {
  if (!existsSync(hookDir)) return;
  const entries = readdirSync(hookDir).filter(name => name !== STATE_FILE);
  if (!state) {
    if (entries.length > 0) {
      throw new Error(`Unowned files exist in ${hookDir}: ${entries.join(', ')}`);
    }
    return;
  }
  const foreign = entries.filter(name => !(name in state.managedFiles));
  if (foreign.length > 0) {
    throw new Error(`Unattributed files exist in ${hookDir}: ${foreign.join(', ')}`);
  }
  for (const [name, expectedDigest] of Object.entries(state.managedFiles)) {
    const filePath = join(hookDir, name);
    if (!existsSync(filePath)) continue;
    const stat = lstatSync(filePath);
    if (process.platform !== 'win32') {
      const expectedMode = state.managedModes?.[name];
      if (expectedMode !== undefined && (stat.mode & 0o777) !== expectedMode) {
        throw new Error(`Hook file ${filePath} permission mode changed outside advanced-harness`);
      }
      if ((stat.mode & 0o111) === 0) {
        throw new Error(`Hook file ${filePath} lost executable permission outside advanced-harness`);
      }
    }
    const actualDigest = sha256(readFileSync(filePath, 'utf8'));
    if (actualDigest !== expectedDigest) {
      throw new Error(`Hook file ${filePath} was modified outside advanced-harness`);
    }
  }
}

function atomicWriteFile(path: string, content: string, executable = false): void {
  assertSafeFilesystemPath(path, 'file');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.harness-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    if (executable && process.platform !== 'win32') chmodSync(temporary, 0o755);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function listWorktreeRoots(root: string, run: Runner): string[] {
  const output = run('git', ['worktree', 'list', '--porcelain'], { cwd: root });
  const roots: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      roots.push(line.slice('worktree '.length).trim());
    }
  }
  return roots.length > 0 ? roots : [root];
}

function checkWorktreeConfigBlock(root: string, run: Runner): string | undefined {
  const enabled = readGitConfig(root, ['--local', '--bool', '--get', 'extensions.worktreeConfig'], run);
  if (enabled === 'true') {
    for (const worktreeRoot of listWorktreeRoots(root, run)) {
      const worktreePath = readGitConfig(worktreeRoot, ['--worktree', '--get', 'core.hooksPath'], run);
      if (worktreePath) {
        return `worktree-scoped core.hooksPath "${worktreePath}" in ${worktreeRoot} overrides --local config`;
      }
    }
  }
  return undefined;
}

/** Plans installing or updating the opt-in canonical-checkout Git hook for `owner`. */
export function planCanonicalHookInstall(
  root: string,
  owner: CanonicalHookOwner,
  run: Runner = defaultRun
): CanonicalHookPlan {
  const repo = resolveGitRepo(root, run);
  if (!repo) return { status: 'unavailable', reason: 'not inside a Git work tree (or Git is unavailable)' };
  const hookDir = join(repo.commonDir, HOOKS_DIR_NAME);
  assertSafeFilesystemPath(hookDir, 'directory');

  const statePath = join(hookDir, STATE_FILE);
  let loaded: { state: CanonicalHookState; raw: string } | undefined;
  let localHooksPath: string | undefined;
  let effectiveHooksPath: string | undefined;
  let worktreeRoots: string[] = [repo.topLevel];
  try {
    const wtBlock = checkWorktreeConfigBlock(root, run);
    if (wtBlock) return { status: 'unavailable', reason: wtBlock };
    loaded = readState(statePath);
    validateHookDirOwnership(hookDir, loaded?.state);
    localHooksPath = readGitConfig(root, ['--local', '--get', 'core.hooksPath'], run);
    effectiveHooksPath = readGitConfig(root, ['--get', 'core.hooksPath'], run);
    worktreeRoots = listWorktreeRoots(root, run);
  } catch (err) {
    return { status: 'unavailable', reason: (err as Error).message };
  }

  const state = loaded?.state;
  const installedHooksPath = toForwardSlashes(hookDir);
  const ownConfigured = isOwnHooksPath(repo.topLevel, localHooksPath, hookDir);

  const previousLocalHooksPath = ownConfigured
    ? state?.previousLocalHooksPath
    : localHooksPath ?? state?.previousLocalHooksPath;
  const previousEffectiveHooksPath = ownConfigured
    ? state?.previousEffectiveHooksPath
    : (!localHooksPath && effectiveHooksPath && !isOwnHooksPath(repo.topLevel, effectiveHooksPath, hookDir)
        ? effectiveHooksPath
        : state?.previousEffectiveHooksPath);

  const chainedHooksPath = previousLocalHooksPath ?? previousEffectiveHooksPath;
  let scripts: Record<string, string>;
  try {
    scripts = buildScripts(worktreeRoots, repo.commonDir, chainedHooksPath);
  } catch (err) {
    return { status: 'unavailable', reason: (err as Error).message };
  }
  const managedFiles = Object.fromEntries(
    Object.entries(scripts).map(([name, content]) => [name, sha256(content)])
  );
  const managedModes = process.platform !== 'win32'
    ? Object.fromEntries(Object.keys(scripts).map(name => [name, 0o755]))
    : undefined;

  const nextOwners = [...new Set([...(state?.owners ?? []), owner])].sort() as CanonicalHookOwner[];
  const nextState: CanonicalHookState = {
    version: 1,
    owners: nextOwners,
    ...(previousLocalHooksPath ? { previousLocalHooksPath } : {}),
    ...(previousEffectiveHooksPath ? { previousEffectiveHooksPath } : {}),
    installedHooksPath,
    managedFiles,
    ...(managedModes ? { managedModes } : {}),
  };

  const stateCurrent = state !== undefined && JSON.stringify(state) === JSON.stringify(nextState);
  const scriptsCurrent = Object.entries(scripts).every(([name, content]) => {
    const file = join(hookDir, name);
    if (!existsSync(file) || readFileSync(file, 'utf8') !== content) return false;
    if (process.platform !== 'win32') {
      const expectedMode = nextState.managedModes?.[name] ?? 0o755;
      if ((lstatSync(file).mode & 0o777) !== expectedMode) return false;
    }
    return true;
  });
  const configCurrent = ownConfigured && localHooksPath === installedHooksPath;

  if (stateCurrent && scriptsCurrent && configCurrent) {
    return { status: 'current', hookDir };
  }

  return {
    status: 'change',
    action: state ? 'update' : 'install',
    root,
    hookDir,
    installedHooksPath,
    previousLocalHooksPath,
    previousEffectiveHooksPath,
    expectedLocalHooksPath: localHooksPath,
    expectedStateText: loaded?.raw,
    nextState,
    scripts,
    restoreHooksPath: false,
  };
}

/** Plans releasing `owner` from the canonical-checkout hook; removes it when the last owner leaves. */
export function planCanonicalHookRemoval(
  root: string,
  owner: CanonicalHookOwner,
  run: Runner = defaultRun
): CanonicalHookPlan {
  const repo = resolveGitRepo(root, run);
  if (!repo) return { status: 'unavailable', reason: 'not inside a Git work tree (or Git is unavailable)' };
  const hookDir = join(repo.commonDir, HOOKS_DIR_NAME);

  const statePath = join(hookDir, STATE_FILE);
  if (!existsSync(statePath)) return { status: 'current', hookDir };
  assertSafeFilesystemPath(hookDir, 'directory');

  let loaded: { state: CanonicalHookState; raw: string } | undefined;
  let localHooksPath: string | undefined;
  try {
    loaded = readState(statePath);
    localHooksPath = readGitConfig(root, ['--local', '--get', 'core.hooksPath'], run);
  } catch (err) {
    return { status: 'unavailable', reason: (err as Error).message };
  }
  const state = loaded?.state;
  if (!state || !state.owners.includes(owner)) return { status: 'current', hookDir };

  const remaining = state.owners.filter(item => item !== owner);
  const ownConfigured = isOwnHooksPath(repo.topLevel, localHooksPath, hookDir);

  if (remaining.length > 0) {
    const nextState: CanonicalHookState = {
      ...state,
      owners: remaining,
    };
    return {
      status: 'change',
      action: 'release',
      root,
      hookDir,
      installedHooksPath: state.installedHooksPath,
      previousLocalHooksPath: state.previousLocalHooksPath,
      previousEffectiveHooksPath: state.previousEffectiveHooksPath,
      expectedLocalHooksPath: localHooksPath,
      expectedStateText: loaded?.raw,
      nextState,
      scripts: undefined,
      restoreHooksPath: false,
    };
  }

  const restoreHooksPath = ownConfigured;
  const warning = !ownConfigured && localHooksPath
    ? `local core.hooksPath was changed to "${localHooksPath}"; it will be left untouched`
    : undefined;

  return {
    status: 'change',
    action: 'remove',
    root,
    hookDir,
    installedHooksPath: state.installedHooksPath,
    previousLocalHooksPath: state.previousLocalHooksPath,
    previousEffectiveHooksPath: state.previousEffectiveHooksPath,
    expectedLocalHooksPath: localHooksPath,
    expectedStateText: loaded?.raw,
    nextState: undefined,
    scripts: undefined,
    restoreHooksPath,
    ...(warning ? { warning } : {}),
  };
}

/** Returns true if the canonical-checkout hook is already installed in `root`. */
export function isCanonicalHookInstalled(root: string, run: Runner = defaultRun): boolean {
  const hookDir = resolveCanonicalHookDir(root, run);
  if (!hookDir) return false;
  return existsSync(join(hookDir, STATE_FILE));
}

export function describeCanonicalHook(plan: CanonicalHookPlan): string {
  if (plan.status === 'unavailable') return `Canonical-checkout Git hook: skipped (${plan.reason}).`;
  if (plan.status === 'current') return `Canonical-checkout Git hook: ${plan.hookDir} (already current; no change).`;
  if (plan.action === 'install') {
    const chainNote = plan.previousLocalHooksPath
      ? `; chains to and preserves existing local core.hooksPath "${plan.previousLocalHooksPath}"`
      : plan.previousEffectiveHooksPath
        ? `; chains to inherited core.hooksPath "${plan.previousEffectiveHooksPath}"`
        : '; chains to any existing .git/hooks/*';
    return `Canonical-checkout Git hook: install in ${plan.hookDir} and set local git config core.hooksPath=${plan.installedHooksPath}${chainNote}.`;
  }
  if (plan.action === 'update') {
    return `Canonical-checkout Git hook: update hook scripts in ${plan.hookDir}.`;
  }
  if (plan.action === 'release') {
    return `Canonical-checkout Git hook: release this host from ${plan.hookDir} (other owners keep it).`;
  }
  const restoreNote = plan.restoreHooksPath
    ? plan.previousLocalHooksPath
      ? ` and restore local core.hooksPath="${plan.previousLocalHooksPath}"`
      : ' and unset local core.hooksPath'
    : plan.warning
      ? ` (${plan.warning})`
      : '';
  return `Canonical-checkout Git hook: remove ${plan.hookDir}${restoreNote}.`;
}

function acquireLock(lockPath: string): void {
  const payload = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n';
  try {
    writeFileSync(lockPath, payload, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      let ownerInfo = 'unknown owner';
      try {
        const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown; createdAt?: unknown };
        ownerInfo = `PID ${String(parsed.pid ?? 'unknown')}, started ${String(parsed.createdAt ?? 'unknown')}`;
      } catch {
        // Leave lock intact; report conservative unknown owner.
      }
      throw new Error(
        `Canonical hook lock exists at ${lockPath} (${ownerInfo}). Verify no other advanced-harness process is running, then remove ${lockPath} manually and rerun.`
      );
    }
    throw err;
  }
}

function snapshotHookDir(hookDir: string): Map<string, string> | undefined {
  if (!existsSync(hookDir)) return undefined;
  const snapshot = new Map<string, string>();
  for (const name of readdirSync(hookDir)) {
    const file = join(hookDir, name);
    if (lstatSync(file).isFile()) {
      snapshot.set(name, readFileSync(file, 'utf8'));
    }
  }
  return snapshot;
}

function restoreHookDirSnapshot(hookDir: string, snapshot: Map<string, string> | undefined): void {
  if (!snapshot) {
    if (existsSync(hookDir)) {
      for (const name of readdirSync(hookDir)) {
        const file = join(hookDir, name);
        if (lstatSync(file).isFile()) unlinkSync(file);
      }
      if (readdirSync(hookDir).length === 0) rmdirSync(hookDir);
    }
    return;
  }
  mkdirSync(hookDir, { recursive: true });
  for (const name of readdirSync(hookDir)) {
    if (!snapshot.has(name)) {
      const file = join(hookDir, name);
      if (lstatSync(file).isFile()) unlinkSync(file);
    }
  }
  for (const [name, content] of snapshot) {
    atomicWriteFile(join(hookDir, name), content, name !== STATE_FILE);
  }
}

/** Applies a planned canonical-checkout hook change under a lockfile after revalidating config and state. */
export function applyCanonicalHook(plan: CanonicalHookPlan, run: Runner = defaultRun): boolean {
  if (plan.status !== 'change') return false;
  assertSafeFilesystemPath(plan.hookDir, 'directory');

  mkdirSync(dirname(plan.hookDir), { recursive: true });
  const lockPath = `${plan.hookDir}.harness.lock`;
  acquireLock(lockPath);
  try {
    const currentLocal = readGitConfig(plan.root, ['--local', '--get', 'core.hooksPath'], run);
    if (currentLocal !== plan.expectedLocalHooksPath) {
      throw new Error(`Local git config core.hooksPath changed after preview ("${currentLocal ?? 'unset'}"); left untouched.`);
    }

    const wtBlock = checkWorktreeConfigBlock(plan.root, run);
    if (wtBlock) {
      throw new Error(`Cannot apply canonical hook: ${wtBlock}.`);
    }

    const statePath = join(plan.hookDir, STATE_FILE);
    const currentStateText = existsSync(statePath) ? readFileSync(statePath, 'utf8') : undefined;
    if (currentStateText !== plan.expectedStateText) {
      throw new Error(`Canonical hook state in ${statePath} changed after preview; left untouched.`);
    }

    const loaded = currentStateText ? readState(statePath) : undefined;

    if (plan.action === 'install' || plan.action === 'update') {
      validateHookDirOwnership(plan.hookDir, loaded?.state);
      const snapshot = snapshotHookDir(plan.hookDir);
      try {
        mkdirSync(plan.hookDir, { recursive: true });
        const prevManaged = Object.keys(loaded?.state.managedFiles ?? {});
        const nextManaged = new Set(Object.keys(plan.scripts!));
        for (const stale of prevManaged) {
          if (!nextManaged.has(stale) && existsSync(join(plan.hookDir, stale))) {
            unlinkSync(join(plan.hookDir, stale));
          }
        }
        for (const [name, content] of Object.entries(plan.scripts!)) {
          atomicWriteFile(join(plan.hookDir, name), content, true);
        }
        atomicWriteFile(statePath, JSON.stringify(plan.nextState, null, 2) + '\n');
        if (currentLocal !== plan.installedHooksPath) {
          run('git', ['config', '--local', 'core.hooksPath', plan.installedHooksPath], { cwd: plan.root });
        }
      } catch (err) {
        let readback: string | undefined;
        try {
          readback = readGitConfig(plan.root, ['--local', '--get', 'core.hooksPath'], run);
        } catch (readbackErr) {
          throw new Error(
            `${(err as Error).message}; config readback failed (${(readbackErr as Error).message}); preserved ${plan.hookDir} and recovery state`
          );
        }
        if (readback === plan.installedHooksPath) {
          throw new Error(
            `${(err as Error).message}; core.hooksPath is already set to ${plan.installedHooksPath}; preserved ${plan.hookDir} and recovery state`
          );
        }
        try {
          restoreHookDirSnapshot(plan.hookDir, snapshot);
        } catch (rollbackErr) {
          throw new Error(
            `${(err as Error).message}; rollback of ${plan.hookDir} also failed: ${(rollbackErr as Error).message}`
          );
        }
        throw err;
      }
      return true;
    }

    if (plan.action === 'release') {
      atomicWriteFile(statePath, JSON.stringify(plan.nextState, null, 2) + '\n');
      return true;
    }

    // Last-owner removal: update Git config first so failures never leave core.hooksPath dangling.
    if (plan.restoreHooksPath) {
      if (plan.previousLocalHooksPath) {
        run('git', ['config', '--local', 'core.hooksPath', plan.previousLocalHooksPath], { cwd: plan.root });
      } else {
        run('git', ['config', '--local', '--unset', 'core.hooksPath'], { cwd: plan.root });
      }
    }

    const managedFiles = loaded?.state.managedFiles ?? {};
    const managedModes = loaded?.state.managedModes;
    const preserved: string[] = [];
    try {
      if (existsSync(plan.hookDir)) {
        for (const entry of readdirSync(plan.hookDir)) {
          if (entry === STATE_FILE) continue;
          const entryPath = join(plan.hookDir, entry);
          const expectedDigest = managedFiles[entry];
          const stat = lstatSync(entryPath);
          const expectedMode = managedModes?.[entry];
          const modeValid = process.platform === 'win32'
            || (expectedMode !== undefined && (stat.mode & 0o777) === expectedMode);
          if (expectedDigest && stat.isFile() && modeValid && sha256(readFileSync(entryPath, 'utf8')) === expectedDigest) {
            unlinkSync(entryPath);
          } else {
            preserved.push(entry);
          }
        }
        if (existsSync(statePath)) unlinkSync(statePath);
        if (preserved.length === 0) {
          rmdirSync(plan.hookDir);
        } else {
          plan.warning = [plan.warning, `preserved foreign/modified files in ${plan.hookDir}: ${preserved.join(', ')}`]
            .filter(Boolean)
            .join('; ');
        }
      }
    } catch (removeErr) {
      throw new Error(
        `Git config core.hooksPath was already restored/unset, but cleanup of ${plan.hookDir} partially failed: ${(removeErr as Error).message}`
      );
    }
    return true;
  } finally {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
}

/**
 * Interactive opt-in and preview helper for install and update flows.
 * Returns `undefined` when skipped/declined; never writes to disk or Git config.
 */
export async function promptCanonicalHook(
  root: string | undefined,
  owner: CanonicalHookOwner,
  ask: (question: string, suggested?: string) => Promise<string>,
  output: (message: string) => void,
  options: { run?: Runner; updateOnly?: boolean } = {}
): Promise<CanonicalHookPlan | undefined> {
  if (!root) return undefined;
  const run = options.run ?? defaultRun;
  const hookDir = resolveCanonicalHookDir(root, run);
  if (!hookDir) {
    output('Canonical-checkout Git hook: skipped (not inside a Git work tree or Git is unavailable).');
    return undefined;
  }

  const alreadyInstalled = isCanonicalHookInstalled(root, run);
  if (!alreadyInstalled) {
    const answer = (await ask(
      'Install opt-in local Git hook to protect canonical checkout? (writes local git config core.hooksPath) (yes/no)',
      'no'
    )).trim().toLowerCase();
    if (answer !== 'yes' && answer !== 'y') {
      output('Canonical-checkout Git hook: declined (left unconfigured).');
      return undefined;
    }
  }

  const plan = planCanonicalHookInstall(root, owner, run);
  output(describeCanonicalHook(plan));
  return plan;
}

/** Previews releasing `owner` from the canonical-checkout hook during uninstall. */
export function previewCanonicalHookRemoval(
  root: string | undefined,
  owner: CanonicalHookOwner,
  output: (message: string) => void,
  options: { run?: Runner } = {}
): CanonicalHookPlan | undefined {
  if (!root) return undefined;
  const plan = planCanonicalHookRemoval(root, owner, options.run ?? defaultRun);
  if (plan.status === 'change' || plan.status === 'unavailable') {
    output(describeCanonicalHook(plan));
  }
  return plan;
}

/** Applies a confirmed canonical-checkout hook plan; returns false and reports on failure. */
export function finishCanonicalHook(
  plan: CanonicalHookPlan | undefined,
  output: (message: string) => void,
  error: (message: string) => void,
  run: Runner = defaultRun
): boolean {
  if (!plan || plan.status !== 'change') return true;
  try {
    if (applyCanonicalHook(plan, run)) {
      const verb = plan.action === 'install' ? 'installed' : plan.action === 'update' ? 'updated' : plan.action === 'release' ? 'released' : 'removed';
      output(`Canonical-checkout Git hook ${verb}: ${plan.hookDir}`);
      if (plan.warning) output(`Canonical-checkout Git hook note: ${plan.warning}.`);
    }
    return true;
  } catch (err) {
    error(`Canonical-checkout Git hook step failed (primary files were preserved): ${(err as Error).message}`);
    return false;
  }
}
