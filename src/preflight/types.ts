/** Status of one preflight check. `inconclusive` means a tool or git call failed; it never counts as a pass. */
export type CheckStatus = 'pass' | 'warn' | 'block' | 'inconclusive';

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export type ChangeOrigin = 'committed' | 'staged' | 'unstaged' | 'untracked';

/**
 * One changed path. A deleted path has `content: undefined` and no `kind` (absent),
 * which is distinct from a present zero-byte file (`kind: 'file'`, `content.length === 0`).
 * A symlink's content is its link target; other non-regular entries have no content.
 * Contents are read in full; size limits belong to the checks that consume them.
 */
export type ChangeEntry = {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  origin: ChangeOrigin;
  kind?: 'file' | 'symlink' | 'submodule' | 'other';
  content: Buffer | undefined;
};

export type BaseSource = 'option' | 'project-context';

export type Changeset = {
  /** Absolute repository top-level (`git rev-parse --show-toplevel`); repo-relative paths are relative to it. */
  top: string;
  base: string;
  baseSource: BaseSource;
  mergeBase: string;
  head: string;
  entries: ChangeEntry[];
};

export type PreflightContext = {
  worktree: string;
  changeset: Changeset;
};

export type CheckOutcome = {
  status: CheckStatus;
  evidence: string[];
  metrics?: Record<string, number>;
};

/** A pluggable check. Checks report evidence only; they never record approval. */
export type PreflightCheck = {
  id: string;
  run(context: PreflightContext): Promise<CheckOutcome> | CheckOutcome;
};

export type CheckResult = { id: string; status: CheckStatus; evidence: string[] };

export type PreflightResult = {
  approved: boolean;
  blocking: string[];
  warnings: string[];
  metrics: Record<string, number>;
  checks: CheckResult[];
};

/** Exit codes: 0 pass, 1 blocked, 2 inconclusive. */
export type PreflightExitCode = 0 | 1 | 2;

export class PreflightToolError extends Error {
  override name = 'PreflightToolError';
}
