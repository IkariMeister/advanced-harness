import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { contextData, contextPath, readContext } from '../project-context.ts';
import { linkedContextSelection, locateProjectContext, resolveProjectLocations, validateProfile } from '../project-setup.ts';
import type { ChangeOrigin, Changeset, CheckOutcome, PreflightCheck } from './types.ts';

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

/** Checks that worktreeDirectory was not modified compared to the trusted ref when project context was edited. */
function checkUnmodifiedWorktreeDirectory(top: string, changeset: Changeset): CheckOutcome | undefined {
  let target: string;
  let agentsRel: string;
  try {
    target = toRepoPath(changeset.top, locateProjectContext(top).target);
    agentsRel = toRepoPath(changeset.top, join(top, 'AGENTS.md'));
  } catch (error) {
    return { status: 'inconclusive', evidence: [`Failed to inspect project context changes: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const changed = changeset.entries.flatMap((entry) => [entry.path, entry.oldPath]).filter((p): p is string => p !== undefined).map((p) => p.replaceAll('\\', '/'));
  const modified = [target, agentsRel].find((context) => changed.some((p) => samePath(p, context)));
  if (modified === undefined) {
    return undefined;
  }

  // Project context was modified in the changeset. Verify whether worktreeDirectory itself was changed.
  try {
    const commit = trustedCommit(top);
    const trustedAgents = trustedFile(top, commit, agentsRel);
    if (trustedAgents === undefined) throw new Error(`${agentsRel} is absent at trusted ref ${TRUSTED_REF}`);

    let trustedTarget = agentsRel;
    let trustedText: string | undefined = trustedAgents;
    const linked = linkedContextSelection(trustedAgents);
    if (linked !== undefined) {
      trustedTarget = toRepoPath(top, contextPath(top, linked));
      if (leavesRepo(trustedTarget)) throw new Error(`linked context target ${trustedTarget} at trusted ref resolves outside the repository`);
      trustedText = trustedFile(top, commit, trustedTarget);
      if (trustedText === undefined) throw new Error(`${trustedTarget} is absent at trusted ref ${TRUSTED_REF}`);
    }
    const trustedData = contextData(trustedText, 'project');
    if (trustedData === undefined) throw new Error(`no project settings in ${trustedTarget} at trusted ref ${TRUSTED_REF}`);
    const trustedProfile = validateProfile(trustedData);

    const localText = readContext(resolve(top, target));
    const localData = contextData(localText ?? '', 'project');
    if (localData === undefined) throw new Error(`no project settings in ${target}`);
    const localProfile = validateProfile(localData);

    if (trustedProfile.worktreeDirectory !== localProfile.worktreeDirectory) {
      return {
        status: 'block',
        evidence: [
          `Project context (${modified}) modified worktreeDirectory from '${trustedProfile.worktreeDirectory}' to '${localProfile.worktreeDirectory}'; cannot verify task worktree boundary against a modified worktreeDirectory.`,
        ],
      };
    }
  } catch (error) {
    return {
      status: 'block',
      evidence: [
        `Project context (${modified}) was modified in this changeset and trusted worktreeDirectory could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  return undefined;
}

/** Determines whether candidate is strictly contained within parent (path containment). */
export function isPathContained(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
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

    // 2. Guard against modified project context / worktreeDirectory
    const modifiedCtx = checkUnmodifiedWorktreeDirectory(top, changeset);
    if (modifiedCtx) return modifiedCtx;

    // 3. Check worktreeDirectory configuration and containment
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
    const containment = checkWorktreeContainment(top, configuredParent);
    if (containment) return containment;

    // 4. Optional task branch check
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
