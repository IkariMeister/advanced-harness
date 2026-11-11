import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { updateContext } from '../src/project-context.ts';
import { loadProjectPreflightPolicy } from '../src/preflight/policy.ts';
import { createDefaultChecks, runPreflight } from '../src/preflight/runner.ts';
import { scanAddedText } from '../src/preflight/secret-scanner.ts';
import { makeTempRoot } from './temp-directory.ts';

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function projectRepo(policy?: { forbiddenPathGlobs?: string[]; allowlist?: unknown; gitlinkAcknowledgements?: unknown }): string {
  const root = makeTempRoot('preflight-policy-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  const checks = Object.fromEntries(['build', 'lint', 'unit', 'roborazzi', 'runtime', 'e2e'].map(name => [name, { status: 'unconfigured' }]));
  const profile = { version: 1, baseBranch: 'main', shell: 'bash', checks, device: { preference: 'ask' }, worktreeDirectory: join(root, '..', 'wt'), memoryPath: join(root, '..', 'mem', 'MEMORY.md') };
  writeFileSync(join(root, 'AGENTS.md'), updateContext('', 'project', profile, []));
  if (policy) {
    mkdirSync(join(root, '.harness'));
    if (policy.forbiddenPathGlobs !== undefined || policy.gitlinkAcknowledgements !== undefined) writeFileSync(join(root, '.harness', 'preflight.json'), JSON.stringify({ ...(policy.forbiddenPathGlobs === undefined ? {} : { forbiddenPathGlobs: policy.forbiddenPathGlobs }), ...(policy.gitlinkAcknowledgements === undefined ? {} : { gitlinkAcknowledgements: policy.gitlinkAcknowledgements }) }));
    if (policy.allowlist !== undefined) writeFileSync(join(root, '.harness', 'preflight-allowlist.json'), JSON.stringify(policy.allowlist));
  }
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'base');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(root, 'checkout', '-q', '-b', 'task');
  return root;
}

test('trusted preflight policy validates exact justified gitlink acknowledgements including additions', () => {
  const valid = [
    { path: 'vendor/old', oldId: 'a'.repeat(40), newId: 'b'.repeat(40), justification: 'Reviewed old and new source.' },
    { path: 'vendor/new', newId: 'c'.repeat(40), justification: 'Reviewed added source.' },
  ];
  const root = projectRepo({ gitlinkAcknowledgements: valid });
  const policy = loadProjectPreflightPolicy(root, 'refs/remotes/origin/HEAD');
  assert.deepEqual(policy.gitlinkAcknowledgements, valid);
  assert.deepEqual(loadProjectPreflightPolicy(root, 'refs/remotes/origin/HEAD', { forbiddenPathGlobs: true }).gitlinkAcknowledgements, valid, 'an explicit path-glob override preserves trusted acknowledgements');

  for (const entry of [
    { path: 'vendor/old', oldId: 'a'.repeat(40), newId: 'b'.repeat(40), justification: '  ' },
    { path: '../outside', newId: 'c'.repeat(40), justification: 'Reviewed.' },
    { path: 'vendor/new', newId: 'not-a-commit', justification: 'Reviewed.' },
  ]) {
    const invalidRoot = projectRepo({ gitlinkAcknowledgements: [entry] });
    assert.throws(() => loadProjectPreflightPolicy(invalidRoot, 'refs/remotes/origin/HEAD'), /Gitlink acknowledgement/);
    assert.throws(() => loadProjectPreflightPolicy(invalidRoot, 'refs/remotes/origin/HEAD', { forbiddenPathGlobs: true }), /Gitlink acknowledgement/, 'an explicit path-glob override does not bypass acknowledgement validation');
  }
});

