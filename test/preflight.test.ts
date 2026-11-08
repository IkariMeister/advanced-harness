import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { updateContext } from '../src/project-context.ts';
import { collectChangeset } from '../src/preflight/changeset.ts';
import { exitCodeFor, runPreflight } from '../src/preflight/runner.ts';
import type { PreflightCheck } from '../src/preflight/types.ts';
import { makeTempRoot } from './temp-directory.ts';

const script = resolve(import.meta.dirname, '../scripts/preflight.ts');

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

test('changeset covers committed, staged, unstaged, untracked, renamed, and deleted files with contents', () => {
  const root = repo();
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
  assert.deepEqual({ ...find('committed.txt'), content: find('committed.txt')?.content?.toString() }, { path: 'committed.txt', status: 'added', origin: 'committed', kind: 'file', content: 'new\n' });
  assert.equal(find('new.txt')?.status, 'renamed');
  assert.equal(find('new.txt')?.oldPath, 'old.txt');
  assert.equal(find('gone.txt')?.status, 'deleted');
  assert.equal(find('gone.txt')?.content, undefined);
  assert.equal(find('staged.txt')?.origin, 'staged');
  assert.equal(find('staged.txt')?.content?.toString(), 'staged\n');
  assert.equal(find('edit.txt')?.origin, 'unstaged');
  assert.equal(find('edit.txt')?.content?.toString(), 'v2\n');
  assert.equal(find('dir/untracked.txt')?.origin, 'untracked');
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

  const unknownRes = await runPreflight({ worktree: root, base: 'main', checks: [{ id: 'u', run: () => ({ status: 'weird' as unknown as any, evidence: ['weird'] }) }] });
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
  git(root, 'checkout', '-q', '-b', 'task');

  // Baseline: unmodified baseBranch
  const result = await runPreflight({ worktree: root });
  assert.equal(exitCodeFor(result), 0, JSON.stringify(result));
  const baseCheck = result.checks.find((c) => c.id === 'base-context');
  assert.equal(baseCheck?.status, 'pass');

  // Modify project context in working tree without explicit --base -> BLOCKS (exit 1)
  const modifiedProfile = { ...profile, shell: 'cmd' };
  writeFileSync(join(root, 'AGENTS.md'), updateContext('', 'project', modifiedProfile, []));
  const blockedResult = await runPreflight({ worktree: root });
  assert.equal(exitCodeFor(blockedResult), 1);
  const blockedBaseCheck = blockedResult.checks.find((c) => c.id === 'base-context');
  assert.equal(blockedBaseCheck?.status, 'block');
  assert.match(blockedBaseCheck!.evidence[0]!, /pass explicit --base <ref>/);
  assert.equal(blockedResult.blocking.length, 1);

  // When explicit --base is provided, base-context passes even with modified context
  const overrideResult = await runPreflight({ worktree: root, base: 'main' });
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

  const unstagedSub = entries.find((e) => e.path === 'mysub' && e.origin === 'unstaged');
  assert.equal(unstagedSub?.kind, 'submodule');
  assert.equal(unstagedSub?.content, undefined);

  const untrackedRepo = entries.find((e) => (e.path === 'nested-repo' || e.path === 'nested-repo/'));
  assert.equal(untrackedRepo?.kind, 'submodule');
  assert.equal(untrackedRepo?.content, undefined);
});

test('CLI exit codes and JSON contract', () => {
  const root = repo();
  writeFileSync(join(root, 'u.txt'), 'u');
  const pass = cli('--worktree', root, '--base', 'main', '--json');
  assert.equal(pass.status, 0, pass.stderr);
  const parsed = JSON.parse(pass.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ['approved', 'blocking', 'warnings', 'metrics', 'checks']);
  assert.equal(parsed.approved, true);

  const human = cli('--worktree', root, '--base', 'main');
  assert.equal(human.status, 0);
  assert.match(human.stdout, /Preflight: PASS/);

  assert.equal(cli('--worktree', root, '--base', 'nope').status, 2);
  assert.equal(cli('--bogus').status, 2);
  assert.equal(cli().status, 2);
  assert.equal(cli('--worktree', '--json').status, 2);
  assert.equal(cli('--worktree', root, '--base', 'a', '--base', 'b').status, 2);

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
  const profile = { version: 1, baseBranch: 'main', shell: 'bash', checks, device: { preference: 'ask' }, worktreeDirectory: join(blockRepo, '..', 'wt'), memoryPath: join(blockRepo, '..', 'mem', 'MEMORY.md') };
  writeFileSync(join(blockRepo, 'AGENTS.md'), updateContext('', 'project', profile, []));
  git(blockRepo, 'add', 'AGENTS.md');
  git(blockRepo, 'commit', '-q', '-m', 'add project context on main');
  git(blockRepo, 'checkout', '-q', '-b', 'task');
  writeFileSync(join(blockRepo, 'AGENTS.md'), updateContext('', 'project', { ...profile, shell: 'cmd' }, []));
  const blockedCli = cli('--worktree', blockRepo);
  assert.equal(blockedCli.status, 1);
  assert.match(blockedCli.stdout, /Preflight: BLOCKED/);

  // CLI exit 2 on unhandled failure
  const exit2Cli = cli('--worktree', blockRepo, '--base', 'does-not-exist');
  assert.equal(exit2Cli.status, 2);
});
