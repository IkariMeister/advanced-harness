import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, posix, relative, resolve, win32 } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { updateContext } from '../src/project-context.ts';
import { baseContextCheck, isPathContained, pathPolicyCheck, secretScanCheck, worktreeBoundaryCheck } from '../src/preflight/checks.ts';
import { collectChangeset, nestedGitEnvironment } from '../src/preflight/changeset.ts';
import { exitCodeFor, formatHuman, resolveBase, runPreflight, UnresolvedBaseError } from '../src/preflight/runner.ts';
import type { Changeset, CheckStatus, PreflightCheck } from '../src/preflight/types.ts';
import { entryDecision, runCli } from '../scripts/preflight.ts';
import { MAX_SECRET_SCAN_BYTES, resolveGitleaksExecutable, safeGitleaksRuleId, scanAddedText } from '../src/preflight/secret-scanner.ts';
import { makeTempRoot } from './temp-directory.ts';

const script = resolve(import.meta.dirname, '../scripts/preflight.ts');
const contextSections = ['build', 'lint', 'unit', 'roborazzi', 'runtime', 'e2e'];

test('path policy normalizes case and separators, skips deletions, and supports project glob replacement', async () => {
  const changeset = (entries: Changeset['entries']): Changeset => ({ top: '/', base: 'main', baseSource: 'option', mergeBase: '', head: '', entries });
  const entry = (path: string, status: 'added' | 'deleted' = 'added') => ({ path, status, origin: 'untracked' as const, content: Buffer.from('x') });
  const run = (entries: Changeset['entries'], globs?: readonly string[]) => pathPolicyCheck(globs).run({ worktree: '/', changeset: changeset(entries) });
  assert.equal((await run([entry('Secrets\\ID_RSA.pub')])).status, 'block');
  assert.equal((await run([{ ...entry('safe.txt'), oldPath: 'secret.pem', status: 'renamed' }])).status, 'pass');
  assert.equal((await run([entry('foo/old.pem', 'deleted')])).status, 'pass');
  assert.equal((await run([entry('artifact/custom.bin')], ['**/*.bin'])).status, 'block');
  assert.equal((await run([entry('artifact/custom.bin')], ['**/*.pem'])).status, 'pass');
});

