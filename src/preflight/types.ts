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
  /** Added text and new-side line numbers for this origin; binary/non-text entries are omitted. */
  addedText?: string;
  targetLines?: number[];
  /** False when changed bytes cannot be safely represented as added text. */
  addedTextComplete?: boolean;
  /** Exact old/new commit IDs when this change is a Git gitlink. */
  gitlink?: { oldId?: string; newId?: string; nestedContentDirty?: boolean };
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

/** One item of a `--criteria` file. `done` is the human's checkbox state as recorded in the file. */
export type CriteriaItem = { text: string; done: boolean };

/** A parsed criteria file, or the reason it could not be used (inconclusive). Undefined means no file was supplied. */
export type AcceptanceCriteriaInput = { items: CriteriaItem[] } | { error: string };

/**
 * A justified bypass supplied for a run. `applied` is true only when it changed a block to warn. The entry is
 * recorded evidence of a stated reason; it is never approval.
 */
export type BypassEntry = { check: string; justification: string; applied: boolean };

export type PreflightContext = {
  worktree: string;
  changeset: Changeset;
  task?: string | undefined;
  gitlinkAcknowledgements?: readonly { path: string; oldId?: string; newId: string; justification?: string }[] | undefined;
  trustedPolicyCommit?: string | undefined;
  criteria?: AcceptanceCriteriaInput | undefined;
  /** The `--justify-no-tests` text. The runner applies the bypass after severity; checks only receive it. */
  justifyNoTests?: string | undefined;
};

export type CheckOutcome = {
  status: CheckStatus;
  evidence: string[];
  metrics?: Record<string, number>;
};

/**
 * A pluggable check. Checks report evidence only; they never record approval.
 * Built-in checks carry module-private identity (for example, whether the trusted policy may configure them),
 * so a caller-supplied object cannot opt in by setting a field.
 */
export type PreflightCheck = {
  id: string;
  run(context: PreflightContext): Promise<CheckOutcome> | CheckOutcome;
};

export type CheckResult = { id: string; status: CheckStatus; evidence: string[] };

export type PreflightResult = {
  /** Derived only from check statuses. No marker, stamp, justification, or criteria text sets it. */
  approved: boolean;
  blocking: string[];
  warnings: string[];
  metrics: Record<string, number>;
  checks: CheckResult[];
  /** Present when `--justify-no-tests` was supplied to a run that executed checks. */
  bypass?: BypassEntry[];
};

/** Exit codes: 0 pass, 1 blocked, 2 inconclusive. */
export type PreflightExitCode = 0 | 1 | 2;

export class PreflightToolError extends Error {
  override name = 'PreflightToolError';
}
