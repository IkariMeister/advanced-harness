import type { EffectivePolicy } from './policy.ts';

/** Status of one preflight check. `inconclusive` means a tool or git call failed; it never counts as a pass. */
export type CheckStatus = 'pass' | 'warn' | 'block' | 'inconclusive';

/** Policy keys a check can consume. Keys no installed check consumes are reported as recorded but not enforced. */
export type PolicyKey = 'forbiddenGlobs' | 'prodGlobs' | 'testGlobs' | 'allowlistPath';

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
  /** Effective policy read from the trusted ref. Read-only: worktree edits to the policy never reach checks. */
  readonly policy: EffectivePolicy;
};

export type CheckOutcome = {
  status: CheckStatus;
  evidence: string[];
  metrics?: Record<string, number>;
};

/**
 * A pluggable check. Checks report evidence only; they never record approval.
 * `policy.configurable` marks ids a project policy may name (enable/disable, severity).
 * `policy.consumes` lists the policy keys the check enforces.
 */
export type PreflightCheck = {
  id: string;
  policy?: { configurable?: boolean; consumes?: readonly PolicyKey[] };
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
