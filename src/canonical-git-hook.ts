import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  installedHooksPath: string;
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
      expectedLocalHooksPath: string | undefined;
      nextState: CanonicalHookState | undefined;
      scripts: Record<CanonicalHookName, string> | undefined;
      effectiveExternalHooksPath: string | undefined;
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

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isOwnHooksPath(root: string, configured: string | undefined, hookDir: string): boolean {
  if (!configured) return false;
  return samePath(resolve(root, configured), hookDir);
}

/** Resolves `<git-common-dir>/advanced-harness-hooks` for the repository containing `root`. */
export function resolveCanonicalHookDir(root: string, run: Runner = defaultRun): string | undefined {
  try {
    if (run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root }) !== 'true') return undefined;
    const commonDir = run('git', ['rev-parse', '--git-common-dir'], { cwd: root });
    if (!commonDir) return undefined;
    return join(resolve(root, commonDir), HOOKS_DIR_NAME);
  } catch {
    return undefined;
  }
}

function readGitConfig(root: string, args: string[], run: Runner): string | undefined {
  try {
    const value = run('git', ['config', ...args], { cwd: root });
    return value || undefined;
  } catch {
    return undefined;
  }
}

function readState(statePath: string): CanonicalHookState | undefined {
  if (!existsSync(statePath)) return undefined;
  assertSafeFilesystemPath(statePath, 'file');
  const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<CanonicalHookState>;
  if (
    parsed.version !== 1
    || !Array.isArray(parsed.owners)
    || typeof parsed.installedHooksPath !== 'string'
  ) {
    throw new Error(`Malformed canonical hook state in ${statePath}`);
  }
  return {
    version: 1,
    owners: [...new Set(parsed.owners)].sort() as CanonicalHookOwner[],
    ...(typeof parsed.previousLocalHooksPath === 'string' && parsed.previousLocalHooksPath
      ? { previousLocalHooksPath: parsed.previousLocalHooksPath }
      : {}),
    installedHooksPath: parsed.installedHooksPath,
  };
}

const shellSingleQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function renderHookScript(hookName: CanonicalHookName, previousHooksPath: string | undefined): string {
  const prevAssignment = previousHooksPath
    ? `prev_hooks_dir=${shellSingleQuote(toForwardSlashes(previousHooksPath))}`
    : `prev_hooks_dir=''`;

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
    prevAssignment,
    '',
    'git_dir=$(cd "$(git rev-parse --git-dir 2>/dev/null)" 2>/dev/null && pwd -P) || exit 0',
    'common_dir=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P) || exit 0',
    '',
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
    '',
    canonicalAction[hookName],
    'exit 0',
    '',
  ].join('\n');
}

