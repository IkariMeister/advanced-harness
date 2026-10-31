import type { PermissionRule } from './permission-reconciliation.ts';

/**
 * Harness-wide security guardrails (BH-036): sensitive paths no role may read or
 * edit, and destructive Git commands no role may run. Each host renders the same
 * intent in its native permission language. Patterns are workflow guardrails, not
 * a sandbox against scripts, aliases, or separate processes.
 */

/**
 * Sensitive files: Android signing assets/project secrets plus SSH and cloud credentials.
 * Home-directory entries also carry `~`-free forms in both separators, so OpenCode matching
 * does not depend on `~` expansion or on `/` versus `\` paths (they also match such
 * directories outside the home, which are equally sensitive).
 */
export const sensitivePaths = [
  { opencode: ['*.jks'], claude: ['**/*.jks'] },
  { opencode: ['*.keystore'], claude: ['**/*.keystore'] },
  { opencode: ['*local.properties'], claude: ['**/local.properties'] },
  { opencode: ['*google-services.json'], claude: ['**/google-services.json'] },
  { opencode: ['*signing.properties'], claude: ['**/signing.properties'] },
  { opencode: ['*.pem'], claude: ['**/*.pem'] },
  { opencode: ['*.key'], claude: ['**/*.key'] },
  { opencode: ['~/.ssh/*', '*/.ssh/*', '*\\.ssh\\*'], claude: ['~/.ssh/**'] },
  { opencode: ['~/.aws/credentials', '*/.aws/credentials', '*\\.aws\\credentials'], claude: ['~/.aws/credentials'] },
  { opencode: ['~/.config/gh/hosts.yml', '*/.config/gh/hosts.yml', '*\\.config\\gh\\hosts.yml'], claude: ['~/.config/gh/hosts.yml'] },
] as const;

const openCodeSensitivePaths: readonly string[] = sensitivePaths.flatMap(path => path.opencode);

/** Shell glob forms of destructive Git commands, shared by OpenCode and Claude Code. */
export const destructiveGitCommands = [
  'git reset --hard', 'git reset --hard *', 'git reset * --hard', 'git reset * --hard *',
  'git clean', 'git clean *',
  'git push --force', 'git push --force *', 'git push * --force', 'git push * --force *',
  'git push -f', 'git push -f *', 'git push * -f', 'git push * -f *',
  'git push --force-with-lease*', 'git push * --force-with-lease*',
  'git push * +*',
] as const;

/** Short-flag clusters of two to four letters containing `f`, as `?` patterns (`-?f`, `-f?`, ..., `-f???`). */
const bundledForceClusters: readonly string[] = [1, 2, 3].flatMap(others =>
  Array.from({ length: others + 1 }, (_, at) => `-${'?'.repeat(at)}f${'?'.repeat(others - at)}`));

/**
 * OpenCode-only forms for bundled short force flags (`-uf`, `-fu`, `-vuf`, `-vuqf`, ...): `?`
 * matches one character, so each cluster stays a single token. Claude Code has no
 * single-character wildcard; its `git push *` exceptions are already downgraded to prompts.
 */
export const openCodeBundledForcePushCommands: readonly string[] = bundledForceClusters
  .flatMap(cluster => [`git push ${cluster}`, `git push ${cluster} *`, `git push * ${cluster}`, `git push * ${cluster} *`]);

/** A Codex prefix_rule pattern: ordered tokens, where a nested list lists alternatives for one position. */
export type CodexPrefixPattern = readonly (string | readonly string[])[];

/**
 * Bundled short force flags spelled out for Codex, which has no wildcard token: `f` with one
 * or two of git push's other value-free short flags (`-uf`, `-fu`, `-vuf`, ...).
 */
export const codexBundledForceFlags: readonly string[] = (() => {
  const others = ['d', 'n', 'q', 'u', 'v'];
  const clusters = new Set<string>();
  for (const a of others) {
    clusters.add(`-${a}f`).add(`-f${a}`);
    for (const b of others) if (b !== a) for (const letters of [[a, b, 'f'], [a, 'f', b], ['f', a, b]]) clusters.add(`-${letters.join('')}`);
  }
  return [...clusters];
})();

/** Remote names whose position-four force flags Codex can match; other remotes and later positions are not seen. */
export const codexKnownRemotes: readonly string[] = ['origin', 'upstream'];

/**
 * Codex prefix_rule patterns. Prefix rules match exact leading tokens only, so force flags after
 * an unlisted remote or after a refspec, `--force-with-lease=<ref>`, and `+refspec` are not matched.
 */
export const codexDestructiveGitPrefixes: readonly CodexPrefixPattern[] = [
  ['git', 'reset', '--hard'],
  ['git', 'clean'],
  ['git', 'push', '--force'],
  ['git', 'push', '-f'],
  ['git', 'push', '--force-with-lease'],
  ['git', 'push', codexBundledForceFlags],
  ['git', 'push', codexKnownRemotes, ['--force', '-f', '--force-with-lease', ...codexBundledForceFlags]],
];

const allOpenCodeGuardrails: readonly PermissionRule[] = [
  ...openCodeSensitivePaths.map(path => ({ action: 'read', resource: path, effect: 'deny' as const })),
  ...openCodeSensitivePaths.map(path => ({ action: 'edit', resource: path, effect: 'deny' as const })),
  ...[...destructiveGitCommands, ...openCodeBundledForcePushCommands].map(command => ({ action: 'shell', resource: command, effect: 'deny' as const })),
];

/**
 * OpenCode rules appended last to a role so ordered last-match resolution keeps them
 * in force. Only actions the role can reach (any non-deny rule) get guardrails.
 */
export function openCodeGuardrailRules(permissions: readonly PermissionRule[]): PermissionRule[] {
  const reachable = new Set(permissions.filter(rule => rule.effect !== 'deny').map(rule => rule.action));
  return allOpenCodeGuardrails.filter(guard => reachable.has('*') || reachable.has(guard.action)).map(guard => ({ ...guard }));
}

export function isOpenCodeGuardrailRule(rule: PermissionRule): boolean {
  return rule.effect === 'deny' && allOpenCodeGuardrails.some(guard => guard.action === rule.action && guard.resource === rule.resource);
}

/** Claude Code project deny rules; Edit rules also cover Write. */
export function claudeGuardrailDenyRules(): string[] {
  const paths = sensitivePaths.flatMap(path => path.claude);
  return [
    ...paths.map(path => `Read(${path})`),
    ...paths.map(path => `Edit(${path})`),
    ...destructiveGitCommands.map(command => `Bash(${command})`),
  ];
}

const globalOptionsWithValue = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'];

/** Token-level check of one command segment (executable first) for a destructive Git invocation. */
export function isDestructiveGitInvocation(tokens: readonly string[]): boolean {
  const base = (tokens[0] ?? '').toLowerCase().replace(/\\/g, '/').split('/').pop() ?? '';
  if (base !== 'git' && base !== 'git.exe') return false;
  let index = 1;
  while (index < tokens.length && tokens[index]!.startsWith('-')) {
    index += globalOptionsWithValue.includes(tokens[index]!) ? 2 : 1;
  }
  const subcommand = tokens[index]?.toLowerCase();
  const args = tokens.slice(index + 1);
  if (subcommand === 'clean') return true;
  if (subcommand === 'reset') return args.includes('--hard');
  if (subcommand === 'push') {
    return args.some(arg => arg === '--force' || arg.startsWith('--force-with-lease') || arg === '--force-if-includes'
      || /^-[A-Za-z]*f[A-Za-z]*$/.test(arg) || (arg.startsWith('+') && arg.length > 1));
  }
  return false;
}
