import type { PreflightCheck } from './types.ts';

export const DEFAULT_SENSITIVE_PATH_GLOBS = ['**/.env*', '**/id_rsa*', '**/.DS_Store', '**/keys/**', '**/keystores/**', '**/*.key', '**/*.pem', '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore', '**/build/**', '**/dist/**'] as const;
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
  return { id: 'path-policy', run({ changeset }) {
    const hits = changeset.entries.filter(entry => entry.status !== 'deleted' && globs.some(glob => matchesGlob(entry.path, glob)));
    return hits.length ? { status: 'block', evidence: hits.map(entry => `Sensitive path rule matched: ${entry.path} [${entry.origin}]`), metrics: { matched: hits.length } } : { status: 'pass', evidence: ['No changed paths match configured sensitive path rules.'], metrics: { matched: 0 } };
  } };
}