test('trusted base policy replaces path globs, normalizes exact allowlist paths, and hides justifications', async () => {
  const justification = 'Reviewed approved fixture exception; no production credential.';
  const root = projectRepo({ forbiddenPathGlobs: ['**/*.bin'], allowlist: [{ path: 'src\\token.ts', rule: 'high-entropy-assignment', justification }] });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'token.ts'), 'const api_key = "THIS_IS_A_FAKE_SECRET_VALUE_0123456789";\n');
  writeFileSync(join(root, '.env.local'), 'ordinary text\n');
  const policy = loadProjectPreflightPolicy(root, 'main');
  assert.deepEqual(policy.sensitivePathGlobs, ['**/*.bin']);
  assert.equal(policy.secretExceptions[0]?.path, 'src/token.ts');
  assert.equal(policy.secretExceptions[0]?.justification, justification);
  assert.equal(createDefaultChecks().length, 6);
  const secretScanner: typeof scanAddedText = (changes, dependencies) => scanAddedText(changes, { ...dependencies, probe: () => ({ available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' }) });
  const result = await runPreflight({ worktree: root, base: 'main', secretScanner });
  assert.equal(result.checks.find(check => check.id === 'path-policy')?.status, 'pass', 'replacement globs do not retain the default .env rule');
  assert.equal(result.checks.find(check => check.id === 'secret-scan')?.status, 'pass');
  assert.equal(result.metrics['secret-scan.exceptionsApplied'], 1);
  assert.ok(!JSON.stringify(result).includes(justification));
});

test('trusted allowlist preserves optional positive line and rejects unknown exception keys', () => {
  const root = projectRepo({ allowlist: [{ path: './src/token.ts', rule: 'fixture', line: 12, origin: 'staged', justification: 'Reviewed one generated line.' }] });
  assert.deepEqual(loadProjectPreflightPolicy(root, 'main').secretExceptions, [{ path: 'src/token.ts', rule: 'fixture', line: 12, origin: 'staged', justification: 'Reviewed one generated line.' }]);
  const invalid = projectRepo({ allowlist: [{ path: 'src/token.ts', rule: 'fixture', line: 12, justification: 'Reviewed.', extra: 'bad' }] });
  assert.throws(() => loadProjectPreflightPolicy(invalid, 'main'), /unknown setting/);
});

test('line-scoped exceptions require origin and normalized empty paths are rejected', () => {
  const missingOrigin = projectRepo({ allowlist: [{ path: 'token.ts', rule: 'fixture', line: 1, justification: 'Review.' }] });
  assert.throws(() => loadProjectPreflightPolicy(missingOrigin, 'main'), /optional positive line with scan origin/);
  const emptyPath = projectRepo({ allowlist: [{ path: './', rule: 'fixture', justification: 'Review.' }] });
  assert.throws(() => loadProjectPreflightPolicy(emptyPath, 'main'), /paths must be nonempty/);
});

test('branch policy edits are blocked and cannot weaken trusted checks; explicit options remain authoritative', async () => {
  const root = projectRepo({ forbiddenPathGlobs: ['**/*.pem'], allowlist: [] });
  mkdirSync(join(root, '.harness'), { recursive: true });
  writeFileSync(join(root, '.harness', 'preflight.json'), JSON.stringify({ forbiddenPathGlobs: [] }));
  writeFileSync(join(root, '.harness', 'preflight-allowlist.json'), JSON.stringify([{ path: 'candidate.pem', rule: 'high-entropy-assignment', justification: 'Branch-added suppression attempt.' }]));
  writeFileSync(join(root, 'candidate.pem'), 'const api_key = "THIS_IS_A_FAKE_SECRET_VALUE_0123456789";\n');
  const secretScanner: typeof scanAddedText = (changes, dependencies) => scanAddedText(changes, { ...dependencies, probe: () => ({ available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' }) });
  const trusted = await runPreflight({ worktree: root, base: 'main', secretScanner });
  assert.equal(trusted.checks.find(check => check.id === 'policy-integrity')?.status, 'block');
  assert.equal(trusted.checks.find(check => check.id === 'path-policy')?.status, 'block', 'base forbidden-path policy remains in force despite branch edits');
  assert.equal(trusted.checks.find(check => check.id === 'secret-scan')?.status, 'block', 'branch allowlist edits cannot suppress findings');

  const explicit = await runPreflight({ worktree: root, base: 'main', sensitivePathGlobs: ['**/*.txt'], secretExceptions: [], secretScanner });
  assert.equal(explicit.checks.find(check => check.id === 'path-policy')?.status, 'pass', 'trusted programmatic glob options take precedence over base policy');
  assert.equal(explicit.checks.find(check => check.id === 'secret-scan')?.status, 'block', 'explicit empty exceptions are preserved');
  assert.equal(explicit.checks.find(check => check.id === 'policy-integrity')?.status, 'block');
});

test('project-context base changes cannot select branch-authored policy', async () => {
  const root = projectRepo({ forbiddenPathGlobs: ['**/*.pem'], allowlist: [] });
  writeFileSync(join(root, 'candidate.pem'), 'const api_key = "THIS_IS_A_FAKE_SECRET_VALUE_0123456789";\n');
  const agentsPath = join(root, 'AGENTS.md');
  writeFileSync(agentsPath, readFileSync(agentsPath, 'utf8').replace('"baseBranch": "main"', '"baseBranch": "task"'));
  const secretScanner: typeof scanAddedText = (changes, dependencies) => scanAddedText(changes, { ...dependencies, probe: () => ({ available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' }) });
  const result = await runPreflight({ worktree: root, secretScanner });
  assert.equal(result.checks.find(check => check.id === 'base-context')?.status, 'block');
  assert.equal(result.checks.find(check => check.id === 'path-policy')?.status, 'block', 'implicit policy source stays pinned to the trusted remote default ref');
});

test('invalid trusted policy keeps policy-dependent checks inconclusive while independent checks continue', async () => {
  const root = projectRepo({ forbiddenPathGlobs: [] });
  writeFileSync(join(root, '.harness', 'preflight.json'), '{broken');
  git(root, 'add', '.harness/preflight.json'); git(root, 'commit', '-q', '-m', 'invalid trusted policy');
  git(root, 'update-ref', 'refs/heads/main', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const invalid = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(invalid.checks.find(check => check.id === 'secret-scan')?.status, 'inconclusive');
  assert.equal(invalid.checks.find(check => check.id === 'path-policy')?.status, 'inconclusive');
  assert.equal(invalid.checks.find(check => check.id === 'changeset')?.status, 'pass');
  const explicit = await runPreflight({ worktree: root, base: 'main', sensitivePathGlobs: [], secretExceptions: [] });
  assert.equal(explicit.checks.find(check => check.id === 'path-policy')?.status, 'inconclusive', 'malformed trusted JSON invalidates policy-dependent checks even when overrides are supplied');
  assert.equal(explicit.checks.find(check => check.id === 'secret-scan')?.status, 'inconclusive', 'malformed trusted JSON cannot authorize trusted acknowledgements');
  assert.equal(explicit.checks.find(check => check.id === 'changeset')?.status, 'pass', 'independent checks continue when trusted policy is malformed');
  assert.equal(explicit.checks.find(check => check.id === 'base-context')?.status, 'pass');

  const conflict = await runPreflight({ worktree: root, checks: [], sensitivePathGlobs: [] });
  assert.equal(conflict.checks[0]?.status, 'inconclusive');
  assert.match(conflict.checks[0]?.evidence[0] ?? '', /cannot be combined/);
});

test('explicit exceptions replace valid trusted entries but malformed trusted allowlists remain inconclusive', async () => {
  const valid = projectRepo({ allowlist: [{ path: 'candidate.ts', rule: 'fixture', justification: 'Trusted fixture exception.' }] });
  const policy = loadProjectPreflightPolicy(valid, 'refs/remotes/origin/HEAD', { secretExceptions: true });
  assert.deepEqual(policy.secretExceptions, [], 'caller exceptions replace values from a valid trusted allowlist');

  for (const [name, contents] of [['malformed JSON', '{broken'], ['null JSON value', 'null'], ['object JSON value', '{}']] as const) {
    const root = projectRepo({ allowlist: [] });
    writeFileSync(join(root, '.harness', 'preflight-allowlist.json'), contents);
    git(root, 'add', '.harness/preflight-allowlist.json');
    git(root, 'commit', '-q', '-m', `invalid trusted allowlist: ${name}`);
    git(root, 'update-ref', 'refs/heads/main', 'HEAD');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const result = await runPreflight({ worktree: root, base: 'main', secretExceptions: [] });
    assert.equal(result.checks.find(check => check.id === 'secret-scan')?.status, 'inconclusive', name);
    assert.equal(result.checks.find(check => check.id === 'path-policy')?.status, 'inconclusive', name);
    assert.equal(result.checks.find(check => check.id === 'changeset')?.status, 'pass', `independent checks continue for ${name}`);
    assert.equal(result.checks.find(check => check.id === 'base-context')?.status, 'pass', name);
  }
});

test('custom checks can run with configured project policy but reject explicit policy overrides', async () => {
  const root = projectRepo({ forbiddenPathGlobs: ['**/*.pem'], allowlist: [] });
  const customCheck = { id: 'custom', description: 'Independent custom check', run: async () => ({ status: 'pass' as const, summary: 'Custom check ran.', evidence: [] }) };
  const result = await runPreflight({ worktree: root, base: 'main', checks: [customCheck] });
  assert.equal(result.checks[0]?.id, 'custom');
  assert.equal(result.checks[0]?.status, 'pass', JSON.stringify(result));

  const conflict = await runPreflight({ worktree: root, base: 'main', checks: [customCheck], secretExceptions: [] });
  assert.equal(conflict.checks[0]?.status, 'inconclusive');
  assert.match(conflict.checks[0]?.evidence[0] ?? '', /cannot be combined/);
});

test('trusted policy rejects non-regular, oversized, invalid UTF-8, unknown-key, and traversal inputs', async (t) => {
  const scenarios: { name: string; apply(root: string): void }[] = [
    { name: 'symlink mode', apply(root) { const hash = spawnSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: '{}', encoding: 'utf8' }); assert.equal(hash.status, 0); git(root, 'update-index', '--cacheinfo', `120000,${hash.stdout.trim()},.harness/preflight.json`); } },
    { name: 'gitlink mode', apply(root) { git(root, 'update-index', '--add', '--cacheinfo', `160000,${gitOutput(root, 'rev-parse', 'HEAD')},.harness/preflight.json`); } },
    { name: 'over 1 MiB', apply(root) { writeFileSync(join(root, '.harness', 'preflight.json'), Buffer.alloc(1024 * 1024 + 1, 0x20)); } },
    { name: 'invalid UTF-8', apply(root) { writeFileSync(join(root, '.harness', 'preflight.json'), Buffer.from([0xff, 0xfe])); } },
    { name: 'unknown configuration key', apply(root) { writeFileSync(join(root, '.harness', 'preflight.json'), JSON.stringify({ forbiddenPathGlobs: [], weaken: true })); } },
    { name: 'allowlist traversal path', apply(root) { writeFileSync(join(root, '.harness', 'preflight-allowlist.json'), JSON.stringify([{ path: '../token', rule: 'fixture', justification: 'Reviewed.' }])); } },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    const root = projectRepo({ forbiddenPathGlobs: [], allowlist: [] });
    scenario.apply(root);
    if (!scenario.name.includes('mode')) git(root, 'add', '.harness');
    git(root, 'commit', '-q', '-m', 'invalid trusted policy fixture');
    git(root, 'update-ref', 'refs/heads/main', 'HEAD');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const result = await runPreflight({ worktree: root, base: 'main' });
    assert.ok(result.checks.some(check => check.id === 'secret-scan' && check.status === 'inconclusive'), JSON.stringify(result));
    assert.ok(result.checks.some(check => check.id === 'path-policy' && check.status === 'inconclusive'), JSON.stringify(result));
    assert.ok(result.checks.some(check => check.id === 'changeset' && check.status === 'pass'), JSON.stringify(result));
  });
});

function gitOutput(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
