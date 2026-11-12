import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { updateContext } from '../src/project-context.ts';
import { applySeverity, DEFAULT_PREFLIGHT_CONFIG, effectiveForbiddenGlobs, loadProjectPreflightPolicy, validatePreflightConfig } from '../src/preflight/policy.ts';
import { createDefaultChecks, exitCodeFor, runPreflight } from '../src/preflight/runner.ts';
import { changesetCheck, pathPolicyCheck, policyIntegrityCheck, secretScanCheck } from '../src/preflight/checks.ts';
import { scanAddedText } from '../src/preflight/secret-scanner.ts';
import type { PreflightCheck } from '../src/preflight/types.ts';
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
    { path: 'vendor/upper', oldId: 'A'.repeat(64), newId: 'B'.repeat(64), justification: 'Reviewed 64 digit IDs.' },
  ];
  const root = projectRepo({ gitlinkAcknowledgements: valid });
  const policy = loadProjectPreflightPolicy(root, 'refs/remotes/origin/HEAD');
  assert.deepEqual(policy.gitlinkAcknowledgements, [valid[0], valid[1], { ...valid[2], oldId: 'a'.repeat(64), newId: 'b'.repeat(64) }]);
  assert.deepEqual(loadProjectPreflightPolicy(root, 'refs/remotes/origin/HEAD', { forbiddenPathGlobs: true }).gitlinkAcknowledgements, policy.gitlinkAcknowledgements, 'an explicit path-glob override preserves normalized trusted acknowledgements');

  for (const entry of [
    { path: 'vendor/old', oldId: 'a'.repeat(40), newId: 'b'.repeat(40), justification: '  ' },
    { path: '../outside', newId: 'c'.repeat(40), justification: 'Reviewed.' },
    { path: 'vendor/new', newId: 'not-a-commit', justification: 'Reviewed.' },
    { path: 'vendor/invalid-length', newId: 'a'.repeat(41), justification: 'Reviewed.' },
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
  assert.deepEqual(createDefaultChecks().map(check => check.id), ['changeset', 'base-context', 'policy-integrity', 'worktree-boundary', 'path-policy', 'secret-scan', 'policy']);
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
  const originWithoutLine = projectRepo({ allowlist: [{ path: 'token.ts', rule: 'fixture', origin: 'staged', justification: 'Review.' }] });
  assert.throws(() => loadProjectPreflightPolicy(originWithoutLine, 'main'), /optional positive line with scan origin/);
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

  git(root, 'checkout', '-q', '-b', 'weaker-base');
  writeFileSync(join(root, '.harness', 'preflight.json'), JSON.stringify({ forbiddenPathGlobs: [] }));
  git(root, 'add', '.harness/preflight.json'); git(root, 'commit', '-q', '-m', 'weaker comparison base policy');
  git(root, 'checkout', '-q', 'task');
  writeFileSync(join(root, 'candidate.pem'), 'ordinary text\n');
  const weakerBase = await runPreflight({ worktree: root, base: 'weaker-base', secretScanner });
  assert.equal(weakerBase.checks.find(check => check.id === 'path-policy')?.status, 'block', '--base never selects or weakens trusted origin/HEAD policy');
  assert.equal(weakerBase.checks.find(check => check.id === 'policy-integrity')?.status, 'block', 'the alternate base cannot authorize its candidate policy edit');
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
  let customRan = false;
  const custom = await runPreflight({ worktree: root, base: 'main', checks: [{ id: 'custom', run: () => { customRan = true; return { status: 'pass', evidence: ['ran'] }; } }] });
  assert.equal(customRan, true);
  assert.equal(custom.checks[0]?.status, 'pass');

  const conflict = await runPreflight({ worktree: root, checks: [], sensitivePathGlobs: [] });
  assert.equal(conflict.checks[0]?.status, 'inconclusive');
  assert.match(conflict.checks[0]?.evidence[0] ?? '', /cannot be combined/);
});

