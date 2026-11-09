import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectChangeset } from '../src/preflight/changeset.ts';
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
