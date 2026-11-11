import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { normalizeExceptionPath, validateSecretExceptions, type SecretException } from './exceptions.ts';
import { validateSensitivePathGlobs } from './path-policy.ts';

const CONFIG_PATH = '.harness/preflight.json';
const ALLOWLIST_PATH = '.harness/preflight-allowlist.json';
const MAX_POLICY_BYTES = 1024 * 1024;
const POLICY_PATHS = [CONFIG_PATH, ALLOWLIST_PATH] as const;
export type GitlinkAcknowledgement = { path: string; oldId?: string; newId: string; justification: string };
export type ProjectPreflightPolicy = { sensitivePathGlobs?: readonly string[]; secretExceptions: SecretException[]; gitlinkAcknowledgements: GitlinkAcknowledgement[] };
export class PreflightPolicyError extends Error {
  override name = 'PreflightPolicyError';
  readonly code: 'base-unavailable' | 'invalid';
  constructor(code: 'base-unavailable' | 'invalid', message: string) { super(message); this.code = code; }
}

function gitBuffer(root: string, args: string[], maxBuffer = MAX_POLICY_BYTES + 1): Buffer {
  const result = spawnSync('git', ['-C', root, '--literal-pathspecs', ...args], { maxBuffer });
  if (result.error || result.status !== 0) throw new PreflightPolicyError('invalid', 'Trusted preflight policy could not be read from the selected base ref.');
  return result.stdout;
}

function resolveCommit(root: string, baseRef: string): string {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`], { encoding: 'utf8', maxBuffer: 32 * 1024 });
  if (result.error || result.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(result.stdout.trim())) throw new PreflightPolicyError('base-unavailable', 'Trusted preflight policy base ref could not be resolved.');
  return result.stdout.trim();
}

function readTrustedFile(root: string, commit: string, path: string): string | undefined {
  const listing = gitBuffer(root, ['ls-tree', '-z', commit, '--', path]).toString('utf8');
  if (!listing) return undefined;
  const record = listing.split('\0')[0] ?? '';
  const tab = record.indexOf('\t');
  if (tab < 0 || record.slice(tab + 1) !== path) throw new Error('Trusted preflight policy tree entry was invalid.');
  const [mode, type, object] = record.slice(0, tab).split(' ');
  if (type !== 'blob' || !['100644', '100755'].includes(mode ?? '') || !object) throw new Error('Trusted preflight policy files must be regular files.');
  const bytes = gitBuffer(root, ['cat-file', 'blob', object]);
  if (bytes.length > MAX_POLICY_BYTES) throw new Error('Trusted preflight policy files exceed 1 MiB.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Trusted preflight policy files must be UTF-8 JSON.'); }
}

function parseJson(value: string | undefined): unknown | undefined {
  if (value === undefined) return undefined;
  try { return JSON.parse(value) as unknown; } catch { throw new Error('Trusted preflight policy file contains invalid JSON.'); }
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
    if (Object.keys(entry).some(key => !['path', 'oldId', 'newId', 'justification'].includes(key)) || typeof entry.path !== 'string' || !entry.path.trim() || typeof entry.newId !== 'string' || !/^[0-9a-f]{40,64}$/i.test(entry.newId) || (entry.oldId !== undefined && (typeof entry.oldId !== 'string' || !/^[0-9a-f]{40,64}$/i.test(entry.oldId))) || typeof entry.justification !== 'string' || !entry.justification.trim()) throw new Error('Gitlink acknowledgements require an exact path, newId, optional oldId, and nonblank justification.');
    const path = entry.path.replaceAll('\\', '/').replace(/^\.\//, '');
    if (path !== entry.path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Gitlink acknowledgement path must be normalized and repository-relative.');
    return { path, ...(entry.oldId === undefined ? {} : { oldId: entry.oldId as string }), newId: entry.newId, justification: entry.justification.trim() };
  });
}

/** Loads validated project policy only from the commit named by the caller's trusted base ref. */
function loadProjectPreflightPolicyUnchecked(root: string, baseRef: string, overrides: { forbiddenPathGlobs?: boolean; secretExceptions?: boolean } = {}): ProjectPreflightPolicy {
  const resolvedRoot = resolve(root);
  const commit = resolveCommit(resolvedRoot, baseRef);
  const config = parseJson(readTrustedFile(resolvedRoot, commit, CONFIG_PATH));
  let sensitivePathGlobs: readonly string[] | undefined;
  if (config !== undefined) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Trusted preflight configuration must be a JSON object.');
    const fields = config as Record<string, unknown>;
    if (Object.keys(fields).some(key => !['forbiddenPathGlobs', 'gitlinkAcknowledgements'].includes(key))) throw new Error('Trusted preflight configuration contains an unknown setting.');
    if (!overrides.forbiddenPathGlobs && fields.forbiddenPathGlobs !== undefined) {
      validateSensitivePathGlobs(fields.forbiddenPathGlobs);
      sensitivePathGlobs = [...fields.forbiddenPathGlobs];
    }
  }
  const allowlist = parseJson(readTrustedFile(resolvedRoot, commit, ALLOWLIST_PATH));
  if (allowlist !== undefined && !Array.isArray(allowlist)) throw new Error('Secret allowlist must be a JSON array.');
  return { ...(sensitivePathGlobs === undefined ? {} : { sensitivePathGlobs }), secretExceptions: overrides.secretExceptions ? [] : allowlist === undefined ? [] : validateExceptions(allowlist), gitlinkAcknowledgements: validateGitlinkAcknowledgements(config && typeof config === 'object' ? (config as Record<string, unknown>).gitlinkAcknowledgements : undefined) };
}

export function loadProjectPreflightPolicy(root: string, baseRef: string, overrides: { forbiddenPathGlobs?: boolean; secretExceptions?: boolean } = {}): ProjectPreflightPolicy {
  try { return loadProjectPreflightPolicyUnchecked(root, baseRef, overrides); }
  catch (error) {
    if (error instanceof PreflightPolicyError) throw error;
    throw new PreflightPolicyError('invalid', error instanceof Error ? error.message : 'Trusted preflight policy validation failed.');
  }
}

/** True for either project policy file or an ancestor that could replace its directory. */
export function isProjectPreflightPolicyPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  return POLICY_PATHS.some(policyPath => policyPath === normalized || policyPath.startsWith(`${normalized.replace(/\/$/, '')}/`));
}

export const projectPreflightPolicyPaths = { configuration: CONFIG_PATH, allowlist: ALLOWLIST_PATH };
