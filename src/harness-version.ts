import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessVersionStamp } from './receipt-lineage.ts';

export type Runner = (executable: string, args: string[], options?: { cwd?: string; timeout?: number }) => string;

const defaultRun: Runner = (executable, args, options) => {
  return execFileSync(executable, args, {
    cwd: options?.cwd,
    timeout: options?.timeout ?? 10000,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
};

export type SourceVersion = {
  version: string;
  commit: string;
  dirty: boolean;
};

export function readSourceVersion(repoRoot: string, run: Runner = defaultRun): SourceVersion {
  let version = '0.0.0';
  try {
    const pkgText = readFileSync(join(repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgText) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.trim()) {
      version = pkg.version.trim();
    }
  } catch {
    // default version fallback if package.json cannot be read
  }

  let commit = 'unknown';
  try {
    commit = run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  } catch {
    commit = 'untracked';
  }

  let dirty = false;
  try {
    const status = run('git', ['status', '--porcelain'], { cwd: repoRoot });
    dirty = status.length > 0;
  } catch {
    // If git status fails, dirty remains false or untracked
  }

  return { version, commit, dirty };
}

export type VersionComparison =
  | 'unknown-installed'
  | 'up-to-date'
  | 'source-newer'
  | 'local-ahead-of-remote'
  | 'remote-newer'
  | 'diverged'
  | 'inconclusive';

export type RemoteComparison = {
  remoteHead?: string;
  status: 'up-to-date' | 'local-ahead' | 'remote-newer' | 'diverged' | 'inconclusive';
};

export function checkRemoteHead(repoRoot: string, run: Runner = defaultRun): RemoteComparison {
  try {
    const output = run('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd: repoRoot, timeout: 15000 });
    const match = output.match(/^([a-f0-9]{40})\s+refs\/heads\/main/m);
    if (!match || !match[1]) {
      return { status: 'inconclusive' };
    }
    const remoteHead = match[1];
    let localHead = '';
    try {
      localHead = run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    } catch {
      return { remoteHead, status: 'inconclusive' };
    }

    if (localHead === remoteHead) {
      return { remoteHead, status: 'up-to-date' };
    }

    // Check if remoteHead is ancestor of localHead (local ahead)
    let isAncestorOfLocal = false;
    let localAncestryInconclusive = false;
    try {
      run('git', ['merge-base', '--is-ancestor', remoteHead, localHead], { cwd: repoRoot });
      isAncestorOfLocal = true;
    } catch (error) {
      if (!isAncestryNegative(error)) localAncestryInconclusive = true;
    }

    if (isAncestorOfLocal) {
      return { remoteHead, status: 'local-ahead' };
    }

    // Check if localHead is ancestor of remoteHead (remote newer)
    let isAncestorOfRemote = false;
    let remoteAncestryInconclusive = false;
    try {
      run('git', ['merge-base', '--is-ancestor', localHead, remoteHead], { cwd: repoRoot });
      isAncestorOfRemote = true;
    } catch (error) {
      if (!isAncestryNegative(error)) remoteAncestryInconclusive = true;
    }

    if (isAncestorOfRemote) {
      return { remoteHead, status: 'remote-newer' };
    }

    return { remoteHead, status: localAncestryInconclusive || remoteAncestryInconclusive ? 'inconclusive' : 'diverged' };
  } catch {
    return { status: 'inconclusive' };
  }
}

function isAncestryNegative(error: unknown): boolean {
  // execFileSync reports git's normal --is-ancestor negative result as exit 1.
  // Missing objects and command failures have other exit codes and are inconclusive.
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 1;
}

export function compareInstalledAndSource(
  installed: HarnessVersionStamp | undefined,
  source: SourceVersion
): 'unknown-installed' | 'up-to-date' | 'source-newer' {
  if (!installed || !installed.commit || installed.commit === 'unknown' || installed.commit === 'untracked') {
    return 'unknown-installed';
  }
  if (installed.commit === source.commit) {
    return 'up-to-date';
  }
  return 'source-newer';
}
