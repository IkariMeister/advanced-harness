import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseTree, type Node } from 'jsonc-parser';
import { normalizeExceptionPath, validateSecretExceptions, type SecretException } from './exceptions.ts';
import { DEFAULT_SENSITIVE_PATH_GLOBS, markTrustedPolicyDependent, validateSensitivePathGlobs } from './path-policy.ts';
import { firstStderrLine, TRUSTED_REF, TrustedRefMissingError, trustedCommit } from './trusted-context.ts';
import type { CheckStatus, PreflightCheck } from './types.ts';

const CONFIG_PATH = '.harness/preflight.json';
const ALLOWLIST_PATH = '.harness/preflight-allowlist.json';
const MAX_POLICY_BYTES = 1024 * 1024;
const POLICY_PATHS = [CONFIG_PATH, ALLOWLIST_PATH] as const;
const CONFIG_KEYS = ['version', 'checks', 'forbiddenPathGlobs', 'prodGlobs', 'testGlobs', 'gitlinkAcknowledgements'] as const;

/**
 * Built-in checks the policy can never disable, downgrade, or name as configurable. `acceptance-criteria` is fixed
 * because its input is per-run task evidence from `--criteria`, not repository policy a branch could reshape.
 */
export const FIXED_CHECK_IDS = ['changeset', 'base-context', 'policy-integrity', 'policy', 'secret-scan', 'worktree-boundary', 'acceptance-criteria'] as const;
/** Built-in checks the trusted policy may enable, disable, or re-severity. */
export const CONFIGURABLE_CHECK_IDS = ['path-policy', 'test-change'] as const;
export type ConfigurableCheckId = typeof CONFIGURABLE_CHECK_IDS[number];
export type Severity = 'block' | 'warn';
export type ForbiddenGlobMode = 'add' | 'replace' | 'default';
export type GitlinkAcknowledgement = { path: string; oldId?: string; newId: string; justification: string };

/** A validated `.harness/preflight.json`, normalized: an array `forbiddenPathGlobs` becomes `mode: 'replace'`. */
export type PreflightConfig = {
  version: 1;
  checks: Partial<Record<ConfigurableCheckId, { enabled?: boolean; severity?: Severity }>>;
  forbiddenPathGlobs?: { mode: 'add' | 'replace'; globs: readonly string[] };
  /** Enforced by the `test-change` check (BH-070). Given together or not at all. */
  prodGlobs?: readonly string[];
  testGlobs?: readonly string[];
  gitlinkAcknowledgements: GitlinkAcknowledgement[];
};

export type PolicySource = { path: string; ref: string; commit: string; present: boolean };

export type ProjectPreflightPolicy = {
  trustedCommit: string;
  source: PolicySource;
  /** Forbidden-path globs as recorded in the trusted file, or as supplied programmatically. Undefined when none. */
  sensitivePathGlobs?: readonly string[];
  forbiddenGlobMode: ForbiddenGlobMode;
  /** Configurable built-in checks disabled by the trusted policy. */
  disabled: string[];
  /** Configurable built-in checks the trusted policy sets to `enabled: true`. */
  enabled: string[];
  /** Severity overrides for configurable built-in checks, keyed by check id. */
  severity: Record<string, Severity>;
  prodGlobs?: readonly string[];
  testGlobs?: readonly string[];
  secretExceptions: SecretException[];
  gitlinkAcknowledgements: GitlinkAcknowledgement[];
  /** Values replaced by programmatic options, for example "forbiddenPathGlobs" or "secretExceptions". */
  overridden: string[];
};

type PolicyOverrides = { forbiddenPathGlobs?: boolean; secretExceptions?: boolean };

export class PreflightPolicyError extends Error {
  override name = 'PreflightPolicyError';
  readonly code: 'base-unavailable' | 'git-failure' | 'invalid';
  constructor(code: 'base-unavailable' | 'git-failure' | 'invalid', message: string) { super(message); this.code = code; }
}