test('policy-dependent custom factory checks are guarded while custom same-ID checks run', async () => {
  const missing = projectRepo();
  git(missing, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  const directFactory = await runPreflight({ worktree: missing, base: 'main', checks: [pathPolicyCheck(), secretScanCheck()] });
  assert.deepEqual(directFactory.checks.map(check => check.status), ['inconclusive', 'inconclusive']);

  let sameIdRan = false;
  const sameId = await runPreflight({ worktree: missing, base: 'main', checks: [{ id: 'secret-scan', run: () => { sameIdRan = true; return { status: 'pass', evidence: ['custom'] }; } }] });
  assert.equal(sameIdRan, true);
  assert.equal(sameId.checks[0]?.status, 'pass');
});

test('custom check failure message is retained when trusted policy is unavailable', async () => {
  const root = projectRepo();
  git(root, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  const result = await runPreflight({ worktree: root, base: 'main', checks: [{ id: 'custom', run: () => { throw new Error('custom diagnostic'); } }] });
  assert.equal(result.checks[0]?.status, 'inconclusive');
  assert.match(result.checks[0]?.evidence.join('\n') ?? '', /custom diagnostic/);
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

test('custom checks still run when trusted policy is missing or invalid', async () => {
  const missing = projectRepo();
  git(missing, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  let missingRan = false;
  const missingResult = await runPreflight({ worktree: missing, base: 'main', checks: [{ id: 'custom', run: () => { missingRan = true; return { status: 'pass', evidence: ['custom ran'] }; } }] });
  assert.equal(missingRan, true);
  assert.equal(missingResult.checks[0]?.status, 'pass');

  const invalid = projectRepo({ forbiddenPathGlobs: [] });
  writeFileSync(join(invalid, '.harness', 'preflight.json'), '{broken');
  git(invalid, 'add', '.harness/preflight.json'); git(invalid, 'commit', '-q', '-m', 'invalid trusted policy');
  git(invalid, 'update-ref', 'refs/heads/main', 'HEAD');
  git(invalid, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  let invalidRan = false;
  const invalidResult = await runPreflight({ worktree: invalid, base: 'main', checks: [{ id: 'custom', run: () => { invalidRan = true; return { status: 'pass', evidence: ['custom ran'] }; } }] });
  assert.equal(invalidRan, true);
  assert.equal(invalidResult.checks[0]?.status, 'pass');
});

test('policy-unavailable handling does not short-circuit caller checks with built-in IDs', async () => {
  const checkIds = ['path-policy', 'secret-scan'] as const;
  const makeChecks = (calls: string[]) => checkIds.map(id => ({
    id,
    run() { calls.push(id); return { status: 'pass' as const, evidence: [`caller ${id} ran`] }; },
  }));

  const missing = projectRepo();
  git(missing, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  const missingCalls: string[] = [];
  const missingResult = await runPreflight({ worktree: missing, base: 'main', checks: makeChecks(missingCalls) });
  assert.deepEqual(missingCalls.sort(), [...checkIds].sort());
  assert.deepEqual(missingResult.checks.map(check => check.status), ['pass', 'pass']);

  const invalid = projectRepo({ forbiddenPathGlobs: [] });
  writeFileSync(join(invalid, '.harness/preflight.json'), '{broken');
  git(invalid, 'add', '.harness/preflight.json'); git(invalid, 'commit', '-q', '-m', 'invalid trusted policy');
  git(invalid, 'update-ref', 'refs/heads/main', 'HEAD');
  git(invalid, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const invalidCalls: string[] = [];
  const invalidResult = await runPreflight({ worktree: invalid, base: 'main', checks: makeChecks(invalidCalls) });
  assert.deepEqual(invalidCalls.sort(), [...checkIds].sort());
  assert.deepEqual(invalidResult.checks.map(check => check.status), ['pass', 'pass']);
});

test('runPreflight honors trusted committed gitlink acknowledgements for updates and additions', async () => {
  const root = projectRepo();
  const updateSource = makeTempRoot('preflight-ack-update-src-');
  git(updateSource, 'init', '-q', '-b', 'main');
  git(updateSource, 'config', 'user.email', 'sub@example.com'); git(updateSource, 'config', 'user.name', 'Sub');
  writeFileSync(join(updateSource, 'source.txt'), 'version A\n');
  git(updateSource, 'add', '.'); git(updateSource, 'commit', '-q', '-m', 'source A');
  const idA = gitOutput(updateSource, 'rev-parse', 'HEAD');
  writeFileSync(join(updateSource, 'source.txt'), 'version B\n');
  git(updateSource, 'add', '.'); git(updateSource, 'commit', '-q', '-m', 'source B');
  const idB = gitOutput(updateSource, 'rev-parse', 'HEAD');

  const addSource = makeTempRoot('preflight-ack-add-src-');
  git(addSource, 'init', '-q', '-b', 'main');
  git(addSource, 'config', 'user.email', 'sub@example.com'); git(addSource, 'config', 'user.name', 'Sub');
  writeFileSync(join(addSource, 'source.txt'), 'new source\n');
  git(addSource, 'add', '.'); git(addSource, 'commit', '-q', '-m', 'new source');
  const idNew = gitOutput(addSource, 'rev-parse', 'HEAD');

  git(root, 'checkout', '-q', 'main');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', updateSource.replaceAll('\\', '/'), 'vendor/update');
  git(join(root, 'vendor/update'), 'checkout', '-q', idA);
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'base gitlink');
  mkdirSync(join(root, '.harness'), { recursive: true });
  const acks = [
    { path: 'vendor/update', oldId: idA.toUpperCase(), newId: idB.toUpperCase(), justification: 'Reviewed updated upstream source.' },
    { path: 'vendor/added', newId: idNew.toUpperCase(), justification: 'Reviewed added upstream source.' },
  ];
  writeFileSync(join(root, '.harness', 'preflight.json'), JSON.stringify({ gitlinkAcknowledgements: acks }));
  git(root, 'add', '.harness/preflight.json'); git(root, 'commit', '-q', '-m', 'trusted gitlink acknowledgements');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const policyCommit = gitOutput(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'task'); git(root, 'merge', '-q', '--ff-only', 'main');

  git(join(root, 'vendor/update'), 'checkout', '-q', idB);
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', addSource.replaceAll('\\', '/'), 'vendor/added');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'update and add gitlinks');
  const checks = [changesetCheck, policyIntegrityCheck, secretScanCheck([], () => ({ backend: 'builtin', complete: true, findings: [] }))];

  const clean = await runPreflight({ worktree: root, base: 'main', checks });
  const cleanScan = clean.checks.find(check => check.id === 'secret-scan')!;
  assert.equal(cleanScan.status, 'warn', JSON.stringify(clean));
  assert.equal(exitCodeFor(clean), 0, JSON.stringify(clean));
  assert.equal(clean.metrics['secret-scan.acknowledgedPaths'], 2, JSON.stringify(clean));
  assert.match(cleanScan.evidence.join('\n'), /vendor\/update/);
  assert.match(cleanScan.evidence.join('\n'), /vendor\/added/);
  assert.ok(cleanScan.evidence.join('\n').includes(policyCommit), 'evidence identifies the exact trusted policy commit');

  writeFileSync(join(root, '.harness', 'preflight.json'), JSON.stringify({ gitlinkAcknowledgements: [
    { path: 'vendor/update', newId: idB, justification: 'Omitted before ID must not acknowledge a modified gitlink.' },
  ] }));
  git(root, 'add', '.harness/preflight.json'); git(root, 'commit', '-q', '-m', 'test omitted old gitlink acknowledgement');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const omittedOldIdResult = await runPreflight({ worktree: root, base: 'main', checks });
  const omittedOldIdScan = omittedOldIdResult.checks.find(check => check.id === 'secret-scan')!;
  assert.equal(omittedOldIdResult.metrics['secret-scan.acknowledgedPaths'], 0);
  assert.equal(omittedOldIdScan.status, 'inconclusive', JSON.stringify(omittedOldIdResult));
  assert.match(omittedOldIdScan.evidence.join('\n'), /unmatched: 1/);

  writeFileSync(join(root, '.harness', 'preflight.json'), JSON.stringify({ gitlinkAcknowledgements: acks }));
  git(root, 'add', '.harness/preflight.json'); git(root, 'commit', '-q', '-m', 'restore positive gitlink acknowledgements');
  git(root, 'update-ref', 'refs/remotes/origin/main', policyCommit);

  writeFileSync(join(root, 'vendor/update', 'untracked.txt'), 'nested dirty content\n');
  const dirty = await runPreflight({ worktree: root, base: 'main', checks });
  assert.equal(dirty.checks.find(check => check.id === 'secret-scan')?.status, 'inconclusive');
  assert.equal(exitCodeFor(dirty), 2);
  assert.match(dirty.checks.find(check => check.id === 'secret-scan')!.evidence.join('\n'), /vendor\/update/);
  rmSync(join(root, 'vendor/update', 'untracked.txt'));

  writeFileSync(join(root, '.harness/preflight.json'), JSON.stringify({ gitlinkAcknowledgements: [] }));
  const candidateEdit = await runPreflight({ worktree: root, base: 'main', checks });
  assert.equal(candidateEdit.checks.find(check => check.id === 'policy-integrity')?.status, 'block');
  assert.equal(candidateEdit.checks.find(check => check.id === 'secret-scan')?.status, 'warn', 'the candidate acknowledgement edit does not replace trusted acknowledgements');
  assert.equal(exitCodeFor(candidateEdit), 1);
  assert.ok(candidateEdit.checks.find(check => check.id === 'secret-scan')!.evidence.join('\n').includes(policyCommit));
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

const noGitleaks: typeof scanAddedText = (changes, dependencies) => scanAddedText(changes, { ...dependencies, probe: () => ({ available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' }) });

/** Repository whose trusted `origin/HEAD` commit carries the given `.harness/preflight.json` (a string is written as-is). */
function policyRepo(config?: unknown): string {
  const root = projectRepo();
  if (config === undefined) return root;
  mkdirSync(join(root, '.harness'), { recursive: true });
  writeFileSync(join(root, '.harness', 'preflight.json'), typeof config === 'string' ? config : JSON.stringify(config));
  git(root, 'add', '.harness/preflight.json'); git(root, 'commit', '-q', '-m', 'trusted policy');
  git(root, 'update-ref', 'refs/heads/main', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return root;
}

function policyRow(result: { checks: { id: string; status: string; evidence: string[] }[] }) {
  return result.checks.find(check => check.id === 'policy');
}

test('preflight policy schema rejects unknown keys at every level and unsupported versions, naming the file', () => {
  const rejected: [unknown, RegExp][] = [
    [{ weaken: true }, /unknown top-level setting "weaken"/],
    [{ checks: { 'path-policy': { enabled: true, extra: 1 } } }, /checks\.path-policy has unknown setting "extra"/],
    [{ forbiddenPathGlobs: { mode: 'add', globs: [], extra: 1 } }, /forbiddenPathGlobs has unknown setting "extra"/],
    [{ version: 2 }, /version must be 1/],
    [{ version: '1' }, /version must be 1/],
  ];
  for (const [config, pattern] of rejected) {
    assert.throws(() => validatePreflightConfig(JSON.stringify(config)), (error: unknown) => error instanceof Error && pattern.test(error.message) && error.message.includes('.harness/preflight.json'), JSON.stringify(config));
  }
  assert.equal(validatePreflightConfig('{}').version, 1);
  assert.equal(validatePreflightConfig(JSON.stringify({ version: 1 })).version, 1);
  assert.throws(() => validatePreflightConfig('[]'), /\.harness\/preflight\.json/);
  assert.throws(() => validatePreflightConfig('{broken'), /not valid JSON/);
});

test('fixed check IDs are rejected as fixed, unknown IDs are rejected, and enabled and severity are typed', () => {
  for (const id of ['changeset', 'base-context', 'policy-integrity', 'policy', 'secret-scan', 'worktree-boundary']) {
    assert.throws(() => validatePreflightConfig(JSON.stringify({ checks: { [id]: { enabled: false } } })), /is a fixed check.*path-policy/, id);
  }
  assert.throws(() => validatePreflightConfig(JSON.stringify({ checks: { nope: {} } })), /is not a known check.*path-policy/);
  assert.throws(() => validatePreflightConfig(JSON.stringify({ checks: { 'path-policy': { enabled: 'no' } } })), /enabled must be true or false/);
  assert.throws(() => validatePreflightConfig(JSON.stringify({ checks: { 'path-policy': { severity: 'fatal' } } })), /severity must be "block" or "warn"/);
});

test('forbiddenPathGlobs accepts the array and object forms, rejects unsafe globs, and requires prodGlobs and testGlobs together', () => {
  assert.deepEqual(validatePreflightConfig(JSON.stringify({ forbiddenPathGlobs: ['**/*.bin'] })).forbiddenPathGlobs, { mode: 'replace', globs: ['**/*.bin'] });
  assert.deepEqual(validatePreflightConfig(JSON.stringify({ forbiddenPathGlobs: [] })).forbiddenPathGlobs, { mode: 'replace', globs: [] });
  assert.deepEqual(validatePreflightConfig(JSON.stringify({ forbiddenPathGlobs: { mode: 'add', globs: ['**/*.bin'] } })).forbiddenPathGlobs, { mode: 'add', globs: ['**/*.bin'] });
  assert.deepEqual(validatePreflightConfig(JSON.stringify({ forbiddenPathGlobs: { mode: 'replace', globs: [] } })).forbiddenPathGlobs, { mode: 'replace', globs: [] });
  for (const value of ['x', { mode: 'merge', globs: [] }, { mode: 'add' }, ['/absolute/path'], ['../escape'], { mode: 'add', globs: 'x' }]) {
    assert.throws(() => validatePreflightConfig(JSON.stringify({ forbiddenPathGlobs: value })), /\.harness\/preflight\.json/, JSON.stringify(value));
  }
  assert.throws(() => validatePreflightConfig(JSON.stringify({ prodGlobs: ['src/**'] })), /given together/);
  assert.deepEqual(validatePreflightConfig(JSON.stringify({ prodGlobs: ['src/**'], testGlobs: ['test/**'] })).prodGlobs, ['src/**']);
  assert.deepEqual([...effectiveForbiddenGlobs('add', ['custom/**'])].slice(-1), ['custom/**']);
  assert.deepEqual([...effectiveForbiddenGlobs('replace', ['custom/**'])], ['custom/**']);
});

test('severity changes only block and warn, a disabled path-policy is skipped and listed, and inert forbidden globs warn', async () => {
  assert.equal(applySeverity('block', 'warn'), 'warn');
  assert.equal(applySeverity('warn', 'block'), 'block');
  assert.equal(applySeverity('pass', 'block'), 'pass');
  assert.equal(applySeverity('inconclusive', 'warn'), 'inconclusive');

  const warned = policyRepo({ checks: { 'path-policy': { severity: 'warn' } }, forbiddenPathGlobs: ['**/*.pem'] });
  writeFileSync(join(warned, 'candidate.pem'), 'ordinary text\n');
  const warnResult = await runPreflight({ worktree: warned, base: 'main', secretScanner: noGitleaks });
  assert.equal(warnResult.checks.find(check => check.id === 'path-policy')?.status, 'warn');
  assert.ok(warnResult.warnings.some(line => line.startsWith('path-policy: Sensitive path rule matched')));

  const disabled = policyRepo({ checks: { 'path-policy': { enabled: false } }, forbiddenPathGlobs: ['**/*.pem'] });
  writeFileSync(join(disabled, 'candidate.pem'), 'ordinary text\n');
  const disabledResult = await runPreflight({ worktree: disabled, base: 'main', secretScanner: noGitleaks });
  assert.equal(disabledResult.checks.some(check => check.id === 'path-policy'), false, 'a disabled configurable check is skipped');
  assert.match(policyRow(disabledResult)?.evidence.join('\n') ?? '', /Disabled checks: path-policy\./);
  assert.equal(policyRow(disabledResult)?.status, 'warn', 'forbiddenPathGlobs is inert while path-policy is disabled');
});

test('severity applies only to a built-in configurable instance, never to a caller-supplied check with the same ID or marker', async () => {
  const warnPolicy = policyRepo({ checks: { 'path-policy': { severity: 'warn' } } });
  writeFileSync(join(warnPolicy, 'candidate.pem'), 'ordinary text\n');
  const builtIn = await runPreflight({ worktree: warnPolicy, base: 'main', checks: [pathPolicyCheck()] });
  assert.equal(builtIn.checks[0]?.status, 'warn', 'a built-in configurable instance that blocks becomes warn');

  const withOldMarker = await runPreflight({ worktree: warnPolicy, base: 'main', checks: [
    { id: 'path-policy', policy: { configurable: true }, run: () => ({ status: 'block' as const, evidence: ['caller block with a marker'] }) } as PreflightCheck,
  ] });
  assert.equal(withOldMarker.checks[0]?.status, 'block', 'a caller-supplied object that sets a marker field is not downgraded');

  const sameId = await runPreflight({ worktree: warnPolicy, base: 'main', checks: [{ id: 'path-policy', run: () => ({ status: 'block' as const, evidence: ['caller block'] }) }] });
  assert.equal(sameId.checks[0]?.status, 'block', 'a caller-supplied check with the same ID keeps its status');

  const inherited = await runPreflight({ worktree: warnPolicy, base: 'main', checks: [{ id: 'constructor', run: () => ({ status: 'pass' as const, evidence: ['caller constructor'] }) }] });
  assert.equal(inherited.checks[0]?.status, 'pass', 'an inherited property name never supplies a severity');
});

test('add and replace forbidden-glob modes change the effective list, and the row reports the mode and count', async () => {
  const added = policyRepo({ forbiddenPathGlobs: { mode: 'add', globs: ['**/*.bin'] } });
  writeFileSync(join(added, '.env.local'), 'ordinary text\n');
  writeFileSync(join(added, 'artifact.bin'), 'ordinary text\n');
  const addedResult = await runPreflight({ worktree: added, base: 'main', secretScanner: noGitleaks });
  assert.match(addedResult.blocking.join('\n'), /path-policy: Sensitive path rule matched: \.env\.local/, 'default rules stay in force under add');
  assert.match(addedResult.blocking.join('\n'), /path-policy: Sensitive path rule matched: artifact\.bin/, 'added globs apply');
  assert.match(policyRow(addedResult)?.evidence.join('\n') ?? '', /Forbidden path globs: mode add, \d+ glob\(s\)\./);

  const replaced = policyRepo({ forbiddenPathGlobs: { mode: 'replace', globs: [] } });
  writeFileSync(join(replaced, '.env.local'), 'ordinary text\n');
  const replacedResult = await runPreflight({ worktree: replaced, base: 'main', secretScanner: noGitleaks });
  assert.equal(replacedResult.checks.find(check => check.id === 'path-policy')?.status, 'pass', 'an empty replace list drops the built-in rules');
  assert.match(policyRow(replacedResult)?.evidence.join('\n') ?? '', /Forbidden path globs: mode replace, 0 glob\(s\)\./);
});

test('recorded prodGlobs and testGlobs are not enforced, so the policy row warns', async () => {
  const root = policyRepo({ prodGlobs: ['src/**'], testGlobs: ['test/**'] });
  const result = await runPreflight({ worktree: root, base: 'main', secretScanner: noGitleaks });
  assert.equal(policyRow(result)?.status, 'warn');
  assert.match(policyRow(result)?.evidence.join('\n') ?? '', /prodGlobs and testGlobs are recorded for BH-070 and not enforced yet/);
  assert.ok(result.warnings.some(line => line.startsWith('policy: ')));
});

test('a worktree edit to the policy file does not weaken the trusted policy in force', async () => {
  const root = policyRepo({ forbiddenPathGlobs: ['**/*.pem'] });
  writeFileSync(join(root, 'candidate.pem'), 'ordinary text\n');
  mkdirSync(join(root, '.harness'), { recursive: true });
  writeFileSync(join(root, '.harness', 'preflight.json'), JSON.stringify({ checks: { 'path-policy': { enabled: false } }, forbiddenPathGlobs: [] }));
  const result = await runPreflight({ worktree: root, base: 'main', secretScanner: noGitleaks });
  assert.equal(result.checks.find(check => check.id === 'policy-integrity')?.status, 'block');
  assert.equal(result.checks.find(check => check.id === 'path-policy')?.status, 'block', 'the trusted policy keeps path-policy enabled with its globs');
  assert.match(policyRow(result)?.evidence.join('\n') ?? '', /Disabled checks: none\./);
});

test('the policy row names refs/remotes/origin/HEAD and the short commit, with and without --base', async () => {
  const root = policyRepo({ forbiddenPathGlobs: ['**/*.pem'] });
  const commit = gitOutput(root, 'rev-parse', 'refs/remotes/origin/HEAD').slice(0, 12);
  for (const base of [undefined, 'main']) {
    const result = await runPreflight({ worktree: root, ...(base === undefined ? {} : { base }), secretScanner: noGitleaks });
    const row = policyRow(result);
    assert.equal(row?.status, 'pass', JSON.stringify(result));
    assert.ok(row?.evidence[0]?.includes(`at refs/remotes/origin/HEAD (commit ${commit})`), row?.evidence[0]);
  }
});

test('a missing trusted ref gives the recovery hint, makes policy-dependent checks inconclusive, and exits 2', async () => {
  const root = policyRepo({ forbiddenPathGlobs: ['**/*.pem'] });
  git(root, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  const result = await runPreflight({ worktree: root, base: 'main', secretScanner: noGitleaks });
  for (const id of ['path-policy', 'secret-scan', 'policy']) {
    const check = result.checks.find(item => item.id === id);
    assert.equal(check?.status, 'inconclusive', id);
    assert.match(check?.evidence.join('\n') ?? '', /git remote set-head origin --auto/, id);
  }
  assert.equal(result.checks.find(check => check.id === 'changeset')?.status, 'pass');
  assert.equal(exitCodeFor(result), 2);
});

test('a corrupt trusted ref reports the Git failure rather than the missing-ref hint, and exits 2', async () => {
  const root = policyRepo({ forbiddenPathGlobs: ['**/*.pem'] });
  writeFileSync(join(root, '.git', 'refs', 'remotes', 'origin', 'main'), `${'1'.repeat(40)}\n`);
  const result = await runPreflight({ worktree: root, base: 'main', secretScanner: noGitleaks });
  const row = policyRow(result);
  assert.equal(row?.status, 'inconclusive');
  assert.match(row?.evidence.join('\n') ?? '', /Trusted preflight policy ref refs\/remotes\/origin\/HEAD could not be read: /);
  assert.doesNotMatch(row?.evidence.join('\n') ?? '', /unavailable; /, 'a Git failure is not reported as a missing ref');
  assert.equal(result.checks.find(check => check.id === 'path-policy')?.status, 'inconclusive');
  assert.equal(exitCodeFor(result), 2);
});

test('a policy object that disappears after the commit resolves is a Git failure, not an invalid policy', async () => {
  const root = policyRepo({ forbiddenPathGlobs: ['**/*.pem'] });
  const blob = gitOutput(root, 'rev-parse', 'refs/remotes/origin/HEAD:.harness/preflight.json');
  const loose = join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
  assert.ok(existsSync(loose), 'the policy blob is stored loose, so removing it makes cat-file fail after ls-tree succeeds');
  rmSync(loose);
  const result = await runPreflight({ worktree: root, base: 'main', secretScanner: noGitleaks });
  const row = policyRow(result)?.evidence.join('\n') ?? '';
  assert.match(row, /Trusted preflight policy ref refs\/remotes\/origin\/HEAD could not be read: \.harness\/preflight\.json: git cat-file failed: /);
  assert.doesNotMatch(row, /is invalid/, 'a Git failure is not reported as an invalid policy');
  assert.doesNotMatch(row, /selected base ref/);
  for (const id of ['path-policy', 'secret-scan', 'policy']) assert.equal(result.checks.find(check => check.id === id)?.status, 'inconclusive', id);
  assert.equal(exitCodeFor(result), 2);
});

test('DEFAULT_PREFLIGHT_CONFIG is a valid policy file that matches built-in behavior', () => {
  assert.deepEqual(validatePreflightConfig(JSON.stringify(DEFAULT_PREFLIGHT_CONFIG)).checks, { 'path-policy': { enabled: true, severity: 'block' } });
});

test('the default policy committed at origin/HEAD gives every check the same status as no policy file, apart from the policy row', async () => {
  const scenarios: [string, string | undefined][] = [['a clean changeset', undefined], ['a path the built-in rules match', 'candidate.pem']];
  const statuses = (result: { checks: { id: string; status: string }[] }) => result.checks.filter(check => check.id !== 'policy').map(check => [check.id, check.status]);
  for (const [name, changed] of scenarios) {
    const bare = projectRepo();
    const withDefault = policyRepo(DEFAULT_PREFLIGHT_CONFIG);
    if (changed !== undefined) {
      writeFileSync(join(bare, changed), 'ordinary text\n');
      writeFileSync(join(withDefault, changed), 'ordinary text\n');
    }
    const without = await runPreflight({ worktree: bare, base: 'main', secretScanner: noGitleaks });
    const withPolicy = await runPreflight({ worktree: withDefault, base: 'main', secretScanner: noGitleaks });
    assert.deepEqual(statuses(withPolicy), statuses(without), name);
    assert.equal(policyRow(without)?.status, 'pass', name);
    assert.equal(policyRow(withPolicy)?.status, 'pass', name);
  }
});

test('duplicate keys in the trusted policy and allowlist are refused, and the error names the file', async () => {
  assert.throws(() => validatePreflightConfig('{"forbiddenPathGlobs":[],"forbiddenPathGlobs":["**/*.pem"]}'), /Invalid \.harness\/preflight\.json: duplicate key "forbiddenPathGlobs"; keep one value/);
  assert.throws(() => validatePreflightConfig('{"checks":{"path-policy":{"enabled":true,"enabled":false}}}'), /Invalid \.harness\/preflight\.json: duplicate key "enabled"/);

  const root = policyRepo('{"forbiddenPathGlobs":[],"forbiddenPathGlobs":["**/*.pem"]}');
  const result = await runPreflight({ worktree: root, base: 'main', secretScanner: noGitleaks });
  assert.equal(result.checks.find(check => check.id === 'path-policy')?.status, 'inconclusive');
  assert.match(policyRow(result)?.evidence.join('\n') ?? '', /Invalid \.harness\/preflight\.json: duplicate key "forbiddenPathGlobs"/);

  const allowlistRoot = projectRepo();
  mkdirSync(join(allowlistRoot, '.harness'), { recursive: true });
  writeFileSync(join(allowlistRoot, '.harness', 'preflight-allowlist.json'), '[{"path":"a.ts","path":"b.ts","rule":"fixture","justification":"Reviewed."}]');
  git(allowlistRoot, 'add', '.harness/preflight-allowlist.json'); git(allowlistRoot, 'commit', '-q', '-m', 'duplicate allowlist key');
  git(allowlistRoot, 'update-ref', 'refs/heads/main', 'HEAD');
  assert.throws(() => loadProjectPreflightPolicy(allowlistRoot, 'main'), /\.harness\/preflight-allowlist\.json: duplicate key "path"/);
});

test('trusted policy errors begin with the file they concern, and an oversized file is reported as oversized', () => {
  const cases: [string, string, string | Buffer, string][] = [
    ['allowlist that is not an array', 'preflight-allowlist.json', '{}', '.harness/preflight-allowlist.json: Secret allowlist must be a JSON array.'],
    ['allowlist entry with an unknown setting', 'preflight-allowlist.json', JSON.stringify([{ path: 'a.ts', rule: 'x', justification: 'Reviewed.', extra: 1 }]), '.harness/preflight-allowlist.json: Secret allowlist entry contains an unknown setting.'],
    ['policy that is not UTF-8', 'preflight.json', Buffer.from([0xff, 0xfe]), '.harness/preflight.json: Trusted preflight policy files must be UTF-8 JSON.'],
    ['policy one byte over 1 MiB', 'preflight.json', Buffer.alloc(1024 * 1024 + 1, 0x20), '.harness/preflight.json: Trusted preflight policy files exceed 1 MiB.'],
    ['policy far over 1 MiB', 'preflight.json', Buffer.alloc(2 * 1024 * 1024, 0x20), '.harness/preflight.json: Trusted preflight policy files exceed 1 MiB.'],
  ];
  for (const [name, file, contents, message] of cases) {
    const root = projectRepo();
    mkdirSync(join(root, '.harness'), { recursive: true });
    writeFileSync(join(root, '.harness', file), contents);
    git(root, 'add', '.harness'); git(root, 'commit', '-q', '-m', name);
    git(root, 'update-ref', 'refs/heads/main', 'HEAD');
    assert.throws(() => loadProjectPreflightPolicy(root, 'main'), (error: unknown) => error instanceof Error && error.message === message, name);
  }
});

test('programmatic overrides are reported on the policy row and replace only their own values', async () => {
  const root = policyRepo({ forbiddenPathGlobs: ['**/*.pem'] });
  const result = await runPreflight({ worktree: root, base: 'main', sensitivePathGlobs: ['**/*.txt'], secretExceptions: [], secretScanner: noGitleaks });
  assert.match(policyRow(result)?.evidence.join('\n') ?? '', /Programmatic overrides: forbiddenPathGlobs, secretExceptions\./);
  assert.match(policyRow(result)?.evidence.join('\n') ?? '', /Forbidden path globs: mode replace, 1 glob\(s\)\./);
});

test('custom checks run beside a configured policy file, and the policy does not change their status', async () => {
  const root = policyRepo({ checks: { 'path-policy': { enabled: false, severity: 'warn' } }, forbiddenPathGlobs: ['**/*.pem'] });
  const result = await runPreflight({ worktree: root, base: 'main', checks: [
    { id: 'path-policy', run: () => ({ status: 'block' as const, evidence: ['custom block'] }) },
    { id: 'custom', run: () => ({ status: 'pass' as const, evidence: ['custom pass'] }) },
  ] });
  assert.equal(result.checks.find(check => check.id === 'path-policy')?.status, 'block', 'an unmarked custom check is neither disabled nor re-severitied');
  assert.equal(result.checks.find(check => check.id === 'custom')?.status, 'pass');
});

function gitOutput(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
