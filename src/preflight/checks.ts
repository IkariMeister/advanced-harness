import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { contextData, contextPath } from '../project-context.ts';
import {
  linkedContextSelection,
  locateProjectContext,
  resolveProjectLocations,
  validateProfile,
  type ProjectProfile,
} from '../project-setup.ts';
import type { ChangeOrigin, Changeset, CheckOutcome, PreflightCheck } from './types.ts';
import { addedTextByteLength, MAX_SECRET_SCAN_BYTES, safeGitleaksRuleId, scanAddedText, type SecretFinding } from './secret-scanner.ts';
import { markConfigurableBuiltIn, markTrustedPolicyDependent, matchesGlob, validateSensitivePathGlobs } from './path-policy.ts';
import { isProjectPreflightPolicyPath } from './policy.ts';
import { normalizeExceptionPath, validateSecretExceptions, type SecretException } from './exceptions.ts';
import { trustedCommit } from './trusted-context.ts';
import { displayText } from './criteria.ts';
export { validateSecretExceptions, type SecretException } from './exceptions.ts';
export { DEFAULT_SENSITIVE_PATH_GLOBS, pathPolicyCheck } from './path-policy.ts';

const TRUSTED_REF = 'refs/remotes/origin/HEAD';
const BASE_CONTEXT_TRUSTED_HINT = 'pass --base <ref> or run `git remote set-head origin --auto`';
const WORKTREE_BOUNDARY_TRUSTED_HINT = 'run `git remote set-head origin --auto`';
const MAX_CONTEXT_BYTES = 1024 * 1024;

/** Repo-relative, forward-slash path of an absolute path under the repository top-level. */
const toRepoPath = (top: string, path: string) => relative(resolve(top), path).replaceAll('\\', '/');

/** True when a repo-relative path leaves the repository top-level. */
const leavesRepo = (repoPath: string) => repoPath === '..' || repoPath.startsWith('../') || isAbsolute(repoPath);

