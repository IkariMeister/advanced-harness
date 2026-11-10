import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectChangeset } from '../src/preflight/changeset.ts';
import { secretScanCheck } from '../src/preflight/checks.ts';
import { makeTempRoot } from './temp-directory.ts';

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
test('changeset exposes added text and new-side line numbers per committed, staged, unstaged, and untracked origin', () => {
  const root = makeTempRoot('preflight-lines-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'committed.txt'), 'base\n');
  writeFileSync(join(root, 'committed [name].txt'), 'old\n');
  writeFileSync(join(root, 'staged [name].txt'), 'old\n');
  writeFileSync(join(root, 'unstaged [name].txt'), 'old\n');
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'base'); git(root, 'checkout', '-q', '-b', 'task');
  writeFileSync(join(root, 'committed.txt'), 'base\ncommitted\n++committed\nafter committed\n');
  writeFileSync(join(root, 'committed [name].txt'), 'old\nadded\n');
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 3]));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'committed change');
  writeFileSync(join(root, 'staged [name].txt'), 'old\n++staged\nafter staged\n'); git(root, 'add', 'staged [name].txt');
  writeFileSync(join(root, 'unstaged [name].txt'), 'old\n++unstaged\nafter unstaged\n');
  writeFileSync(join(root, 'untracked.txt'), 'untracked\n');
  const entries = collectChangeset(root, 'main').entries;
  const byPath = (path: string, origin: string) => entries.find(entry => entry.path === path && entry.origin === origin);
  assert.deepEqual(byPath('committed.txt', 'committed')?.targetLines, [2, 3, 4]);
  assert.equal(byPath('committed.txt', 'committed')?.addedText, 'committed\n++committed\nafter committed\n');
  assert.deepEqual(byPath('untracked.txt', 'untracked')?.targetLines, [1]);
  assert.equal(byPath('untracked.txt', 'untracked')?.addedText, 'untracked\n');
  assert.equal(byPath('committed [name].txt', 'committed')?.addedText, 'added\n');
  assert.deepEqual(byPath('committed [name].txt', 'committed')?.targetLines, [2]);
  assert.equal(byPath('staged [name].txt', 'staged')?.addedText, '++staged\nafter staged\n');
  assert.deepEqual(byPath('staged [name].txt', 'staged')?.targetLines, [2, 3]);
  assert.equal(byPath('unstaged [name].txt', 'unstaged')?.addedText, '++unstaged\nafter unstaged\n');
  assert.deepEqual(byPath('unstaged [name].txt', 'unstaged')?.targetLines, [2, 3]);
  assert.equal(byPath('binary.bin', 'committed')?.addedTextComplete, false);
});

test('renamed destinations retain added line locations and non-UTF-8 content is inconclusive', () => {
  const root = makeTempRoot('preflight-rename-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  const original = ['stable first', 'stable second', 'stable third', 'stable fourth', 'line five old content', 'stable sixth', 'stable seventh', 'stable eighth', 'stable ninth', 'stable tenth'].join('\n') + '\n';
  writeFileSync(join(root, 'old.txt'), original);
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'base'); git(root, 'checkout', '-q', '-b', 'task');
  git(root, 'mv', 'old.txt', 'new.txt');
  writeFileSync(join(root, 'new.txt'), original.replace('line five old content', 'line five updated content'));
  git(root, 'add', 'new.txt'); git(root, 'commit', '-q', '-m', 'rename with edit');
  writeFileSync(join(root, 'blank-lines.txt'), 'alpha\n\nomega\n');
  writeFileSync(join(root, 'invalid-utf8.txt'), Buffer.from([0x61, 0xff, 0x62]));
  const entries = collectChangeset(root, 'main').entries;
  const renamed = entries.find(entry => entry.path === 'new.txt' && entry.origin === 'committed');
  assert.equal(renamed?.status, 'renamed');
  assert.equal(renamed?.oldPath, 'old.txt');
  assert.deepEqual(renamed?.targetLines, [5]);
  assert.equal(renamed?.addedText, 'line five updated content\n');
  assert.deepEqual(entries.find(entry => entry.path === 'blank-lines.txt')?.targetLines, [1, 2, 3]);
  assert.equal(entries.find(entry => entry.path === 'blank-lines.txt')?.addedText, 'alpha\n\nomega\n');
  assert.equal(entries.find(entry => entry.path === 'invalid-utf8.txt')?.addedTextComplete, false);
});

test('untracked symlinks are not followed and make secret scanning inconclusive', async (t) => {
  const root = makeTempRoot('preflight-symlink-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'keep.txt'), 'keep\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'base'); git(root, 'checkout', '-q', '-b', 'task');
  writeFileSync(join(root, 'secret-target.txt'), 'const api_key = "THIS_IS_A_FAKE_SECRET_VALUE_0123456789";\n');
  try { symlinkSync('secret-target.txt', join(root, 'link.txt')); } catch { t.skip('symlinks unavailable on this machine'); return; }
  const changeset = collectChangeset(root, 'main');
  const link = changeset.entries.find(entry => entry.path === 'link.txt');
  assert.equal(link?.kind, 'symlink');
  assert.equal(link?.content?.toString(), 'secret-target.txt', 'only the link target is read; target file contents are not followed');
  assert.equal(link?.addedTextComplete, false);
  const outcome = await secretScanCheck().run({ worktree: root, changeset });
  assert.equal(outcome.status, 'inconclusive');
});
