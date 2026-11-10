import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { SecretException } from './checks.ts';
import { validateSensitivePathGlobs } from './path-policy.ts';

const CONFIG_PATH = '.harness/preflight.json';
const ALLOWLIST_PATH = '.harness/preflight-allowlist.json';
const MAX_POLICY_BYTES = 1024 * 1024;
const POLICY_PATHS = [CONFIG_PATH, ALLOWLIST_PATH] as const;
export type ProjectPreflightPolicy = { sensitivePathGlobs?: readonly string[]; secretExceptions: SecretException[] };

function gitBuffer(root: string, args: string[], maxBuffer = MAX_POLICY_BYTES + 1): Buffer {
  const result = spawnSync('git', ['-C', root, '--literal-pathspecs', ...args], { maxBuffer });
  if (result.error || result.status !== 0) throw new Error('Trusted preflight policy could not be read from the selected base ref.');
  return result.stdout;
}

function resolveCommit(root: string, baseRef: string): string {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`], { encoding: 'utf8', maxBuffer: 32 * 1024 });
  if (result.error || result.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(result.stdout.trim())) throw new Error('Trusted preflight policy base ref could not be resolved.');
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
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Secret allowlist entries require path, rule, and justification strings.');
    const candidate = item as Record<string, unknown>;
    const path = candidate.path;
    const rule = candidate.rule;
    const justification = candidate.justification;
    if (typeof path !== 'string' || typeof rule !== 'string' || typeof justification !== 'string' || !justification.trim() || /[\u0000-\u001f\u007f]/.test(path) || /[\u0000-\u001f\u007f]/.test(rule)) throw new Error('Secret allowlist entries require a safe exact path/rule and nonblank justification.');
    const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').includes('..')) throw new Error('Secret allowlist paths must be exact repository-relative paths.');
    return { path: normalized, rule: rule.trim(), justification: justification.trim() };
  });
}

/** Loads validated project policy only from the commit named by the caller's trusted base ref. */
export function loadProjectPreflightPolicy(root: string, baseRef: string, overrides: { forbiddenPathGlobs?: boolean; secretExceptions?: boolean } = {}): ProjectPreflightPolicy {
  const resolvedRoot = resolve(root);
  const commit = resolveCommit(resolvedRoot, baseRef);
  const config = overrides.forbiddenPathGlobs ? undefined : parseJson(readTrustedFile(resolvedRoot, commit, CONFIG_PATH));
  let sensitivePathGlobs: readonly string[] | undefined;
  if (config !== undefined) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Trusted preflight configuration must be a JSON object.');
    const fields = config as Record<string, unknown>;
    if (Object.keys(fields).some(key => key !== 'forbiddenPathGlobs')) throw new Error('Trusted preflight configuration contains an unknown setting.');
    if (fields.forbiddenPathGlobs !== undefined) {
      validateSensitivePathGlobs(fields.forbiddenPathGlobs);
      sensitivePathGlobs = [...fields.forbiddenPathGlobs];
    }
  }
  const allowlist = overrides.secretExceptions ? undefined : parseJson(readTrustedFile(resolvedRoot, commit, ALLOWLIST_PATH));
  return { ...(sensitivePathGlobs === undefined ? {} : { sensitivePathGlobs }), secretExceptions: allowlist === undefined ? [] : validateExceptions(allowlist) };
}

/** True for either project policy file or an ancestor that could replace its directory. */
export function isProjectPreflightPolicyPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  return POLICY_PATHS.some(policyPath => policyPath === normalized || policyPath.startsWith(`${normalized.replace(/\/$/, '')}/`));
}

export const projectPreflightPolicyPaths = { configuration: CONFIG_PATH, allowlist: ALLOWLIST_PATH };