function buildScripts(previousHooksPath: string | undefined): Record<CanonicalHookName, string> {
  return {
    'pre-commit': renderHookScript('pre-commit', previousHooksPath),
    'pre-merge-commit': renderHookScript('pre-merge-commit', previousHooksPath),
    'pre-rebase': renderHookScript('pre-rebase', previousHooksPath),
    'post-checkout': renderHookScript('post-checkout', previousHooksPath),
  };
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

/** Plans installing or updating the opt-in canonical-checkout Git hook for `owner`. */
export function planCanonicalHookInstall(
  root: string,
  owner: CanonicalHookOwner,
  run: Runner = defaultRun
): CanonicalHookPlan {
  const hookDir = resolveCanonicalHookDir(root, run);
  if (!hookDir) return { status: 'unavailable', reason: 'not inside a Git work tree (or Git is unavailable)' };
  assertSafeFilesystemPath(hookDir, 'directory');

  const statePath = join(hookDir, STATE_FILE);
  let state: CanonicalHookState | undefined;
  try {
    state = readState(statePath);
  } catch (err) {
    return { status: 'unavailable', reason: (err as Error).message };
  }

  const installedHooksPath = toForwardSlashes(hookDir);
  const localHooksPath = readGitConfig(root, ['--local', '--get', 'core.hooksPath'], run);
  const effectiveHooksPath = readGitConfig(root, ['--get', 'core.hooksPath'], run);
  const ownConfigured = isOwnHooksPath(root, localHooksPath, hookDir);

  const previousLocalHooksPath = ownConfigured
    ? state?.previousLocalHooksPath
    : localHooksPath ?? state?.previousLocalHooksPath;
  const effectiveExternalHooksPath = !localHooksPath && effectiveHooksPath && !isOwnHooksPath(root, effectiveHooksPath, hookDir)
    ? effectiveHooksPath
    : undefined;

  const nextOwners = [...new Set([...(state?.owners ?? []), owner])].sort() as CanonicalHookOwner[];
  const nextState: CanonicalHookState = {
    version: 1,
    owners: nextOwners,
    ...(previousLocalHooksPath ? { previousLocalHooksPath } : {}),
    installedHooksPath,
  };
  const scripts = buildScripts(previousLocalHooksPath);

  const stateCurrent = state !== undefined
    && JSON.stringify(state) === JSON.stringify(nextState);
  const scriptsCurrent = canonicalHookNames.every(name => {
    const file = join(hookDir, name);
    return existsSync(file) && readFileSync(file, 'utf8') === scripts[name];
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
    expectedLocalHooksPath: localHooksPath,
    nextState,
    scripts,
    effectiveExternalHooksPath,
    restoreHooksPath: false,
  };
}

/** Plans releasing `owner` from the canonical-checkout hook; removes it when the last owner leaves. */
export function planCanonicalHookRemoval(
  root: string,
  owner: CanonicalHookOwner,
  run: Runner = defaultRun
): CanonicalHookPlan {
  const hookDir = resolveCanonicalHookDir(root, run);
  if (!hookDir) return { status: 'unavailable', reason: 'not inside a Git work tree (or Git is unavailable)' };

  const statePath = join(hookDir, STATE_FILE);
  if (!existsSync(statePath)) return { status: 'current', hookDir };
  assertSafeFilesystemPath(hookDir, 'directory');

  let state: CanonicalHookState | undefined;
  try {
    state = readState(statePath);
  } catch (err) {
    return { status: 'unavailable', reason: (err as Error).message };
  }
  if (!state || !state.owners.includes(owner)) return { status: 'current', hookDir };

  const remaining = state.owners.filter(item => item !== owner);
  const localHooksPath = readGitConfig(root, ['--local', '--get', 'core.hooksPath'], run);
  const ownConfigured = isOwnHooksPath(root, localHooksPath, hookDir);

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
      expectedLocalHooksPath: localHooksPath,
      nextState,
      scripts: undefined,
      effectiveExternalHooksPath: undefined,
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
    expectedLocalHooksPath: localHooksPath,
    nextState: undefined,
    scripts: undefined,
    effectiveExternalHooksPath: undefined,
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
      ? `; chains to and preserves existing core.hooksPath "${plan.previousLocalHooksPath}"`
      : plan.effectiveExternalHooksPath
        ? `; warning: non-local core.hooksPath "${plan.effectiveExternalHooksPath}" is set`
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

/** Applies a planned canonical-checkout hook change after confirming local config did not drift. */
export function applyCanonicalHook(plan: CanonicalHookPlan, run: Runner = defaultRun): boolean {
  if (plan.status !== 'change') return false;
  assertSafeFilesystemPath(plan.hookDir, 'directory');

  const currentLocal = readGitConfig(plan.root, ['--local', '--get', 'core.hooksPath'], run);
  if (currentLocal !== plan.expectedLocalHooksPath) {
    throw new Error(`Local git config core.hooksPath changed after preview ("${currentLocal ?? 'unset'}"); left untouched.`);
  }

  const statePath = join(plan.hookDir, STATE_FILE);
  if (plan.action === 'install' || plan.action === 'update') {
    mkdirSync(plan.hookDir, { recursive: true });
    for (const name of canonicalHookNames) {
      atomicWriteFile(join(plan.hookDir, name), plan.scripts![name], true);
    }
    atomicWriteFile(statePath, JSON.stringify(plan.nextState, null, 2) + '\n');
    if (currentLocal !== plan.installedHooksPath) {
      run('git', ['config', '--local', 'core.hooksPath', plan.installedHooksPath], { cwd: plan.root });
    }
    return true;
  }

  if (plan.action === 'release') {
    atomicWriteFile(statePath, JSON.stringify(plan.nextState, null, 2) + '\n');
    return true;
  }

  if (plan.restoreHooksPath) {
    if (plan.previousLocalHooksPath) {
      run('git', ['config', '--local', 'core.hooksPath', plan.previousLocalHooksPath], { cwd: plan.root });
    } else {
      try {
        run('git', ['config', '--local', '--unset', 'core.hooksPath'], { cwd: plan.root });
      } catch {
        // Already unset.
      }
    }
  }
  rmSync(plan.hookDir, { recursive: true, force: true });
  return true;
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
  if (!alreadyInstalled || !options.updateOnly) {
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

/** Applies a confirmed canonical-checkout hook plan; reports errors without rolling back primary writes. */
export function finishCanonicalHook(
  plan: CanonicalHookPlan | undefined,
  output: (message: string) => void,
  error: (message: string) => void,
  run: Runner = defaultRun
): void {
  if (!plan || plan.status !== 'change') return;
  try {
    if (applyCanonicalHook(plan, run)) {
      const verb = plan.action === 'install' ? 'installed' : plan.action === 'update' ? 'updated' : plan.action === 'release' ? 'released' : 'removed';
      output(`Canonical-checkout Git hook ${verb}: ${plan.hookDir}`);
      if (plan.warning) output(`Canonical-checkout Git hook note: ${plan.warning}.`);
    }
  } catch (err) {
    error(`Canonical-checkout Git hook step failed (primary files were preserved): ${(err as Error).message}`);
  }
}
