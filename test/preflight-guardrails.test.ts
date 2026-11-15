import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { updateContext } from '../src/project-context.ts';
import { testChangeCheck } from '../src/preflight/checks.ts';
import { acceptanceCriteriaCheck, readAcceptanceCriteria } from '../src/preflight/criteria.ts';
import { exitCodeFor, formatHuman, runPreflight, type PreflightOptions } from '../src/preflight/runner.ts';
import { scanAddedText } from '../src/preflight/secret-scanner.ts';
import type { AcceptanceCriteriaInput, Changeset, PreflightResult } from '../src/preflight/types.ts';
import { makeTempRoot } from './temp-directory.ts';

const script = resolve(import.meta.dirname, '../scripts/preflight.ts');
const noGitleaks: typeof scanAddedText = (changes, dependencies) => scanAddedText(changes, { ...dependencies, probe: () => ({ available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' }) });
const PROD_TEST = { prodGlobs: ['src/**'], testGlobs: ['test/**'] };

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function cli(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

/**
 * A main checkout whose committed base holds project context, an optional trusted policy, and the given files,
 * plus a linked task worktree under worktreeDirectory (so worktree-boundary passes). origin/HEAD names the base.
 */
function taskRepo(options: { config?: unknown; files?: Record<string, string> } = {}): { root: string; worktree: string } {
  const baseDir = makeTempRoot('preflight-guard-');
  const root = join(baseDir, 'repo');
  const worktreeDirectory = join(baseDir, 'wt');
  mkdirSync(root);
  mkdirSync(worktreeDirectory);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  const checks = Object.fromEntries(['build', 'lint', 'unit', 'roborazzi', 'runtime', 'e2e'].map(name => [name, { status: 'unconfigured' }]));
  const profile = { version: 1, projectRoot: root, baseBranch: 'main', shell: 'bash', checks, device: { preference: 'ask' }, worktreeDirectory, memoryPath: join(baseDir, 'mem', 'MEMORY.md') };
  writeFileSync(join(root, 'AGENTS.md'), updateContext('', 'project', profile, []));
  if (options.config !== undefined) {
    mkdirSync(join(root, '.harness'));
    writeFileSync(join(root, '.harness', 'preflight.json'), JSON.stringify(options.config));
  }
  for (const [path, text] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const worktree = join(worktreeDirectory, 'task');
  git(root, 'worktree', 'add', '-q', '-b', 'task', worktree);
  return { root, worktree };
}

const run = (worktree: string, extra: Partial<PreflightOptions> = {}) => runPreflight({ worktree, base: 'main', secretScanner: noGitleaks, ...extra });
const statusOf = (result: PreflightResult, id: string) => result.checks.find(check => check.id === id)?.status;
const evidenceOf = (result: PreflightResult, id: string) => result.checks.find(check => check.id === id)?.evidence.join('\n') ?? '';
/** approved must equal the status rule alone: every executed check passed or warned. */
const derivedApproval = (result: PreflightResult) => result.checks.length > 0 && result.checks.every(check => check.status === 'pass' || check.status === 'warn');
const parseJson = (stdout: string) => JSON.parse(stdout) as PreflightResult;

function changeEntry(path: string, extra: Partial<Changeset['entries'][number]> = {}): Changeset['entries'][number] {
  return { path, status: 'modified', origin: 'committed', content: undefined, ...extra };
}

function changesetOf(entries: Changeset['entries']): Changeset {
  return { top: '/', base: 'main', baseSource: 'option', mergeBase: '', head: '', entries };
}

test('test-change passes with a not-run note when prodGlobs and testGlobs are not configured', async () => {
  const { worktree } = taskRepo({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  const result = await run(worktree);
  assert.equal(statusOf(result, 'test-change'), 'pass');
  assert.deepEqual(result.checks.find(check => check.id === 'test-change')?.evidence, ['prodGlobs/testGlobs not configured; check not run']);
  assert.equal(derivedApproval(result), true);
});

test('production changes warn without a test change, and a changed test file makes the check pass', async () => {
  const { worktree } = taskRepo({ config: PROD_TEST, files: { 'src/a.ts': 'export const a = 1;\n' } });
  writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  const warned = await run(worktree);
  assert.equal(statusOf(warned, 'test-change'), 'warn');
  assert.match(evidenceOf(warned, 'test-change'), /Production files changed \(1\) and no test files changed: src\/a\.ts\./);
  assert.ok(warned.warnings.some(line => line.startsWith('test-change: Production files changed')));
  assert.equal(exitCodeFor(warned), 0, 'a warning is evidence, not a block');
  assert.equal(warned.approved, derivedApproval(warned));

  mkdirSync(join(worktree, 'test'));
  writeFileSync(join(worktree, 'test', 'a.test.ts'), 'test("a", () => {});\n');
  const passed = await run(worktree);
  assert.equal(statusOf(passed, 'test-change'), 'pass');
  assert.match(evidenceOf(passed, 'test-change'), /Test files changed: 1; production files changed: 1\./);
});

test('severity block blocks a production-only change, and a justified bypass downgrades it while recording the text', async () => {
  const justification = 'Generated constant only; no behavior changed.';
  const { worktree } = taskRepo({ config: { ...PROD_TEST, checks: { 'test-change': { severity: 'block' } } }, files: { 'src/a.ts': 'export const a = 1;\n' } });
  writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 2;\n');

  const blocked = await run(worktree);
  assert.equal(statusOf(blocked, 'test-change'), 'block');
  assert.equal(exitCodeFor(blocked), 1);
  assert.equal(blocked.bypass, undefined, 'no bypass is recorded without a justification');

  const bypassed = await run(worktree, { justifyNoTests: justification });
  assert.equal(statusOf(bypassed, 'test-change'), 'warn');
  assert.deepEqual(bypassed.bypass, [{ check: 'test-change', justification, applied: true }]);
  assert.equal(exitCodeFor(bypassed), 0);
  assert.equal(bypassed.approved, derivedApproval(bypassed), 'the bypass changes the status only; approval still derives from statuses');

  const json = cli('--worktree', worktree, '--base', 'main', '--justify-no-tests', justification, '--json');
  assert.equal(json.status, 0, json.stderr);
  const parsed = parseJson(json.stdout);
  assert.deepEqual(parsed.bypass, [{ check: 'test-change', justification, applied: true }]);
  assert.equal(statusOf(parsed, 'test-change'), 'warn');

  const human = cli('--worktree', worktree, '--base', 'main', '--justify-no-tests', justification);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Preflight: PASS \(JUSTIFIED BYPASS\)/);
  assert.ok(human.stdout.includes(`Justified bypass (not approval): test-change block changed to warn. Justification: ${justification}`));

  const blockedCli = cli('--worktree', worktree, '--base', 'main');
  assert.equal(blockedCli.status, 1);
  assert.doesNotMatch(blockedCli.stdout, /JUSTIFIED BYPASS|Justified bypass/);
});

test('a justification is recorded but not applied unless test-change would block, and a disabled test-change is skipped', async () => {
  const justification = 'Not needed at warn severity.';
  const warnRepo = taskRepo({ config: PROD_TEST, files: { 'src/a.ts': 'export const a = 1;\n' } });
  writeFileSync(join(warnRepo.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  const warned = await run(warnRepo.worktree, { justifyNoTests: justification });
  assert.equal(statusOf(warned, 'test-change'), 'warn');
  assert.deepEqual(warned.bypass, [{ check: 'test-change', justification, applied: false }], 'the stated reason is visible even when nothing needed bypassing');
  const warnedCli = cli('--worktree', warnRepo.worktree, '--base', 'main', '--justify-no-tests', justification);
  assert.equal(warnedCli.status, 0, warnedCli.stderr);
  assert.match(warnedCli.stdout, /Preflight: PASS \(evidence only/, 'a not-applied bypass does not change the verdict');
  assert.ok(warnedCli.stdout.includes(`Justified bypass (not approval): test-change bypass not applied (no built-in block to change). Justification: ${justification}`));

  const disabledRepo = taskRepo({ config: { ...PROD_TEST, checks: { 'test-change': { enabled: false, severity: 'block' } } }, files: { 'src/a.ts': 'export const a = 1;\n' } });
  writeFileSync(join(disabledRepo.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  const disabled = await run(disabledRepo.worktree);
  assert.equal(disabled.checks.some(check => check.id === 'test-change'), false);
  assert.equal(exitCodeFor(disabled), 0);
});

test('rename and delete changes count both paths: a rename out of production into tests passes, a production delete warns', async () => {
  const within = taskRepo({ config: PROD_TEST, files: { 'src/a.ts': 'export const a = 1;\n' } });
  git(within.worktree, 'mv', 'src/a.ts', 'src/b.ts');
  const renamedWithin = await run(within.worktree);
  assert.equal(statusOf(renamedWithin, 'test-change'), 'warn');
  assert.match(evidenceOf(renamedWithin, 'test-change'), /src\/b\.ts/);
  assert.match(evidenceOf(renamedWithin, 'test-change'), /src\/a\.ts/, 'the old path of a rename is a production change');

  const movedToTests = taskRepo({ config: PROD_TEST, files: { 'src/a.ts': 'export const a = 1;\n' } });
  mkdirSync(join(movedToTests.worktree, 'test'));
  git(movedToTests.worktree, 'mv', 'src/a.ts', 'test/a.test.ts');
  const renamedToTest = await run(movedToTests.worktree);
  assert.equal(statusOf(renamedToTest, 'test-change'), 'pass', 'the new path is a test change, so the check passes');
  assert.match(evidenceOf(renamedToTest, 'test-change'), /Test files changed: 1; production files changed: 1\./);

  const deleted = taskRepo({ config: PROD_TEST, files: { 'src/a.ts': 'export const a = 1;\n' } });
  rmSync(join(deleted.worktree, 'src', 'a.ts'));
  const deletion = await run(deleted.worktree);
  assert.equal(statusOf(deletion, 'test-change'), 'warn');
  assert.match(evidenceOf(deletion, 'test-change'), /src\/a\.ts/);
});

test('a test file renamed away is a removed test path, and the new production path counts as production', async () => {
  const renamedAway = taskRepo({ config: PROD_TEST, files: { 'test/a.test.ts': 'test("a", () => {});\n', 'src/other.ts': 'export const other = 1;\n' } });
  git(renamedAway.worktree, 'mv', 'test/a.test.ts', 'src/a.ts');
  const result = await run(renamedAway.worktree);
  assert.equal(statusOf(result, 'test-change'), 'warn', 'the moved file is production and no test file remains');
  assert.match(evidenceOf(result, 'test-change'), /Production files changed \(1\) and no test files changed: src\/a\.ts\./);
  assert.match(evidenceOf(result, 'test-change'), /Removed test paths do not count as test changes: test\/a\.test\.ts\./);
  assert.doesNotMatch(evidenceOf(result, 'test-change'), /Test files changed/);
  assert.equal(exitCodeFor(result), 0, 'a warning is evidence, not a block');
});

test('a rename whose old path matches a production glob counts that old path, and a non-test new path adds nothing', async () => {
  const { worktree } = taskRepo({ config: PROD_TEST, files: { 'src/a.ts': 'export const a = 1;\n' } });
  mkdirSync(join(worktree, 'docs'));
  git(worktree, 'mv', 'src/a.ts', 'docs/a.md');
  const result = await run(worktree);
  assert.equal(statusOf(result, 'test-change'), 'warn');
  assert.match(evidenceOf(result, 'test-change'), /Production files changed \(1\) and no test files changed: src\/a\.ts\./);
  assert.doesNotMatch(evidenceOf(result, 'test-change'), /docs\/a\.md/, 'a new path outside both globs is neither production nor test');
});

test('test-change treats paths platform-aware and does not count a copy source as changed', async () => {
  const check = testChangeCheck(['src/**'], ['test/**']);
  const copy = changesetOf([changeEntry('src/copy.ts', { status: 'added', oldPath: 'src/original.ts' })]);
  const copied = await check.run({ worktree: '/', changeset: copy });
  assert.equal(copied.status, 'warn');
  assert.match(copied.evidence.join('\n'), /src\/copy\.ts/);
  assert.doesNotMatch(copied.evidence.join('\n'), /original/, 'a copy leaves its source unchanged');

  const backslash = await check.run({ worktree: '/', changeset: changesetOf([changeEntry('src\\win\\a.ts')]) });
  assert.equal(backslash.status, 'warn', 'backslash separators are normalized before glob matching');
  const shownOnce = await check.run({ worktree: '/', changeset: changesetOf([changeEntry('SRC/a.ts'), changeEntry('src/a.ts', { origin: 'staged' })]) });
  assert.equal(shownOnce.metrics?.productionFiles, process.platform === 'win32' ? 1 : 2, 'Windows paths that differ only by case are one changed path');
  const notConfigured = await testChangeCheck().run({ worktree: '/', changeset: changesetOf([changeEntry('src/a.ts')]) });
  assert.deepEqual(notConfigured, { status: 'pass', evidence: ['prodGlobs/testGlobs not configured; check not run'] });
});

test('a deleted test file does not satisfy test-change, and a deleted file matching a production glob counts as production', async () => {
  const { worktree } = taskRepo({ config: PROD_TEST, files: { 'src/a.ts': 'export const a = 1;\n', 'test/a.test.ts': 'test("a", () => {});\n' } });
  writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  rmSync(join(worktree, 'test', 'a.test.ts'));
  const result = await run(worktree);
  assert.equal(statusOf(result, 'test-change'), 'warn');
  assert.match(evidenceOf(result, 'test-change'), /Production files changed \(1\) and no test files changed: src\/a\.ts\./);
  assert.match(evidenceOf(result, 'test-change'), /Removed test paths do not count as test changes: test\/a\.test\.ts\./);
  assert.equal(exitCodeFor(result), 0, 'a warning is evidence, not a block');

  const deletedTest = await testChangeCheck(['**/*.ts'], ['test/**']).run({ worktree: '/', changeset: changesetOf([changeEntry('test/b.test.ts', { status: 'deleted' })]) });
  assert.equal(deletedTest.status, 'warn', 'a deleted file that matches a production glob counts as production');
  const liveTest = await testChangeCheck(['**/*.ts'], ['test/**']).run({ worktree: '/', changeset: changesetOf([changeEntry('test/b.test.ts')]) });
  assert.equal(liveTest.status, 'pass', 'the same path present in the candidate is a test change');
});

test('a staged test modification followed by an unstaged deletion leaves the test removed, not present', async () => {
  const { worktree } = taskRepo({ config: PROD_TEST, files: { 'src/a.ts': 'export const a = 1;\n', 'test/a.test.ts': 'test("a", () => {});\n' } });
  writeFileSync(join(worktree, 'test', 'a.test.ts'), 'test("a changed", () => {});\n');
  git(worktree, 'add', 'test/a.test.ts');
  rmSync(join(worktree, 'test', 'a.test.ts'));
  writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  const result = await run(worktree);
  assert.equal(statusOf(result, 'test-change'), 'warn', 'an absent test does not satisfy the guardrail');
  assert.match(evidenceOf(result, 'test-change'), /Production files changed \(1\) and no test files changed: src\/a\.ts\./);
  assert.match(evidenceOf(result, 'test-change'), /Removed test paths do not count as test changes: test\/a\.test\.ts\./);
  assert.doesNotMatch(evidenceOf(result, 'test-change'), /Test files changed/);
  assert.equal(exitCodeFor(result), 0, 'a warning is evidence, not a block');
});

test('a committed test modification followed by a staged deletion leaves the test removed, not present', async () => {
  const { worktree } = taskRepo({ config: PROD_TEST, files: { 'src/a.ts': 'export const a = 1;\n', 'test/a.test.ts': 'test("a", () => {});\n' } });
  writeFileSync(join(worktree, 'test', 'a.test.ts'), 'test("a changed", () => {});\n');
  git(worktree, 'add', 'test/a.test.ts');
  git(worktree, 'commit', '-q', '-m', 'change test');
  git(worktree, 'rm', '-q', 'test/a.test.ts');
  writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  const result = await run(worktree);
  assert.equal(statusOf(result, 'test-change'), 'warn');
  assert.match(evidenceOf(result, 'test-change'), /Production files changed \(1\) and no test files changed: src\/a\.ts\./);
  assert.match(evidenceOf(result, 'test-change'), /Removed test paths do not count as test changes: test\/a\.test\.ts\./);
  assert.doesNotMatch(evidenceOf(result, 'test-change'), /Test files changed/);
});

test('a committed test modification followed by a staged rename away from it leaves the old path removed', async () => {
  const { worktree } = taskRepo({ config: PROD_TEST, files: { 'src/a.ts': 'export const a = 1;\n', 'test/a.test.ts': 'test("a", () => {});\n' } });
  writeFileSync(join(worktree, 'test', 'a.test.ts'), 'test("a changed", () => {});\n');
  git(worktree, 'add', 'test/a.test.ts');
  git(worktree, 'commit', '-q', '-m', 'change test');
  git(worktree, 'mv', 'test/a.test.ts', 'src/b.ts');
  const result = await run(worktree);
  assert.equal(statusOf(result, 'test-change'), 'warn', 'the old test path is removed by the later staged rename');
  assert.match(evidenceOf(result, 'test-change'), /Production files changed \(1\) and no test files changed: src\/b\.ts\./);
  assert.match(evidenceOf(result, 'test-change'), /Removed test paths do not count as test changes: test\/a\.test\.ts\./);
  assert.doesNotMatch(evidenceOf(result, 'test-change'), /Test files changed/);
});

test('a deletion followed by a re-add counts the test as present, for a staged deletion with an untracked re-add and a committed deletion with a staged re-add', async () => {
  const withUntracked = taskRepo({ config: PROD_TEST, files: { 'src/a.ts': 'export const a = 1;\n', 'test/a.test.ts': 'test("a", () => {});\n' } });
  git(withUntracked.worktree, 'rm', '-q', 'test/a.test.ts');
  mkdirSync(join(withUntracked.worktree, 'test'), { recursive: true });
  writeFileSync(join(withUntracked.worktree, 'test', 'a.test.ts'), 'test("a again", () => {});\n');
  writeFileSync(join(withUntracked.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  const untrackedResult = await run(withUntracked.worktree);
  assert.equal(statusOf(untrackedResult, 'test-change'), 'pass', 'a later untracked add restores the test');
  assert.match(evidenceOf(untrackedResult, 'test-change'), /Test files changed: 1; production files changed: 1\./);
  assert.doesNotMatch(evidenceOf(untrackedResult, 'test-change'), /Removed test paths/);

  const withStaged = taskRepo({ config: PROD_TEST, files: { 'src/a.ts': 'export const a = 1;\n', 'test/a.test.ts': 'test("a", () => {});\n' } });
  git(withStaged.worktree, 'rm', '-q', 'test/a.test.ts');
  git(withStaged.worktree, 'commit', '-q', '-m', 'drop test');
  mkdirSync(join(withStaged.worktree, 'test'), { recursive: true });
  writeFileSync(join(withStaged.worktree, 'test', 'a.test.ts'), 'test("a again", () => {});\n');
  git(withStaged.worktree, 'add', 'test/a.test.ts');
  writeFileSync(join(withStaged.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  const stagedResult = await run(withStaged.worktree);
  assert.equal(statusOf(stagedResult, 'test-change'), 'pass', 'a staged re-add after a committed deletion is present');
  assert.match(evidenceOf(stagedResult, 'test-change'), /Test files changed: 1; production files changed: 1\./);
});

test('test-change resolves a path by its final state across origins, whatever the entry order', async () => {
  const check = testChangeCheck(['src/**'], ['test/**']);
  const unstagedDeletedFirst = await check.run({ worktree: '/', changeset: changesetOf([
    changeEntry('test/a.test.ts', { status: 'deleted', origin: 'unstaged' }),
    changeEntry('test/a.test.ts', { origin: 'staged' }),
    changeEntry('src/a.ts'),
  ]) });
  assert.equal(unstagedDeletedFirst.status, 'warn', 'the unstaged deletion is the latest origin, whatever the array order');
  assert.match(unstagedDeletedFirst.evidence.join('\n'), /Removed test paths do not count as test changes: test\/a\.test\.ts\./);
  const stagedAddedAfterCommittedDelete = await check.run({ worktree: '/', changeset: changesetOf([
    changeEntry('src/a.ts'),
    changeEntry('test/a.test.ts', { origin: 'staged', status: 'added' }),
    changeEntry('test/a.test.ts', { origin: 'committed', status: 'deleted' }),
  ]) });
  assert.equal(stagedAddedAfterCommittedDelete.status, 'pass', 'the later staged add is present');
});

test('a Windows case-only rename settles to the new spelling across origins, and a backslash spelling is the same path', { skip: process.platform !== 'win32' }, async () => {
  const committed = taskRepo({ config: PROD_TEST, files: { 'src/a.ts': 'export const a = 1;\n', 'test/Foo.test.ts': 'test("a", () => {});\n' } });
  git(committed.worktree, 'mv', 'test/Foo.test.ts', 'test/foo.test.ts');
  git(committed.worktree, 'commit', '-q', '-m', 'rename test case');
  writeFileSync(join(committed.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  const committedResult = await run(committed.worktree);
  assert.equal(statusOf(committedResult, 'test-change'), 'pass', 'a committed case-only rename leaves the test present under the new spelling');
  assert.match(evidenceOf(committedResult, 'test-change'), /Test files changed: 1; production files changed: 1\./);
  assert.doesNotMatch(evidenceOf(committedResult, 'test-change'), /Removed test paths/, 'the old spelling is settled before the new one, so the new one stays present');

  const staged = taskRepo({ config: PROD_TEST, files: { 'src/a.ts': 'export const a = 1;\n', 'test/Foo.test.ts': 'test("a", () => {});\n' } });
  writeFileSync(join(staged.worktree, 'test', 'Foo.test.ts'), 'test("a changed", () => {});\n');
  git(staged.worktree, 'add', 'test/Foo.test.ts');
  git(staged.worktree, 'commit', '-q', '-m', 'change test');
  git(staged.worktree, 'mv', 'test/Foo.test.ts', 'test/foo.test.ts');
  writeFileSync(join(staged.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  const stagedResult = await run(staged.worktree);
  assert.equal(statusOf(stagedResult, 'test-change'), 'pass', 'a committed edit followed by a staged case-only rename is present under the new spelling');
  assert.match(evidenceOf(stagedResult, 'test-change'), /Test files changed: 1; production files changed: 1\./);
  assert.doesNotMatch(evidenceOf(stagedResult, 'test-change'), /Removed test paths/);
});

test('origin settling normalizes backslash separators, so a backslash spelling and a slash spelling are one path', async () => {
  const check = testChangeCheck(['src/**'], ['test/**']);
  const deletedLater = await check.run({ worktree: '/', changeset: changesetOf([
    changeEntry('src/a.ts', { origin: 'untracked', status: 'added' }),
    changeEntry('test\\Foo.test.ts', { origin: 'committed', status: 'added' }),
    changeEntry('test/Foo.test.ts', { origin: 'unstaged', status: 'deleted' }),
  ]) });
  assert.equal(deletedLater.status, 'warn', 'the unstaged deletion of the same path removes the committed add, whatever the separator');
  assert.match(deletedLater.evidence.join('\n'), /Removed test paths do not count as test changes: test\/Foo\.test\.ts\./);
  assert.doesNotMatch(deletedLater.evidence.join('\n'), /Test files changed/);

  const readdedLater = await check.run({ worktree: '/', changeset: changesetOf([
    changeEntry('src/a.ts', { origin: 'untracked', status: 'added' }),
    changeEntry('test/Bar.test.ts', { origin: 'committed', status: 'deleted' }),
    changeEntry('test\\Bar.test.ts', { origin: 'unstaged', status: 'added' }),
  ]) });
  assert.equal(readdedLater.status, 'pass', 'the unstaged add with a backslash separator restores the same path');
  assert.match(readdedLater.evidence.join('\n'), /Test files changed: 1; production files changed: 1\./);
});

test('recursive wildcards in test-change cross U+2028 and CR/LF, for ** and the **/ directory form', async () => {
  const lineSeparator = String.fromCharCode(0x2028);
  const recursive = testChangeCheck(['src/**'], ['test/**']);
  assert.equal((await recursive.run({ worktree: '/', changeset: changesetOf([changeEntry(`src/a${lineSeparator}b.ts`)]) })).status, 'warn', '** matches U+2028 in a production path');
  assert.equal((await recursive.run({ worktree: '/', changeset: changesetOf([changeEntry('src/a\r\nb.ts')]) })).status, 'warn', '** matches CR/LF in a production path');
  assert.equal((await recursive.run({ worktree: '/', changeset: changesetOf([changeEntry(`test/sub${lineSeparator}dir/a.test.ts`), changeEntry('src/a.ts')]) })).status, 'pass', '** matches a test path with U+2028 inside the part it covers (test/ prefix anchored), so the test change counts');
  assert.equal((await recursive.run({ worktree: '/', changeset: changesetOf([changeEntry('test/sub\r\ndir/a.test.ts'), changeEntry('src/a.ts')]) })).status, 'pass', '** matches a test path with CR/LF inside the part it covers');
  assert.equal((await recursive.run({ worktree: '/', changeset: changesetOf([changeEntry(`test${lineSeparator}dir/a.test.ts`), changeEntry('src/a.ts')]) })).status, 'warn', 'test/** is anchored: a path starting with test<U+2028> is not under test/, so it is not a test change');

  const directoryForm = testChangeCheck(['**/*.ts'], ['**/*.test.ts']);
  assert.equal((await directoryForm.run({ worktree: '/', changeset: changesetOf([changeEntry(`lib${lineSeparator}/a.ts`)]) })).status, 'warn', '**/ matches a directory with U+2028 in its name');
  assert.equal((await directoryForm.run({ worktree: '/', changeset: changesetOf([changeEntry('lib\r\n/a.ts')]) })).status, 'warn', '**/ matches a directory with CR/LF in its name');
  const testDirectory = await directoryForm.run({ worktree: '/', changeset: changesetOf([changeEntry(`test${lineSeparator}dir/a.test.ts`), changeEntry('lib/x.ts')]) });
  assert.equal(testDirectory.status, 'pass', '**/*.test.ts matches a test whose directory name holds U+2028');
  assert.match(testDirectory.evidence.join('\n'), /Test files changed: 1; production files changed: 1\./);

  const anchoredDirectoryForm = testChangeCheck(['src/**'], ['test/**/*.test.ts']);
  assert.equal((await anchoredDirectoryForm.run({ worktree: '/', changeset: changesetOf([changeEntry(`test/sub${lineSeparator}dir/a.test.ts`), changeEntry('src/a.ts')]) })).status, 'pass', 'test/**/*.test.ts matches a nested test directory whose name holds U+2028');
  assert.equal((await anchoredDirectoryForm.run({ worktree: '/', changeset: changesetOf([changeEntry('test/sub\r\ndir/a.test.ts'), changeEntry('src/a.ts')]) })).status, 'pass', 'test/**/*.test.ts matches a nested test directory whose name holds CR/LF');
});

test('invalid prodGlobs or testGlobs passed to testChangeCheck name that field, not forbiddenPathGlobs', () => {
  assert.throws(() => testChangeCheck(['/absolute/**'], ['test/**']), (error: unknown) => error instanceof Error && error.message === 'prodGlobs must be an array of safe repository-relative glob strings.');
  assert.throws(() => testChangeCheck(['src/**'], ['../escape/**']), (error: unknown) => error instanceof Error && error.message === 'testGlobs must be an array of safe repository-relative glob strings.');
});

test('the human bypass line escapes control characters so a justification cannot forge a line, while JSON keeps it verbatim', () => {
  const justification = 'first\nforged line\u001b[31m red';
  const { worktree } = taskRepo({ config: { ...PROD_TEST, checks: { 'test-change': { severity: 'block' } } }, files: { 'src/a.ts': 'export const a = 1;\n' } });
  writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  const human = cli('--worktree', worktree, '--base', 'main', '--justify-no-tests', justification);
  assert.equal(human.status, 0, human.stderr);
  assert.ok(human.stdout.includes('Justification: first\\u000aforged line\\u001b[31m red'), human.stdout);
  assert.ok(!human.stdout.includes('\u001b'), 'no raw escape byte reaches the output');
  assert.ok(!human.stdout.split('\n').some(line => line.startsWith('forged line')), 'a newline in the justification cannot start a line');
  const json = cli('--worktree', worktree, '--base', 'main', '--justify-no-tests', justification, '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(parseJson(json.stdout).bypass?.[0]?.justification, justification, 'JSON keeps the justification verbatim');
});

test('the human bypass line bounds a long justification', () => {
  const result: PreflightResult = { approved: false, blocking: [], warnings: [], metrics: {}, checks: [], bypass: [{ check: 'test-change', justification: 'y'.repeat(300), applied: true }] };
  const human = formatHuman(result);
  assert.ok(human.includes(`Justification: ${'y'.repeat(240)}…`), human);
  assert.ok(!human.includes('y'.repeat(241)));
});

test('an inconclusive test-change is not bypassed, and the bypass is recorded as not applied', async () => {
  const { root, worktree } = taskRepo({ config: { ...PROD_TEST, checks: { 'test-change': { severity: 'block' } } }, files: { 'src/a.ts': 'export const a = 1;\n' } });
  writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  git(root, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  const justification = 'Generated constant only; no behavior changed.';
  const result = await run(worktree, { justifyNoTests: justification });
  assert.equal(statusOf(result, 'test-change'), 'inconclusive');
  assert.deepEqual(result.bypass, [{ check: 'test-change', justification, applied: false }]);
  assert.equal(exitCodeFor(result), 2);
  assert.equal(result.approved, false);
  const human = cli('--worktree', worktree, '--base', 'main', '--justify-no-tests', justification);
  assert.equal(human.status, 2);
  assert.match(human.stdout, /Preflight: INCONCLUSIVE/);
  assert.doesNotMatch(human.stdout, /JUSTIFIED BYPASS/);
  assert.ok(human.stdout.includes(`Justified bypass (not approval): test-change bypass not applied (no built-in block to change). Justification: ${justification}`), human.stdout);
  assert.doesNotMatch(human.stdout, /block changed to warn/);
});

test('a caller-supplied check named test-change keeps its status whatever the severity, and the bypass never changes it', async () => {
  const justification = 'Reason.';
  const warnPolicy = taskRepo({ config: { checks: { 'test-change': { severity: 'warn' } } }, files: { 'src/a.ts': 'export const a = 1;\n' } });
  const blocking = [{ id: 'test-change', run: () => ({ status: 'block' as const, evidence: ['caller block'] }) }];
  const plain = await runPreflight({ worktree: warnPolicy.worktree, base: 'main', checks: blocking });
  const bypassed = await runPreflight({ worktree: warnPolicy.worktree, base: 'main', checks: blocking, justifyNoTests: justification });
  assert.equal(statusOf(plain, 'test-change'), 'block');
  assert.equal(statusOf(bypassed, 'test-change'), 'block', 'severity and the bypass apply only to the built-in instance');
  assert.deepEqual(bypassed.bypass, [{ check: 'test-change', justification, applied: false }]);
  assert.equal(exitCodeFor(bypassed), 1);
  const blockedHuman = formatHuman(bypassed);
  assert.ok(blockedHuman.includes(`Justified bypass (not approval): test-change bypass not applied (no built-in block to change). Justification: ${justification}`), blockedHuman);
  assert.doesNotMatch(blockedHuman, /block changed to warn|JUSTIFIED BYPASS/);
  assert.match(blockedHuman, /\[block\] test-change/, 'the caller block is still reported as a block');

  const blockPolicy = taskRepo({ config: { checks: { 'test-change': { severity: 'block' } } }, files: { 'src/a.ts': 'export const a = 1;\n' } });
  const warning = await runPreflight({ worktree: blockPolicy.worktree, base: 'main', checks: [{ id: 'test-change', run: () => ({ status: 'warn' as const, evidence: ['caller warn'] }) }] });
  assert.equal(statusOf(warning, 'test-change'), 'warn', 'a caller warn is not raised to block');
});

test('a worktree edit to the policy file cannot weaken the trusted test-change globs or severity', async () => {
  const { worktree } = taskRepo({ config: { ...PROD_TEST, checks: { 'test-change': { severity: 'block' } } }, files: { 'src/a.ts': 'export const a = 1;\n' } });
  writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  writeFileSync(join(worktree, '.harness', 'preflight.json'), JSON.stringify({ checks: { 'test-change': { severity: 'warn', enabled: false } } }));
  const result = await run(worktree);
  assert.equal(statusOf(result, 'policy-integrity'), 'block');
  assert.equal(statusOf(result, 'test-change'), 'block', 'the trusted severity and globs still apply');
  assert.equal(exitCodeFor(result), 1);
  assert.match(evidenceOf(result, 'policy'), /Severity overrides: test-change=block\./);
  assert.match(evidenceOf(result, 'policy'), /Disabled checks: none\./);
});

test('a run that ends early for a missing worktree records no bypass', async () => {
  const { root } = taskRepo({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  const missing = join(root, 'absent-worktree');
  const result = await run(missing, { justifyNoTests: 'Reason.' });
  assert.equal(result.bypass, undefined, 'no bypass is recorded when the run stops before the checks');
  assert.equal(exitCodeFor(result), 2);
  const json = cli('--worktree', missing, '--base', 'main', '--justify-no-tests', 'Reason.', '--json');
  assert.equal(json.status, 2);
  assert.equal(Object.hasOwn(parseJson(json.stdout), 'bypass'), false);
  const human = cli('--worktree', missing, '--base', 'main', '--justify-no-tests', 'Reason.');
  assert.equal(human.status, 2);
  assert.doesNotMatch(human.stdout, /Justified bypass/);
});

test('runPreflight refuses an empty or whitespace-only justifyNoTests before any check runs, so no block is downgraded', async () => {
  const { worktree } = taskRepo({ config: { ...PROD_TEST, checks: { 'test-change': { severity: 'block' } } }, files: { 'src/a.ts': 'export const a = 1;\n' } });
  writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  const unjustified = await run(worktree);
  assert.equal(exitCodeFor(unjustified), 1, 'without a justification the same change is blocked');
  for (const blank of ['', '   ', '\t\n ']) {
    const result = await run(worktree, { justifyNoTests: blank });
    assert.equal(result.bypass, undefined, `no bypass is recorded for ${JSON.stringify(blank)}`);
    assert.equal(statusOf(result, 'test-change'), 'inconclusive', JSON.stringify(blank));
    assert.match(evidenceOf(result, 'test-change'), /justifyNoTests must be a nonblank string/);
    assert.equal(exitCodeFor(result), 2, JSON.stringify(blank));
    assert.equal(result.approved, false);
    assert.equal(result.approved, derivedApproval(result));
    assert.doesNotMatch(formatHuman(result), /JUSTIFIED BYPASS|Justified bypass/);
  }
  const nonString = await run(worktree, { justifyNoTests: 42 as unknown as string });
  assert.equal(nonString.bypass, undefined, 'a non-string justification from a JavaScript caller is refused too');
  assert.equal(exitCodeFor(nonString), 2);
});

test('runPreflight keeps a valid justification verbatim, leading and trailing spaces included, and the CLI matches', async () => {
  const justification = '  Generated constant only; no behavior changed.  ';
  const { worktree } = taskRepo({ config: { ...PROD_TEST, checks: { 'test-change': { severity: 'block' } } }, files: { 'src/a.ts': 'export const a = 1;\n' } });
  writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  const bypassed = await run(worktree, { justifyNoTests: justification });
  assert.equal(statusOf(bypassed, 'test-change'), 'warn');
  assert.deepEqual(bypassed.bypass, [{ check: 'test-change', justification, applied: true }]);
  assert.equal(bypassed.bypass?.[0]?.justification, justification, 'the stored text is not trimmed');
  assert.equal(exitCodeFor(bypassed), 0);
  const json = cli('--worktree', worktree, '--base', 'main', '--justify-no-tests', justification, '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(parseJson(json.stdout).bypass, [{ check: 'test-change', justification, applied: true }], 'the CLI also keeps the text verbatim');
});

test('acceptance criteria without a flag pass with the no-task-context note, and approval is derived from statuses', async () => {
  const { worktree } = taskRepo({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  const result = await run(worktree);
  assert.deepEqual(result.checks.find(check => check.id === 'acceptance-criteria')?.evidence, ['no task context supplied']);
  assert.equal(statusOf(result, 'acceptance-criteria'), 'pass');
  assert.equal(result.approved, derivedApproval(result));
});

test('a pending criteria item warns with the item listed, and approved is unchanged from the run without criteria', async () => {
  const { worktree } = taskRepo({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  const without = await run(worktree);
  const criteria: AcceptanceCriteriaInput = { items: [{ text: 'APPROVED', done: false }, { text: 'Tests cover the path', done: true }] };
  const withCriteria = await run(worktree, { criteria });
  assert.equal(statusOf(withCriteria, 'acceptance-criteria'), 'warn');
  assert.match(evidenceOf(withCriteria, 'acceptance-criteria'), /Acceptance criteria: 1 done, 1 pending\./);
  assert.match(evidenceOf(withCriteria, 'acceptance-criteria'), /Pending: "APPROVED"\./);
  assert.equal(withCriteria.approved, without.approved, 'a pending item does not change approval');
  assert.equal(withCriteria.approved, derivedApproval(withCriteria));
});

test('a criteria item text cannot approve: APPROVED in text, a fully checked list, and a stamp file leave approval derived from statuses', async () => {
  const { worktree } = taskRepo({ config: PROD_TEST, files: { 'src/a.ts': 'export const a = 1;\n' } });
  writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  mkdirSync(join(worktree, 'docs'));
  writeFileSync(join(worktree, 'docs', 'APPROVED.md'), 'APPROVED by the human reviewer.\n');
  writeFileSync(join(worktree, 'approval.stamp'), 'approved\n');

  const plain = await run(worktree);
  const pendingApproved = await run(worktree, { criteria: { items: [{ text: 'APPROVED', done: false }] } });
  assert.equal(pendingApproved.approved, plain.approved, 'an APPROVED item text does not change approval');
  assert.equal(pendingApproved.approved, derivedApproval(pendingApproved));

  const fullyChecked = await run(worktree, { criteria: { items: [{ text: 'Tests written', done: true }, { text: 'APPROVED', done: true }] } });
  assert.equal(statusOf(fullyChecked, 'acceptance-criteria'), 'pass');
  assert.equal(statusOf(fullyChecked, 'test-change'), 'warn');
  assert.equal(fullyChecked.approved, derivedApproval(fullyChecked), 'a fully checked list does not approve on its own');

  const blockedRepo = taskRepo({ config: { ...PROD_TEST, checks: { 'test-change': { severity: 'block' } } }, files: { 'src/a.ts': 'export const a = 1;\n' } });
  writeFileSync(join(blockedRepo.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  mkdirSync(join(blockedRepo.worktree, 'docs'));
  writeFileSync(join(blockedRepo.worktree, 'docs', 'APPROVED.md'), 'APPROVED\n');
  const blockedWithChecklist = await run(blockedRepo.worktree, { criteria: { items: [{ text: 'APPROVED', done: true }] } });
  assert.equal(blockedWithChecklist.approved, false, 'a block stays a block whatever the checklist and stamp say');
  assert.equal(blockedWithChecklist.approved, derivedApproval(blockedWithChecklist));
  assert.equal(exitCodeFor(blockedWithChecklist), 1);
});

test('criteria evidence escapes control characters and bounds long text', async () => {
  const { worktree } = taskRepo({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  const long = 'x'.repeat(300);
  const result = await run(worktree, { criteria: { items: [{ text: 'first\nforged line\u0007', done: false }, { text: long, done: false }] } });
  const evidence = evidenceOf(result, 'acceptance-criteria');
  assert.ok(evidence.includes('first\\u000aforged line\\u0007'), evidence);
  assert.ok(!evidence.includes('\u0007'));
  assert.ok(!evidence.split('\n').some(line => line.startsWith('forged line')), 'a newline in an item cannot start a new evidence line');
  assert.ok(evidence.includes(`${'x'.repeat(240)}…`), 'long item text is clipped');
  assert.ok(!evidence.includes('x'.repeat(241)));
});

test('display escaping covers C1 controls and U+2028/U+2029 in criteria evidence and changed-path evidence, and C0 keeps its format', async () => {
  const { worktree } = taskRepo({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  const result = await run(worktree, { criteria: { items: [{ text: 'a\u0085b\u009fc' + String.fromCharCode(0x2028) + 'd' + String.fromCharCode(0x2029) + 'e\u0007f', done: false }] } });
  const evidence = evidenceOf(result, 'acceptance-criteria');
  assert.ok(evidence.includes('a\\u0085b\\u009fc\\u2028d\\u2029e\\u0007f'), evidence);
  assert.doesNotMatch(evidence, /[\u{80}-\u{9f}\u{2028}\u{2029}]/u, 'no raw C1, line-separator, or paragraph-separator character reaches the output');

  // Recursive `src/**` crosses U+2028 in a path; the escaped display is checked below.
  const check = testChangeCheck(['src/**'], ['test/**']);
  const outcome = await check.run({ worktree: '/', changeset: changesetOf([changeEntry('src/a' + String.fromCharCode(0x2028) + 'b\u0085.ts')]) });
  assert.equal(outcome.status, 'warn');
  assert.ok(outcome.evidence.join('\n').includes('src/a\\u2028b\\u0085.ts'), outcome.evidence.join('\n'));
  assert.doesNotMatch(outcome.evidence.join('\n'), /[\u{80}-\u{9f}\u{2028}\u{2029}]/u);
});

test('a criteria file that cannot be used is inconclusive, exits 2, and never passes', async () => {
  const files = makeTempRoot('preflight-criteria-files-');
  const write = (name: string, text: string | Buffer) => { const path = join(files, name); writeFileSync(path, text); return path; };
  const cases: [string, string][] = [
    ['not JSON', write('malformed.json', '{"items":[')],
    ['empty item list', write('empty.json', '{"items":[]}')],
    ['missing done', write('missing-done.json', '{"items":[{"text":"a"}]}')],
    ['done is not boolean', write('string-done.json', '{"items":[{"text":"a","done":"yes"}]}')],
    ['blank text', write('blank.json', '{"items":[{"text":"   ","done":true}]}')],
    ['extra item key', write('extra-item.json', '{"items":[{"text":"a","done":true,"approved":true}]}')],
    ['extra top-level key', write('extra-top.json', '{"items":[{"text":"a","done":true}],"approved":true}')],
    ['top level is an array', write('array.json', '[]')],
    ['duplicate done key', write('duplicate.json', '{"items":[{"text":"a","done":true,"done":false}]}')],
    ['not UTF-8', write('bad-utf8.json', Buffer.from([0xff, 0xfe, 0x00]))],
    ['larger than 1 MiB', write('oversized.json', Buffer.alloc(1024 * 1024 + 1, 0x20))],
    ['missing file', join(files, 'does-not-exist.json')],
  ];
  const { worktree } = taskRepo({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  try {
    for (const [name, path] of cases) {
      const criteria = readAcceptanceCriteria(path);
      assert.ok('error' in criteria, `${name} is refused`);
      const result = await run(worktree, { criteria });
      assert.equal(statusOf(result, 'acceptance-criteria'), 'inconclusive', name);
      assert.equal(exitCodeFor(result), 2, name);
      assert.equal(result.approved, false, name);
    }
    const valid = readAcceptanceCriteria(write('valid.json', '{"items":[{"text":"a","done":true}]}'));
    assert.deepEqual(valid, { items: [{ text: 'a', done: true }] });
  } finally {
    rmSync(files, { recursive: true, force: true });
  }
});

test('criteria check reports pending items through the CLI, with approved unchanged, and rejects a missing file as inconclusive', () => {
  const { worktree } = taskRepo({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  const files = makeTempRoot('preflight-criteria-cli-');
  try {
    const criteriaPath = join(files, 'criteria.json');
    writeFileSync(criteriaPath, JSON.stringify({ items: [{ text: 'Pending item', done: false }, { text: 'Done item', done: true }] }));
    const without = parseJson(cli('--worktree', worktree, '--base', 'main', '--json').stdout);
    const withFile = cli('--worktree', worktree, '--base', 'main', '--criteria', criteriaPath, '--json');
    assert.equal(withFile.status, 0, withFile.stderr);
    const parsed = parseJson(withFile.stdout);
    assert.equal(statusOf(parsed, 'acceptance-criteria'), 'warn');
    assert.equal(parsed.approved, without.approved, 'the criteria warning leaves approved unchanged');
    assert.deepEqual(Object.keys(parsed), ['approved', 'blocking', 'warnings', 'metrics', 'checks'], 'no bypass key without a justified bypass');

    const missing = cli('--worktree', worktree, '--base', 'main', '--criteria', join(files, 'absent.json'), '--json');
    assert.equal(missing.status, 2);
    assert.equal(statusOf(parseJson(missing.stdout), 'acceptance-criteria'), 'inconclusive');
  } finally {
    rmSync(files, { recursive: true, force: true });
  }
});

test('flag validation refuses missing, blank, and duplicate justification and criteria values', () => {
  const { worktree } = taskRepo({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  const cases: [string[], RegExp][] = [
    [['--worktree', worktree, '--justify-no-tests'], /Missing value for --justify-no-tests/],
    [['--worktree', worktree, '--justify-no-tests', '--json'], /Missing value for --justify-no-tests/],
    [['--worktree', worktree, '--justify-no-tests', '   '], /--justify-no-tests requires a nonblank justification/],
    [['--worktree', worktree, '--justify-no-tests', 'first', '--justify-no-tests', 'second'], /Duplicate option: --justify-no-tests/],
    [['--worktree', worktree, '--criteria'], /Missing value for --criteria/],
    [['--worktree', worktree, '--criteria', 'a.json', '--criteria', 'b.json'], /Duplicate option: --criteria/],
  ];
  for (const [args, pattern] of cases) {
    const result = cli(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, pattern, args.join(' '));
    assert.equal(result.stdout, '', 'a usage error prints no result');
  }
  assert.match(cli('--help').stdout, /--criteria <file>/);
  assert.match(cli('--help').stdout, /--justify-no-tests "<text>"/);
});

test('an acceptance-criteria row reports done and pending counts that match the file', async () => {
  const criteria = parseCriteria('{"items":[{"text":"a","done":true},{"text":"b","done":false},{"text":"c","done":false}]}');
  assert.deepEqual(criteria, { items: [{ text: 'a', done: true }, { text: 'b', done: false }, { text: 'c', done: false }] });
  const outcome = await acceptanceCriteriaCheck.run({ worktree: '/', changeset: changesetOf([]), criteria });
  assert.equal(outcome.status, 'warn');
  assert.deepEqual(outcome.metrics, { items: 3, done: 1, pending: 2 });
  assert.deepEqual(outcome.evidence, ['Acceptance criteria: 1 done, 2 pending.', 'Pending: "b", "c".']);
});

function parseCriteria(text: string): AcceptanceCriteriaInput {
  const root = makeTempRoot('preflight-criteria-parse-');
  const path = join(root, 'criteria.json');
  writeFileSync(path, text);
  try { return readAcceptanceCriteria(path); } finally { rmSync(root, { recursive: true, force: true }); }
}