test('secret scan reports only a redacted rule and location and validates exact exceptions', async () => {
  const changeset: Changeset = { top: '/', base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [{ path: 'src/token.ts', status: 'added', origin: 'untracked', kind: 'file', content: Buffer.from('token'), addedText: 'const api_key = "THIS_IS_A_FAKE_SECRET_VALUE_0123456789"', targetLines: [7] }] };
  const scanner = (changes: Parameters<typeof scanAddedText>[0]) => scanAddedText(changes, { probe: () => ({ available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' }) });
  const outcome = await secretScanCheck([], scanner).run({ worktree: '/', changeset });
  assert.equal(outcome.status, 'block');
  assert.ok(!outcome.evidence.join('').includes('THIS_IS_A_FAKE_SECRET_VALUE_0123456789'));
  if (outcome.status === 'block') assert.ok(outcome.evidence.some(line => line === 'high-entropy-assignment at src/token.ts:7 [REDACTED]'));
  const exception = secretScanCheck([{ path: 'src/token.ts', rule: 'high-entropy-assignment', justification: ' Reviewed placeholder only ' }], scanner);
  assert.equal((await exception.run({ worktree: '/', changeset })).status, 'pass');
  const lineScoped = secretScanCheck([{ path: 'src/token.ts', rule: 'high-entropy-assignment', line: 8, origin: 'untracked', justification: 'Only this generated fixture line.' }], scanner);
  assert.equal((await lineScoped.run({ worktree: '/', changeset })).status, 'block', 'a line-scoped exception does not suppress another line');
  const exactLine = secretScanCheck([{ path: 'src/token.ts', rule: 'high-entropy-assignment', line: 7, origin: 'untracked', justification: 'Reviewed this exact snapshot line.' }], scanner);
  assert.equal((await exactLine.run({ worktree: '/', changeset })).status, 'pass');
  const wrongOrigin = secretScanCheck([{ path: 'src/token.ts', rule: 'high-entropy-assignment', line: 7, origin: 'staged', justification: 'Different origin is not covered.' }], scanner);
  assert.equal((await wrongOrigin.run({ worktree: '/', changeset })).status, 'block');
  const gitleaksScanner = () => ({ backend: 'gitleaks' as const, complete: true, findings: [{ rule: safeGitleaksRuleId('custom-rule'), path: 'src/token.ts', line: 7, redacted: true as const }] });
  const gitleaksException = secretScanCheck([{ path: 'src/token.ts', rule: 'custom-rule', justification: ' Reviewed exact rule ' }], gitleaksScanner);
  assert.equal((await gitleaksException.run({ worktree: '/', changeset })).status, 'pass');
  const { addedText: _addedText, ...binaryEntry } = changeset.entries[0]!;
  const binaryChangeset: Changeset = { ...changeset, entries: [{ ...binaryEntry, addedTextComplete: false }, { ...changeset.entries[0]!, path: 'src/other.ts', addedText: 'ordinary text\n', targetLines: [3], addedTextComplete: true }] };
  let binaryScannerCalled = false;
  const binaryOutcome = await secretScanCheck([], (lines) => { binaryScannerCalled = true; assert.deepEqual(lines.map(line => line.path), ['src/other.ts']); return { backend: 'builtin', complete: true, findings: [] }; }).run({ worktree: '/', changeset: binaryChangeset });
  assert.equal(binaryOutcome.status, 'inconclusive');
  assert.equal(binaryScannerCalled, true);
  assert.ok(binaryOutcome.evidence.some(line => line.includes('src/token.ts')));
  assert.equal(binaryOutcome.metrics?.backendBuiltin, 1);
  assert.equal(binaryOutcome.metrics?.affectedPaths, 1);
  const noEligibleText = await secretScanCheck([], () => { throw new Error('scanner must not run'); }).run({ worktree: '/', changeset: { ...changeset, entries: [{ ...binaryEntry, addedTextComplete: false }] } });
  assert.equal(noEligibleText.status, 'inconclusive');
  assert.equal(noEligibleText.metrics?.notRun, 1);
  assert.equal(noEligibleText.metrics?.backendBuiltin, 0);
  const sanitizedIncomplete = await secretScanCheck([], () => ({ backend: 'unavailable', complete: false, reason: 'private raw scanner diagnostic', findings: [] })).run({ worktree: '/', changeset });
  assert.equal(sanitizedIncomplete.status, 'inconclusive');
  assert.ok(sanitizedIncomplete.evidence.includes('Secret scan incomplete: scanner could not complete its bounded probe or scan.'));
  assert.ok(!sanitizedIncomplete.evidence.join('').includes('private raw scanner diagnostic'));
  const knownIncomplete = await secretScanCheck([], () => ({ backend: 'gitleaks', complete: false, reason: 'Gitleaks report could not be read.', findings: [] })).run({ worktree: '/', changeset });
  assert.ok(knownIncomplete.evidence.includes('Secret scan incomplete: Gitleaks report could not be read.'));
});

test('Gitleaks cleanup failures preserve findings and report a fixed incomplete reason', () => {
  const scannerChanges = [
    { path: 'a.txt', line: 1, text: 'first', origin: 'committed' },
    { path: 'b.txt', line: 1, text: 'second', origin: 'staged' },
  ];
  let calls = 0;
  const run = ((_: string, args: readonly string[]) => {
    calls += 1;
    if (calls === 2) return { status: null, error: new Error('secret raw subprocess detail'), stdout: '', stderr: '' } as ReturnType<typeof spawnSync>;
    const reportPath = args[args.indexOf('--report-path') + 1]!;
    writeFileSync(reportPath, JSON.stringify([{ RuleID: 'fixture', StartLine: 1 }]));
    return { status: 1, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>;
  }) as typeof spawnSync;
  const cleanupFails = () => { throw new Error('private cleanup path'); };
  const successfulScanCleanup = scanAddedText(scannerChanges.slice(0, 1), { probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }), run: ((_: string, args: readonly string[]) => { const reportPath = args[args.indexOf('--report-path') + 1]!; writeFileSync(reportPath, '[]'); return { status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>; }) as typeof spawnSync, createTempDirectory: () => makeTempRoot('gitleaks-cleanup-success-'), removeTempDirectory: cleanupFails });
  assert.equal(successfulScanCleanup.complete, false);
  assert.equal(successfulScanCleanup.reason, 'Gitleaks temporary files could not be cleaned up.');
  assert.deepEqual(successfulScanCleanup.findings, []);

  const failedLater = scanAddedText(scannerChanges, { probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }), run, createTempDirectory: () => makeTempRoot('gitleaks-cleanup-failure-'), removeTempDirectory: cleanupFails });
  assert.equal(failedLater.complete, false);
  assert.equal(failedLater.reason, 'Gitleaks temporary files could not be cleaned up.');
  assert.deepEqual(failedLater.findings.map(finding => [finding.rule, finding.path]), [[safeGitleaksRuleId('fixture'), 'a.txt']]);
  assert.ok(!JSON.stringify(failedLater).includes('secret raw subprocess detail'));
});

test('secret scanner input retains blank added lines and origin boundaries', async () => {
  const changeset: Changeset = { top: '/', base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [{ path: 'src/a.ts', status: 'modified', origin: 'committed', content: Buffer.from(''), addedText: 'alpha\n\nomega\n', targetLines: [1, 2, 3], addedTextComplete: true }, { path: 'src/a.ts', status: 'modified', origin: 'staged', content: Buffer.from(''), addedText: 'staged\n', targetLines: [4], addedTextComplete: true }] };
  let received: Parameters<typeof scanAddedText>[0] = [];
  const check = await secretScanCheck([], (changes) => { received = changes; return { backend: 'builtin', complete: true, findings: [] }; }).run({ worktree: '/', changeset });
  assert.equal(check.status, 'pass');
  assert.deepEqual(received.map(item => [item.text, item.origin]), [['alpha', 'committed'], ['', 'committed'], ['omega', 'committed'], ['staged', 'staged']]);
});

test('trusted gitlink acknowledgement is exact, visible as incomplete coverage, and cannot clear other gaps', async () => {
  const gitlinkEntry = { path: 'vendor/lib', status: 'modified' as const, origin: 'committed' as const, kind: 'submodule' as const, content: undefined, addedTextComplete: false, gitlink: { oldId: 'a'.repeat(40), newId: 'b'.repeat(40) } };
  const changeset: Changeset = { top: '/', base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [gitlinkEntry] };
  const acknowledgement = { path: 'vendor/lib', oldId: 'a'.repeat(40), newId: 'b'.repeat(40), justification: 'Reviewed upstream contents.' };
  const check = secretScanCheck([], () => ({ backend: 'builtin', complete: true, findings: [] }));
  const accepted = await check.run({ worktree: '/', changeset, gitlinkAcknowledgements: [acknowledgement] });
  assert.equal(accepted.status, 'warn');
  assert.equal(accepted.metrics?.acknowledgedPaths, 1);
  assert.ok(accepted.evidence.some(line => /Acknowledged incomplete coverage: vendor\/lib/.test(line)));
  const withText = await check.run({ worktree: '/', changeset: { ...changeset, entries: [...changeset.entries, { path: 'ordinary.txt', status: 'added', origin: 'committed', content: Buffer.from('ordinary'), addedText: 'ordinary text', targetLines: [1], addedTextComplete: true }] }, gitlinkAcknowledgements: [acknowledgement] });
  assert.equal(withText.metrics?.complete, 0, 'acknowledged gitlink coverage remains incomplete even when ordinary text is scanned');
  assert.equal(exitCodeFor({ approved: true, blocking: [], warnings: withText.evidence, metrics: {}, checks: [{ id: 'secret-scan', status: withText.status, evidence: withText.evidence }] }), 0, 'the sole acknowledged gap retains the approved exit 0 behavior');
  assert.match(formatHuman({ approved: true, blocking: [], warnings: withText.evidence, metrics: {}, checks: [{ id: 'secret-scan', status: withText.status, evidence: withText.evidence }] }), /Secret scan backend: builtin \(incomplete\)/);
  assert.equal(JSON.parse(JSON.stringify({ metrics: withText.metrics })).metrics.complete, 0, 'JSON retains incomplete coverage');

  const wrongId = await check.run({ worktree: '/', changeset, gitlinkAcknowledgements: [{ ...acknowledgement, newId: 'c'.repeat(40) }] });
  assert.equal(wrongId.status, 'inconclusive');
  assert.ok(wrongId.evidence.some(line => /matched: 0; unmatched: 1/.test(line)));

  const wrongSamePath = { ...acknowledgement, oldId: 'd'.repeat(40) };
  const correctAndIncorrect = await check.run({ worktree: '/', changeset, gitlinkAcknowledgements: [acknowledgement, wrongSamePath] });
  assert.equal(correctAndIncorrect.status, 'warn');
  assert.ok(correctAndIncorrect.evidence.some(line => /Trusted gitlink acknowledgements from policy commit unavailable: 2; matched: 1; unmatched: 1/.test(line)), 'each tuple is counted independently even when its path matches');

  const unrelatedGap = await check.run({ worktree: '/', changeset: { ...changeset, entries: [...changeset.entries, { path: 'ordinary.bin', status: 'added', origin: 'committed', content: undefined, addedTextComplete: false }] }, gitlinkAcknowledgements: [acknowledgement] });
  assert.equal(unrelatedGap.status, 'inconclusive');
  assert.ok(unrelatedGap.evidence.some(line => line.includes('ordinary.bin')));
});

test('an acknowledged gitlink cannot mask a failed secret scanner', async () => {
  const oldId = 'a'.repeat(40);
  const newId = 'b'.repeat(40);
  const changeset: Changeset = { top: '/', base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [
    { path: 'vendor/lib', status: 'modified', origin: 'committed', kind: 'submodule', content: undefined, addedTextComplete: false, gitlink: { oldId, newId } },
    { path: 'ordinary.txt', status: 'added', origin: 'committed', content: Buffer.from('added'), addedText: 'ordinary text', targetLines: [1], addedTextComplete: true },
  ] };
  const acknowledgement = { path: 'vendor/lib', oldId, newId, justification: 'Reviewed upstream source.' };
  const outcome = await secretScanCheck([], () => ({ backend: 'unavailable', complete: false, reason: 'Gitleaks scan failed.', findings: [] })).run({ worktree: '/', changeset, gitlinkAcknowledgements: [acknowledgement] });
  assert.equal(outcome.status, 'inconclusive');
  assert.equal(outcome.metrics?.acknowledgedPaths, 1);
  const result = {
    approved: false, blocking: [], warnings: [],
    metrics: Object.fromEntries(Object.entries(outcome.metrics ?? {}).map(([key, value]) => [`secret-scan.${key}`, value])),
    checks: [{ id: 'secret-scan', status: outcome.status, evidence: outcome.evidence }],
  };
  assert.equal(exitCodeFor(result), 2);
  assert.match(formatHuman(result), /Preflight: INCONCLUSIVE/);
  assert.doesNotMatch(formatHuman(result), /PASS \(ACKNOWLEDGED INCOMPLETE COVERAGE\)/);
});

test('aggregate scan cap applies before either scanner and long paths remain exact behind safe display', async () => {
  const tooLarge = 'x'.repeat(MAX_SECRET_SCAN_BYTES + 1);
  const oversized: Changeset = { top: '/', base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [{ path: 'large.txt', status: 'added', origin: 'untracked', kind: 'file', content: Buffer.from(''), addedText: tooLarge, targetLines: [1], addedTextComplete: true }] };
  let called = false;
  const oversizedOutcome = await secretScanCheck([], () => { called = true; return { backend: 'builtin' as const, complete: true, findings: [] }; }).run({ worktree: '/', changeset: oversized });
  assert.equal(oversizedOutcome.status, 'inconclusive');
  assert.equal(called, false, 'the aggregate limit is enforced before either scanner is invoked');

  const path = `src/${'deep/'.repeat(80)}token.ts`;
  const changeset: Changeset = { top: '/', base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [{ path, status: 'added', origin: 'untracked', kind: 'file', content: Buffer.from(''), addedText: 'payload', targetLines: [7], addedTextComplete: true }] };
  const scanner = () => ({ backend: 'builtin' as const, complete: true, findings: [{ rule: 'fixture-rule', path, line: 7, redacted: true as const }] });
  const exceptionPath = `./${path.replaceAll('/', '\\')}`;
  const excepted = await secretScanCheck([{ path: exceptionPath, rule: 'fixture-rule', justification: 'Approved fixture.' }], scanner).run({ worktree: '/', changeset });
  assert.equal(excepted.status, 'pass');
  assert.equal(excepted.metrics?.exceptionsApplied, 1, 'exception matching uses the untruncated normalized path');
  const blocked = await secretScanCheck([], scanner).run({ worktree: '/', changeset });
  assert.equal(blocked.status, 'block');
  assert.ok(blocked.evidence.some(line => line.includes('[REDACTED]')));
  assert.ok(!blocked.evidence.some(line => line.includes(path)), 'display path is safely shortened while finding identity stays complete');

  const controlPath = 'src/first-line\nforged-line.ts';
  const controlChangeset: Changeset = { ...changeset, entries: [{ ...changeset.entries[0]!, path: controlPath }] };
  const controlFinding = await secretScanCheck([], () => ({ backend: 'builtin' as const, complete: true, findings: [{ rule: 'fixture-rule', path: controlPath, line: 7, redacted: true as const }] })).run({ worktree: '/', changeset: controlChangeset });
  assert.equal(controlFinding.status, 'block');
  assert.ok(controlFinding.evidence.some(line => line.includes('first-line\\u000aforged-line.ts')));
  assert.ok(controlFinding.evidence.every(line => !line.includes('\n')));
});

test('built-in secret detector returns sanitized locations only', () => {
  const result = scanAddedText([{ path: 'a.txt', line: 3, text: '-----BEGIN PRIVATE KEY-----' }], { probe: () => ({ available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' }) });
  assert.equal(result.complete, true);
  assert.equal(result.findings[0]?.path, 'a.txt');
  assert.equal(result.findings[0]?.line, 3);
  assert.equal(result.findings[0]?.redacted, true);
  assert.ok(!JSON.stringify(result).includes('BEGIN PRIVATE KEY'));
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repo(): string {
  const root = makeTempRoot('preflight-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(root, 'keep.txt'), 'keep\n');
  writeFileSync(join(root, 'old.txt'), 'rename me with enough content to be detected\n');
  writeFileSync(join(root, 'gone.txt'), 'delete me\n');
  writeFileSync(join(root, 'edit.txt'), 'v1\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'task');
  return root;
}

function cli(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

/** Simulates a clone's origin/HEAD locally (no network): origin/HEAD -> origin/main at the current main. */
function simulateOriginHead(root: string): void {
  git(root, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
}

function projectProfile(root: string, baseBranch = 'main') {
  const checks = Object.fromEntries(contextSections.map((name) => [name, { status: 'unconfigured' }]));
  return { version: 1, projectRoot: root, baseBranch, shell: 'bash', checks, device: { preference: 'ask' }, worktreeDirectory: join(root, '..', 'wt'), memoryPath: join(root, '..', 'mem', 'MEMORY.md') };
}

/**
 * Repo on `main` with committed context (AGENTS.md, or AGENTS.md linking to `ctx.md`) and
 * checked out on `task`. Simulates origin/HEAD unless `originHead` is false.
 */
function projectRepo(options: { originHead?: boolean; link?: boolean } = {}): string {
  const root = makeTempRoot('preflight-ctx-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  if (options.link) {
    writeFileSync(join(root, 'ctx.md'), updateContext('', 'project', projectProfile(root), []));
    writeFileSync(join(root, 'AGENTS.md'), 'Read `ctx.md` for Advanced Harness project settings before planning.\n');
  } else {
    writeFileSync(join(root, 'AGENTS.md'), updateContext('', 'project', projectProfile(root), []));
  }
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'add project context on main');
  if (options.originHead !== false) simulateOriginHead(root);
  git(root, 'checkout', '-q', '-b', 'task');
  return root;
}

function baseContextOf(result: { checks: { id: string; status: CheckStatus; evidence: string[] }[] }) {
  return result.checks.find((check) => check.id === 'base-context');
}

test('changeset covers committed, staged, unstaged, untracked, renamed, and deleted files with contents', () => {
  const root = repo();
  simulateOriginHead(root);
  writeFileSync(join(root, 'committed.txt'), 'new\n');
  renameSync(join(root, 'old.txt'), join(root, 'new.txt'));
  rmSync(join(root, 'gone.txt'));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'task');
  writeFileSync(join(root, 'staged.txt'), 'staged\n');
  git(root, 'add', 'staged.txt');
  writeFileSync(join(root, 'edit.txt'), 'v2\n');
  writeFileSync(join(root, 'empty.txt'), '');
  mkdirSync(join(root, 'dir'));
  writeFileSync(join(root, 'dir', 'untracked.txt'), 'u\n');
  writeFileSync(join(root, 'file with spaces.txt'), 'space\n');
  writeFileSync(join(root, 'file-[1].txt'), 'bracket\n');
  writeFileSync(join(root, 'café.txt'), 'accent\n');

  const { entries } = collectChangeset(root, 'main');
  const find = (path: string) => entries.find((entry) => entry.path === path);
  assert.deepEqual({ ...find('committed.txt'), content: find('committed.txt')?.content?.toString() }, { path: 'committed.txt', status: 'added', origin: 'committed', kind: 'file', content: 'new\n', addedText: 'new\n', targetLines: [1], addedTextComplete: true });
  assert.equal(find('committed.txt')?.addedText, 'new\n');
  assert.deepEqual(find('committed.txt')?.targetLines, [1]);
  assert.equal(find('new.txt')?.status, 'renamed');
  assert.equal(find('new.txt')?.oldPath, 'old.txt');
  assert.equal(find('gone.txt')?.status, 'deleted');
  assert.equal(find('gone.txt')?.content, undefined);
  assert.equal(find('staged.txt')?.origin, 'staged');
  assert.equal(find('staged.txt')?.content?.toString(), 'staged\n');
  assert.equal(find('staged.txt')?.addedText, 'staged\n');
  assert.deepEqual(find('staged.txt')?.targetLines, [1]);
  assert.equal(find('staged.txt')?.addedTextComplete, true);
  assert.equal(find('edit.txt')?.origin, 'unstaged');
  assert.equal(find('edit.txt')?.content?.toString(), 'v2\n');
  assert.equal(find('edit.txt')?.addedText, 'v2\n');
  assert.deepEqual(find('edit.txt')?.targetLines, [1]);
  assert.equal(find('edit.txt')?.addedTextComplete, true);
  assert.equal(find('dir/untracked.txt')?.origin, 'untracked');
  assert.equal(find('dir/untracked.txt')?.addedText, 'u\n');
  assert.deepEqual(find('dir/untracked.txt')?.targetLines, [1]);
  assert.equal(find('dir/untracked.txt')?.addedTextComplete, true);
  assert.equal(find('file with spaces.txt')?.content?.toString(), 'space\n');
  assert.equal(find('file-[1].txt')?.content?.toString(), 'bracket\n');
  assert.equal(find('café.txt')?.content?.toString(), 'accent\n');
  // A present zero-byte file is distinct from an absent (deleted) file.
  assert.equal(find('empty.txt')?.content?.length, 0);
  assert.equal(find('empty.txt')?.kind, 'file');
  assert.equal(find('gone.txt')?.kind, undefined);
});

test('symlinks are reported with their target, not as empty files', (t) => {
  const root = repo();
  simulateOriginHead(root);
  try { symlinkSync('keep.txt', join(root, 'link')); } catch { t.skip('symlinks unavailable on this machine'); return; }
  const link = collectChangeset(root, 'main').entries.find((entry) => entry.path === 'link');
  assert.equal(link?.kind, 'symlink');
  assert.equal(link?.content?.toString(), 'keep.txt');
  git(root, 'add', 'link');
  const staged = collectChangeset(root, 'main').entries.find((entry) => entry.path === 'link');
  assert.equal(staged?.origin, 'staged');
  assert.equal(staged?.kind, 'symlink');
  assert.equal(staged?.content?.toString(), 'keep.txt');
});

test('unstaged deletion and staged rename are reported', () => {
  const root = repo();
  git(root, 'mv', 'old.txt', 'moved.txt');
  rmSync(join(root, 'gone.txt'));
  const { entries } = collectChangeset(root, 'main');
  assert.deepEqual(entries.map(({ path, status, origin, oldPath }) => ({ path, status, origin, oldPath })), [
    { path: 'moved.txt', status: 'renamed', origin: 'staged', oldPath: 'old.txt' },
    { path: 'gone.txt', status: 'deleted', origin: 'unstaged', oldPath: undefined },
  ]);
});

test('staged deletion and multi-origin modifications are tracked per origin', () => {
  const root = repo();
  // committed edit on task branch
  writeFileSync(join(root, 'edit.txt'), 'v2-committed\n');
  git(root, 'commit', '-q', '-m', 'edit edit.txt on task', 'edit.txt');

  // staged edit on top of that
  writeFileSync(join(root, 'edit.txt'), 'v3-staged\n');
  git(root, 'add', 'edit.txt');

  // unstaged edit on top of that
  writeFileSync(join(root, 'edit.txt'), 'v4-working\n');

  // stage deletion of keep.txt
  git(root, 'rm', '-q', 'keep.txt');

  const { entries } = collectChangeset(root, 'main');
  const edits = entries.filter((e) => e.path === 'edit.txt');
  assert.equal(edits.length, 3);
  assert.equal(edits.find((e) => e.origin === 'committed')?.content?.toString(), 'v2-committed\n');
  assert.equal(edits.find((e) => e.origin === 'staged')?.content?.toString(), 'v3-staged\n');
  assert.equal(edits.find((e) => e.origin === 'unstaged')?.content?.toString(), 'v4-working\n');

  const stagedDel = entries.find((e) => e.path === 'keep.txt' && e.origin === 'staged');
  assert.equal(stagedDel?.status, 'deleted');
  assert.equal(stagedDel?.origin, 'staged');
  assert.equal(stagedDel?.content, undefined);
});

test('checks run in deterministic id order and aggregate block/warn', async () => {
  const root = repo();
  simulateOriginHead(root);
  const order: string[] = [];
  const make = (id: string, status: 'pass' | 'warn' | 'block'): PreflightCheck => ({ id, run: () => { order.push(id); return { status, evidence: [`${id} evidence`], metrics: { n: 1 } }; } });
  const result = await runPreflight({ worktree: root, base: 'main', checks: [make('c', 'block'), make('a', 'pass'), make('b', 'warn')] });
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(result.checks.map((check) => check.id), ['a', 'b', 'c']);
  assert.equal(result.approved, false);
  assert.deepEqual(result.blocking, ['c: c evidence']);
  assert.deepEqual(result.warnings, ['b: b evidence']);
  assert.deepEqual(result.metrics, { 'a.n': 1, 'b.n': 1, 'c.n': 1 });
  assert.equal(exitCodeFor(result), 1);
});

test('inconclusive takes precedence over block in exit codes', async () => {
  const root = repo();
  const make = (id: string, status: 'block' | 'inconclusive'): PreflightCheck => ({ id, run: () => ({ status, evidence: [`${id} evidence`] }) });
  const result = await runPreflight({ worktree: root, base: 'main', checks: [make('b', 'block'), make('a', 'inconclusive')] });
  assert.equal(result.approved, false);
  assert.equal(exitCodeFor(result), 2);
});

test('empty check list, unknown status, and duplicate check ids are inconclusive', async () => {
  const root = repo();
  const emptyRes = await runPreflight({ worktree: root, base: 'main', checks: [] });
  assert.equal(emptyRes.approved, false);
  assert.equal(exitCodeFor(emptyRes), 2);

  const unknownRes = await runPreflight({ worktree: root, base: 'main', checks: [{ id: 'u', run: () => ({ status: 'weird' as unknown as CheckStatus, evidence: ['weird'] }) }] });
  assert.equal(unknownRes.approved, false);
  assert.equal(exitCodeFor(unknownRes), 2);
  assert.equal(unknownRes.checks[0]?.status, 'inconclusive');

  const dupRes = await runPreflight({ worktree: root, base: 'main', checks: [{ id: 'dup', run: () => ({ status: 'pass', evidence: [] }) }, { id: 'dup', run: () => ({ status: 'pass', evidence: [] }) }] });
  assert.equal(dupRes.approved, false);
  assert.equal(exitCodeFor(dupRes), 2);
});

test('a throwing check is inconclusive, not a pass', async () => {
  const root = repo();
  const result = await runPreflight({ worktree: root, base: 'main', checks: [{ id: 'x', run: () => { throw new Error('boom'); } }] });
  assert.equal(result.checks[0]?.status, 'inconclusive');
  assert.equal(result.approved, false);
  assert.equal(exitCodeFor(result), 2);
});

test('missing base, missing ref, non-git directories, and unborn HEAD are inconclusive', async () => {
  const root = repo();
  const unborn = makeTempRoot('preflight-unborn-');
  git(unborn, 'init', '-q', '-b', 'main');
  for (const options of [
    { worktree: root },
    { worktree: root, base: 'does-not-exist' },
    { worktree: makeTempRoot('preflight-nogit-'), base: 'main' },
    { worktree: unborn, base: 'main' },
  ]) {
    const result = await runPreflight(options);
    assert.equal(result.approved, false);
    assert.equal(exitCodeFor(result), 2, JSON.stringify(result));
  }
});

test('base resolution exposes an explicit typed unresolved-base error', () => {
  const resolved = resolveBase(repo(), undefined);
  assert.ok('error' in resolved);
  if ('error' in resolved) assert.ok(resolved.error instanceof UnresolvedBaseError);
});

test('base ref defaults to baseBranch from project context, and base-context fails closed on context changes without explicit base', async () => {
  const root = makeTempRoot('preflight-base-ctx-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');

  const unconfigured = { status: 'unconfigured' };
  const checks = Object.fromEntries(['build', 'lint', 'unit', 'roborazzi', 'runtime', 'e2e'].map((name) => [name, unconfigured]));
  const profile = { version: 1, baseBranch: 'main', shell: 'bash', checks, device: { preference: 'ask' }, worktreeDirectory: join(root, '..', 'wt'), memoryPath: join(root, '..', 'mem', 'MEMORY.md') };
  writeFileSync(join(root, 'AGENTS.md'), updateContext('', 'project', profile, []));
  git(root, 'add', 'AGENTS.md');
  git(root, 'commit', '-q', '-m', 'add project context on main');
  simulateOriginHead(root);
  git(root, 'checkout', '-q', '-b', 'task');

  // Baseline: unmodified baseBranch
  const result = await runPreflight({ worktree: root, checks: [baseContextCheck] });
  assert.equal(exitCodeFor(result), 0, JSON.stringify(result));
  const baseCheck = result.checks.find((c) => c.id === 'base-context');
  assert.equal(baseCheck?.status, 'pass');

  // Modify project context in working tree without explicit --base -> BLOCKS (exit 1)
  const modifiedProfile = { ...profile, shell: 'cmd' };
  writeFileSync(join(root, 'AGENTS.md'), updateContext('', 'project', modifiedProfile, []));
  const blockedResult = await runPreflight({ worktree: root, checks: [baseContextCheck] });
  assert.equal(exitCodeFor(blockedResult), 1);
  const blockedBaseCheck = blockedResult.checks.find((c) => c.id === 'base-context');
  assert.equal(blockedBaseCheck?.status, 'block');
  assert.match(blockedBaseCheck!.evidence[0]!, /pass explicit --base <ref>/);
  assert.equal(blockedResult.blocking.length, 1);

  // When explicit --base is provided, base-context passes even with modified context
  const overrideResult = await runPreflight({ worktree: root, base: 'main', checks: [baseContextCheck] });
  assert.equal(exitCodeFor(overrideResult), 0);
  const overrideBaseCheck = overrideResult.checks.find((c) => c.id === 'base-context');
  assert.equal(overrideBaseCheck?.status, 'pass');
  assert.match(overrideBaseCheck!.evidence[0]!, /explicitly provided/);
});

test('submodule entries are reported with kind submodule and no content for committed, unstaged, and untracked', () => {
  const root = repo();
  const sub = makeTempRoot('preflight-sub-');
  git(sub, 'init', '-q', '-b', 'main');
  git(sub, 'config', 'user.email', 'sub@example.com');
  git(sub, 'config', 'user.name', 'Sub');
  writeFileSync(join(sub, 'sub.txt'), 'sub\n');
  git(sub, 'add', '.');
  git(sub, 'commit', '-q', '-m', 'sub commit');

  // Committed submodule
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.replaceAll('\\', '/'), 'mysub');
  git(join(root, 'mysub'), 'config', 'user.email', 'sub@example.com');
  git(join(root, 'mysub'), 'config', 'user.name', 'Sub');
  git(root, 'commit', '-q', '-m', 'add submodule');

  // Unstaged modification in submodule
  writeFileSync(join(root, 'mysub', 'sub.txt'), 'sub modified\n');
  git(join(root, 'mysub'), 'commit', '-q', '-a', '-m', 'sub inner commit');

  // Untracked nested repo
  const untrackedNested = join(root, 'nested-repo');
  mkdirSync(untrackedNested);
  git(untrackedNested, 'init', '-q', '-b', 'main');
  writeFileSync(join(untrackedNested, 'file.txt'), 'nested\n');

  const { entries } = collectChangeset(root, 'main');
  const subEntry = entries.find((e) => e.path === 'mysub' && e.origin === 'committed');
  assert.equal(subEntry?.kind, 'submodule');
  assert.equal(subEntry?.content, undefined);
  assert.match(subEntry?.gitlink?.newId ?? '', /^[0-9a-f]{40,64}$/i, 'committed gitlinks retain the exact new commit ID');

  const unstagedSub = entries.find((e) => e.path === 'mysub' && e.origin === 'unstaged');
  assert.equal(unstagedSub?.kind, 'submodule');
  assert.equal(unstagedSub?.content, undefined);

  const untrackedRepo = entries.find((e) => (e.path === 'nested-repo' || e.path === 'nested-repo/'));
  assert.equal(untrackedRepo?.kind, 'submodule');
  assert.equal(untrackedRepo?.content, undefined);
});

test('changed gitlinks expose exact before and after commit IDs for acknowledgement matching', () => {
  const root = repo();
  const sub = makeTempRoot('preflight-gitlink-ids-');
  git(sub, 'init', '-q', '-b', 'main');
  git(sub, 'config', 'user.email', 'sub@example.com');
  git(sub, 'config', 'user.name', 'Sub');
  writeFileSync(join(sub, 'payload.txt'), 'initial\n');
  git(sub, 'add', '.'); git(sub, 'commit', '-q', '-m', 'initial submodule commit');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.replaceAll('\\', '/'), 'vendor/lib');
  git(join(root, 'vendor/lib'), 'config', 'user.email', 'sub@example.com');
  git(join(root, 'vendor/lib'), 'config', 'user.name', 'Sub');
  git(root, 'commit', '-q', '-m', 'add gitlink');
  const base = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'vendor/lib', 'payload.txt'), 'updated\n');
  git(join(root, 'vendor/lib'), 'commit', '-q', '-a', '-m', 'advance submodule');
  git(root, 'add', 'vendor/lib');
  git(root, 'commit', '-q', '-m', 'advance gitlink');
  const entry = collectChangeset(root, base).entries.find(change => change.path === 'vendor/lib' && change.origin === 'committed');
  assert.equal(entry?.kind, 'submodule');
  assert.match(entry?.gitlink?.oldId ?? '', /^[0-9a-f]{40,64}$/i);
  assert.match(entry?.gitlink?.newId ?? '', /^[0-9a-f]{40,64}$/i);
  assert.notEqual(entry?.gitlink?.oldId, entry?.gitlink?.newId);
  assert.equal(entry?.content, undefined);
  assert.equal(entry?.addedTextComplete, false);
});

test('dirty untracked submodule content is a non-acknowledgeable coverage gap with unchanged IDs', async () => {
  const root = repo();
  const sub = makeTempRoot('preflight-dirty-submodule-');
  git(sub, 'init', '-q', '-b', 'main');
  git(sub, 'config', 'user.email', 'sub@example.com');
  git(sub, 'config', 'user.name', 'Sub');
  writeFileSync(join(sub, 'tracked.txt'), 'clean\n');
  git(sub, 'add', '.'); git(sub, 'commit', '-q', '-m', 'clean submodule');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.replaceAll('\\', '/'), 'vendor/lib');
  git(root, 'commit', '-q', '-m', 'add clean submodule');
  const id = git(join(root, 'vendor/lib'), 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'vendor/lib', 'untracked-secret.txt'), 'untracked content\n');

  const changeset = collectChangeset(root, 'main');
  const entry = changeset.entries.find(candidate => candidate.path === 'vendor/lib' && candidate.origin === 'unstaged');
  assert.deepEqual([entry?.gitlink?.oldId, entry?.gitlink?.newId], [id, id]);
  assert.equal(entry?.gitlink?.nestedContentDirty, true);
  const result = await secretScanCheck([], () => ({ backend: 'builtin', complete: true, findings: [] })).run({ worktree: root, changeset, gitlinkAcknowledgements: [{ path: 'vendor/lib', oldId: id, newId: id }] });
  assert.equal(result.status, 'inconclusive');
  assert.ok(result.evidence.some(line => line.includes('vendor/lib')));
});

test('nested Git timeout remains a dirty gap, is cached per path, and receives a scrubbed Git environment', async () => {
  const root = repo();
  const sub = makeTempRoot('preflight-timeout-submodule-');
  git(sub, 'init', '-q', '-b', 'main');
  git(sub, 'config', 'user.email', 'sub@example.com'); git(sub, 'config', 'user.name', 'Sub');
  writeFileSync(join(sub, 'tracked.txt'), 'A\n');
  git(sub, 'add', '.'); git(sub, 'commit', '-q', '-m', 'sub A');
  const idA = git(sub, 'rev-parse', 'HEAD');
  writeFileSync(join(sub, 'tracked.txt'), 'B\n');
  git(sub, 'add', '.'); git(sub, 'commit', '-q', '-m', 'sub B');
  const idB = git(sub, 'rev-parse', 'HEAD');

  git(root, 'checkout', '-q', 'main');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.replaceAll('\\', '/'), 'vendor/lib');
  git(join(root, 'vendor/lib'), 'checkout', '-q', idA);
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'base submodule');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'task-timeout');
  git(join(root, 'vendor/lib'), 'checkout', '-q', idB);
  git(root, 'add', 'vendor/lib'); git(root, 'commit', '-q', '-m', 'advance submodule');
  writeFileSync(join(root, 'vendor/lib', 'untracked.txt'), 'dirty nested content\n');

  let calls = 0;
  let suppliedEnvironment: NodeJS.ProcessEnv | undefined;
  const poisonKeys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const;
  const old = Object.fromEntries(poisonKeys.map(key => [key, process.env[key]])) as Record<typeof poisonKeys[number], string | undefined>;
  const runner = (_command: string, _args: readonly string[], options: { maxBuffer: number; timeout: number; env: NodeJS.ProcessEnv }) => {
    calls += 1;
    for (const key of poisonKeys) process.env[key] = 'poison';
    suppliedEnvironment = options.env;
    for (const key of poisonKeys) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
    const error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    return { error, status: null, stdout: Buffer.alloc(0) };
  };
  let changeset: Changeset;
  try { changeset = collectChangeset(root, base, 'option', { nestedStatus: runner }); }
  finally {
    for (const key of poisonKeys) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
  }
  assert.equal(calls, 1, 'changed gitlinks and the indexed dirty-link scan share the per-path status result');
  assert.equal(suppliedEnvironment?.GIT_DIR, undefined);
  assert.equal(suppliedEnvironment?.GIT_WORK_TREE, undefined);
  assert.equal(suppliedEnvironment?.GIT_INDEX_FILE, undefined);
  for (const key of poisonKeys.slice(3)) assert.equal(suppliedEnvironment?.[key], undefined, `${key} is scrubbed from nested Git`);
  assert.equal(suppliedEnvironment?.GIT_OPTIONAL_LOCKS, '0');
  const entry = changeset.entries.find(candidate => candidate.path === 'vendor/lib' && candidate.origin === 'committed');
  assert.equal(entry?.gitlink?.nestedContentDirty, true, 'a timed-out status probe is treated as dirty');
  const check = await secretScanCheck([], () => ({ backend: 'builtin', complete: true, findings: [] })).run({ worktree: root, changeset, gitlinkAcknowledgements: [{ path: 'vendor/lib', oldId: idA, newId: idB }] });
  assert.equal(check.status, 'inconclusive');
  assert.match(check.evidence.join('\n'), /vendor\/lib/);
});

test('nested Git environment helper removes inherited location and configuration overrides', () => {
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const;
  const originals = Object.fromEntries(keys.map(key => [key, process.env[key]])) as Record<typeof keys[number], string | undefined>;
  const values: Record<typeof keys[number], string> = {
    GIT_DIR: 'same-repo/.git', GIT_WORK_TREE: 'same-repo', GIT_INDEX_FILE: 'same-repo/.git/index', GIT_COMMON_DIR: 'same-repo/.git',
    GIT_OBJECT_DIRECTORY: 'same-repo/.git/objects', GIT_ALTERNATE_OBJECT_DIRECTORIES: 'same-repo/.git/objects',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
  };
  try {
    for (const key of keys) process.env[key] = values[key];
    const scrubbed = nestedGitEnvironment();
    for (const key of keys) assert.equal(scrubbed[key], undefined, `${key} must be removed for nested Git`);
    assert.equal(scrubbed.GIT_OPTIONAL_LOCKS, '0');
  } finally {
    for (const key of keys) {
      if (originals[key] === undefined) delete process.env[key]; else process.env[key] = originals[key];
    }
  }
});

test('populated gitlink directory without repository metadata is not acknowledgeable', async () => {
  const root = repo();
  const sub = makeTempRoot('preflight-no-git-submodule-');
  git(sub, 'init', '-q', '-b', 'main');
  git(sub, 'config', 'user.email', 'sub@example.com');
  git(sub, 'config', 'user.name', 'Sub');
  writeFileSync(join(sub, 'tracked.txt'), 'tracked\n');
  git(sub, 'add', '.'); git(sub, 'commit', '-q', '-m', 'submodule baseline');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.replaceAll('\\', '/'), 'vendor/lib');
  git(root, 'commit', '-q', '-m', 'add gitlink');
  const id = git(join(root, 'vendor/lib'), 'rev-parse', 'HEAD');
  rmSync(join(root, 'vendor/lib', '.git'), { recursive: true, force: true });
  writeFileSync(join(root, 'vendor/lib', 'local-only.txt'), 'untracked local content\n');

  const changeset = collectChangeset(root, 'main');
  const entry = changeset.entries.find(candidate => candidate.path === 'vendor/lib' && candidate.origin === 'unstaged');
  assert.deepEqual([entry?.gitlink?.oldId, entry?.gitlink?.newId], [id, id]);
  assert.equal(entry?.gitlink?.nestedContentDirty, true);
  const result = await secretScanCheck([], () => ({ backend: 'builtin', complete: true, findings: [] })).run({ worktree: root, changeset, gitlinkAcknowledgements: [{ path: 'vendor/lib', oldId: id, newId: id }] });
  assert.equal(result.status, 'inconclusive');
});

