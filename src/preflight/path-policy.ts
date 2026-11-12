import type { PreflightCheck } from './types.ts';

const trustedPolicyDependentChecks = new WeakSet<PreflightCheck>();
const configurableBuiltInChecks = new WeakSet<PreflightCheck>();
// This identity marker is intentionally instance-based; wrapping or copying a built-in check loses its policy-dependent marker.
export function markTrustedPolicyDependent<T extends PreflightCheck>(check: T): T { trustedPolicyDependentChecks.add(check); return check; }
export function isTrustedPolicyDependent(check: PreflightCheck): boolean { return trustedPolicyDependentChecks.has(check); }
/** Registered only by this module's built-in factory (`pathPolicyCheck`). A caller-supplied object cannot register itself. */
function markConfigurableBuiltIn<T extends PreflightCheck>(check: T): T { configurableBuiltInChecks.add(check); return check; }
/** True only for a built-in configurable check instance, so the trusted policy may enable, disable, or re-severity it. */
export function isConfigurableBuiltIn(check: PreflightCheck): boolean { return configurableBuiltInChecks.has(check); }

export const DEFAULT_SENSITIVE_PATH_GLOBS = ['**/.env*', '**/id_rsa*', '**/.DS_Store', '**/keys/**', '**/keystores/**', '**/*.key', '**/*.pem', '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore', '**/build/**', '**/dist/**'] as const;
export function validateSensitivePathGlobs(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some(glob => typeof glob !== 'string' || !glob.trim() || glob.length > 300 || /[\u0000-\u001f\u007f]/.test(glob) || glob.startsWith('/') || /^[a-z]:/i.test(glob) || glob.replaceAll('\\', '/').split('/').includes('..'))) throw new Error('forbiddenPathGlobs must be an array of safe repository-relative glob strings.');
}
function matchesGlob(path: string, glob: string): boolean {
  const p = path.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  const g = glob.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  let source = '';
  for (let i = 0; i < g.length; i += 1) {
    const char = g[i]!;
    if (char === '*' && g[i + 1] === '*' && g[i + 2] === '/') { source += '(?:.*/)?'; i += 2; }
    else if (char === '*' && g[i + 1] === '*') { source += '.*'; i += 1; }
    else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(p);
}

export function pathPolicyCheck(globs: readonly string[] = DEFAULT_SENSITIVE_PATH_GLOBS): PreflightCheck {
  validateSensitivePathGlobs(globs);
  const check: PreflightCheck = { id: 'path-policy', run({ changeset }) {
    const hits = changeset.entries.filter(entry => entry.status !== 'deleted' && globs.some(glob => matchesGlob(entry.path, glob)));
    const safePath = (path: string) => [...path.replaceAll('\\', '/')].slice(0, 240).map(character => /[\u0000-\u001f\u007f]/.test(character) ? `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}` : character).join('');
    return hits.length ? { status: 'block', evidence: [...hits.slice(0, 50).map(entry => `Sensitive path rule matched: ${safePath(entry.path)} [${entry.origin}]`), ...(hits.length > 50 ? [`… ${hits.length - 50} additional matching path(s).`] : [])], metrics: { matched: hits.length } } : { status: 'pass', evidence: ['No changed paths match configured sensitive path rules.'], metrics: { matched: 0 } };
  } };
  return markConfigurableBuiltIn(markTrustedPolicyDependent(check));
}