/** Platform-aware path identity: Windows paths compare case-insensitively. */
const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function gitBytes(top: string, args: string[]): Buffer {
  const res = spawnSync('git', ['-C', top, '--literal-pathspecs', ...args], { maxBuffer: 16 * 1024 * 1024 });
  if (res.error) throw new Error(`git could not be started: ${res.error.message}`);
  if (res.status !== 0) {
    const detail = res.stderr.toString('utf8').trim().split(/\r?\n/)[0] ?? '';
    throw new Error(`git ${args[0]} failed (exit ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return res.stdout;
}

/** Reads a regular tracked text file at the trusted commit. Undefined when it is absent there. */
function trustedFile(top: string, commit: string, repoPath: string): string | undefined {
  const listing = gitBytes(top, ['ls-tree', '-z', commit, '--', repoPath]).toString('utf8');
  if (listing === '') return undefined;
  const record = listing.split('\0')[0] ?? '';
  const tab = record.indexOf('\t');
  if (tab < 0 || record.slice(tab + 1) !== repoPath) throw new Error(`unexpected ls-tree output for ${repoPath}`);
  const [mode, type, object] = record.slice(0, tab).split(' ');
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || !object) throw new Error(`${repoPath} at trusted ref is not a regular file`);
  const bytes = gitBytes(top, ['cat-file', 'blob', object]);
  if (bytes.length > MAX_CONTEXT_BYTES) throw new Error(`${repoPath} at trusted ref exceeds 1 MiB`);
  return bytes.toString('utf8');
}

/** Reads and validates the project profile at the trusted ref. */
function readTrustedProjectContext(top: string, contextRoot = top, hint = BASE_CONTEXT_TRUSTED_HINT): { target: string; profile: ProjectProfile } {
  const commit = trustedCommit(top, hint);
  const agentsRel = toRepoPath(top, join(contextRoot, 'AGENTS.md'));
  const trustedAgents = trustedFile(top, commit, agentsRel);
  if (trustedAgents === undefined) throw new Error(`${agentsRel} is absent at trusted ref ${TRUSTED_REF}`);

  let trustedTarget = agentsRel;
  let trustedText: string | undefined = trustedAgents;
  const linked = linkedContextSelection(trustedAgents);
  if (linked !== undefined) {
    trustedTarget = toRepoPath(top, contextPath(contextRoot, linked));
    // Defensive: contextPath already rejects escaping links, so this guard is defense in depth only.
    if (leavesRepo(trustedTarget)) throw new Error(`linked context target ${trustedTarget} at trusted ref resolves outside the repository`);
    trustedText = trustedFile(top, commit, trustedTarget);
    if (trustedText === undefined) throw new Error(`${trustedTarget} is absent at trusted ref ${TRUSTED_REF}`);
  }
  const data = contextData(trustedText, 'project');
  if (data === undefined) throw new Error(`no project settings in ${trustedTarget} at trusted ref ${TRUSTED_REF}`);
  const profile = validateProfile(data);
  return { target: trustedTarget, profile };
}

/**
 * Compares the worktree's linked context target and baseBranch with the trusted ref's AGENTS.md.
 * Returns undefined when they match; throws when the trusted ref cannot be read (inconclusive).
 */
function compareWithTrustedRef(top: string, worktree: string, worktreeTarget: string, worktreeBase: string): CheckOutcome | undefined {
  const { target: trustedTarget, profile: trustedProfile } = readTrustedProjectContext(top, worktree, BASE_CONTEXT_TRUSTED_HINT);

  const differences: string[] = [];
  if (!samePath(trustedTarget, worktreeTarget)) differences.push(`linked context target ${trustedTarget} (trusted) vs ${worktreeTarget} (worktree)`);
  if (trustedProfile.baseBranch !== worktreeBase) differences.push(`baseBranch ${trustedProfile.baseBranch} (trusted) vs ${worktreeBase} (worktree)`);
  if (differences.length === 0) return undefined;
  return { status: 'block', evidence: [`Project context differs from trusted ref ${TRUSTED_REF}: ${differences.join('; ')}.`] };
}

/**
 * Checks that the project context was not modified when the base ref was derived
 * from project context. With `--base` omitted, the worktree's linked context target and
 * baseBranch must match the trusted ref, and the changeset must not touch the context
 * file or AGENTS.md. Fails closed: any unverifiable state is inconclusive, never a pass.
 */
export const baseContextCheck: PreflightCheck = {
  id: 'base-context',
  run({ worktree, changeset }) {
    let target: string;
    try {
      target = toRepoPath(changeset.top, locateProjectContext(worktree).target);
    } catch (error) {
      return { status: 'inconclusive', evidence: [`Project context resolution failed: ${error instanceof Error ? error.message : String(error)}`] };
    }
    const agentsRel = toRepoPath(changeset.top, join(worktree, 'AGENTS.md'));

    // Second blocking layer: the changeset touches the context file, or AGENTS.md itself (which holds the link).
    const changed = changeset.entries.flatMap((entry) => [entry.path, entry.oldPath]).filter((p): p is string => p !== undefined).map((p) => p.replaceAll('\\', '/'));
    const modified = [target, agentsRel].find((context) => changed.some((p) => samePath(p, context)));

    if (changeset.baseSource === 'option') {
      return {
        status: 'pass',
        evidence: [
          `Base ref '${changeset.base}' explicitly provided via option`,
          modified !== undefined ? `Project context file (${modified}) modified (informational; explicit --base in use)` : `Project context file (${target}) unmodified`,
        ],
      };
    }

    // baseSource is 'project-context': the worktree's context must match the trusted ref and be unmodified.
    // Defensive: contextPath already rejects escaping links, so this guard is defense in depth only.
    if (leavesRepo(target)) {
      return { status: 'inconclusive', evidence: [`Project context resolution failed: linked context target ${target} resolves outside the repository`] };
    }
    try {
      const trusted = compareWithTrustedRef(changeset.top, worktree, target, changeset.base);
      if (trusted) return trusted;
    } catch (error) {
      return { status: 'inconclusive', evidence: [`Trusted project context could not be verified: ${error instanceof Error ? error.message : String(error)}`] };
    }

    if (modified !== undefined) {
      return {
        status: 'block',
        evidence: [
          `Project context (${modified}) was modified in this changeset; pass explicit --base <ref> for authoritative base ref.`,
        ],
      };
    }

    return {
      status: 'pass',
      evidence: [`Project context (${target}) unmodified; baseBranch ${changeset.base} matches trusted ref ${TRUSTED_REF}`],
    };
  },
};

/** Built-in check: reports the collected changeset. Guardrail checks (BH-067..071) plug in alongside it. */
export const changesetCheck: PreflightCheck = {
  id: 'changeset',
  run({ changeset }) {
    const counts: Record<ChangeOrigin, number> = { committed: 0, staged: 0, unstaged: 0, untracked: 0 };
    for (const entry of changeset.entries) counts[entry.origin] += 1;
    return {
      status: 'pass',
      evidence: [
        `Base ${changeset.base} (merge-base ${changeset.mergeBase.slice(0, 12)}), HEAD ${changeset.head.slice(0, 12)}`,
        `${changeset.entries.length} change(s): ${counts.committed} committed, ${counts.staged} staged, ${counts.unstaged} unstaged, ${counts.untracked} untracked`,
      ],
      metrics: { files: changeset.entries.length, ...counts },
    };
  },
};

/** Project policy files are read from origin/HEAD (refs/remotes/origin/HEAD), never from --base; edits in the candidate changeset are review blockers. */
export const policyIntegrityCheck: PreflightCheck = {
  id: 'policy-integrity',
  run({ changeset }) {
    const changed = changeset.entries.flatMap(entry => [entry.path, entry.oldPath].filter((path): path is string => path !== undefined)).filter(isProjectPreflightPolicyPath);
    const unique = [...new Set(changed)];
    const shown = unique.slice(0, 50).map(path => JSON.stringify(path.length > 240 ? `${path.slice(0, 240)}…` : path));
    return unique.length
      ? { status: 'block', evidence: [`Project preflight policy changes require review: ${shown.join(', ')}${unique.length > 50 ? `, … ${unique.length - 50} additional path(s)` : ''}.`], metrics: { changedFiles: unique.length } }
      : { status: 'pass', evidence: ['No project preflight policy files changed.'], metrics: { changedFiles: 0 } };
  },
};

/** Path text for evidence: backslashes become forward slashes, then the shared display escaping and bound apply. */
function displayFindingPath(path: string): string {
  return displayText(path.replaceAll('\\', '/'));
}
export const TEST_CHANGE_CHECK_ID = 'test-change';

/** Changed-path identity for de-duplication: Windows paths compare case-insensitively, other platforms exactly. */
const changedPathKey = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);

/**
 * Warns when production files changed and no test file changed (BH-070); passes when tests changed or no production
 * file changed. A rename contributes its new and old path. A deletion counts as a production change when its path
 * matches a production glob, but a removed path (a deletion, or the old path of a rename) is never a test change.
 * A copy's source is not a change. A path that matches a test glob is a test even when a production glob also matches
 * it. Without both globs the check passes with an explicit "not run" note. It reads the trusted policy's globs, so it
 * is trusted-policy dependent.
 */
export function testChangeCheck(prodGlobs?: readonly string[], testGlobs?: readonly string[]): PreflightCheck {
  if (prodGlobs !== undefined) validateSensitivePathGlobs(prodGlobs, 'prodGlobs');
  if (testGlobs !== undefined) validateSensitivePathGlobs(testGlobs, 'testGlobs');
  const check: PreflightCheck = { id: TEST_CHANGE_CHECK_ID, run({ changeset }) {
    if (prodGlobs === undefined || testGlobs === undefined) return { status: 'pass', evidence: ['prodGlobs/testGlobs not configured; check not run'] };
    const productionPatterns: readonly string[] = prodGlobs;
    const testPatterns: readonly string[] = testGlobs;
    const changed = new Map<string, string>();
    // Keys of paths that still exist in the candidate: the path of every non-deleted entry. A rename's old path is removed.
    const present = new Set<string>();
    for (const entry of changeset.entries) {
      const touched = entry.status === 'renamed' && entry.oldPath !== undefined ? [entry.path, entry.oldPath] : [entry.path];
      for (const touchedPath of touched) {
        const normalized = touchedPath.replaceAll('\\', '/');
        changed.set(changedPathKey(normalized), normalized);
      }
      if (entry.status !== 'deleted') present.add(changedPathKey(entry.path.replaceAll('\\', '/')));
    }
    const paths = [...changed.entries()];
    const matchesTest = (path: string) => testPatterns.some(glob => matchesGlob(path, glob));
    const isTest = ([key, path]: [string, string]) => present.has(key) && matchesTest(path);
    const tests = paths.filter(isTest).map(([, path]) => path);
    const removedTests = paths.filter(entry => !present.has(entry[0]) && matchesTest(entry[1])).map(([, path]) => path);
    const production = paths.filter(entry => !isTest(entry) && productionPatterns.some(glob => matchesGlob(entry[1], glob))).map(([, path]) => path);
    const metrics = { productionFiles: production.length, testFiles: tests.length };
    if (production.length === 0) return { status: 'pass', evidence: ['No production files changed.'], metrics };
    if (tests.length > 0) return { status: 'pass', evidence: [`Test files changed: ${tests.length}; production files changed: ${production.length}.`], metrics };
    const shown = production.slice(0, 50).map(displayFindingPath);
    const evidence = [`Production files changed (${production.length}) and no test files changed: ${shown.join(', ')}${production.length > 50 ? `, … ${production.length - 50} additional path(s)` : ''}.`];
    if (removedTests.length) {
      const shownRemoved = removedTests.slice(0, 50).map(displayFindingPath);
      evidence.push(`Removed test paths do not count as test changes: ${shownRemoved.join(', ')}${removedTests.length > 50 ? `, … ${removedTests.length - 50} additional path(s)` : ''}.`);
    }
    return { status: 'warn', evidence, metrics };
  } };
  return markConfigurableBuiltIn(markTrustedPolicyDependent(check));
}

export function secretScanCheck(exceptions: readonly SecretException[] = [], scanner: typeof scanAddedText = scanAddedText): PreflightCheck {
  const check: PreflightCheck = { id: 'secret-scan', run({ changeset, gitlinkAcknowledgements, trustedPolicyCommit }) {
    validateSecretExceptions(exceptions);
    const payload = changeset.entries.flatMap(entry => {
      if (entry.status === 'deleted' || entry.addedText === undefined || entry.addedTextComplete === false) return [];
      if (entry.targetLines?.length === 0) return [];
      const lines = entry.addedText.split(/\r?\n/);
      if (entry.addedText.endsWith('\n')) lines.pop();
      const addedLines = entry.targetLines === undefined ? lines : lines.slice(0, entry.targetLines.length);
      return addedLines.map((text, index) => ({ path: entry.path.replaceAll('\\', '/'), line: entry.targetLines?.[index] ?? index + 1, text, origin: entry.origin }));
    });
    const acknowledgements = gitlinkAcknowledgements ?? [];
    const acknowledgementMatchesEntry = (item: typeof acknowledgements[number], entry: typeof changeset.entries[number]) => entry.gitlink !== undefined && entry.gitlink.newId !== undefined && item.path === entry.path && item.newId.toLowerCase() === entry.gitlink.newId.toLowerCase() && (item.oldId === undefined ? entry.status === 'added' && entry.gitlink.oldId === undefined : item.oldId.toLowerCase() === entry.gitlink.oldId?.toLowerCase());
    const entryAcknowledged = (entry: typeof changeset.entries[number]) => entry.gitlink?.nestedContentDirty !== true && acknowledgements.some(item => acknowledgementMatchesEntry(item, entry));
    const incompleteEntries = changeset.entries.filter(entry => entry.status !== 'deleted' && entry.addedTextComplete === false);
    const acknowledgedEntries = incompleteEntries.filter(entry => entry.gitlink && entryAcknowledged(entry));
    const incomplete = incompleteEntries.filter(entry => !entryAcknowledged(entry));
    const payloadBytes = addedTextByteLength(payload);
    if (payloadBytes > MAX_SECRET_SCAN_BYTES) return { status: 'inconclusive', evidence: ['Secret scan input exceeded the configured 4 MiB aggregate limit.'], metrics: { backendGitleaks: 0, backendBuiltin: 0, backendUnavailable: 0, notRun: 1, scannerComplete: 0, complete: 0, findings: 0, exceptionsApplied: 0 } };
    const scanned = payload.length ? scanner(payload) : { backend: 'unavailable' as const, findings: [], complete: true };
    const notRun = payload.length === 0 ? 1 : 0;
    const backendMetrics = { backendGitleaks: notRun ? 0 : scanned.backend === 'gitleaks' ? 1 : 0, backendBuiltin: notRun ? 0 : scanned.backend === 'builtin' ? 1 : 0, backendUnavailable: notRun ? 0 : scanned.backend === 'unavailable' ? 1 : 0 };
    const isExcepted = (finding: SecretFinding) => exceptions.some(exception => normalizeExceptionPath(exception.path) === normalizeExceptionPath(finding.path) && canonicalExceptionRule(exception.rule, scanned.backend) === finding.rule && (exception.line === undefined || (exception.line === finding.line && exception.origin === finding.origin)) && !!exception.justification.trim());
    const actionable: SecretFinding[] = [];
    let exceptionsApplied = 0;
    for (const finding of scanned.findings) {
      if (isExcepted(finding)) exceptionsApplied += 1;
      else actionable.push(finding);
    }
    const incompletePaths = [...new Set(incomplete.map(entry => entry.path))];
    const coverageComplete = scanned.complete && incompleteEntries.length === 0;
    const evidence = [notRun ? 'Secret scan backend: not run.' : `Secret scan backend: ${scanned.backend}${coverageComplete ? ' (complete).' : ' (incomplete).'}`];
    if (!scanned.complete) evidence.push(`Secret scan incomplete: ${safeScanReason(scanned.reason)}`);
    if (actionable.length) evidence.push(...actionable.slice(0, 100).map(finding => `${finding.rule} at ${displayFindingPath(finding.path)}:${finding.line} [REDACTED]`));
    else if (scanned.complete) evidence.push('No high-confidence secrets found in added text.');
    if (incompletePaths.length) evidence.push(`Could not scan ${incompletePaths.length} changed path(s): ${incompletePaths.slice(0, 50).map(displayFindingPath).join(', ')}${incompletePaths.length > 50 ? ', …' : ''}.`);
    if (acknowledgedEntries.length) evidence.push(`Acknowledged incomplete coverage: ${acknowledgedEntries.map(entry => `${displayFindingPath(entry.path)} (${entry.gitlink!.oldId ?? 'added'} -> ${entry.gitlink!.newId})`).join(', ')}.`);
    const matchedAcknowledgements = acknowledgements.filter(item => changeset.entries.some(entry => entryAcknowledged(entry) && acknowledgementMatchesEntry(item, entry)));
    if (acknowledgements.length) evidence.push(`Trusted gitlink acknowledgements from policy commit ${trustedPolicyCommit ?? 'unavailable'}: ${acknowledgements.length}; matched: ${matchedAcknowledgements.length}; unmatched: ${acknowledgements.length - matchedAcknowledgements.length}.`);
    const acknowledgedPaths = new Set(acknowledgedEntries.map(entry => entry.path)).size;
    const metrics = { ...backendMetrics, notRun, scannerComplete: scanned.complete ? 1 : 0, complete: coverageComplete ? 1 : 0, findings: actionable.length, exceptionsApplied, affectedPaths: incompletePaths.length, acknowledgedPaths };
    return { status: actionable.length ? 'block' : !scanned.complete || incomplete.length ? 'inconclusive' : acknowledgedEntries.length ? 'warn' : 'pass', evidence, metrics };
  } };
  return markTrustedPolicyDependent(check);
}

function safeScanReason(reason: unknown): string {
  const allowed = new Set([
    'Gitleaks aggregate scan deadline exceeded.',
    'Gitleaks scan failed.',
    'Gitleaks report could not be read.',
    'Gitleaks returned malformed JSON output.',
    'Gitleaks probe failed.',
    'Gitleaks is not installed in an absolute PATH entry.',
    'Gitleaks probe temporary directory could not be created.',
    'Gitleaks scan temporary directory could not be created.',
    'Gitleaks temporary files could not be cleaned up.',
    'Gitleaks is present but its version probe failed.',
    'Gitleaks 8.30.1 or newer is required.',
    'Gitleaks stdin JSON report interface is unavailable.',
    'Secret scan input exceeded the configured bound.',
    'Gitleaks executable was not resolved to an absolute path.',
  ]);
  return typeof reason === 'string' && allowed.has(reason) ? reason : 'scanner could not complete its bounded probe or scan.';
}

function canonicalExceptionRule(rule: string, backend: string): string {
  return backend === 'gitleaks' ? safeGitleaksRuleId(rule) : rule;
}
/** Checks git rev-parse --git-dir vs --git-common-dir. */
function checkCanonicalCheckout(top: string): CheckOutcome | undefined {
  let gitDirRes: ReturnType<typeof spawnSync>;
  let gitCommonDirRes: ReturnType<typeof spawnSync>;
  try {
    gitDirRes = spawnSync('git', ['-C', top, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
    gitCommonDirRes = spawnSync('git', ['-C', top, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' });
  } catch (error) {
    return { status: 'inconclusive', evidence: [`git rev-parse could not be started: ${error instanceof Error ? error.message : String(error)}`] };
  }

  if (gitDirRes.error || gitCommonDirRes.error) {
    const err = gitDirRes.error ?? gitCommonDirRes.error;
    return { status: 'inconclusive', evidence: [`git rev-parse failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (gitDirRes.status !== 0 || gitCommonDirRes.status !== 0) {
    return { status: 'inconclusive', evidence: ['git rev-parse --git-dir or --git-common-dir failed to exit cleanly'] };
  }

  const rawGitDir = String(gitDirRes.stdout).trim();
  const rawGitCommonDir = String(gitCommonDirRes.stdout).trim();

  let realGitDir: string;
  let realGitCommonDir: string;
  try {
    realGitDir = realpathSync.native(resolve(top, rawGitDir));
    realGitCommonDir = realpathSync.native(resolve(top, rawGitCommonDir));
  } catch (error) {
    return { status: 'inconclusive', evidence: [`Failed to resolve git directories: ${error instanceof Error ? error.message : String(error)}`] };
  }

  if (samePath(realGitDir, realGitCommonDir)) {
    return {
      status: 'block',
      evidence: [
        `Target directory ${top} is the canonical repository checkout, not an isolated task worktree (--git-dir equals --git-common-dir). Work must be executed in a dedicated worktree under worktreeDirectory.`,
      ],
    };
  }
  return undefined;
}

/**
 * Verifies that worktreeDirectory configured in the worktree matches the trusted ref.
 * An unavailable or unreadable trusted ref or trusted project context blocks (exit 1),
 * as does a modified worktreeDirectory.
 */
function checkTrustedWorktreeDirectory(top: string, localWorktreeDirectory: string): CheckOutcome | undefined {
  let trustedTarget: string;
  let trustedProfile: ProjectProfile;
  try {
    const trusted = readTrustedProjectContext(top, top, WORKTREE_BOUNDARY_TRUSTED_HINT);
    trustedTarget = trusted.target;
    trustedProfile = trusted.profile;
  } catch (error) {
    return {
      status: 'block',
      evidence: [
        `Trusted worktreeDirectory could not be verified against ${TRUSTED_REF}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  // Only raw strings are compared deliberately because identical raw strings expand identically.
  if (trustedProfile.worktreeDirectory !== localWorktreeDirectory) {
    return {
      status: 'block',
      evidence: [
        `Project context (${trustedTarget}) modified worktreeDirectory from '${trustedProfile.worktreeDirectory}' (at ${TRUSTED_REF}) to '${localWorktreeDirectory}'; cannot verify task worktree boundary against a modified worktreeDirectory.`,
      ],
    };
  }

  return undefined;
}

export interface PathContainmentApi {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}

/** Determines whether candidate is strictly contained within parent (path containment). */
export function isPathContained(
  parent: string,
  candidate: string,
  pathApi: PathContainmentApi = { relative, isAbsolute, sep },
): boolean {
  const rel = pathApi.relative(parent, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel);
}

/** Validates that top is strictly contained within configuredParent. */
function checkWorktreeContainment(top: string, configuredParent: string): CheckOutcome | undefined {
  let realConfiguredParent: string;
  let realTop: string;
  try {
    realConfiguredParent = realpathSync.native(configuredParent);
  } catch (error) {
    return {
      status: 'block',
      evidence: [`Configured worktreeDirectory (${configuredParent}) cannot be resolved on disk: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  try {
    realTop = realpathSync.native(top);
  } catch (error) {
    return {
      status: 'inconclusive',
      evidence: [`Worktree top (${top}) could not be resolved: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  if (!isPathContained(realConfiguredParent, realTop)) {
    return {
      status: 'block',
      evidence: [
        `Worktree ${top} (resolved: ${realTop}) is outside the configured worktreeDirectory (${configuredParent}, resolved: ${realConfiguredParent}).`,
      ],
    };
  }
  return undefined;
}

interface TaskBranchResult {
  outcome?: CheckOutcome;
  branch?: string;
}

/** Validates optional task branch token match and returns the active branch. */
function checkTaskBranch(top: string, task: string): TaskBranchResult {
  const cleanTask = task.trim().replace(/^#/, '');
  if (!cleanTask) {
    return {
      outcome: {
        status: 'inconclusive',
        evidence: ['Invalid task parameter: task key cannot be empty'],
      },
    };
  }

  let branchRes: ReturnType<typeof spawnSync>;
  try {
    branchRes = spawnSync('git', ['-C', top, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' });
  } catch (error) {
    return {
      outcome: {
        status: 'inconclusive',
        evidence: [`git symbolic-ref could not be started: ${error instanceof Error ? error.message : String(error)}`],
      },
    };
  }

  if (branchRes.error) {
    return {
      outcome: {
        status: 'inconclusive',
        evidence: [`git symbolic-ref failed: ${branchRes.error.message}`],
      },
    };
  }

  if (branchRes.status === 1) {
    return {
      outcome: {
        status: 'block',
        evidence: [`Worktree HEAD is detached; expected branch matching task '${task}'`],
      },
    };
  }

  if (branchRes.status !== 0) {
    return {
      outcome: {
        status: 'inconclusive',
        evidence: [`git symbolic-ref exited with code ${branchRes.status}`],
      },
    };
  }

  const branch = String(branchRes.stdout).trim();
  const escapedKey = cleanTask.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[^a-zA-Z0-9])${escapedKey}(?:$|[^a-zA-Z0-9])`, 'i');

  if (!pattern.test(branch)) {
    return {
      outcome: {
        status: 'block',
        evidence: [`Branch '${branch}' does not match task key '${task}'`],
      },
      branch,
    };
  }
  return { branch };
}

/**
 * Checks that the inspected repository top-level is a linked task worktree
 * (not the canonical checkout), is located under the configured `worktreeDirectory`,
 * and optionally that the branch name matches the task key.
 */
export const worktreeBoundaryCheck: PreflightCheck = {
  id: 'worktree-boundary',
  run({ changeset, task }) {
    const top = changeset.top;

    // 1. Check whether top is a linked worktree or canonical checkout
    const canonical = checkCanonicalCheckout(top);
    if (canonical) return canonical;

    // 2. Check worktreeDirectory configuration
    const locationRes = resolveProjectLocations(top);
    if (locationRes.status === 'missing') {
      return {
        status: 'block',
        evidence: [
          'No shared worktreeDirectory is configured in project context. Configure worktreeDirectory via harness:setup before preflight.',
        ],
      };
    }
    if (locationRes.status !== 'resolved') {
      return {
        status: 'inconclusive',
        evidence: [`Shared location resolution failed (${locationRes.status}): ${locationRes.reason}`],
      };
    }

    const configuredParent = locationRes.locations.worktreeDirectory;

    // 3. Verify worktreeDirectory against trusted ref
    const trustedWtDir = checkTrustedWorktreeDirectory(top, locationRes.stored.worktreeDirectory);
    if (trustedWtDir) return trustedWtDir;

    if (locationRes.source === 'paths') {
      return {
        status: 'block',
        evidence: [
          'Project has paths configuration but no project settings. Full project settings are required before preflight.',
        ],
      };
    }

    // 4. Check worktree containment
    const containment = checkWorktreeContainment(top, configuredParent);
    if (containment) return containment;

    // 5. Optional task branch check
    if (task !== undefined) {
      const taskCheck = checkTaskBranch(top, task);
      if (taskCheck.outcome) return taskCheck.outcome;

      return {
        status: 'pass',
        evidence: [
          `Worktree ${top} is an isolated task worktree under ${configuredParent}`,
          `Branch '${taskCheck.branch}' matches task key '${task}'`,
        ],
      };
    }

    return {
      status: 'pass',
      evidence: [`Worktree ${top} is an isolated task worktree under ${configuredParent}`],
    };
  },
};
