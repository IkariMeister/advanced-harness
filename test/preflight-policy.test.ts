import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { updateContext } from '../src/project-context.ts';
import { defaultChecks, exitCodeFor, runPreflight } from '../src/preflight/runner.ts';
import {
  applySeverity,
  configurableCheckIds,
  DEFAULT_PREFLIGHT_POLICY,
  FIXED_CHECK_IDS,
  isInsideRealPath,
  validatePreflightPolicy,
  type EffectivePolicy,
  type PreflightPolicy,
} from '../src/preflight/policy.ts';
import { trustedCommit, TrustedRefMissingError } from '../src/preflight/trusted-context.ts';
import type { CheckResult, CheckStatus, PreflightCheck } from '../src/preflight/types.ts';
import { makeTempRoot } from './temp-directory.ts';

const contextSections = ['build', 'lint', 'unit', 'roborazzi', 'runtime', 'e2e'];
const configurableIds = ['path-policy'];
const file = 'AGENTS.md';
const schema = (value: unknown, ids: readonly string[] = configurableIds, contextFile?: string) => validatePreflightPolicy(value, { configurableIds: ids, file, ...(contextFile ? { contextFile } : {}) });
const messageOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function simulateOriginHead(root: string): void {
  git(root, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
}

function profile(root: string, baseBranch = 'main') {
  const checks = Object.fromEntries(contextSections.map((name) => [name, { status: 'unconfigured' }]));
  return { version: 1, baseBranch, shell: 'bash', checks, device: { preference: 'ask' }, worktreeDirectory: join(root, '..', 'wt'), memoryPath: join(root, '..', 'mem', 'MEMORY.md') };
}

/** Project settings plus an optional preflight section, as harness:setup writes them. */
function contextText(root: string, policy?: unknown): string {
  const text = updateContext('', 'project', profile(root), []);
  return policy === undefined ? text : updateContext(text, 'preflight', policy, []);
}

/**
 * Repo on `main` whose AGENTS.md carries `trustedPolicy` (none when undefined). Simulates origin/HEAD unless
 * `originHead` is false. The task branch is checked out with a clean worktree.
 */
function policyRepo(trustedPolicy?: unknown, options: { originHead?: boolean } = {}): string {
  const root = makeTempRoot('preflight-policy-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(root, 'AGENTS.md'), contextText(root, trustedPolicy));
  writeFileSync(join(root, 'keep.txt'), 'keep\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'trusted context on main');
  if (options.originHead !== false) simulateOriginHead(root);
  git(root, 'checkout', '-q', '-b', 'task');
  return root;
}

const resultOf = (result: { checks: CheckResult[] }, id: string) => result.checks.find((check) => check.id === id);
const policyEvidence = (result: { checks: CheckResult[] }) => resultOf(result, 'policy')?.evidence.join('\n') ?? '';

const configurable = (id: string, status: CheckStatus): PreflightCheck => ({ id, policy: { configurable: true }, run: () => ({ status, evidence: [`${id} evidence`] }) });

// --- Schema -----------------------------------------------------------------

test('a minimal and a complete valid policy are accepted, unchanged', () => {
  assert.deepEqual(schema({ version: 1 }), { version: 1 });
  const complete: PreflightPolicy = {
    version: 1,
    checks: { 'path-policy': { enabled: true, severity: 'warn' } },
    forbiddenGlobs: { mode: 'add', globs: ['**/*.secret', 'config/*.json'] },
    prodGlobs: ['src/**'],
    testGlobs: ['test/**'],
    allowlistPath: '.harness/allow.json',
  };
  assert.equal(schema(complete), complete);
  assert.equal(schema(DEFAULT_PREFLIGHT_POLICY), DEFAULT_PREFLIGHT_POLICY);
});

test('each documented schema error names the file and the JSON path', () => {
  assert.equal(messageOf(() => schema({ version: 1, checks: { 'path-policy': { severity: 'error' } } })), 'AGENTS.md preflight policy: checks.path-policy.severity must be "block" or "warn" (got "error").');
  assert.equal(messageOf(() => schema({ version: 1, forbidenGlobs: { mode: 'add', globs: ['a'] } })), 'AGENTS.md preflight policy: unknown key "forbidenGlobs"; allowed: version, checks, forbiddenGlobs, prodGlobs, testGlobs, allowlistPath.');
  assert.equal(messageOf(() => schema({ version: 1, forbiddenGlobs: { mode: 'add', globs: ['**/*.a', 'x/**', 'src/{a,b}/**'] } })), 'AGENTS.md preflight policy: forbiddenGlobs.globs[2] "src/{a,b}/**" uses unsupported syntax "{"; use *, ** or ? only.');
  assert.equal(messageOf(() => schema({ version: 1, prodGlobs: ['src/**'] })), 'AGENTS.md preflight policy: prodGlobs is set but testGlobs is missing; set both or neither.');
  assert.equal(messageOf(() => schema({ version: 1, allowlistPath: '../shared/allow.json' })), 'AGENTS.md preflight policy: allowlistPath "../shared/allow.json" leaves the project; use a path inside the repository.');
});

test('unknown keys are rejected at every level, with the level named', () => {
  assert.match(messageOf(() => schema({ version: 1, checks: { 'path-policy': { enabled: true, color: 'red' } } })) ?? '', /unknown key "color" at checks\.path-policy; allowed: enabled, severity\./);
  assert.match(messageOf(() => schema({ version: 1, forbiddenGlobs: { mode: 'add', globs: ['a'], extra: 1 } })) ?? '', /unknown key "extra" at forbiddenGlobs; allowed: mode, globs\./);
});

test('version, enablement, and mode are checked with actionable messages', () => {
  assert.equal(messageOf(() => schema({ checks: {} })), 'AGENTS.md preflight policy: version must be 1 (got missing).');
  assert.equal(messageOf(() => schema({ version: 2 })), 'AGENTS.md preflight policy: version must be 1 (got 2).');
  assert.match(messageOf(() => schema({ version: 1, checks: { 'path-policy': { enabled: 'yes' } } })) ?? '', /checks\.path-policy\.enabled must be true or false/);
  assert.match(messageOf(() => schema({ version: 1, forbiddenGlobs: { mode: 'merge', globs: ['a'] } })) ?? '', /forbiddenGlobs\.mode must be "add" or "replace"/);
});

test('glob rules: non-empty, length, separators, relative, no .., no drive letter, no unsupported syntax, no duplicates, and count', () => {
  const forbidden = (globs: unknown) => messageOf(() => schema({ version: 1, forbiddenGlobs: { mode: 'add', globs } })) ?? '';
  assert.match(forbidden(['']), /globs\[0\] must be a non-empty string/);
  assert.match(forbidden(['a'.repeat(257)]), /globs\[0\] is longer than 256 characters/);
  assert.match(forbidden(['a\\b']), /must use forward slashes only/);
  assert.match(forbidden(['/abs/x']), /must not start with "\/"/);
  assert.match(forbidden(['C:/x']), /must not start with a drive letter/);
  assert.match(forbidden(['a/../b']), /has a "\.\." segment/);
  assert.match(forbidden(['a\nb']), /must not contain NUL, CR, or LF/);
  for (const ch of ['[', ']', '}', '!']) assert.match(forbidden([`x${ch}y`]), new RegExp(`uses unsupported syntax "\\${ch}"`));
  assert.match(forbidden(['**/*.PEM', '**/*.pem']), /globs\[1\] "\*\*\/\*\.pem" duplicates an earlier glob/);
  assert.match(forbidden([]), /must list 1 to 200 globs \(got 0 entries\)/);
  assert.match(forbidden(Array.from({ length: 201 }, (_, i) => `g${i}/**`)), /must list 1 to 200 globs \(got 201 entries\)/);
  assert.equal(schema({ version: 1, forbiddenGlobs: { mode: 'add', globs: Array.from({ length: 200 }, (_, i) => `g${i}/**`) } }).version, 1);
});

test('allowlistPath: relative POSIX, inside the project, outside .git, and not the context file itself', () => {
  const allow = (allowlistPath: string, contextFile?: string) => messageOf(() => schema({ version: 1, allowlistPath }, configurableIds, contextFile)) ?? '';
  assert.match(allow('/etc/allow.json'), /is absolute/);
  assert.match(allow('C:/allow.json'), /is absolute/);
  assert.match(allow('dir\\allow.json'), /must use forward slashes/);
  assert.match(allow('.git/allow.json'), /is inside \.git\//);
  assert.match(allow('x/.GIT/allow.json'), /is inside \.git\//);
  assert.match(allow('AGENTS.md', 'AGENTS.md'), /is the context file itself/);
  assert.match(allow('./allow.json'), /empty or "\." segment/);
  assert.equal(schema({ version: 1, allowlistPath: 'AGENTS.md.allow' }, configurableIds, 'AGENTS.md').allowlistPath, 'AGENTS.md.allow');
});

test('prodGlobs and testGlobs must be set together', () => {
  assert.equal(messageOf(() => schema({ version: 1, testGlobs: ['test/**'] })), 'AGENTS.md preflight policy: testGlobs is set but prodGlobs is missing; set both or neither.');
  assert.equal(schema({ version: 1, prodGlobs: ['src/**'], testGlobs: ['test/**'] }).version, 1);
});

test('fixed checks are never configurable and unknown ids list the configurable ones', () => {
  for (const id of FIXED_CHECK_IDS) {
    const message = messageOf(() => schema({ version: 1, checks: { [id]: { enabled: false } } })) ?? '';
    assert.match(message, new RegExp(`checks\\.${id} is not configurable: ${id} is a fixed check`));
    assert.match(message, /Configurable checks: path-policy\./);
  }
  assert.match(messageOf(() => schema({ version: 1, checks: { 'secret-scan': { severity: 'warn' } } })) ?? '', /checks\.secret-scan is not configurable: secret-scan is a fixed check/);
  assert.match(messageOf(() => schema({ version: 1, checks: { nope: {} } })) ?? '', /checks\.nope is not a known check id\. Configurable checks: path-policy\./);
});

test('the configurable ids come from the registry marker, and the setup list agrees with the default registry', () => {
  assert.deepEqual(configurableCheckIds(defaultChecks), ['path-policy']);
  assert.deepEqual(configurableCheckIds([configurable('custom', 'pass'), { id: 'plain', run: () => ({ status: 'pass', evidence: [] }) }]), ['custom']);
});

test('applySeverity moves block and warn in both directions and never changes pass or inconclusive', () => {
  assert.deepEqual(applySeverity({ status: 'block', evidence: ['x'] }, 'warn'), { status: 'warn', evidence: ['x', 'severity block→warn by project policy (trusted ref)'] });
  assert.deepEqual(applySeverity({ status: 'warn', evidence: ['x'] }, 'block'), { status: 'block', evidence: ['x', 'severity warn→block by project policy (trusted ref)'] });
  assert.deepEqual(applySeverity({ status: 'block', evidence: ['x'] }, 'block'), { status: 'block', evidence: ['x'] });
  assert.deepEqual(applySeverity({ status: 'pass', evidence: ['x'] }, 'block'), { status: 'pass', evidence: ['x'] });
  assert.deepEqual(applySeverity({ status: 'inconclusive', evidence: ['x'] }, 'warn'), { status: 'inconclusive', evidence: ['x'] });
  assert.deepEqual(applySeverity({ status: 'warn', evidence: ['x'] }, undefined), { status: 'warn', evidence: ['x'] });
});

test('fixed-check and unknown-id rejections surface as inconclusive runs, not as a silent skip', async () => {
  const fixed = policyRepo({ version: 1, checks: { 'secret-scan': { enabled: false } } });
  const fixedResult = await runPreflight({ worktree: fixed, base: 'main' });
  assert.equal(exitCodeFor(fixedResult), 2);
  assert.match(resultOf(fixedResult, 'policy')?.evidence[0] ?? '', /checks\.secret-scan is not configurable: secret-scan is a fixed check/);
  assert.equal(fixedResult.checks.every((check) => check.status === 'inconclusive'), true);

  const unknown = policyRepo({ version: 1, checks: { 'no-such-check': { severity: 'warn' } } });
  const unknownResult = await runPreflight({ worktree: unknown, base: 'main' });
  assert.equal(exitCodeFor(unknownResult), 2);
  assert.match(resultOf(unknownResult, 'policy')?.evidence[0] ?? '', /not a known check id\. Configurable checks: path-policy/);
});

// --- Trusted ref ------------------------------------------------------------

test('the trusted policy takes effect with and without --base, and a worktree copy never does', async () => {
  const root = policyRepo({ version: 1, forbiddenGlobs: { mode: 'replace', globs: ['**/*.nothing'] } });
  writeFileSync(join(root, '.env'), 'PLACEHOLDER=1\n');
  for (const options of [{ worktree: root }, { worktree: root, base: 'main' }]) {
    const result = await runPreflight(options);
    assert.equal(resultOf(result, 'path-policy')?.status, 'pass', JSON.stringify(result.checks));
    assert.match(policyEvidence(result), /Policy source: AGENTS\.md at trusted ref refs\/remotes\/origin\/HEAD/);
    assert.equal(resultOf(result, 'policy')?.status, 'pass');
  }
});

test('a weakened worktree policy is reported as warn while the trusted policy stays effective', async () => {
  const root = policyRepo({ version: 1, forbiddenGlobs: { mode: 'add', globs: ['**/*.secretdoc'] } });
  writeFileSync(join(root, 'AGENTS.md'), contextText(root, { version: 1, checks: { 'path-policy': { enabled: false } }, forbiddenGlobs: { mode: 'replace', globs: ['**/*.nothing'] } }));
  writeFileSync(join(root, 'id_rsa'), 'not a key\n');
  writeFileSync(join(root, 'notes.secretdoc'), 'note\n');
  const result = await runPreflight({ worktree: root, base: 'main' });
  const pathPolicy = resultOf(result, 'path-policy');
  assert.equal(pathPolicy?.status, 'block', JSON.stringify(pathPolicy));
  assert.ok(pathPolicy!.evidence.some((line) => line.includes('id_rsa')));
  assert.ok(pathPolicy!.evidence.some((line) => line.includes('notes.secretdoc')));
  assert.equal(resultOf(result, 'policy')?.status, 'warn');
  assert.match(policyEvidence(result), /differs from trusted ref refs\/remotes\/origin\/HEAD \(edited\); the change takes effect only after it reaches origin\/HEAD/);
  assert.match(policyEvidence(result), /Disabled checks: none\./);
  assert.equal(result.checks.some((check) => check.id === 'path-policy'), true);
});

test('a policy in a linked context file is read from the trusted ref; a worktree edit to that file is only reported', async () => {
  const root = makeTempRoot('preflight-policy-linked-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'HARNESS.md'), contextText(root, { version: 1, forbiddenGlobs: { mode: 'replace', globs: ['**/*.nothing'] } }));
  writeFileSync(join(root, 'AGENTS.md'), 'Read `docs/HARNESS.md` for Advanced Harness project settings before planning.\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'linked trusted context on main');
  simulateOriginHead(root);
  git(root, 'checkout', '-q', '-b', 'task');
  // The worktree edit disables path-policy. It must not take effect: the trusted policy keeps path-policy running.
  writeFileSync(join(root, 'docs', 'HARNESS.md'), contextText(root, { version: 1, checks: { 'path-policy': { enabled: false } } }));

  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(resultOf(result, 'path-policy')?.status, 'pass', JSON.stringify(result.checks));
  assert.equal(resultOf(result, 'policy')?.status, 'warn', JSON.stringify(result.checks));
  assert.match(policyEvidence(result), /Policy source: docs\/HARNESS\.md at trusted ref refs\/remotes\/origin\/HEAD\./);
  assert.match(policyEvidence(result), /worktree preflight policy \(docs\/HARNESS\.md\) differs from trusted ref refs\/remotes\/origin\/HEAD \(edited\)/);
  assert.match(policyEvidence(result), /Disabled checks: none\./);
});

test('--base does not skip the context read: an oversized worktree AGENTS.md makes every check inconclusive', async () => {
  const root = policyRepo({ version: 1 });
  writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(1024 * 1024 + 1));
  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(exitCodeFor(result), 2, JSON.stringify(result.checks));
  assert.ok(result.checks.every((check) => check.status === 'inconclusive'), JSON.stringify(result.checks));
  assert.match(policyEvidence(result), /Context must be a regular text file no larger than 1 MiB/);
});

test('--base does not skip the context read: a symlinked worktree AGENTS.md makes every check inconclusive (skipped without symlink privilege)', async (t) => {
  const root = policyRepo({ version: 1 });
  writeFileSync(join(root, 'real.md'), contextText(root, { version: 1 }));
  rmSync(join(root, 'AGENTS.md'));
  try { symlinkSync(join(root, 'real.md'), join(root, 'AGENTS.md'), 'file'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') { t.skip('symlink creation requires OS privilege'); return; } throw error; }
  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(exitCodeFor(result), 2, JSON.stringify(result.checks));
  assert.ok(result.checks.every((check) => check.status === 'inconclusive'), JSON.stringify(result.checks));
  assert.match(policyEvidence(result), /Context must be a regular text file no larger than 1 MiB/);
});

test('a worktree policy added where the trusted ref has none is reported as added, and has no effect', async () => {
  const root = policyRepo(undefined);
  writeFileSync(join(root, 'AGENTS.md'), contextText(root, { version: 1, checks: { 'path-policy': { enabled: false } } }));
  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(resultOf(result, 'policy')?.status, 'warn');
  assert.match(policyEvidence(result), /\(added\)/);
  assert.match(policyEvidence(result), /Policy source: none/);
  assert.equal(resultOf(result, 'path-policy')?.status, 'pass');
});

test('a trusted ref that is unavailable with a worktree policy is inconclusive with the set-head hint', async () => {
  const root = policyRepo(undefined, { originHead: false });
  writeFileSync(join(root, 'AGENTS.md'), contextText(root, { version: 1 }));
  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(exitCodeFor(result), 2, JSON.stringify(result));
  assert.ok(result.checks.every((check) => check.status === 'inconclusive'));
  assert.match(resultOf(result, 'policy')?.evidence[0] ?? '', /git remote set-head origin --auto/);
});

test('a trusted ref that is unavailable with no worktree policy behaves as before, with a built-in policy result', async () => {
  const root = policyRepo(undefined, { originHead: false });
  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(resultOf(result, 'base-context')?.status, 'pass', JSON.stringify(result));
  assert.equal(resultOf(result, 'policy')?.status, 'pass');
  assert.match(policyEvidence(result), /Trusted ref refs\/remotes\/origin\/HEAD is unavailable/);
});

test('(a) a Git failure reading the trusted ref is a load error with --base and no worktree policy: inconclusive (exit 2), not a pass', async () => {
  const root = policyRepo(undefined);
  // origin/HEAD still resolves to origin/main, but origin/main now names a commit object that does not exist.
  writeFileSync(join(root, '.git', 'refs', 'remotes', 'origin', 'main'), '0123456789abcdef0123456789abcdef01234567\n');
  let caught: unknown;
  try { trustedCommit(root); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error && !(caught instanceof TrustedRefMissingError), String(caught));
  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(exitCodeFor(result), 2, JSON.stringify(result));
  assert.ok(result.checks.every((check) => check.status === 'inconclusive'), JSON.stringify(result.checks));
  assert.match(resultOf(result, 'policy')?.evidence[0] ?? '', /Preflight policy could not be loaded: .*refs\/remotes\/origin\/HEAD/);
});

test('(b) a confirmed missing trusted ref with no worktree policy is not a load error: it still passes', async () => {
  const root = policyRepo(undefined, { originHead: false });
  assert.throws(() => trustedCommit(root), (error: unknown) => error instanceof TrustedRefMissingError);
  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(resultOf(result, 'policy')?.status, 'pass', JSON.stringify(result));
  assert.match(policyEvidence(result), /Policy source: none/);
  assert.equal(resultOf(result, 'base-context')?.status, 'pass', JSON.stringify(result));
});

test('an invalid trusted policy makes every check inconclusive with the reason', async () => {
  const root = policyRepo({ version: 1, checks: { 'path-policy': { severity: 'error' } } });
  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(exitCodeFor(result), 2);
  assert.ok(result.checks.every((check) => check.status === 'inconclusive'));
  assert.match(resultOf(result, 'policy')?.evidence[0] ?? '', /Preflight policy could not be loaded: AGENTS\.md preflight policy: checks\.path-policy\.severity must be "block" or "warn" \(got "error"\)\./);
});

test('an invalid worktree policy is reported as warn and does not apply', async () => {
  const root = policyRepo(undefined);
  writeFileSync(join(root, 'AGENTS.md'), contextText(root).replace('<!-- advanced-harness:project:end -->', '<!-- advanced-harness:project:end -->\n\n<!-- advanced-harness:preflight:start -->\n```json\n{"version": 1\n```\n<!-- advanced-harness:preflight:end -->'));
  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(resultOf(result, 'policy')?.status, 'warn', JSON.stringify(result.checks));
  assert.match(policyEvidence(result), /is invalid and does not apply/);
  assert.equal(resultOf(result, 'path-policy')?.status, 'pass');
});

// --- Severity, disabling, and built-in evidence -----------------------------

test('a registered check may not take the reserved policy id; the run is inconclusive with the reason', async () => {
  const root = policyRepo(undefined);
  const result = await runPreflight({ worktree: root, base: 'main', checks: [configurable('policy', 'pass')] });
  assert.equal(exitCodeFor(result), 2);
  assert.deepEqual(result.checks.map((check) => check.id), ['policy']);
  assert.equal(result.checks[0]?.status, 'inconclusive');
  assert.deepEqual(result.checks[0]?.evidence, ['Preflight check id "policy" is reserved for the built-in policy result.']);
});

test('severity overrides apply in both directions; pass and inconclusive are untouched', async () => {
  const root = policyRepo({ version: 1, checks: { custom: { severity: 'warn' }, other: { severity: 'block' }, okPass: { severity: 'block' }, inc: { severity: 'warn' } } });
  const checks = [configurable('custom', 'block'), configurable('other', 'warn'), configurable('okPass', 'pass'), configurable('inc', 'inconclusive')];
  const result = await runPreflight({ worktree: root, base: 'main', checks });
  assert.equal(resultOf(result, 'custom')?.status, 'warn');
  assert.deepEqual(resultOf(result, 'custom')?.evidence, ['custom evidence', 'severity block→warn by project policy (trusted ref)']);
  assert.equal(resultOf(result, 'other')?.status, 'block');
  assert.deepEqual(resultOf(result, 'other')?.evidence, ['other evidence', 'severity warn→block by project policy (trusted ref)']);
  assert.deepEqual(resultOf(result, 'okPass'), { id: 'okPass', status: 'pass', evidence: ['okPass evidence'] });
  assert.deepEqual(resultOf(result, 'inc'), { id: 'inc', status: 'inconclusive', evidence: ['inc evidence'] });
  assert.match(policyEvidence(result), /Severity set by project policy \(trusted ref\): custom=warn\./);
  assert.equal(exitCodeFor(result), 2);
});

test('disabled checks are skipped and listed in the policy evidence', async () => {
  const root = policyRepo({ version: 1, checks: { custom: { enabled: false } } });
  const checks = [configurable('custom', 'block'), configurable('other', 'warn')];
  const result = await runPreflight({ worktree: root, base: 'main', checks });
  assert.equal(resultOf(result, 'custom'), undefined);
  assert.equal(resultOf(result, 'other')?.status, 'warn');
  assert.match(policyEvidence(result), /Disabled by project policy \(trusted ref\); skipped, not run: custom\./);
  assert.deepEqual(result.checks.map((check) => check.id), ['other', 'policy']);
});

test('recorded keys no installed check consumes are reported as warn evidence: recorded but not enforced', async () => {
  const root = policyRepo({ version: 1, prodGlobs: ['src/**'], testGlobs: ['test/**'], allowlistPath: 'missing/allow.json' });
  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(resultOf(result, 'policy')?.status, 'warn');
  assert.match(policyEvidence(result), /Recorded but not enforced by any installed check yet: prodGlobs \(BH-070\), testGlobs \(BH-070\), allowlistPath \(BH-068\)\./);
  assert.match(policyEvidence(result), /Allowlist missing\/allow\.json: not present; no exceptions apply\./);
  assert.ok(result.warnings.some((line) => line.startsWith('policy: Recorded but not enforced')));
});

test('with no policy, the built-in policy result is present, passes, and says so', async () => {
  const root = policyRepo(undefined);
  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(resultOf(result, 'policy')?.status, 'pass');
  assert.match(policyEvidence(result), /Policy source: none\./);
  assert.deepEqual(result.checks.map((check) => check.id), ['base-context', 'changeset', 'path-policy', 'policy', 'secret-scan']);
});

test('the built-in policy result is sorted among the other checks', async () => {
  const root = policyRepo(undefined);
  const result = await runPreflight({ worktree: root, base: 'main', checks: [configurable('zeta', 'pass'), configurable('alpha', 'pass')] });
  assert.deepEqual(result.checks.map((check) => check.id), ['alpha', 'policy', 'zeta']);
});

// --- Allowlist --------------------------------------------------------------

test('an allowlist file in the worktree is resolved and reported; a missing one is evidence, not an error', async () => {
  const present = policyRepo({ version: 1, allowlistPath: 'allow.json' });
  writeFileSync(join(present, 'allow.json'), '[]\n');
  const presentResult = await runPreflight({ worktree: present, base: 'main' });
  assert.equal(exitCodeFor(presentResult), 0, JSON.stringify(presentResult.checks));
  assert.match(policyEvidence(presentResult), /Allowlist allow\.json resolved in the worktree: present\./);

  const missing = policyRepo({ version: 1, allowlistPath: 'config/allow.json' });
  const missingResult = await runPreflight({ worktree: missing, base: 'main' });
  assert.match(policyEvidence(missingResult), /Allowlist config\/allow\.json: not present; no exceptions apply\./);
  assert.notEqual(exitCodeFor(missingResult), 2);
});

test('an allowlist over 1 MiB is refused as a load error', async () => {
  const root = policyRepo({ version: 1, allowlistPath: 'big.json' });
  writeFileSync(join(root, 'big.json'), Buffer.alloc(1024 * 1024 + 1));
  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(exitCodeFor(result), 2);
  assert.match(resultOf(result, 'policy')?.evidence[0] ?? '', /allowlistPath "big\.json" exceeds 1 MiB/);
});

test('an allowlist file symlink escaping the worktree is refused (skipped without symlink privilege)', async (t) => {
  const root = policyRepo({ version: 1, allowlistPath: 'allow.json' });
  const outside = makeTempRoot('preflight-policy-outside-');
  writeFileSync(join(outside, 'allow.json'), '[]\n');
  try { symlinkSync(join(outside, 'allow.json'), join(root, 'allow.json'), 'file'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') { t.skip('symlink creation requires OS privilege'); return; } throw error; }
  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(exitCodeFor(result), 2);
  assert.match(resultOf(result, 'policy')?.evidence[0] ?? '', /symlink or junction at allow\.json/);
});

test('an allowlist path through a directory link escaping the worktree is refused (skipped without link privilege)', async (t) => {
  const root = policyRepo({ version: 1, allowlistPath: 'lists/allow.json' });
  const outside = makeTempRoot('preflight-policy-dirlink-');
  writeFileSync(join(outside, 'allow.json'), '[]\n');
  try { symlinkSync(outside, join(root, 'lists'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') { t.skip('directory links require OS privilege'); return; } throw error; }
  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(exitCodeFor(result), 2);
  assert.match(resultOf(result, 'policy')?.evidence[0] ?? '', /symlink or junction at lists|resolves outside the worktree/);
});

test('a parent directory segment in the allowlist path is refused by the schema', async () => {
  const root = policyRepo({ version: 1, allowlistPath: '../shared/allow.json' });
  const result = await runPreflight({ worktree: root, base: 'main' });
  assert.equal(exitCodeFor(result), 2);
  assert.match(resultOf(result, 'policy')?.evidence[0] ?? '', /leaves the project; use a path inside the repository/);
});

test('allowlistPath on win32 refuses .git with trailing dots or spaces and refuses any colon; POSIX keeps those names', () => {
  const check = (allowlistPath: string, platform: NodeJS.Platform) => messageOf(() => validatePreflightPolicy({ version: 1, allowlistPath }, { configurableIds, file, platform })) ?? '';
  for (const path of ['.git./allow.json', '.git /allow.json', 'x/.GIT. /allow.json', '.git../allow.json']) assert.match(check(path, 'win32'), /is inside \.git\//, path);
  for (const path of ['.git:stream/allow.json', 'allow.json:Zone.Identifier', 'x/a:b/allow.json']) {
    assert.match(check(path, 'win32'), /has a ":" in a segment; NTFS streams and drive syntax are refused\./, path);
    assert.match(check(path, 'linux'), /has a ":" in a segment/, path);
  }
  assert.equal(check('.git./allow.json', 'linux'), '');
  assert.equal(check('.gitignore/allow.json', 'win32'), '');
  assert.equal(check('x/.github/allow.json', 'win32'), '');
});

test('containment is platform-aware: win32 identity is case-insensitive and rejects escapes; POSIX is case-sensitive', () => {
  assert.equal(isInsideRealPath('C:\\Repo\\Allow.json', 'c:\\repo', 'win32'), true);
  assert.equal(isInsideRealPath('C:\\REPO\\sub\\allow.json', 'c:\\repo', 'win32'), true);
  assert.equal(isInsideRealPath('C:\\repo\\..\\other\\allow.json', 'C:\\repo', 'win32'), false);
  assert.equal(isInsideRealPath('D:\\repo\\allow.json', 'C:\\repo', 'win32'), false);
  assert.equal(isInsideRealPath('/Repo/allow.json', '/repo', 'linux'), false);
  assert.equal(isInsideRealPath('/repo/allow.json', '/repo', 'linux'), true);
  assert.equal(isInsideRealPath('/repo', '/repo', 'linux'), true);
});

// --- Effective policy shape -------------------------------------------------

test('the effective policy exposes the trusted-ref source, overrides, and the forbidden globs', async () => {
  const root = policyRepo({ version: 1, checks: { 'path-policy': { severity: 'warn' } }, forbiddenGlobs: { mode: 'add', globs: ['**/*.x'] } });
  const seen: EffectivePolicy[] = [];
  const probe: PreflightCheck = { id: 'probe', policy: { configurable: true, consumes: ['forbiddenGlobs'] }, run: ({ policy }) => { seen.push(policy); return { status: 'pass', evidence: [] }; } };
  const result = await runPreflight({ worktree: root, base: 'main', checks: [probe, configurable('path-policy', 'pass')] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.source, 'trusted-ref');
  assert.deepEqual(seen[0]!.forbiddenGlobs, { mode: 'add', globs: ['**/*.x'] });
  assert.deepEqual(seen[0]!.severity, { 'path-policy': 'warn' });
  assert.deepEqual(seen[0]!.inert, []);
  assert.equal(resultOf(result, 'probe')?.status, 'pass');
});
