import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { contextPath } from '../project-context.ts';
// trusted-context.ts, project-setup.ts, and preflight/policy.ts import each other: top-level code here must not call imported functions at module evaluation time.
import { linkedContextSelection } from '../project-setup.ts';

/** The trusted ref: read locally without fetching. Shared by base-context and the preflight policy. */
export const TRUSTED_REF = 'refs/remotes/origin/HEAD';
export const TRUSTED_HINT = 'pass --base <ref> or run `git remote set-head origin --auto`';
export const MAX_CONTEXT_BYTES = 1024 * 1024;

/** Repo-relative, forward-slash path of an absolute path under the repository top-level. */
export const toRepoPath = (top: string, path: string) => relative(resolve(top), path).replaceAll('\\', '/');

/** True when a repo-relative path leaves the repository top-level. */
export const leavesRepo = (repoPath: string) => repoPath === '..' || repoPath.startsWith('../') || isAbsolute(repoPath);

/** Platform-aware path identity: Windows paths compare case-insensitively. */
export const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

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
export function trustedCommit(top: string): string {
  const res = spawnSync('git', ['-C', top, '--literal-pathspecs', 'rev-parse', '--verify', '--quiet', `${TRUSTED_REF}^{commit}`], { encoding: 'utf8' });
  if (res.error) throw new Error(`git rev-parse could not be started: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`trusted ref ${TRUSTED_REF} unavailable; ${TRUSTED_HINT}`);
  const commit = res.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`trusted ref ${TRUSTED_REF} did not resolve to a commit`);
  return commit;
}

/** Reads a regular tracked text file at the trusted commit. Undefined when it is absent there. */
export function trustedFile(top: string, commit: string, repoPath: string): string | undefined {
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

export type TrustedContext = {
  /** Repo-relative path of the context file that holds the settings (AGENTS.md or its linked target). */
  target: string;
  /** Text of that file at the trusted ref; undefined when the file is absent there. */
  text: string | undefined;
};

/**
 * Locates the project context at the trusted ref using the same AGENTS.md / link resolution as base-context.
 * Throws when the trusted ref is unavailable, or when a present file is unreadable, non-regular, oversized,
 * or links outside the repository. An absent file is not an error: `text` is undefined.
 */
export function readTrustedContext(top: string, worktree: string): TrustedContext {
  const commit = trustedCommit(top);
  const agentsRel = toRepoPath(top, join(worktree, 'AGENTS.md'));
  const trustedAgents = trustedFile(top, commit, agentsRel);
  if (trustedAgents === undefined) return { target: agentsRel, text: undefined };
  const linked = linkedContextSelection(trustedAgents);
  if (linked === undefined) return { target: agentsRel, text: trustedAgents };
  const target = toRepoPath(top, contextPath(worktree, linked));
  // Defensive: contextPath already rejects escaping links, so this guard is defense in depth only.
  if (leavesRepo(target)) throw new Error(`linked context target ${target} at trusted ref resolves outside the repository`);
  return { target, text: trustedFile(top, commit, target) };
}