test('unstaged gitlink before-state comes from the index, not HEAD', async () => {
  const root = repo();
  const sub = makeTempRoot('preflight-index-gitlink-');
  git(sub, 'init', '-q', '-b', 'main');
  git(sub, 'config', 'user.email', 'sub@example.com');
  git(sub, 'config', 'user.name', 'Sub');
  writeFileSync(join(sub, 'payload.txt'), 'A\n');
  git(sub, 'add', '.'); git(sub, 'commit', '-q', '-m', 'gitlink A');
  git(root, 'checkout', '-q', 'main');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.replaceAll('\\', '/'), 'vendor/lib');
  git(join(root, 'vendor/lib'), 'config', 'user.email', 'sub@example.com');
  git(join(root, 'vendor/lib'), 'config', 'user.name', 'Sub');
  git(root, 'commit', '-q', '-m', 'baseline gitlink A');
  const base = git(root, 'rev-parse', 'HEAD');
  const idA = git(join(root, 'vendor/lib'), 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'task-gitlinks');

  writeFileSync(join(root, 'vendor/lib', 'payload.txt'), 'B\n');
  git(join(root, 'vendor/lib'), 'commit', '-q', '-a', '-m', 'gitlink B');
  const idB = git(join(root, 'vendor/lib'), 'rev-parse', 'HEAD');
  git(root, 'add', 'vendor/lib');

  writeFileSync(join(root, 'vendor/lib', 'payload.txt'), 'C\n');
  git(join(root, 'vendor/lib'), 'commit', '-q', '-a', '-m', 'gitlink C');
  const idC = git(join(root, 'vendor/lib'), 'rev-parse', 'HEAD');
  const changeset = collectChangeset(root, base);
  const staged = changeset.entries.find(entry => entry.path === 'vendor/lib' && entry.origin === 'staged');
  const unstaged = changeset.entries.find(entry => entry.path === 'vendor/lib' && entry.origin === 'unstaged');
  assert.deepEqual([staged?.gitlink?.oldId, staged?.gitlink?.newId], [idA, idB]);
  assert.deepEqual([unstaged?.gitlink?.oldId, unstaged?.gitlink?.newId], [idB, idC]);
  assert.notEqual(idA, idB);
  assert.notEqual(idB, idC);

  const unstagedChangeset: Changeset = { ...changeset, entries: [unstaged!] };
  const check = secretScanCheck([], () => ({ backend: 'builtin', complete: true, findings: [] }));
  const headBasedAck = await check.run({ worktree: root, changeset: unstagedChangeset, gitlinkAcknowledgements: [{ path: 'vendor/lib', oldId: idA, newId: idC }] });
  assert.equal(headBasedAck.status, 'inconclusive', 'HEAD A to worktree C cannot acknowledge the index B to worktree C gap');
  const indexBasedAck = await check.run({ worktree: root, changeset: unstagedChangeset, gitlinkAcknowledgements: [{ path: 'vendor/lib', oldId: idB, newId: idC }] });
  assert.equal(indexBasedAck.status, 'warn');
});

