import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { contextData, hasContextSection } from '../project-context.ts';
// policy.ts and project-setup.ts import each other: top-level code here must not call imported functions at module evaluation time.
import { locateProjectContext } from '../project-setup.ts';
import { readTrustedContext, toRepoPath, TRUSTED_REF, trustedCommit, TrustedRefMissingError, type TrustedContext } from './trusted-context.ts';
import type { CheckOutcome, CheckStatus, PolicyKey, PreflightCheck } from './types.ts';

/** Severity a configurable check may be set to. A project policy can only move block to warn or warn to block. */
export type CheckSeverity = 'block' | 'warn';
export type CheckSettings = { enabled?: boolean; severity?: CheckSeverity };
export type ForbiddenGlobs = { mode: 'add' | 'replace'; globs: string[] };

/** The marked `preflight` section of project context, as validated. */
export type PreflightPolicy = {
  version: 1;
  checks?: Record<string, CheckSettings>;
  forbiddenGlobs?: ForbiddenGlobs;
  prodGlobs?: string[];
  testGlobs?: string[];
  allowlistPath?: string;
};

/** The resolved allowlist path. Entry format and consumption belong to BH-068. */
export type PolicyAllowlist = { repoPath: string; absolutePath: string; present: boolean };

/** The policy checks run against. Read-only on the check context; only the trusted ref can supply it. */
export type EffectivePolicy = {
  source: 'trusted-ref' | 'none';
  trustedFile?: string | undefined;
  trustedNote?: string | undefined;
  policy?: PreflightPolicy | undefined;
  /** Check ids the policy disables. Disabled checks are skipped and listed in the policy result. */
  disabled: string[];
  /** Severity overrides by check id. */
  severity: Record<string, CheckSeverity>;
  forbiddenGlobs?: ForbiddenGlobs | undefined;
  allowlist?: PolicyAllowlist | undefined;
  /** Recorded keys that no active check consumes yet. */
  inert: PolicyKey[];
  /** Describes a worktree policy that differs from the trusted one. It never takes effect. */
  worktreeDifference?: string | undefined;
};

export const POLICY_CHECK_ID = 'policy';
/** Checks a project policy can never disable, downgrade, or name as configurable. */
export const FIXED_CHECK_IDS: readonly string[] = ['changeset', 'base-context', 'policy', 'secret-scan', 'worktree-boundary'];

/** Suggested policy offered by harness:setup. Code constant only; global project defaults never carry it. */
export const DEFAULT_PREFLIGHT_POLICY: PreflightPolicy = { version: 1, checks: { 'path-policy': { enabled: true, severity: 'block' } } };

export const PREFLIGHT_POLICY_INSTRUCTIONS: readonly string[] = [
  'This preflight policy is evidence configuration for harness:preflight. It is not approval to implement, commit, or publish.',
  'Preflight reads the effective policy from the trusted ref refs/remotes/origin/HEAD. Edits here take effect only after they reach origin/HEAD.',
  'Fixed checks (changeset, base-context, policy, secret-scan, worktree-boundary) cannot be disabled or downgraded.',
];

const TOP_KEYS = ['version', 'checks', 'forbiddenGlobs', 'prodGlobs', 'testGlobs', 'allowlistPath'] as const;
const CHECK_KEYS = ['enabled', 'severity'] as const;
const FORBIDDEN_KEYS = ['mode', 'globs'] as const;
const POLICY_KEYS: readonly PolicyKey[] = ['forbiddenGlobs', 'prodGlobs', 'testGlobs', 'allowlistPath'];
const INERT_NOTES: Record<PolicyKey, string> = { forbiddenGlobs: 'its check is disabled or not installed', prodGlobs: 'BH-070', testGlobs: 'BH-070', allowlistPath: 'BH-068' };
const MAX_GLOBS = 200;
const MAX_GLOB_CHARS = 256;
const MAX_ALLOWLIST_BYTES = 1024 * 1024;

/** A rejected policy. The message names the file and the JSON path. */
export class PreflightPolicyError extends Error {
  override name = 'PreflightPolicyError';
}

