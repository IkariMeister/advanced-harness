import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { contextData, contextPath } from '../project-context.ts';
import { linkedContextSelection, locateProjectContext, validateProfile } from '../project-setup.ts';
import type { ChangeOrigin, CheckOutcome, PreflightCheck } from './types.ts';
import { safeGitleaksRuleId, scanAddedText } from './secret-scanner.ts';
export { DEFAULT_SENSITIVE_PATH_GLOBS, pathPolicyCheck } from './path-policy.ts';

const TRUSTED_REF = 'refs/remotes/origin/HEAD';
const TRUSTED_HINT = 'pass --base <ref> or run `git remote set-head origin --auto`';
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

/** Resolves the trusted ref to a commit locally. Never fetches. */
function trustedCommit(top: string): string {
  const res = spawnSync('git', ['-C', top, '--literal-pathspecs', 'rev-parse', '--verify', '--quiet', `${TRUSTED_REF}^{commit}`], { encoding: 'utf8' });
  if (res.error) throw new Error(`git rev-parse could not be started: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`trusted ref ${TRUSTED_REF} unavailable; ${TRUSTED_HINT}`);
  const commit = res.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`trusted ref ${TRUSTED_REF} did not resolve to a commit`);
  return commit;
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

/**
 * Compares the worktree's linked context target and baseBranch with the trusted ref's AGENTS.md.
 * Returns undefined when they match; throws when the trusted ref cannot be read (inconclusive).
 */
function compareWithTrustedRef(top: string, worktree: string, worktreeTarget: string, worktreeBase: string): CheckOutcome | undefined {
  const commit = trustedCommit(top);
  const agentsRel = toRepoPath(top, join(worktree, 'AGENTS.md'));
  const trustedAgents = trustedFile(top, commit, agentsRel);
  if (trustedAgents === undefined) throw new Error(`${agentsRel} is absent at trusted ref ${TRUSTED_REF}`);

  let trustedTarget = agentsRel;
  let trustedText: string | undefined = trustedAgents;
  const linked = linkedContextSelection(trustedAgents);
  if (linked !== undefined) {
    trustedTarget = toRepoPath(top, contextPath(worktree, linked));
    // Defensive: contextPath already rejects escaping links, so this guard is defense in depth only.
    if (leavesRepo(trustedTarget)) throw new Error(`linked context target ${trustedTarget} at trusted ref resolves outside the repository`);
    trustedText = trustedFile(top, commit, trustedTarget);
    if (trustedText === undefined) throw new Error(`${trustedTarget} is absent at trusted ref ${TRUSTED_REF}`);
  }
  const data = contextData(trustedText, 'project');
  if (data === undefined) throw new Error(`no project settings in ${trustedTarget} at trusted ref ${TRUSTED_REF}`);
  const trustedBase = validateProfile(data).baseBranch;

  const differences: string[] = [];
  if (!samePath(trustedTarget, worktreeTarget)) differences.push(`linked context target ${trustedTarget} (trusted) vs ${worktreeTarget} (worktree)`);
  if (trustedBase !== worktreeBase) differences.push(`baseBranch ${trustedBase} (trusted) vs ${worktreeBase} (worktree)`);
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

export type SecretException = { path: string; rule: string; justification: string };
export function validateSecretExceptions(exceptions: readonly SecretException[]): void {
  for (const exception of exceptions) {
    if (!exception || typeof exception.path !== 'string' || !exception.path || typeof exception.rule !== 'string' || !exception.rule || typeof exception.justification !== 'string' || !exception.justification.trim()) throw new Error('Secret exceptions require an exact path, rule, and nonblank justification.');
  }
}
export function secretScanCheck(exceptions: readonly SecretException[] = [], scanner: typeof scanAddedText = scanAddedText): PreflightCheck {
  return { id: 'secret-scan', run({ changeset }) {
    validateSecretExceptions(exceptions);
    const payload = changeset.entries.flatMap(entry => {
      if (entry.status === 'deleted' || !entry.addedText || entry.addedTextComplete === false) return [];
      const lines = entry.addedText.split(/\r?\n/);
      return lines.flatMap((text, index) => text ? [{ path: entry.path.replaceAll('\\', '/'), line: entry.targetLines?.[index] ?? index + 1, text }] : []);
    });
    if (changeset.entries.some(entry => entry.status !== 'deleted' && entry.addedTextComplete === false)) {
      return { status: 'inconclusive', evidence: ['Secret scan could not extract added text from one or more binary changes.'], metrics: { backendGitleaks: 0, complete: 0, findings: 0 } };
    }
    const scanned = scanner(payload);
    if (!scanned.complete) return { status: 'inconclusive', evidence: [`Secret scan backend: ${scanned.backend}.`, scanned.reason ?? 'Secret scanner did not complete.'], metrics: { backendGitleaks: scanned.backend === 'gitleaks' ? 1 : 0, complete: 0, findings: 0 } };
    const actionable = scanned.findings.filter(finding => !exceptions.some(exception => exception.path === finding.path && canonicalExceptionRule(exception.rule, scanned.backend) === finding.rule && !!exception.justification.trim()));
    return { status: actionable.length ? 'block' : 'pass', evidence: [`Secret scan backend: ${scanned.backend} (complete).`, ...(actionable.length ? actionable.map(finding => `${finding.rule} at ${finding.path}:${finding.line} [REDACTED]`) : ['No high-confidence secrets found in added text.'])], metrics: { backendGitleaks: scanned.backend === 'gitleaks' ? 1 : 0, complete: 1, findings: actionable.length } };
  } };
}

function canonicalExceptionRule(rule: string, backend: string): string {
  return backend === 'gitleaks' ? safeGitleaksRuleId(rule) : rule;
}