test('CLI exit codes and JSON contract', () => {
  const baseDir = makeTempRoot('preflight-cli-contract-');
  const repoRoot = join(baseDir, 'repo');
  const configuredWtDir = join(baseDir, 'configured-worktrees');
  const taskWt = join(configuredWtDir, 'task');
  mkdirSync(repoRoot);
  mkdirSync(configuredWtDir);

  git(repoRoot, 'init', '-q', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Test');
  git(repoRoot, 'config', 'core.autocrlf', 'false');

  const profile = {
    version: 1,
    projectRoot: repoRoot,
    baseBranch: 'main',
    shell: 'bash',
    checks: Object.fromEntries(contextSections.map((n) => [n, { status: 'unconfigured' }])),
    device: { preference: 'ask' },
    worktreeDirectory: configuredWtDir,
    memoryPath: join(baseDir, 'mem', 'MEMORY.md'),
  };
  writeFileSync(join(repoRoot, 'AGENTS.md'), updateContext('', 'project', profile, []));
  writeFileSync(join(repoRoot, 'u.txt'), 'u');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-q', '-m', 'init');
  simulateOriginHead(repoRoot);

  git(repoRoot, 'worktree', 'add', '-q', '-b', 'task', taskWt);
  writeFileSync(join(taskWt, 'new-file.txt'), 'content');

  const pass = cli('--worktree', taskWt, '--base', 'main', '--json');
  assert.equal(pass.status, 0, pass.stderr);
  const parsed = JSON.parse(pass.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ['approved', 'blocking', 'warnings', 'metrics', 'checks']);
  assert.equal(parsed.approved, true);

  const human = cli('--worktree', taskWt, '--base', 'main');
  assert.equal(human.status, 0);
  assert.match(human.stdout, /Preflight: PASS/);

  assert.equal(cli('--worktree', taskWt, '--base', 'nope').status, 2);
  assert.equal(cli('--bogus').status, 2);
  assert.equal(cli().status, 2);
  assert.equal(cli('--worktree', '--json').status, 2);
  assert.equal(cli('--worktree', taskWt, '--base', 'a', '--base', 'b').status, 2);

  const help = cli('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: npm run harness:preflight/);

  const shortHelp = cli('-h');
  assert.equal(shortHelp.status, 0);
  assert.match(shortHelp.stdout, /Usage: npm run harness:preflight/);

  // CLI exit 1 (blocked) when project context is modified without explicit --base
  const blockRepo = makeTempRoot('preflight-block-cli-');
  git(blockRepo, 'init', '-q', '-b', 'main');
  git(blockRepo, 'config', 'user.email', 'test@example.com');
  git(blockRepo, 'config', 'user.name', 'Test');
  git(blockRepo, 'config', 'core.autocrlf', 'false');
  const unconfigured = { status: 'unconfigured' };
  const checks = Object.fromEntries(['build', 'lint', 'unit', 'roborazzi', 'runtime', 'e2e'].map((name) => [name, unconfigured]));
  const blockProfile = { version: 1, projectRoot: blockRepo, baseBranch: 'main', shell: 'bash', checks, device: { preference: 'ask' }, worktreeDirectory: join(blockRepo, '..', 'wt'), memoryPath: join(blockRepo, '..', 'mem', 'MEMORY.md') };
  writeFileSync(join(blockRepo, 'AGENTS.md'), updateContext('', 'project', blockProfile, []));
  git(blockRepo, 'add', 'AGENTS.md');
  git(blockRepo, 'commit', '-q', '-m', 'add project context on main');
  simulateOriginHead(blockRepo);
  git(blockRepo, 'checkout', '-q', '-b', 'task');
  writeFileSync(join(blockRepo, 'AGENTS.md'), updateContext('', 'project', { ...blockProfile, shell: 'cmd' }, []));
  const blockedCli = cli('--worktree', blockRepo);
  assert.equal(blockedCli.status, 1);
  assert.match(blockedCli.stdout, /Preflight: BLOCKED/);

  // CLI exit 2 when the --base ref does not exist (missing-base case)
  const exit2Cli = cli('--worktree', blockRepo, '--base', 'does-not-exist');
  assert.equal(exit2Cli.status, 2);
});

test('CLI rejects the removed gitlink acknowledgement option with trusted-policy migration guidance', async () => {
  let received: Parameters<typeof runPreflight>[0] | undefined;
  const captured: string[] = [];
  const deps = {
    runPreflight: (options: Parameters<typeof runPreflight>[0]) => { received = options; return Promise.resolve({ approved: true, blocking: [], warnings: [], metrics: {}, checks: [{ id: 'x', status: 'pass' as const, evidence: [] }] }); },
    output: (message: string) => captured.push(message),
    error: (message: string) => captured.push(message),
  };
  const ack = { path: 'vendor/a', oldId: 'a'.repeat(40), newId: 'b'.repeat(40) };
  assert.equal(await runCli(['--worktree', '.', '--ack-gitlink', JSON.stringify(ack)], deps), 2);
  assert.match(captured.at(-1) ?? '', /trusted \.harness\/preflight\.json/);
  assert.equal(received, undefined);
});

test('CLI blocks a secret finding while keeping the payload out of human and JSON output', () => {
  const root = projectRepo();
  const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdef';
  writeFileSync(join(root, 'candidate.txt'), `token=${secret}\n`);
  const human = cli('--worktree', root, '--base', 'main');
  assert.equal(human.status, 1, human.stderr);
  assert.match(human.stdout, /Preflight: BLOCKED/);
  assert.match(human.stdout, /\[REDACTED\]/);
  assert.ok(!human.stdout.includes(secret));
  const json = cli('--worktree', root, '--base', 'main', '--json');
  assert.equal(json.status, 1, json.stderr);
  assert.ok(!json.stdout.includes(secret));
  assert.match(json.stdout, /\[REDACTED\]/);
});

test('CLI secret scan uses controlled PATH with Git and without Gitleaks', () => {
  const root = projectRepo();
  const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdef';
  writeFileSync(join(root, 'candidate.txt'), `token=${secret}\n`);
  const gitExecutable = (process.env.PATH ?? '').split(delimiter).map(value => value.replace(/^"(.*)"$/, '$1')).map(directory => join(directory, process.platform === 'win32' ? 'git.exe' : 'git')).find(path => existsSync(path));
  assert.ok(gitExecutable, 'a Git executable is available for the isolated PATH');
  const portableGit = process.platform === 'win32' ? resolve(gitExecutable, '..', '..', 'mingw64', 'bin', 'git.exe') : gitExecutable;
  const isolatedGitSource = existsSync(portableGit) ? portableGit : gitExecutable;
  const fixture = mkdtempSync(join(dirname(root), 'preflight-isolated-path-'));
  try {
    const bin = join(fixture, 'bin');
    mkdirSync(bin);
    const wrapper = join(bin, process.platform === 'win32' ? 'git.exe' : 'git');
    if (process.platform === 'win32') {
      copyFileSync(isolatedGitSource, wrapper);
      const dependencyDirectory = resolve(isolatedGitSource, '..');
      if (isolatedGitSource === portableGit) {
        for (const name of readdirSync(dependencyDirectory)) if (/\.dll$/i.test(name)) copyFileSync(join(dependencyDirectory, name), join(bin, name));
      }
    }
    else {
      writeFileSync(wrapper, `#!/bin/sh\nexec "${isolatedGitSource}" "$@"\n`);
      chmodSync(wrapper, 0o755);
    }
    const controlledPath = bin;
    assert.equal(resolveGitleaksExecutable(controlledPath), undefined);
    const result = spawnSync(process.execPath, [script, '--worktree', root, '--base', 'main'], { encoding: 'utf8', env: { ...process.env, PATH: controlledPath, GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Secret scan backend: builtin \(complete\)\./);
    assert.match(result.stdout, /candidate\.txt.*\[REDACTED\]/);
    assert.ok(!result.stdout.includes(secret));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('runCli maps an unexpected runner failure to exit 2 with the unexpected-error message', async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runCli(['--worktree', '/unused', '--base', 'main'], {
    runPreflight: async () => { throw new Error('boom'); },
    output: (message) => output.push(message),
    error: (message) => errors.push(message),
  });
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /Unexpected preflight error: boom/);
  assert.deepEqual(output, []);
});

test('committed baseBranch tampering is blocked against the trusted ref when --base is omitted', async () => {
  const root = projectRepo();
  git(root, 'branch', 'loose', 'main');
  writeFileSync(join(root, 'AGENTS.md'), updateContext('', 'project', projectProfile(root, 'loose'), []));
  git(root, 'add', 'AGENTS.md');
  git(root, 'commit', '-q', '-m', 'tamper baseBranch on task');

  const result = await runPreflight({ worktree: root });
  assert.equal(exitCodeFor(result), 1, JSON.stringify(result));
  const check = baseContextOf(result);
  assert.equal(check?.status, 'block');
  assert.match(check!.evidence[0]!, /baseBranch main \(trusted\) vs loose \(worktree\)/);
});

test('repointing AGENTS.md to another tracked context file with a different baseBranch is blocked', async () => {
  const root = makeTempRoot('preflight-repoint-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(root, 'ctx.md'), updateContext('', 'project', projectProfile(root, 'main'), []));
  writeFileSync(join(root, 'other.md'), updateContext('', 'project', projectProfile(root, 'loose'), []));
  writeFileSync(join(root, 'AGENTS.md'), 'Read `ctx.md` for Advanced Harness project settings before planning.\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'linked context on main');
  git(root, 'branch', 'loose', 'main');
  simulateOriginHead(root);
  git(root, 'checkout', '-q', '-b', 'task');
  writeFileSync(join(root, 'AGENTS.md'), 'Read `other.md` for Advanced Harness project settings before planning.\n');
  git(root, 'add', 'AGENTS.md');
  git(root, 'commit', '-q', '-m', 'repoint link on task');

  const result = await runPreflight({ worktree: root });
  assert.equal(exitCodeFor(result), 1, JSON.stringify(result));
  const check = baseContextOf(result);
  assert.equal(check?.status, 'block');
  assert.match(check!.evidence[0]!, /linked context target ctx\.md \(trusted\) vs other\.md \(worktree\)/);
});

// Covers the earlier resolution failure: contextPath rejects the escaping link during base resolution,
// so the run is inconclusive before base-context's defensive leavesRepo guards are reached.
test('a linked context file outside the repository is inconclusive', async () => {
  const root = makeTempRoot('preflight-outside-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(root, 'AGENTS.md'), 'Read `../outside.md` for Advanced Harness project settings before planning.\n');
  git(root, 'add', 'AGENTS.md');
  git(root, 'commit', '-q', '-m', 'escaping link on main');
  simulateOriginHead(root);
  git(root, 'checkout', '-q', '-b', 'task');

  const result = await runPreflight({ worktree: root });
  assert.equal(exitCodeFor(result), 2, JSON.stringify(result));
  assert.equal(baseContextOf(result)?.status, 'inconclusive');
});

test('a missing origin/HEAD is inconclusive and directs restoration of the trusted ref', async () => {
  const root = projectRepo({ originHead: false });
  const result = await runPreflight({ worktree: root });
  assert.equal(exitCodeFor(result), 2, JSON.stringify(result));
  const check = baseContextOf(result);
  assert.equal(check?.status, 'inconclusive');
  const secretScan = result.checks.find(item => item.id === 'secret-scan');
  assert.match(secretScan!.evidence[0]!, /restore it with `git remote set-head origin --auto`/);
  assert.doesNotMatch(secretScan!.evidence[0]!, /pass --base/);
  const explicitBase = await runPreflight({ worktree: root, base: 'main' });
  const explicitScan = explicitBase.checks.find(item => item.id === 'secret-scan');
  assert.equal(explicitScan?.status, 'inconclusive');
  assert.match(explicitScan!.evidence[0]!, /git remote set-head origin --auto/);
  assert.match(explicitScan!.evidence[0]!, /--base selects the changeset comparison only/);
});

test('an untouched project context matching origin/HEAD passes, including through a linked context file', async () => {
  const root = projectRepo({ link: true });
  const result = await runPreflight({ worktree: root, checks: [baseContextCheck] });
  assert.equal(exitCodeFor(result), 0, JSON.stringify(result));
  assert.equal(baseContextOf(result)?.status, 'pass');
  assert.match(baseContextOf(result)!.evidence[0]!, /matches trusted ref/);
});

test('R-01: the CLI runs when spawned through a relative path from another cwd', () => {
  const elsewhere = makeTempRoot('preflight-entry-cwd-');
  const relativeScript = relative(elsewhere, script);
  const viaRelative = spawnSync(process.execPath, [relativeScript, '--help'], { cwd: elsewhere, encoding: 'utf8' });
  assert.equal(viaRelative.status, 0, viaRelative.stderr);
  assert.match(viaRelative.stdout, /Usage: npm run harness:preflight/);
  const missingViaRelative = spawnSync(process.execPath, [relativeScript], { cwd: elsewhere, encoding: 'utf8' });
  assert.equal(missingViaRelative.status, 2, missingViaRelative.stderr);
  assert.match(missingViaRelative.stderr, /Missing required --worktree/);
});

test('R-01: the CLI runs when spawned through a renamed symlink (skips only when symlinks are unavailable)', (t) => {
  // A file name that does not end in preflight.ts must still run: the entry check compares real module URLs.
  const linkDir = makeTempRoot('preflight-entry-link-');
  const link = join(linkDir, 'renamed-check.ts');
  try { symlinkSync(script, link, 'file'); } catch { t.skip('file symlinks unavailable on this machine'); return; }
  const viaLink = spawnSync(process.execPath, [link, '-h'], { encoding: 'utf8' });
  assert.equal(viaLink.status, 0, viaLink.stderr);
  assert.match(viaLink.stdout, /Usage: npm run harness:preflight/);
  const missingViaLink = spawnSync(process.execPath, [link], { encoding: 'utf8' });
  assert.equal(missingViaLink.status, 2, missingViaLink.stderr);
  assert.match(missingViaLink.stderr, /Missing required --worktree/);
});

test('R-06: entryDecision runs on a matching module URL', () => {
  const moduleUrl = pathToFileURL(script).href;
  assert.equal(entryDecision(script, moduleUrl, false, () => script), 'run');
  assert.equal(entryDecision(join(makeTempRoot('preflight-decide-'), 'renamed.ts'), moduleUrl, false, () => script), 'run');
});

test('R-06: entryDecision skips an unrelated argv1 and an undefined argv1', () => {
  const moduleUrl = pathToFileURL(script).href;
  const other = join(makeTempRoot('preflight-decide-other-'), 'other.ts');
  assert.equal(entryDecision(other, moduleUrl, false, () => other), 'skip');
  assert.equal(entryDecision(undefined, moduleUrl, false), 'skip');
  // The node test runner executes test/preflight.test.ts, whose basename must not look like this module.
  const testFile = join(makeTempRoot('preflight-decide-test-'), 'preflight.test.ts');
  assert.equal(entryDecision(testFile, moduleUrl, false, () => testFile), 'skip');
});

test('R-06: entryDecision is ambiguous for the same basename at a different URL, by argv1 or realpath', () => {
  const moduleUrl = pathToFileURL(script).href;
  const impostor = join(makeTempRoot('preflight-decide-impostor-'), 'preflight.ts');
  assert.equal(entryDecision(impostor, moduleUrl, false, () => impostor), 'ambiguous');
  assert.equal(entryDecision(impostor, moduleUrl, false, () => { throw new Error('ENOENT'); }), 'ambiguous');
  const renamedToImpostor = join(makeTempRoot('preflight-decide-renamed-'), 'renamed.ts');
  assert.equal(entryDecision(renamedToImpostor, moduleUrl, false, () => impostor), 'ambiguous');
});

test('R-06: entryDecision runs when import.meta.main is true', () => {
  const moduleUrl = pathToFileURL(script).href;
  assert.equal(entryDecision(undefined, moduleUrl, true), 'run');
  assert.equal(entryDecision('/some/other.ts', moduleUrl, true, () => '/some/other.ts'), 'run');
});

test('R-08: entryDecision matches a win32 module URL case-insensitively', (t) => {
  if (process.platform !== 'win32') { t.skip('case-insensitive URL matching applies only on win32'); return; }
  const modulePath = join(makeTempRoot('preflight-decide-case-'), 'case-check.ts');
  const argv1 = modulePath.toUpperCase();
  const moduleUrl = pathToFileURL(modulePath).href.toLowerCase();
  // The two URLs differ only by case, so only sameUrl's win32 case folding can make this 'run'.
  assert.equal(pathToFileURL(argv1).href.toLowerCase(), moduleUrl);
  assert.notEqual(pathToFileURL(argv1).href, moduleUrl);
  assert.equal(entryDecision(argv1, moduleUrl, false, () => argv1), 'run');
});

test('R-02: deleting the linked context file without --base is inconclusive, not a block', async () => {
  const root = projectRepo({ link: true });
  rmSync(join(root, 'ctx.md'));
  const result = await runPreflight({ worktree: root });
  assert.equal(exitCodeFor(result), 2, JSON.stringify(result));
  assert.equal(baseContextOf(result)?.status, 'inconclusive');
  assert.match(baseContextOf(result)!.evidence[0]!, /No base ref/);
});

test('R-03: base-context leavesRepo guard fires for a linked target outside the changeset top (direct call with a hand-built changeset)', async () => {
  // Defensive guard: real runs reject escaping links earlier (contextPath), so this exercises the check directly.
  const worktree = makeTempRoot('preflight-guard-wt-');
  writeFileSync(join(worktree, 'AGENTS.md'), 'Read `ctx.md` for Advanced Harness project settings before planning.\n');
  writeFileSync(join(worktree, 'ctx.md'), updateContext('', 'project', projectProfile(worktree), []));
  const changeset: Changeset = { top: makeTempRoot('preflight-guard-top-'), base: 'main', baseSource: 'project-context', mergeBase: '', head: '', entries: [] };
  const outcome = await baseContextCheck.run({ worktree, changeset });
  assert.equal(outcome.status, 'inconclusive');
  assert.match(outcome.evidence[0]!, /resolves outside the repository/);
});

test('R-04(a): a modified linked context file with the same baseBranch and link is blocked without --base', async () => {
  const root = projectRepo({ link: true });
  writeFileSync(join(root, 'ctx.md'), updateContext('', 'project', { ...projectProfile(root), shell: 'cmd' }, []));
  git(root, 'add', 'ctx.md');
  git(root, 'commit', '-q', '-m', 'change shell in linked context on task');
  const result = await runPreflight({ worktree: root });
  assert.equal(exitCodeFor(result), 1, JSON.stringify(result));
  assert.equal(baseContextOf(result)?.status, 'block');
  assert.match(baseContextOf(result)!.evidence[0]!, /Project context \(ctx\.md\) was modified/);
});

test('R-04(b): a staged rename of the linked context file without --base is inconclusive (base resolution fails first, not block)', async () => {
  const root = projectRepo({ link: true });
  git(root, 'mv', 'ctx.md', 'ctx2.md');
  const result = await runPreflight({ worktree: root });
  assert.equal(exitCodeFor(result), 2, JSON.stringify(result));
  assert.equal(baseContextOf(result)?.status, 'inconclusive');
  assert.match(baseContextOf(result)!.evidence[0]!, /No base ref/);
});

/** Repo whose `main` is built by `commitMain` (trusted ref via simulated origin/HEAD); task branch carries a valid worktree AGENTS.md. */
function trustedRefRepo(commitMain: (root: string) => void): string {
  const root = makeTempRoot('preflight-trusted-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  commitMain(root);
  simulateOriginHead(root);
  git(root, 'checkout', '-q', '-b', 'task');
  writeFileSync(join(root, 'AGENTS.md'), updateContext('', 'project', projectProfile(root), []));
  git(root, 'add', 'AGENTS.md');
  git(root, 'commit', '-q', '-m', 'valid worktree context on task');
  return root;
}

test('R-05: unverifiable trusted project context at the trusted ref is inconclusive', async (t) => {
  const commitMain = (root: string, content: string) => {
    writeFileSync(join(root, 'AGENTS.md'), content);
    git(root, 'add', 'AGENTS.md');
    git(root, 'commit', '-q', '-m', 'trusted context on main');
  };
  const scenarios: { name: string; commitMain: (root: string) => void; evidence: RegExp }[] = [
    {
      name: 'trusted AGENTS.md has no project settings section',
      commitMain: (root) => commitMain(root, 'Plain instructions without settings.\n'),
      evidence: /no project settings in AGENTS\.md at trusted ref/,
    },
    {
      name: 'trusted project profile is invalid',
      commitMain: (root) => commitMain(root, updateContext('', 'project', { version: 1 }, [])),
      evidence: /Trusted project context could not be verified: /,
    },
    {
      name: 'trusted AGENTS.md exceeds 1 MiB',
      commitMain: (root) => commitMain(root, updateContext('', 'project', projectProfile(root), []) + 'x'.repeat(1024 * 1024)),
      evidence: /exceeds 1 MiB/,
    },
    {
      name: 'trusted AGENTS.md is a non-regular blob (symlink mode 120000)',
      commitMain: (root) => {
        commitMain(root, updateContext('', 'project', projectProfile(root), []));
        const hash = spawnSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'ctx.md', encoding: 'utf8' });
        assert.equal(hash.status, 0, hash.stderr);
        git(root, 'update-index', '--cacheinfo', `120000,${hash.stdout.trim()},AGENTS.md`);
        git(root, 'commit', '-q', '-m', 'AGENTS.md as symlink blob on main');
      },
      evidence: /is not a regular file/,
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const root = trustedRefRepo(scenario.commitMain);
      const result = await runPreflight({ worktree: root });
      assert.equal(exitCodeFor(result), 2, JSON.stringify(result));
      const check = baseContextOf(result);
      assert.equal(check?.status, 'inconclusive');
      assert.match(check!.evidence[0]!, scenario.evidence);
    });
  }
});

function worktreeBoundaryOf(result: { checks: { id: string; status: CheckStatus; evidence: string[] }[] }) {
  return result.checks.find((check) => check.id === 'worktree-boundary');
}

function makeBoundaryFixture(baseDir: string, options: { originHead?: boolean; link?: boolean } = {}) {
  const repoRoot = join(baseDir, 'repo');
  const configuredWtDir = join(baseDir, 'configured-worktrees');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(configuredWtDir, { recursive: true });

  git(repoRoot, 'init', '-q', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Test');
  git(repoRoot, 'config', 'core.autocrlf', 'false');

  const profile = {
    version: 1,
    projectRoot: repoRoot,
    baseBranch: 'main',
    shell: 'bash',
    checks: Object.fromEntries(contextSections.map((n) => [n, { status: 'unconfigured' }])),
    device: { preference: 'ask' },
    worktreeDirectory: configuredWtDir,
    memoryPath: join(baseDir, 'mem', 'MEMORY.md'),
  };
  if (options.link) {
    writeFileSync(join(repoRoot, 'ctx.md'), updateContext('', 'project', profile, []));
    writeFileSync(join(repoRoot, 'AGENTS.md'), 'Read `ctx.md` for Advanced Harness project settings before planning.\n');
  } else {
    writeFileSync(join(repoRoot, 'AGENTS.md'), updateContext('', 'project', profile, []));
  }
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-q', '-m', 'init');
  if (options.originHead !== false) simulateOriginHead(repoRoot);
  return { repoRoot, configuredWtDir };
}

test('worktree-boundary: canonical checkout is blocked', async () => {
  const root = projectRepo();
  const outcome = await worktreeBoundaryCheck.run({
    worktree: root,
    changeset: { top: root, base: 'main', baseSource: 'project-context', mergeBase: '', head: '', entries: [] },
  });
  assert.equal(outcome.status, 'block');
  assert.match(outcome.evidence[0]!, /canonical repository checkout, not an isolated task worktree/);
});

test('worktree-boundary: defaultChecks pipeline blocks canonical checkout', async () => {
  const root = projectRepo();
  const result = await runPreflight({ worktree: root });
  assert.equal(exitCodeFor(result), 1);
  assert.equal(result.approved, false);
  const boundaryCheck = worktreeBoundaryOf(result);
  assert.equal(boundaryCheck?.status, 'block');
  assert.match(boundaryCheck!.evidence[0]!, /canonical repository checkout/);
});

test('worktree-boundary: defaultChecks pipeline on linked worktree with modified AGENTS.md (with and without --base)', async () => {
  const baseDir = makeTempRoot('preflight-pipeline-linked-mod-');
  const { repoRoot, configuredWtDir } = makeBoundaryFixture(baseDir);
  const taskWt = join(configuredWtDir, 'task');
  git(repoRoot, 'worktree', 'add', '-q', '-b', 'task', taskWt);
  simulateOriginHead(repoRoot);

  // Modify AGENTS.md in task worktree without touching worktreeDirectory
  const modifiedProfile = {
    version: 1,
    projectRoot: repoRoot,
    baseBranch: 'main',
    shell: 'bash',
    checks: Object.fromEntries(contextSections.map((n) => [n, { status: 'configured', command: 'echo ok' }])),
    device: { preference: 'ask' },
    worktreeDirectory: configuredWtDir,
    memoryPath: join(baseDir, 'mem', 'MEMORY.md'),
  };
  writeFileSync(join(taskWt, 'AGENTS.md'), updateContext('', 'project', modifiedProfile, []));

  // Without --base: base-context check blocks because context was modified without explicit base
  const resultNoBase = await runPreflight({ worktree: taskWt });
  assert.equal(exitCodeFor(resultNoBase), 1);
  assert.equal(resultNoBase.approved, false);
  const baseCheck = resultNoBase.checks.find((c) => c.id === 'base-context');
  assert.equal(baseCheck?.status, 'block');
  assert.match(baseCheck!.evidence[0]!, /Project context .* was modified in this changeset; pass explicit --base/);
  // worktreeBoundaryCheck itself passes because worktreeDirectory matches trusted ref
  const boundaryCheckNoBase = worktreeBoundaryOf(resultNoBase);
  assert.equal(boundaryCheckNoBase?.status, 'pass');

  // With explicit --base: base-context passes (informational), and worktreeBoundaryCheck passes
  const resultWithBase = await runPreflight({ worktree: taskWt, base: 'main' });
  assert.equal(exitCodeFor(resultWithBase), 0);
  assert.equal(resultWithBase.approved, true);
  const baseCheckWithBase = resultWithBase.checks.find((c) => c.id === 'base-context');
  assert.equal(baseCheckWithBase?.status, 'pass');
  assert.match(baseCheckWithBase!.evidence[1]!, /Project context file .* modified \(informational; explicit --base in use\)/);
  const boundaryCheckWithBase = worktreeBoundaryOf(resultWithBase);
  assert.equal(boundaryCheckWithBase?.status, 'pass');
});

test('worktree-boundary: missing worktreeDirectory in project context is blocked', async () => {
  const root = makeTempRoot('preflight-wt-missing-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(root, 'init.txt'), 'init');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  const wt = makeTempRoot('preflight-wt-linked-');
  git(root, 'worktree', 'add', '-q', '-b', 'task', wt);
  // wt has no AGENTS.md / project context configured
  const outcome = await worktreeBoundaryCheck.run({
    worktree: wt,
    changeset: { top: wt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
  });
  assert.equal(outcome.status, 'block');
  assert.match(outcome.evidence[0]!, /No shared worktreeDirectory is configured/);
});

test('worktree-boundary: modified project context / worktreeDirectory verification with trusted ref', async () => {
  // 1. Without trusted ref origin/HEAD, worktreeBoundaryCheck blocks because trusted worktreeDirectory cannot be verified
  const baseDirNoTrusted = makeTempRoot('preflight-wt-notrusted-');
  const { repoRoot: repoNoTrusted, configuredWtDir: wtDirNoTrusted } = makeBoundaryFixture(baseDirNoTrusted, { originHead: false });
  const taskWtNoTrusted = join(wtDirNoTrusted, 'task');
  git(repoNoTrusted, 'worktree', 'add', '-q', '-b', 'task', taskWtNoTrusted);
  const outcomeNoTrusted = await worktreeBoundaryCheck.run({
    worktree: taskWtNoTrusted,
    changeset: { top: taskWtNoTrusted, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
  });
  assert.equal(outcomeNoTrusted.status, 'block');
  assert.match(outcomeNoTrusted.evidence[0]!, /Trusted worktreeDirectory could not be verified against refs\/remotes\/origin\/HEAD/);
  assert.match(outcomeNoTrusted.evidence[0]!, /run `git remote set-head origin --auto`/);
  assert.doesNotMatch(outcomeNoTrusted.evidence[0]!, /--base/);

  // 2. With trusted ref origin/HEAD, modifying worktreeDirectory (unstaged, in changeset) blocks
  const baseDir = makeTempRoot('preflight-wt-mod-');
  const { repoRoot, configuredWtDir } = makeBoundaryFixture(baseDir);
  const taskWt = join(configuredWtDir, 'task');
  git(repoRoot, 'worktree', 'add', '-q', '-b', 'task', taskWt);

  const modifiedProfile = {
    version: 1,
    projectRoot: repoRoot,
    baseBranch: 'main',
    shell: 'bash',
    checks: Object.fromEntries(contextSections.map((n) => [n, { status: 'unconfigured' }])),
    device: { preference: 'ask' },
    worktreeDirectory: join(baseDir, 'other-worktrees'),
    memoryPath: join(baseDir, 'mem', 'MEMORY.md'),
  };
  writeFileSync(join(taskWt, 'AGENTS.md'), updateContext('', 'project', modifiedProfile, []));
  const { entries } = collectChangeset(taskWt, 'main');
  const outcomeMod = await worktreeBoundaryCheck.run({
    worktree: taskWt,
    changeset: { top: taskWt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries },
  });
  assert.equal(outcomeMod.status, 'block');
  assert.match(outcomeMod.evidence[0]!, /modified worktreeDirectory/);

  // 3. Modifying an unrelated field in AGENTS.md (e.g. checks) while preserving worktreeDirectory passes
  const unmodifiedWtProfile = {
    ...modifiedProfile,
    worktreeDirectory: configuredWtDir,
    checks: Object.fromEntries(contextSections.map((n) => [n, { status: 'configured', command: 'echo ok' }])),
  };
  writeFileSync(join(taskWt, 'AGENTS.md'), updateContext('', 'project', unmodifiedWtProfile, []));
  const updatedChangeset = collectChangeset(taskWt, 'main');
  assert.ok(updatedChangeset.entries.some((e) => e.path === 'AGENTS.md'));
  const outcomeUnrelated = await worktreeBoundaryCheck.run({
    worktree: taskWt,
    changeset: { top: taskWt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: updatedChangeset.entries },
  });
  assert.equal(outcomeUnrelated.status, 'pass');

  // 4. Committed edit to worktreeDirectory on task branch when running with --base HEAD (empty changeset entries)
  writeFileSync(join(taskWt, 'AGENTS.md'), updateContext('', 'project', modifiedProfile, []));
  git(taskWt, 'add', 'AGENTS.md');
  git(taskWt, 'commit', '-q', '-m', 'modify worktreeDirectory');
  const headChangeset = collectChangeset(taskWt, 'HEAD');
  assert.equal(headChangeset.entries.length, 0);
  const outcomeCommittedHead = await worktreeBoundaryCheck.run({
    worktree: taskWt,
    changeset: headChangeset,
  });
  assert.equal(outcomeCommittedHead.status, 'block');
  assert.match(outcomeCommittedHead.evidence[0]!, /modified worktreeDirectory/);

  const preflightHead = await runPreflight({ worktree: taskWt, base: 'HEAD' });
  assert.equal(exitCodeFor(preflightHead), 1);
  const boundaryCheckHead = worktreeBoundaryOf(preflightHead);
  assert.equal(boundaryCheckHead?.status, 'block');
  assert.match(boundaryCheckHead!.evidence[0]!, /modified worktreeDirectory/);
});

test('worktree-boundary: AGENTS.md absent at trusted ref is blocked', async () => {
  const baseDirAbsent = makeTempRoot('preflight-wt-absent-');
  const repoAbsent = join(baseDirAbsent, 'repo');
  const wtDirAbsent = join(baseDirAbsent, 'wt');
  mkdirSync(repoAbsent, { recursive: true });
  mkdirSync(wtDirAbsent, { recursive: true });
  git(repoAbsent, 'init', '-q', '-b', 'main');
  git(repoAbsent, 'config', 'user.email', 'test@example.com');
  git(repoAbsent, 'config', 'user.name', 'Test');
  git(repoAbsent, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repoAbsent, 'init.txt'), 'init\n');
  git(repoAbsent, 'add', '.');
  git(repoAbsent, 'commit', '-q', '-m', 'init without context');
  simulateOriginHead(repoAbsent);

  const taskWtAbsent = join(wtDirAbsent, 'task');
  git(repoAbsent, 'worktree', 'add', '-q', '-b', 'task', taskWtAbsent);
  const validProfile = {
    version: 1,
    projectRoot: repoAbsent,
    baseBranch: 'main',
    shell: 'bash',
    checks: Object.fromEntries(contextSections.map((n) => [n, { status: 'unconfigured' }])),
    device: { preference: 'ask' },
    worktreeDirectory: wtDirAbsent,
    memoryPath: join(baseDirAbsent, 'mem', 'MEMORY.md'),
  };
  writeFileSync(join(taskWtAbsent, 'AGENTS.md'), updateContext('', 'project', validProfile, []));
  const outcomeAbsent = await worktreeBoundaryCheck.run({
    worktree: taskWtAbsent,
    changeset: { top: taskWtAbsent, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
  });
  assert.equal(outcomeAbsent.status, 'block');
  assert.match(outcomeAbsent.evidence[0]!, /AGENTS\.md is absent at trusted ref/);
});

test('worktree-boundary: linked context ctx.md verification against trusted ref', async () => {
  const baseDirLink = makeTempRoot('preflight-wt-link-');
  const { repoRoot: repoLink, configuredWtDir: wtDirLink } = makeBoundaryFixture(baseDirLink, { link: true });
  const taskWtLink = join(wtDirLink, 'task');
  git(repoLink, 'worktree', 'add', '-q', '-b', 'task', taskWtLink);

  // 1. Untouched linked context passes
  const outcomeLinkUntouched = await worktreeBoundaryCheck.run({
    worktree: taskWtLink,
    changeset: { top: taskWtLink, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
  });
  assert.equal(outcomeLinkUntouched.status, 'pass');

  // 2. Modifying an unrelated field in ctx.md passes
  const profileLink = {
    version: 1,
    projectRoot: repoLink,
    baseBranch: 'main',
    shell: 'bash',
    checks: Object.fromEntries(contextSections.map((n) => [n, { status: 'configured', command: 'echo ok' }])),
    device: { preference: 'ask' },
    worktreeDirectory: wtDirLink,
    memoryPath: join(baseDirLink, 'mem', 'MEMORY.md'),
  };
  writeFileSync(join(taskWtLink, 'ctx.md'), updateContext('', 'project', profileLink, []));
  const linkChangeset = collectChangeset(taskWtLink, 'main');
  assert.ok(linkChangeset.entries.some((e) => e.path === 'ctx.md'));
  const outcomeLinkUnrelated = await worktreeBoundaryCheck.run({
    worktree: taskWtLink,
    changeset: linkChangeset,
  });
  assert.equal(outcomeLinkUnrelated.status, 'pass');

  // 3. Modifying worktreeDirectory in ctx.md (unstaged) blocks
  const profileLinkMod = {
    ...profileLink,
    worktreeDirectory: join(baseDirLink, 'other-wt'),
  };
  writeFileSync(join(taskWtLink, 'ctx.md'), updateContext('', 'project', profileLinkMod, []));
  const linkModChangeset = collectChangeset(taskWtLink, 'main');
  const outcomeLinkMod = await worktreeBoundaryCheck.run({
    worktree: taskWtLink,
    changeset: linkModChangeset,
  });
  assert.equal(outcomeLinkMod.status, 'block');
  assert.match(outcomeLinkMod.evidence[0]!, /modified worktreeDirectory/);

  // 4. Modifying worktreeDirectory in ctx.md (committed with --base HEAD) blocks
  git(taskWtLink, 'add', 'ctx.md');
  git(taskWtLink, 'commit', '-q', '-m', 'modify worktreeDirectory in ctx.md');
  const headLinkChangeset = collectChangeset(taskWtLink, 'HEAD');
  assert.equal(headLinkChangeset.entries.length, 0);
  const outcomeLinkCommittedHead = await worktreeBoundaryCheck.run({
    worktree: taskWtLink,
    changeset: headLinkChangeset,
  });
  assert.equal(outcomeLinkCommittedHead.status, 'block');
  assert.match(outcomeLinkCommittedHead.evidence[0]!, /modified worktreeDirectory/);

  // 5. If AGENTS.md at origin/HEAD links to ctx.md which is absent at origin/HEAD, it blocks
  const baseDirAbsentCtx = makeTempRoot('preflight-wt-absent-ctx-');
  const repoAbsentCtx = join(baseDirAbsentCtx, 'repo');
  const wtDirAbsentCtx = join(baseDirAbsentCtx, 'wt');
  mkdirSync(repoAbsentCtx, { recursive: true });
  mkdirSync(wtDirAbsentCtx, { recursive: true });
  git(repoAbsentCtx, 'init', '-q', '-b', 'main');
  git(repoAbsentCtx, 'config', 'user.email', 'test@example.com');
  git(repoAbsentCtx, 'config', 'user.name', 'Test');
  git(repoAbsentCtx, 'config', 'core.autocrlf', 'false');
  // Commit AGENTS.md linking to ctx.md, but do not commit ctx.md
  writeFileSync(join(repoAbsentCtx, 'AGENTS.md'), 'Read `ctx.md` for Advanced Harness project settings before planning.\n');
  git(repoAbsentCtx, 'add', '.');
  git(repoAbsentCtx, 'commit', '-q', '-m', 'link to absent ctx.md');
  simulateOriginHead(repoAbsentCtx);

  const taskWtAbsentCtx = join(wtDirAbsentCtx, 'task');
  git(repoAbsentCtx, 'worktree', 'add', '-q', '-b', 'task', taskWtAbsentCtx);
  writeFileSync(join(taskWtAbsentCtx, 'ctx.md'), updateContext('', 'project', {
    version: 1,
    projectRoot: repoAbsentCtx,
    baseBranch: 'main',
    shell: 'bash',
    checks: Object.fromEntries(contextSections.map((n) => [n, { status: 'unconfigured' }])),
    device: { preference: 'ask' },
    worktreeDirectory: wtDirAbsentCtx,
    memoryPath: join(baseDirAbsentCtx, 'mem', 'MEMORY.md'),
  }, []));
  const outcomeAbsentCtx = await worktreeBoundaryCheck.run({
    worktree: taskWtAbsentCtx,
    changeset: { top: taskWtAbsentCtx, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
  });
  assert.equal(outcomeAbsentCtx.status, 'block');
  assert.match(outcomeAbsentCtx.evidence[0]!, /ctx\.md is absent at trusted ref/);
});

test('worktree-boundary: preflight exit code precedence when trusted ref is missing (linked worktree)', async () => {
  const baseDir = makeTempRoot('preflight-wt-precedence-');
  const { repoRoot, configuredWtDir } = makeBoundaryFixture(baseDir, { originHead: false });
  const taskWt = join(configuredWtDir, 'task');
  git(repoRoot, 'worktree', 'add', '-q', '-b', 'task', taskWt);

  // 1. Without --base: base-context is inconclusive, worktree-boundary is block, overall exit 2
  const resultNoBase = await runPreflight({ worktree: taskWt });
  const baseCheckNoBase = resultNoBase.checks.find((c) => c.id === 'base-context');
  const boundaryCheckNoBase = worktreeBoundaryOf(resultNoBase);
  assert.equal(baseCheckNoBase?.status, 'inconclusive');
  assert.equal(boundaryCheckNoBase?.status, 'block');
  assert.equal(resultNoBase.approved, false);
  assert.equal(exitCodeFor(resultNoBase), 2);

  // 2. Explicit --base does not replace the independent trusted policy ref, so policy-dependent checks remain inconclusive.
  const resultWithBase = await runPreflight({ worktree: taskWt, base: 'main' });
  const baseCheckWithBase = resultWithBase.checks.find((c) => c.id === 'base-context');
  const boundaryCheckWithBase = worktreeBoundaryOf(resultWithBase);
  assert.equal(baseCheckWithBase?.status, 'pass');
  assert.equal(boundaryCheckWithBase?.status, 'block');
  assert.equal(resultWithBase.approved, false);
  assert.equal(exitCodeFor(resultWithBase), 2);
});

test('worktree-boundary: trailing slash on configured worktreeDirectory passes without false modification block', async () => {
  const baseDir = makeTempRoot('preflight-wt-slash-');
  const repoRoot = join(baseDir, 'repo');
  const configuredWtDir = join(baseDir, 'configured-worktrees');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(configuredWtDir, { recursive: true });

  git(repoRoot, 'init', '-q', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Test');
  git(repoRoot, 'config', 'core.autocrlf', 'false');

  const profileWithSlash = {
    version: 1 as const,
    projectRoot: repoRoot,
    baseBranch: 'main',
    shell: 'bash' as const,
    checks: Object.fromEntries(contextSections.map((n) => [n, { status: 'unconfigured' as const }])),
    device: { preference: 'ask' as const },
    worktreeDirectory: `${configuredWtDir}/`,
    memoryPath: join(baseDir, 'mem', 'MEMORY.md'),
  };
  writeFileSync(join(repoRoot, 'AGENTS.md'), updateContext('', 'project', profileWithSlash, []));
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-q', '-m', 'init with trailing slash');
  simulateOriginHead(repoRoot);

  const taskWt = join(configuredWtDir, 'task');
  git(repoRoot, 'worktree', 'add', '-q', '-b', 'task', taskWt);

  const outcome = await worktreeBoundaryCheck.run({
    worktree: taskWt,
    changeset: { top: taskWt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
  });
  assert.equal(outcome.status, 'pass');
  assert.match(outcome.evidence[0]!, /is an isolated task worktree under/);
});

test('worktree-boundary: repository with only interim paths section is blocked', async () => {
  const baseDir = makeTempRoot('preflight-wt-paths-only-');
  const repoRoot = join(baseDir, 'repo');
  const configuredWtDir = join(baseDir, 'configured-worktrees');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(configuredWtDir, { recursive: true });

  git(repoRoot, 'init', '-q', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Test');
  git(repoRoot, 'config', 'core.autocrlf', 'false');

  const memoryDir = join(baseDir, 'mem');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, 'MEMORY.md'), '# Shared Memory\n');

  writeFileSync(
    join(repoRoot, 'AGENTS.md'),
    updateContext('', 'paths', {
      version: 1,
      worktreeDirectory: configuredWtDir,
      memoryPath: join(memoryDir, 'MEMORY.md'),
    }, []),
  );
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-q', '-m', 'init with paths section only');
  simulateOriginHead(repoRoot);

  const taskWt = join(configuredWtDir, 'task');
  git(repoRoot, 'worktree', 'add', '-q', '-b', 'task', taskWt);

  const outcome = await worktreeBoundaryCheck.run({
    worktree: taskWt,
    changeset: { top: taskWt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
  });
  assert.equal(outcome.status, 'block');
  assert.match(
    outcome.evidence[0]!,
    /Trusted worktreeDirectory could not be verified against refs\/remotes\/origin\/HEAD: no project settings in AGENTS\.md at trusted ref refs\/remotes\/origin\/HEAD/,
  );
});

test('worktree-boundary: worktree with paths-only context against valid origin/HEAD project section is blocked', async () => {
  const baseDir = makeTempRoot('preflight-wt-local-paths-');
  const { repoRoot, configuredWtDir } = makeBoundaryFixture(baseDir);
  const taskWt = join(configuredWtDir, 'task');
  git(repoRoot, 'worktree', 'add', '-q', '-b', 'task', taskWt);

  // Modify task worktree's AGENTS.md to have only interim paths settings
  const memoryDir = join(baseDir, 'mem');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, 'MEMORY.md'), '# Shared Memory\n');

  writeFileSync(
    join(taskWt, 'AGENTS.md'),
    updateContext('', 'paths', {
      version: 1,
      worktreeDirectory: configuredWtDir,
      memoryPath: join(memoryDir, 'MEMORY.md'),
    }, []),
  );

  const outcome = await worktreeBoundaryCheck.run({
    worktree: taskWt,
    changeset: { top: taskWt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
  });
  assert.equal(outcome.status, 'block');
  assert.match(outcome.evidence[0]!, /Project has paths configuration but no project settings/);
});

test('worktree-boundary: linked worktree outside configured worktreeDirectory is blocked', async () => {
  const baseDir = makeTempRoot('preflight-wt-outside-');
  const { repoRoot } = makeBoundaryFixture(baseDir);
  const actualWt = join(baseDir, 'unauthorized-worktree');

  git(repoRoot, 'worktree', 'add', '-q', '-b', 'task', actualWt);
  const outcome = await worktreeBoundaryCheck.run({
    worktree: actualWt,
    changeset: { top: actualWt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
  });
  assert.equal(outcome.status, 'block');
  assert.match(outcome.evidence[0]!, /outside the configured worktreeDirectory/);
});

test('worktree-boundary: valid linked worktree under configured worktreeDirectory passes, and checks task branch matching', async () => {
  const baseDir = makeTempRoot('preflight-wt-valid-');
  const { repoRoot, configuredWtDir } = makeBoundaryFixture(baseDir);
  const taskWt = join(configuredWtDir, 'issue-182');

  git(repoRoot, 'worktree', 'add', '-q', '-b', 'issue/182', taskWt);

  // 1. Without task option -> passes
  const resNoTask = await worktreeBoundaryCheck.run({
    worktree: taskWt,
    changeset: { top: taskWt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
  });
  assert.equal(resNoTask.status, 'pass');
  assert.match(resNoTask.evidence[0]!, /is an isolated task worktree under/);

  // 2. With matching task '#182' and '182' -> passes
  const resMatchingHash = await worktreeBoundaryCheck.run({
    worktree: taskWt,
    changeset: { top: taskWt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
    task: '#182',
  });
  assert.equal(resMatchingHash.status, 'pass');
  assert.match(resMatchingHash.evidence[1]!, /matches task key '#182'/);

  const resMatchingNum = await worktreeBoundaryCheck.run({
    worktree: taskWt,
    changeset: { top: taskWt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
    task: '182',
  });
  assert.equal(resMatchingNum.status, 'pass');

  // Matching BH-067 key -> passes
  const bhWt = join(configuredWtDir, 'bh-067-task');
  git(repoRoot, 'worktree', 'add', '-q', '-b', 'feature/bh-067-check', bhWt);
  const resBh = await worktreeBoundaryCheck.run({
    worktree: bhWt,
    changeset: { top: bhWt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
    task: 'BH-067',
  });
  assert.equal(resBh.status, 'pass');

  // 3. With non-matching task (e.g. 1820 or 999) -> blocks
  const resMismatchSuffix = await worktreeBoundaryCheck.run({
    worktree: taskWt,
    changeset: { top: taskWt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
    task: '18',
  });
  assert.equal(resMismatchSuffix.status, 'block');
  assert.match(resMismatchSuffix.evidence[0]!, /does not match task key '18'/);

  const resMismatch1820 = await worktreeBoundaryCheck.run({
    worktree: taskWt,
    changeset: { top: taskWt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
    task: '1820',
  });
  assert.equal(resMismatch1820.status, 'block');

  const resMismatchOther = await worktreeBoundaryCheck.run({
    worktree: taskWt,
    changeset: { top: taskWt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
    task: '999',
  });
  assert.equal(resMismatchOther.status, 'block');
  assert.match(resMismatchOther.evidence[0]!, /does not match task key '999'/);

  // 4. Detached HEAD with task -> blocks
  git(taskWt, 'checkout', '-q', '--detach');
  const resDetached = await worktreeBoundaryCheck.run({
    worktree: taskWt,
    changeset: { top: taskWt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
    task: '182',
  });
  assert.equal(resDetached.status, 'block');
  assert.match(resDetached.evidence[0]!, /Worktree HEAD is detached/);
});

test('worktree-boundary: symlink escape and linked worktreeDirectory handling', async (t) => {
  const baseDir = makeTempRoot('preflight-wt-symlink-');
  const { repoRoot, configuredWtDir } = makeBoundaryFixture(baseDir);
  const outsideDir = join(baseDir, 'outside-target');
  mkdirSync(outsideDir);

  const actualOutsideWt = join(outsideDir, 'worktree-1');
  git(repoRoot, 'worktree', 'add', '-q', '-b', 'task', actualOutsideWt);

  // 1. Escaping link inside configuredWtDir pointing outside
  const linkInside = join(configuredWtDir, 'escaped-link');
  let canLink = false;
  try {
    symlinkSync(actualOutsideWt, linkInside, 'junction');
    canLink = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') {
      try {
        symlinkSync(actualOutsideWt, linkInside, 'dir');
        canLink = true;
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException).code !== 'EPERM') throw err2;
      }
    }
  }

  if (!canLink) {
    t.skip('Directory symlinks unavailable on this platform');
    return;
  }

  const outcome = await worktreeBoundaryCheck.run({
    worktree: linkInside,
    changeset: { top: linkInside, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
  });
  assert.equal(outcome.status, 'block');
  assert.match(outcome.evidence[0]!, /outside the configured worktreeDirectory/);

  // 2. Legitimate task worktree reached through a symlinked parent directory (configured worktreeDirectory is the real path)
  const linkedWtParent = join(baseDir, 'linked-wt-parent');
  let canLinkParent = false;
  try {
    symlinkSync(configuredWtDir, linkedWtParent, process.platform === 'win32' ? 'junction' : 'dir');
    canLinkParent = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
  }

  if (!canLinkParent) {
    t.skip('Directory symlinks unavailable on this platform');
    return;
  }

  // Note: we test containment of legitWt (inside linkedWtParent) directly against worktreeBoundaryCheck
  // where worktree containment resolves physical symlinks via realpath.
  const legitWt = join(linkedWtParent, 'legit-task');
  git(repoRoot, 'worktree', 'add', '-q', '-b', 'legit', legitWt);
  const legitOutcome = await worktreeBoundaryCheck.run({
    worktree: legitWt,
    changeset: { top: legitWt, base: 'main', baseSource: 'option', mergeBase: '', head: '', entries: [] },
  });
  assert.equal(legitOutcome.status, 'pass');
});

test('CLI supports --task <key> and reports usage or blocks on mismatch', () => {
  const baseDir = makeTempRoot('preflight-cli-task-');
  const { repoRoot, configuredWtDir } = makeBoundaryFixture(baseDir);
  const taskWt = join(configuredWtDir, 'issue-182');
  simulateOriginHead(repoRoot);

  git(repoRoot, 'worktree', 'add', '-q', '-b', 'issue/182', taskWt);

  // CLI exit 0 with matching --task
  const pass = cli('--worktree', taskWt, '--task', '182');
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /Preflight: PASS/);

  // CLI exit 1 with non-matching --task
  const failMismatch = cli('--worktree', taskWt, '--task', '999');
  assert.equal(failMismatch.status, 1);
  assert.match(failMismatch.stdout, /Preflight: BLOCKED/);

  // CLI exit 2 on duplicate or missing --task value
  assert.equal(cli('--worktree', taskWt, '--task').status, 2);
  assert.equal(cli('--worktree', taskWt, '--task', '182', '--task', '183').status, 2);
});

test('worktree-boundary: path containment arithmetic edge cases', () => {
  // Parent is a base directory
  const parent = resolve('/path/to/worktrees');

  // Exact parent (rel === '') -> not contained (must be strictly inside)
  assert.equal(isPathContained(parent, parent), false);

  // Normal child -> contained
  assert.equal(isPathContained(parent, join(parent, 'task-1')), true);

  // Child starting with dots (e.g. ..foo) -> contained (it is a valid child name, not traversal)
  assert.equal(isPathContained(parent, join(parent, '..foo')), true);

  // Nested child -> contained
  assert.equal(isPathContained(parent, join(parent, 'sub', 'task-2')), true);

  // Parent traversal (rel === '..' or starting with ../) -> not contained
  assert.equal(isPathContained(parent, resolve(parent, '..')), false);
  assert.equal(isPathContained(parent, resolve(parent, '..', 'other')), false);

  // Sibling prefix collision (e.g. /path/to/worktrees-other) -> not contained
  const siblingWithPrefix = `${parent}-other`;
  assert.equal(isPathContained(parent, siblingWithPrefix), false);

  // POSIX path containment (unconditional on all platforms)
  const posixParent = '/path/to/worktrees';
  assert.equal(isPathContained(posixParent, posixParent, posix), false);
  assert.equal(isPathContained(posixParent, '/path/to/worktrees/task-1', posix), true);
  assert.equal(isPathContained(posixParent, '/path/to/worktrees/..foo', posix), true);
  assert.equal(isPathContained(posixParent, '/path/to/worktrees/sub/task-2', posix), true);
  assert.equal(isPathContained(posixParent, '/path/to', posix), false);
  assert.equal(isPathContained(posixParent, '/path/to/other', posix), false);
  assert.equal(isPathContained(posixParent, '/path/to/worktrees-other', posix), false);

  // Windows path containment (unconditional on all platforms)
  assert.equal(isPathContained('C:\\worktrees', 'D:\\worktrees\\task-1', win32), false);
  assert.equal(isPathContained('C:\\worktrees', 'C:\\worktrees', win32), false);
  assert.equal(isPathContained('C:\\worktrees', 'C:\\worktrees\\task-1', win32), true);
  assert.equal(isPathContained('C:\\worktrees', 'C:\\worktrees\\..foo', win32), true);
  assert.equal(isPathContained('C:\\worktrees', 'C:\\worktrees-other\\task-1', win32), false);
});