type Bad = (detail: string) => PreflightPolicyError;
export type PolicyFileOptions = {
  /** Check ids the project policy may name (from the registered checks marked configurable). */
  configurableIds: readonly string[];
  /** Repo-relative file the section came from, used in messages. */
  file: string;
  /** Repo-relative context file that holds the section; an allowlist may not name it. */
  contextFile?: string | undefined;
  /** Platform for path rules (for example the `.git` name check). Defaults to the running platform; tests force win32. */
  platform?: NodeJS.Platform | undefined;
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const describe = (value: unknown): string => (value === undefined ? 'missing' : JSON.stringify(value) ?? String(value));
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sameName = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Repo-relative ids of checks marked configurable. */
export function configurableCheckIds(checks: readonly PreflightCheck[]): string[] {
  return checks.filter((check) => check.policy?.configurable === true).map((check) => check.id);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], where: string | undefined, bad: Bad): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw bad(`unknown key "${unknown}"${where ? ` at ${where}` : ''}; allowed: ${allowed.join(', ')}.`);
}

function validateGlob(glob: unknown, at: string, bad: Bad): void {
  if (typeof glob !== 'string' || glob === '') throw bad(`${at} must be a non-empty string.`);
  if (glob.length > MAX_GLOB_CHARS) throw bad(`${at} is longer than ${MAX_GLOB_CHARS} characters.`);
  if (/[\0\r\n]/.test(glob)) throw bad(`${at} must not contain NUL, CR, or LF.`);
  if (glob.includes('\\')) throw bad(`${at} ${JSON.stringify(glob)} must use forward slashes only.`);
  if (glob.startsWith('/')) throw bad(`${at} ${JSON.stringify(glob)} must not start with "/"; globs are relative to the repository.`);
  if (/^[a-zA-Z]:/.test(glob)) throw bad(`${at} ${JSON.stringify(glob)} must not start with a drive letter.`);
  if (glob.split('/').includes('..')) throw bad(`${at} ${JSON.stringify(glob)} has a ".." segment; globs must stay inside the repository.`);
  const unsupported = /[[\]{}!]/.exec(glob);
  if (unsupported) throw bad(`${at} ${JSON.stringify(glob)} uses unsupported syntax "${unsupported[0]}"; use *, ** or ? only.`);
}

function validateGlobs(value: unknown, path: string, bad: Bad): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_GLOBS) {
    throw bad(`${path} must list 1 to ${MAX_GLOBS} globs (got ${Array.isArray(value) ? `${value.length} entries` : describe(value)}).`);
  }
  const seen = new Set<string>();
  value.forEach((glob: unknown, index: number) => {
    const at = `${path}[${index}]`;
    validateGlob(glob, at, bad);
    const key = (glob as string).toLowerCase();
    if (seen.has(key)) throw bad(`${at} ${JSON.stringify(glob)} duplicates an earlier glob (matching is case-insensitive).`);
    seen.add(key);
  });
}

function validateChecks(value: unknown, configurableIds: readonly string[], bad: Bad): void {
  if (!isObject(value)) throw bad(`checks must be an object keyed by check id (got ${describe(value)}).`);
  const configurable = configurableIds.length ? configurableIds.join(', ') : 'none';
  for (const [id, settings] of Object.entries(value)) {
    const at = `checks.${id}`;
    if (FIXED_CHECK_IDS.includes(id)) throw bad(`${at} is not configurable: ${id} is a fixed check and cannot be disabled or downgraded. Configurable checks: ${configurable}.`);
    if (!configurableIds.includes(id)) throw bad(`${at} is not a known check id. Configurable checks: ${configurable}.`);
    if (!isObject(settings)) throw bad(`${at} must be an object with optional enabled and severity (got ${describe(settings)}).`);
    rejectUnknownKeys(settings, CHECK_KEYS, at, bad);
    if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean') throw bad(`${at}.enabled must be true or false (got ${describe(settings.enabled)}).`);
    if (settings.severity !== undefined && settings.severity !== 'block' && settings.severity !== 'warn') throw bad(`${at}.severity must be "block" or "warn" (got ${describe(settings.severity)}).`);
  }
}

function validateForbiddenGlobs(value: unknown, bad: Bad): void {
  if (!isObject(value)) throw bad(`forbiddenGlobs must be an object with mode and globs (got ${describe(value)}).`);
  rejectUnknownKeys(value, FORBIDDEN_KEYS, 'forbiddenGlobs', bad);
  if (value.mode !== 'add' && value.mode !== 'replace') throw bad(`forbiddenGlobs.mode must be "add" or "replace" (got ${describe(value.mode)}).`);
  validateGlobs(value.globs, 'forbiddenGlobs.globs', bad);
}

