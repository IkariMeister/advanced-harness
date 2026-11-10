import type { ForbiddenGlobs } from './policy.ts';
import type { PreflightCheck } from './types.ts';

export const DEFAULT_SENSITIVE_PATH_GLOBS = ['**/.env*', '**/id_rsa*', '**/.DS_Store', '**/keys/**', '**/keystores/**', '**/*.key', '**/*.pem', '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore', '**/build/**', '**/dist/**'] as const;

/**
 * The globs path-policy enforces. No project policy keeps the built-in list. `add` extends it;
 * `replace` uses only the project's globs.
 */
export function effectiveForbiddenGlobs(forbidden: ForbiddenGlobs | undefined): readonly string[] {
  if (!forbidden) return DEFAULT_SENSITIVE_PATH_GLOBS;
  if (forbidden.mode === 'replace') return forbidden.globs;
  return [...new Set([...DEFAULT_SENSITIVE_PATH_GLOBS, ...forbidden.globs])];
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

/** Blocks changed paths that match the forbidden globs from the effective preflight policy. */
export function pathPolicyCheck(): PreflightCheck {
  return { id: 'path-policy', policy: { configurable: true, consumes: ['forbiddenGlobs'] }, run({ changeset, policy }) {
    const globs = effectiveForbiddenGlobs(policy.forbiddenGlobs);
    const hits = changeset.entries.filter(entry => entry.status !== 'deleted' && globs.some(glob => matchesGlob(entry.path, glob)));
    return hits.length ? { status: 'block', evidence: hits.map(entry => `Sensitive path rule matched: ${entry.path} [${entry.origin}]`), metrics: { matched: hits.length } } : { status: 'pass', evidence: ['No changed paths match configured sensitive path rules.'], metrics: { matched: 0 } };
  } };
}
