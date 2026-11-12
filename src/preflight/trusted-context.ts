import { spawnSync } from 'node:child_process';

/** The trusted ref: read locally without fetching. Shared by base-context, worktree-boundary, and the preflight policy. */
export const TRUSTED_REF = 'refs/remotes/origin/HEAD';
export const TRUSTED_HINT = 'pass --base <ref> or run `git remote set-head origin --auto`';

/** Thrown only when Git confirms the trusted ref is absent. Every other failure is a plain Error. */
export class TrustedRefMissingError extends Error {
  override name = 'TrustedRefMissingError';
}

/** The first stderr line of a failed Git call, as `: line`, or empty. Shared so every trusted read formats Git failures alike. */
export const firstStderrLine = (stderr: string): string => {
  const line = stderr.trim().split(/\r?\n/)[0] ?? '';
  return line ? `: ${line}` : '';
};

/**
 * Resolves the trusted ref to a commit locally. Never fetches. A ref Git confirms is absent throws
 * {@link TrustedRefMissingError}, with `hint` as the recovery text. Any other failure (Git cannot run, a corrupt
 * repository, a ref whose commit is missing or unreadable) throws a plain Error that names the Git failure.
 */
export function trustedCommit(top: string, hint = TRUSTED_HINT): string {
  // `show-ref --verify --quiet` exits 1 only when the ref cannot be read (absent, or a symbolic ref whose
  // target is absent). It does not peel, so it does not fail on a missing commit object (that is checked below).
  const present = spawnSync('git', ['-C', top, '--literal-pathspecs', 'show-ref', '--verify', '--quiet', TRUSTED_REF], { encoding: 'utf8' });
  if (present.error) throw new Error(`git show-ref could not be started: ${present.error.message}`);
  if (present.status === 1) throw new TrustedRefMissingError(`trusted ref ${TRUSTED_REF} unavailable; ${hint}`);
  if (present.status !== 0) throw new Error(`git show-ref ${TRUSTED_REF} failed (exit ${present.status})${firstStderrLine(present.stderr)}`);
  const res = spawnSync('git', ['-C', top, '--literal-pathspecs', 'rev-parse', '--verify', `${TRUSTED_REF}^{commit}`], { encoding: 'utf8' });
  if (res.error) throw new Error(`git rev-parse could not be started: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`trusted ref ${TRUSTED_REF} does not resolve to a commit (git rev-parse exit ${res.status})${firstStderrLine(res.stderr)}`);
  const commit = res.stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error(`trusted ref ${TRUSTED_REF} did not resolve to a commit`);
  return commit;
}