/** Every configuration error names the file and says how to correct it. */
function invalid(message: string): never {
  throw new Error(`Invalid ${CONFIG_PATH}: ${message} Correct ${CONFIG_PATH}; see the Preflight policy section of the Advanced Harness configuration guide.`);
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The first key that appears twice in one object, or undefined. JSON.parse keeps only the last value, so duplicates are refused. */
export function duplicateKey(text: string): string | undefined {
  let found: string | undefined;
  const visit = (node: Node): void => {
    if (found !== undefined) return;
    if (node.type === 'object') {
      const seen = new Set<string>();
      for (const property of node.children ?? []) {
        const key = String(property.children?.[0]?.value);
        if (seen.has(key)) { found = key; return; }
        seen.add(key);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  const tree = parseTree(text);
  if (tree) visit(tree);
  return found;
}

/**
 * Reads a blob or tree listing from the trusted commit. A Git failure is a `git-failure` (the ref could not be read),
 * not an invalid policy; `path` names the file the call was reading.
 */
function gitBuffer(root: string, args: string[], path: string, maxBuffer = MAX_POLICY_BYTES + 1): Buffer {
  const result = spawnSync('git', ['-C', root, '--literal-pathspecs', ...args], { maxBuffer });
  // Output beyond the limit stops the call; that is an oversized file, not a Git failure.
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOBUFS') throw new Error(`${path}: Trusted preflight policy files exceed 1 MiB.`);
  if (result.error || result.status !== 0) {
    const detail = result.error ? `: ${result.error.message}` : firstStderrLine(result.stderr.toString('utf8'));
    throw new PreflightPolicyError('git-failure', `${path}: git ${args[0]} failed${detail}`);
  }
  return result.stdout;
}

function resolveCommit(root: string, baseRef: string): string {
  if (baseRef === TRUSTED_REF) {
    try { return trustedCommit(root); }
    catch (error) {
      if (error instanceof TrustedRefMissingError) throw new PreflightPolicyError('base-unavailable', 'Trusted preflight policy base ref could not be resolved.');
      throw new PreflightPolicyError('git-failure', error instanceof Error ? error.message : String(error));
    }
  }
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`], { encoding: 'utf8', maxBuffer: 32 * 1024 });
  if (result.error || result.status !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(result.stdout.trim())) throw new PreflightPolicyError('base-unavailable', 'Trusted preflight policy base ref could not be resolved.');
  return result.stdout.trim();
}

/** Reads a regular UTF-8 file from the trusted commit. Every error starts with `path`, the file it concerns. */
function readTrustedFile(root: string, commit: string, path: string): string | undefined {
  const listing = gitBuffer(root, ['ls-tree', '-z', commit, '--', path], path).toString('utf8');
  if (!listing) return undefined;
  const record = listing.split('\0')[0] ?? '';
  const tab = record.indexOf('\t');
  if (tab < 0 || record.slice(tab + 1) !== path) throw new Error(`${path}: Trusted preflight policy tree entry was invalid.`);
  const [mode, type, object] = record.slice(0, tab).split(' ');
  if (type !== 'blob' || !['100644', '100755'].includes(mode ?? '') || !object) throw new Error(`${path}: Trusted preflight policy files must be regular files.`);
  const bytes = gitBuffer(root, ['cat-file', 'blob', object], path);
  if (bytes.length > MAX_POLICY_BYTES) throw new Error(`${path}: Trusted preflight policy files exceed 1 MiB.`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error(`${path}: Trusted preflight policy files must be UTF-8 JSON.`); }
}

function parseJson(path: string, value: string | undefined): unknown | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error(`${path}: Trusted preflight policy file contains invalid JSON.`); }
  const duplicate = duplicateKey(value);
  if (duplicate !== undefined) throw new Error(`${path}: duplicate key ${JSON.stringify(duplicate)}; keep one value and remove the other.`);
  return parsed;
}

/** Allowlist errors name `.harness/preflight-allowlist.json`, as configuration errors name `.harness/preflight.json`. */
function allowlistExceptions(value: unknown): SecretException[] {
  try { return validateExceptions(value); }
  catch (error) { throw new Error(`${ALLOWLIST_PATH}: ${error instanceof Error ? error.message : String(error)}`); }
}

function validateExceptions(value: unknown): SecretException[] {
  if (!Array.isArray(value)) throw new Error('Secret allowlist must be a JSON array.');
  const entries = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Secret allowlist entries require path, rule, and justification strings.');
    const candidate = item as Record<string, unknown>;
    if (Object.keys(candidate).some(key => !['path', 'rule', 'justification', 'line', 'origin'].includes(key))) throw new Error('Secret allowlist entry contains an unknown setting.');
    return candidate as unknown as SecretException;
  });
  validateSecretExceptions(entries);
  return entries.map(entry => ({ ...entry, path: normalizeExceptionPath(entry.path), rule: entry.rule.trim(), justification: entry.justification.trim() }));
}

function validateGitlinkAcknowledgements(value: unknown): GitlinkAcknowledgement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('gitlinkAcknowledgements must be a JSON array.');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Gitlink acknowledgement entries must be objects.');
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).some(key => !['path', 'oldId', 'newId', 'justification'].includes(key)) || typeof entry.path !== 'string' || !entry.path.trim() || typeof entry.newId !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(entry.newId) || (entry.oldId !== undefined && (typeof entry.oldId !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(entry.oldId))) || typeof entry.justification !== 'string' || !entry.justification.trim()) throw new Error('Gitlink acknowledgements require an exact path, newId, optional oldId, and nonblank justification.');
    const path = entry.path.replaceAll('\\', '/').replace(/^\.\//, '');
    if (path !== entry.path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Gitlink acknowledgement path must be normalized and repository-relative.');
    return { path, ...(entry.oldId === undefined ? {} : { oldId: (entry.oldId as string).toLowerCase() }), newId: entry.newId.toLowerCase(), justification: entry.justification.trim() };
  });
}

function parseConfigText(text: string): unknown {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { return invalid('the file is not valid JSON.'); }
  const duplicate = duplicateKey(text);
  if (duplicate !== undefined) invalid(`duplicate key ${JSON.stringify(duplicate)}; keep one value and remove the other.`);
  return value;
}

function globs(name: string, value: unknown): readonly string[] {
  try { validateSensitivePathGlobs(value); return value; }
  catch { return invalid(`${name} must be an array of safe repository-relative glob strings (no absolute paths, drive letters, or ".." segments; at most 300 characters each).`); }
}

function acknowledgements(value: unknown): GitlinkAcknowledgement[] {
  try { return validateGitlinkAcknowledgements(value); }
  catch (error) { return invalid(error instanceof Error ? error.message : 'gitlinkAcknowledgements is invalid.'); }
}

/**
 * Validates `.harness/preflight.json` text. Shared by the trusted loader and setup, so both accept the same
 * files. Unknown keys are rejected at every level; errors name the file and the correction.
 */
export function validatePreflightConfig(text: string): PreflightConfig {
  const fields = parseConfigText(text);
  if (!isObject(fields)) invalid('the top level must be a JSON object.');
  for (const key of Object.keys(fields)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) invalid(`unknown top-level setting ${JSON.stringify(key)}; remove it or correct its name (allowed: ${CONFIG_KEYS.join(', ')}).`);
  }
  if (fields.version !== undefined && fields.version !== 1) invalid('version must be 1, or omitted.');

  const checks: PreflightConfig['checks'] = {};
  if (fields.checks !== undefined) {
    const configured = fields.checks;
    if (!isObject(configured)) invalid('checks must be a JSON object keyed by configurable check ID.');
    for (const [id, entry] of Object.entries(configured)) {
      if ((FIXED_CHECK_IDS as readonly string[]).includes(id)) invalid(`checks.${id} is a fixed check and cannot be configured. Configurable checks: ${CONFIGURABLE_CHECK_IDS.join(', ')}. Remove that entry.`);
      if (!(CONFIGURABLE_CHECK_IDS as readonly string[]).includes(id)) invalid(`checks.${id} is not a known check. Configurable checks: ${CONFIGURABLE_CHECK_IDS.join(', ')}. Remove or correct that entry.`);
      if (!isObject(entry)) invalid(`checks.${id} must be a JSON object with optional enabled and severity settings.`);
      for (const key of Object.keys(entry)) {
        if (!['enabled', 'severity'].includes(key)) invalid(`checks.${id} has unknown setting ${JSON.stringify(key)}. Allowed: enabled, severity.`);
      }
      const setting: { enabled?: boolean; severity?: Severity } = {};
      const enabled = entry.enabled;
      if (enabled !== undefined) {
        if (typeof enabled !== 'boolean') invalid(`checks.${id}.enabled must be true or false.`);
        setting.enabled = enabled;
      }
      const severity = entry.severity;
      if (severity !== undefined) {
        if (severity !== 'block' && severity !== 'warn') invalid(`checks.${id}.severity must be "block" or "warn".`);
        setting.severity = severity;
      }
      checks[id as ConfigurableCheckId] = setting;
    }
  }

  let forbiddenPathGlobs: PreflightConfig['forbiddenPathGlobs'];
  const forbidden = fields.forbiddenPathGlobs;
  if (forbidden !== undefined) {
    if (Array.isArray(forbidden)) {
      forbiddenPathGlobs = { mode: 'replace', globs: globs('forbiddenPathGlobs', forbidden) };
    } else if (isObject(forbidden)) {
      for (const key of Object.keys(forbidden)) {
        if (!['mode', 'globs'].includes(key)) invalid(`forbiddenPathGlobs has unknown setting ${JSON.stringify(key)}. Allowed: mode, globs.`);
      }
      const mode = forbidden.mode;
      if (mode !== 'add' && mode !== 'replace') invalid('forbiddenPathGlobs.mode must be "add" or "replace".');
      forbiddenPathGlobs = { mode, globs: globs('forbiddenPathGlobs.globs', forbidden.globs) };
    } else {
      invalid('forbiddenPathGlobs must be an array of globs (which replaces the built-in list) or an object {"mode": "add" | "replace", "globs": [...]}.');
    }
  }

  const prodGlobs = fields.prodGlobs === undefined ? undefined : globs('prodGlobs', fields.prodGlobs);
  const testGlobs = fields.testGlobs === undefined ? undefined : globs('testGlobs', fields.testGlobs);
  if ((prodGlobs === undefined) !== (testGlobs === undefined)) invalid('prodGlobs and testGlobs must be given together, or both omitted.');

  return {
    version: 1,
    checks,
    ...(forbiddenPathGlobs === undefined ? {} : { forbiddenPathGlobs }),
    ...(prodGlobs === undefined ? {} : { prodGlobs }),
    ...(testGlobs === undefined ? {} : { testGlobs }),
    gitlinkAcknowledgements: acknowledgements(fields.gitlinkAcknowledgements),
  };
}

/** Loads validated project policy from the commit named by `baseRef`. The file is always read and validated; programmatic overrides replace only their own values. */
function loadProjectPreflightPolicyUnchecked(root: string, baseRef: string, overrides: PolicyOverrides = {}): ProjectPreflightPolicy {
  const resolvedRoot = resolve(root);
  const commit = resolveCommit(resolvedRoot, baseRef).toLowerCase();
  const text = readTrustedFile(resolvedRoot, commit, CONFIG_PATH);
  const config = text === undefined ? undefined : validatePreflightConfig(text);
  const allowlist = parseJson(ALLOWLIST_PATH, readTrustedFile(resolvedRoot, commit, ALLOWLIST_PATH));
  if (allowlist !== undefined && !Array.isArray(allowlist)) throw new Error(`${ALLOWLIST_PATH}: Secret allowlist must be a JSON array.`);
  const exceptions = allowlist === undefined ? [] : allowlistExceptions(allowlist);
  const forbidden = config?.forbiddenPathGlobs;
  // A null-prototype map: an ID such as "toString" or "constructor" never resolves to an inherited function.
  const severity = Object.create(null) as Record<string, Severity>;
  for (const id of CONFIGURABLE_CHECK_IDS) {
    const value = config?.checks[id]?.severity;
    if (value !== undefined) severity[id] = value;
  }
  return {
    trustedCommit: commit,
    source: { path: CONFIG_PATH, ref: baseRef, commit, present: text !== undefined },
    ...(forbidden === undefined ? {} : { sensitivePathGlobs: forbidden.globs }),
    forbiddenGlobMode: forbidden?.mode ?? 'default',
    disabled: CONFIGURABLE_CHECK_IDS.filter(id => config?.checks[id]?.enabled === false),
    enabled: CONFIGURABLE_CHECK_IDS.filter(id => config?.checks[id]?.enabled === true),
    severity,
    ...(config?.prodGlobs === undefined ? {} : { prodGlobs: config.prodGlobs }),
    ...(config?.testGlobs === undefined ? {} : { testGlobs: config.testGlobs }),
    secretExceptions: overrides.secretExceptions ? [] : exceptions,
    gitlinkAcknowledgements: config?.gitlinkAcknowledgements ?? [],
    overridden: [...(overrides.forbiddenPathGlobs ? ['forbiddenPathGlobs'] : []), ...(overrides.secretExceptions ? ['secretExceptions'] : [])],
  };
}

/**
 * Loads the trusted project policy from the commit `baseRef` names.
 *
 * `baseRef` is test-only. The runner always passes `TRUSTED_REF` (`refs/remotes/origin/HEAD`), so no production path
 * can select another policy source. Tests pass another ref, such as `main`, to exercise the loader.
 */
export function loadProjectPreflightPolicy(root: string, baseRef: string, overrides: PolicyOverrides = {}): ProjectPreflightPolicy {
  try { return loadProjectPreflightPolicyUnchecked(root, baseRef, overrides); }
  catch (error) {
    if (error instanceof PreflightPolicyError) throw error;
    throw new PreflightPolicyError('invalid', error instanceof Error ? error.message : 'Trusted preflight policy validation failed.');
  }
}

/** The forbidden-path globs in force: `add` extends the built-in list, `replace` (and an array in the file) substitutes it. */
export function effectiveForbiddenGlobs(mode: ForbiddenGlobMode, globs: readonly string[] = []): readonly string[] {
  if (mode === 'add') return [...DEFAULT_SENSITIVE_PATH_GLOBS, ...globs];
  if (mode === 'replace') return globs;
  return DEFAULT_SENSITIVE_PATH_GLOBS;
}

/** Changes only `block` and `warn`; `pass` and `inconclusive` are never altered by a severity setting. */
export function applySeverity(status: CheckStatus, severity: Severity | undefined): CheckStatus {
  if (severity === undefined || (status !== 'block' && status !== 'warn')) return status;
  return severity;
}

/** Written by `harness:setup` when the human opts in. Matches the built-in behavior exactly. */
export const DEFAULT_PREFLIGHT_CONFIG = { version: 1, checks: { 'path-policy': { enabled: true, severity: 'block' } } } as const;

/** The policy used when no trusted policy is loaded: nothing disabled, built-in globs, no overrides. */
export function builtInPreflightPolicy(): ProjectPreflightPolicy {
  return {
    trustedCommit: '',
    source: { path: CONFIG_PATH, ref: TRUSTED_REF, commit: '', present: false },
    forbiddenGlobMode: 'default',
    disabled: [],
    enabled: [],
    severity: Object.create(null) as Record<string, Severity>,
    secretExceptions: [],
    gitlinkAcknowledgements: [],
    overridden: [],
  };
}

/**
 * The fixed `policy` result row. It states where the policy came from, what it changes, and any programmatic
 * override. It warns when recorded keys are not enforced, so a policy that enforces nothing does not look enforced.
 */
export function policyCheck(policy: ProjectPreflightPolicy): PreflightCheck {
  const check: PreflightCheck = { id: 'policy', run() {
    const forbidden = effectiveForbiddenGlobs(policy.forbiddenGlobMode, policy.sensitivePathGlobs);
    const severities = Object.entries(policy.severity).map(([id, value]) => `${id}=${value}`);
    const notEnforced: string[] = [];
    if (policy.disabled.includes('test-change') && (policy.prodGlobs !== undefined || policy.testGlobs !== undefined)) notEnforced.push('prodGlobs and testGlobs are inert while test-change is disabled');
    const testChangeConfigured = !policy.disabled.includes('test-change') && (policy.severity['test-change'] === 'block' || policy.enabled.includes('test-change'));
    if (testChangeConfigured && (policy.prodGlobs === undefined || policy.testGlobs === undefined)) notEnforced.push('test-change is configured but prodGlobs/testGlobs are not set; the check does not run');
    if (policy.forbiddenGlobMode !== 'default' && policy.disabled.includes('path-policy')) notEnforced.push('forbiddenPathGlobs is inert while path-policy is disabled');
    const commit = policy.source.commit ? policy.source.commit.slice(0, 12) : 'unresolved';
    return {
      status: notEnforced.length ? 'warn' : 'pass',
      evidence: [
        `Policy source: ${policy.source.path} at ${policy.source.ref} (commit ${commit}); ${policy.source.present ? 'file present' : 'file absent, built-in defaults apply'}.`,
        `Disabled checks: ${policy.disabled.join(', ') || 'none'}.`,
        `Severity overrides: ${severities.join(', ') || 'none'}.`,
        `Forbidden path globs: mode ${policy.forbiddenGlobMode}, ${forbidden.length} glob(s).`,
        `Programmatic overrides: ${policy.overridden.join(', ') || 'none'}.`,
        ...notEnforced.map(item => `Recorded but not enforced: ${item}.`),
      ],
      metrics: { disabledChecks: policy.disabled.length, forbiddenGlobs: forbidden.length },
    };
  } };
  return markTrustedPolicyDependent(check);
}

/** True for either project policy file or an ancestor that could replace its directory. */
export function isProjectPreflightPolicyPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  return POLICY_PATHS.some(policyPath => policyPath === normalized || policyPath.startsWith(`${normalized.replace(/\/$/, '')}/`));
}

export const projectPreflightPolicyPaths = { configuration: CONFIG_PATH, allowlist: ALLOWLIST_PATH };
