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

export function toVersionStamp(source: SourceVersion): HarnessVersionStamp {
  return { version: source.version, commit: source.commit, ...(source.dirty ? { dirty: true } : {}) };
}

export function formatVersionStamp(stamp: HarnessVersionStamp): string {
  return `${stamp.version} (${stamp.commit})${stamp.dirty ? ' [dirty local changes]' : ''}`;
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

export type ReleaseVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
};

const releaseVersionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseReleaseVersion(text: string): ReleaseVersion | undefined {
  const match = text.trim().match(releaseVersionPattern);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { prerelease: match[4] } : {})
  };
}

// Orders release versions; a prerelease (e.g. 0.3.0-dev) sorts before its release.
export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

// Returns the v* release tag (without prerelease) that HEAD sits on, if any.
export function detectReleaseTag(repoRoot: string, run: Runner = defaultRun): string | undefined {
  let output = '';
  try {
    output = run('git', ['tag', '--points-at', 'HEAD', '--list', 'v*'], { cwd: repoRoot });
  } catch {
    return undefined;
  }
  const releases = output
    .split(/\r?\n/)
    .map(tag => tag.trim())
    .map(tag => ({ tag, version: parseReleaseVersion(tag) }))
    .filter((entry): entry is { tag: string; version: ReleaseVersion } =>
      entry.tag.startsWith('v') && entry.version !== undefined && entry.version.prerelease === undefined)
    .sort((a, b) => compareReleaseVersions(b.version, a.version));
  return releases[0]?.tag;
}

export type ReleaseTagComparison = {
  currentTag: string;
  latestTag?: string;
  status: 'up-to-date' | 'release-available' | 'inconclusive';
};

// Compares a release-tag checkout with the newest remote v* release tag, never with main.
export function checkRemoteReleaseTag(repoRoot: string, currentTag: string, run: Runner = defaultRun): ReleaseTagComparison {
  const current = parseReleaseVersion(currentTag);
  if (!current) return { currentTag, status: 'inconclusive' };
  let output = '';
  try {
    output = run('git', ['ls-remote', '--tags', 'origin', 'v*'], { cwd: repoRoot, timeout: 15000 });
  } catch {
    return { currentTag, status: 'inconclusive' };
  }
  let latest: { tag: string; version: ReleaseVersion } | undefined;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^[a-f0-9]{40}\s+refs\/tags\/(v[^\s^]+)(\^\{\})?$/);
    if (!match || !match[1]) continue;
    const version = parseReleaseVersion(match[1]);
    if (!version || version.prerelease !== undefined) continue;
    if (!latest || compareReleaseVersions(version, latest.version) > 0) latest = { tag: match[1], version };
  }
  if (!latest) return { currentTag, status: 'inconclusive' };
  return compareReleaseVersions(latest.version, current) > 0
    ? { currentTag, latestTag: latest.tag, status: 'release-available' }
    : { currentTag, latestTag: latest.tag, status: 'up-to-date' };
}

// Describes the harness checkout without network access, for doctor output.
export function describeHarnessCheckout(repoRoot: string, run: Runner = defaultRun): string {
  const source = readSourceVersion(repoRoot, run);
  const tag = detectReleaseTag(repoRoot, run);
  return `${formatVersionStamp(toVersionStamp(source))}${tag ? ` [release tag ${tag}]` : ' [development checkout]'}`;
}

// Validates that a pushed release tag matches the package and lockfile versions.
export function checkReleaseTagVersion(tag: string, packageVersion: string | undefined, lockVersion: string | undefined): string[] {
  const errors: string[] = [];
  const version = parseReleaseVersion(tag);
  if (!tag.startsWith('v') || !version) {
    return [`Tag "${tag}" is not a vX.Y.Z release tag.`];
  }
  if (version.prerelease?.split('.').includes('dev')) {
    errors.push(`Tag "${tag}" uses a -dev version; -dev versions are for main between releases and are never tagged.`);
  }
  const expected = tag.slice(1);
  if (packageVersion !== expected) {
    errors.push(`package.json version "${packageVersion ?? '(missing)'}" does not match tag "${tag}" (expected "${expected}").`);
  }
  if (lockVersion !== expected) {
    errors.push(`package-lock.json version "${lockVersion ?? '(missing)'}" does not match tag "${tag}" (expected "${expected}").`);
  }
  return errors;
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