function validateAllowlistPath(value: unknown, contextFile: string | undefined, bad: Bad, platform: NodeJS.Platform): void {
  if (typeof value !== 'string' || value === '') throw bad('allowlistPath must be a non-empty repo-relative string.');
  if (/[\0\r\n]/.test(value)) throw bad('allowlistPath must not contain NUL, CR, or LF.');
  const shown = JSON.stringify(value);
  if (value.includes('\\')) throw bad(`allowlistPath ${shown} must use forward slashes.`);
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) throw bad(`allowlistPath ${shown} is absolute; use a path relative to the repository root.`);
  const segments = value.split('/');
  if (segments.includes('..')) throw bad(`allowlistPath ${shown} leaves the project; use a path inside the repository.`);
  if (segments.some((segment) => segment === '' || segment === '.')) throw bad(`allowlistPath ${shown} has an empty or "." segment.`);
  // A colon in any segment is refused on every platform: it is NTFS stream syntax (name:stream) or drive syntax.
  if (segments.some((segment) => segment.includes(':'))) throw bad(`allowlistPath ${shown} has a ":" in a segment; NTFS streams and drive syntax are refused.`);
  // On win32 Windows drops trailing dots and spaces from names, so ".git." and ".git " name the .git directory.
  const comparable = (segment: string) => (platform === 'win32' ? segment.replace(/[. ]+$/, '') : segment).toLowerCase();
  if (segments.some((segment) => comparable(segment) === '.git')) throw bad(`allowlistPath ${shown} is inside .git/; use a path outside it.`);
  if (contextFile !== undefined && sameName(value, contextFile)) throw bad(`allowlistPath ${shown} is the context file itself; use a separate file.`);
}

/**
 * Validates a parsed preflight section. Unknown keys are rejected at every level, and each error
 * names the file and JSON path. Returns the value unchanged once it is valid.
 */
export function validatePreflightPolicy(value: unknown, options: PolicyFileOptions): PreflightPolicy {
  const { configurableIds, file } = options;
  const bad: Bad = (detail) => new PreflightPolicyError(`${file} preflight policy: ${detail}`);
  if (!isObject(value)) throw bad('the preflight section must hold a JSON object.');
  rejectUnknownKeys(value, TOP_KEYS, undefined, bad);
  if (value.version !== 1) throw bad(`version must be 1 (got ${describe(value.version)}).`);
  if (value.checks !== undefined) validateChecks(value.checks, configurableIds, bad);
  if (value.forbiddenGlobs !== undefined) validateForbiddenGlobs(value.forbiddenGlobs, bad);
  const hasProd = value.prodGlobs !== undefined;
  const hasTest = value.testGlobs !== undefined;
  if (hasProd !== hasTest) throw bad(`${hasProd ? 'prodGlobs is set but testGlobs is missing' : 'testGlobs is set but prodGlobs is missing'}; set both or neither.`);
  if (hasProd) {
    validateGlobs(value.prodGlobs, 'prodGlobs', bad);
    validateGlobs(value.testGlobs, 'testGlobs', bad);
  }
  if (value.allowlistPath !== undefined) validateAllowlistPath(value.allowlistPath, options.contextFile, bad, options.platform ?? process.platform);
  return value as PreflightPolicy;
}

/** A section read from one context file: absent, or present with its raw JSON and validated policy. */
export type PreflightSection = { present: boolean; raw?: unknown; policy?: PreflightPolicy | undefined };

/**
 * Reads the marked preflight section of a context file. Absent is `present: false`. Malformed or invalid
 * sections throw a {@link PreflightPolicyError} that names the file and the problem.
 */
export function readPreflightSection(text: string | undefined, options: PolicyFileOptions): PreflightSection {
  let raw: unknown;
  try {
    if (!hasContextSection(text, 'preflight')) return { present: false };
    raw = contextData(text, 'preflight');
  } catch (error) {
    const detail = messageOf(error).replace(/\s*No files changed\.$/, '');
    throw new PreflightPolicyError(`${options.file} preflight policy: ${detail} Fix the fenced JSON in the preflight section.`);
  }
  if (raw === undefined) throw new PreflightPolicyError(`${options.file} preflight policy: the preflight section has no fenced JSON settings.`);
  return { present: true, raw, policy: validatePreflightPolicy(raw, options) };
}

/** True when `child` is inside `parent` on the given platform. Windows comparisons are case-insensitive. */
export function isInsideRealPath(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const path = platform === 'win32' ? win32 : posix;
  const fold = (value: string) => (platform === 'win32' ? value.toLowerCase() : value);
  const rel = path.relative(fold(path.resolve(parent)), fold(path.resolve(child)));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Resolves an allowlist path inside the worktree. Every component is lstat-ed; symlinks and junctions
 * are refused, and so is a file that is not regular, over 1 MiB, or outside the worktree after realpath.
 * A missing file is evidence (`present: false`), not an error.
 */
export function resolveAllowlist(worktree: string, repoPath: string): PolicyAllowlist {
  const segments = repoPath.split('/');
  const absolutePath = join(worktree, ...segments);
  let current = worktree;
  for (const [index, segment] of segments.entries()) {
    const next = join(current, segment);
    const shown = segments.slice(0, index + 1).join('/');
    let entry: Stats | undefined;
    try {
      entry = lstatSync(next, { throwIfNoEntry: false });
    } catch (error) {
      throw new PreflightPolicyError(`allowlistPath "${repoPath}" could not be inspected at ${shown}: ${messageOf(error)}`);
    }
    if (!entry) return { repoPath, absolutePath, present: false };
    if (entry.isSymbolicLink()) throw new PreflightPolicyError(`allowlistPath "${repoPath}" passes through a symlink or junction at ${shown}; links are refused.`);
    if (index < segments.length - 1) {
      if (!entry.isDirectory()) throw new PreflightPolicyError(`allowlistPath "${repoPath}": ${shown} is not a directory.`);
      current = next;
      continue;
    }
    if (!entry.isFile()) throw new PreflightPolicyError(`allowlistPath "${repoPath}" is not a regular file.`);
    if (entry.size > MAX_ALLOWLIST_BYTES) throw new PreflightPolicyError(`allowlistPath "${repoPath}" exceeds 1 MiB.`);
  }
  const real = realpathSync(absolutePath);
  if (!isInsideRealPath(real, realpathSync(worktree))) throw new PreflightPolicyError(`allowlistPath "${repoPath}" resolves outside the worktree.`);
  return { repoPath, absolutePath, present: true };
}

/**
 * True when the trusted ref resolves to a commit. Only a ref Git confirms is absent returns false. Any other
 * failure (Git cannot run, a corrupt repository, a ref whose commit is missing) is rethrown as a load error.
 */
function trustedRefAvailable(top: string): boolean {
  try {
    trustedCommit(top);
    return true;
  } catch (error) {
    if (error instanceof TrustedRefMissingError) return false;
    throw error;
  }
}

type LocalPolicy = { present: boolean; raw?: unknown; invalid?: string };

function describeDifference(file: string, local: LocalPolicy, trusted: PreflightSection): string | undefined {
  if (local.invalid !== undefined) return `worktree preflight policy (${file}) is invalid and does not apply: ${local.invalid}. Worktree changes take effect only after they reach origin/HEAD.`;
  let kind: 'added' | 'removed' | 'edited' | undefined;
  if (local.present && trusted.present) kind = isDeepStrictEqual(local.raw, trusted.raw) ? undefined : 'edited';
  else if (local.present) kind = 'added';
  else if (trusted.present) kind = 'removed';
  return kind === undefined ? undefined : `worktree preflight policy (${file}) differs from trusted ref ${TRUSTED_REF} (${kind}); the change takes effect only after it reaches origin/HEAD.`;
}

export type PolicyLoadInput = { worktree: string; top: string; checks: readonly PreflightCheck[] };

/**
 * Loads the effective policy from the trusted ref, the only source that takes effect. The worktree copy is
 * compared and reported, never applied. Throws when the policy cannot be loaded (a {@link PreflightPolicyError}, or
 * a Git failure from the trusted ref); the runner then reports every check as inconclusive.
 */
export function loadEffectivePolicy({ worktree, top, checks }: PolicyLoadInput): EffectivePolicy {
  const configurableIds = configurableCheckIds(checks);

  let located: { target: string; original: string | undefined };
  try {
    located = locateProjectContext(worktree);
  } catch (error) {
    throw new PreflightPolicyError(`project context could not be read: ${messageOf(error)}`);
  }
  const localFile = toRepoPath(top, located.target);
  let local: LocalPolicy;
  try {
    const section = readPreflightSection(located.original, { configurableIds, file: localFile, contextFile: localFile });
    local = { present: section.present, ...(section.present ? { raw: section.raw } : {}) };
  } catch (error) {
    local = { present: true, invalid: messageOf(error) };
  }

  if (!trustedRefAvailable(top)) {
    if (local.present) throw new PreflightPolicyError(`trusted ref ${TRUSTED_REF} is unavailable, and the worktree records a preflight policy that cannot be verified against it; run \`git remote set-head origin --auto\`.`);
    return {
      source: 'none',
      trustedNote: `Policy source: none. Trusted ref ${TRUSTED_REF} is unavailable and the worktree records no preflight policy; built-in check behavior applies (base-context reports the unavailable ref).`,
      disabled: [],
      severity: {},
      inert: [],
    };
  }

  let trustedContext: TrustedContext;
  try {
    trustedContext = readTrustedContext(top, worktree);
  } catch (error) {
    throw new PreflightPolicyError(`trusted project context could not be read at ${TRUSTED_REF}: ${messageOf(error)}`);
  }
  const trustedSection: PreflightSection = trustedContext.text === undefined
    ? { present: false }
    : readPreflightSection(trustedContext.text, { configurableIds, file: trustedContext.target, contextFile: trustedContext.target });
  const worktreeDifference = describeDifference(localFile, local, trustedSection);

  const policy = trustedSection.policy;
  if (!trustedSection.present || policy === undefined) {
    return { source: 'none', disabled: [], severity: {}, inert: [], ...(worktreeDifference ? { worktreeDifference } : {}) };
  }

  const overrides = policy.checks ?? {};
  const disabled = Object.entries(overrides).filter(([, settings]) => settings.enabled === false).map(([id]) => id).sort();
  const severity: Record<string, CheckSeverity> = {};
  for (const [id, settings] of Object.entries(overrides)) if (settings.severity) severity[id] = settings.severity;
  const consumed = new Set<PolicyKey>(checks.filter((check) => !disabled.includes(check.id)).flatMap((check) => check.policy?.consumes ?? []));
  const inert = POLICY_KEYS.filter((key) => policy[key] !== undefined && !consumed.has(key));
  const allowlist = policy.allowlistPath === undefined ? undefined : resolveAllowlist(worktree, policy.allowlistPath);
  return {
    source: 'trusted-ref',
    trustedFile: trustedContext.target,
    policy,
    disabled,
    severity,
    ...(policy.forbiddenGlobs ? { forbiddenGlobs: policy.forbiddenGlobs } : {}),
    ...(allowlist ? { allowlist } : {}),
    inert,
    ...(worktreeDifference ? { worktreeDifference } : {}),
  };
}

/** The built-in `policy` result: source, disabled checks, overrides, worktree differences, and keys recorded but not enforced. */
export function policyOutcome(effective: EffectivePolicy): CheckOutcome {
  const evidence: string[] = [];
  let status: CheckStatus = 'pass';
  if (effective.source === 'trusted-ref') evidence.push(`Policy source: ${effective.trustedFile} at trusted ref ${TRUSTED_REF}.`);
  else evidence.push(effective.trustedNote ?? `Policy source: none. No preflight policy at trusted ref ${TRUSTED_REF}; built-in check behavior applies.`);
  evidence.push(effective.disabled.length ? `Disabled by project policy (trusted ref); skipped, not run: ${effective.disabled.join(', ')}.` : 'Disabled checks: none.');
  for (const [id, severity] of Object.entries(effective.severity)) evidence.push(`Severity set by project policy (trusted ref): ${id}=${severity}.`);
  if (effective.forbiddenGlobs) evidence.push(`forbiddenGlobs (${effective.forbiddenGlobs.mode}) from project policy (trusted ref): ${effective.forbiddenGlobs.globs.length} glob(s).`);
  if (effective.allowlist) {
    evidence.push(effective.allowlist.present ? `Allowlist ${effective.allowlist.repoPath} resolved in the worktree: present.` : `Allowlist ${effective.allowlist.repoPath}: not present; no exceptions apply.`);
  }
  if (effective.worktreeDifference) {
    status = 'warn';
    evidence.push(effective.worktreeDifference);
  }
  if (effective.inert.length) {
    status = 'warn';
    evidence.push(`Recorded but not enforced by any installed check yet: ${effective.inert.map((key) => `${key} (${INERT_NOTES[key]})`).join(', ')}.`);
  }
  return { status, evidence };
}

/**
 * Applies a trusted-ref severity override after a check runs: block to warn, or warn to block. Pass and
 * inconclusive outcomes are never changed.
 */
export function applySeverity(outcome: CheckOutcome, override: CheckSeverity | undefined): CheckOutcome {
  if (override === 'warn' && outcome.status === 'block') return { ...outcome, status: 'warn', evidence: [...outcome.evidence, 'severity block→warn by project policy (trusted ref)'] };
  if (override === 'block' && outcome.status === 'warn') return { ...outcome, status: 'block', evidence: [...outcome.evidence, 'severity warn→block by project policy (trusted ref)'] };
  return outcome;
}
