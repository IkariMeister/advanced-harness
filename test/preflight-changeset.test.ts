import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectChangeset, parseCatFileBatch } from '../src/preflight/changeset.ts';
import { secretScanCheck } from '../src/preflight/checks.ts';
import { PreflightToolError } from '../src/preflight/types.ts';
import { makeTempRoot } from './temp-directory.ts';

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function gitText(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A repository with one base commit on `main` and the `task` branch checked out. */
function initRepository(prefix: string): string {
  const root = makeTempRoot(prefix);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(root, 'seed.txt'), 'seed\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'base'); git(root, 'checkout', '-q', '-b', 'task');
  return root;
}

function entryFor<T extends { path: string; origin: string }>(entries: T[], path: string, origin: string): T | undefined {
  return entries.find(entry => entry.path === path && entry.origin === origin);
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
  writeFileSync(join(root, 'empty-untracked.txt'), '');
  const entries = collectChangeset(root, 'main').entries;
  const byPath = (path: string, origin: string) => entries.find(entry => entry.path === path && entry.origin === origin);
  assert.deepEqual(byPath('committed.txt', 'committed')?.targetLines, [2, 3, 4]);
  assert.equal(byPath('committed.txt', 'committed')?.addedText, 'committed\n++committed\nafter committed\n');
  assert.deepEqual(byPath('untracked.txt', 'untracked')?.targetLines, [1]);
  assert.equal(byPath('untracked.txt', 'untracked')?.addedText, 'untracked\n');
  assert.deepEqual(byPath('empty-untracked.txt', 'untracked')?.targetLines, []);
  assert.equal(byPath('empty-untracked.txt', 'untracked')?.addedText, '');
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
  writeFileSync(join(root, 'secret-target.txt'), 'const api_key = "THIS_IS_A_FAKE_SECRET_VALUE_0123456789";\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'base'); git(root, 'checkout', '-q', '-b', 'task');
  try { symlinkSync('secret-target.txt', join(root, 'link.txt')); } catch { t.skip('symlinks unavailable on this machine'); return; }
  const changeset = collectChangeset(root, 'main');
  const link = changeset.entries.find(entry => entry.path === 'link.txt');
  assert.equal(link?.kind, 'symlink');
  assert.equal(link?.content?.toString(), 'secret-target.txt', 'only the link target is read; target file contents are not followed');
  assert.equal(link?.addedTextComplete, false);
  const outcome = await secretScanCheck().run({ worktree: root, changeset });
  assert.equal(outcome.status, 'inconclusive');
});

test('batched blob reads keep binary, empty, and CRLF content byte-exact in committed and staged passes', () => {
  const root = initRepository('preflight-bytes-');
  const committed: [string, Buffer][] = [
    ['committed.bin', Buffer.from([0, 255, 13, 10, 0x80, 0])],
    ['committed-empty.txt', Buffer.alloc(0)],
    ['committed-crlf.txt', Buffer.from('first\r\nsecond\r\n')],
  ];
  const staged: [string, Buffer][] = [
    ['staged.bin', Buffer.from([0, 1, 2, 13, 10])],
    ['staged-empty.txt', Buffer.alloc(0)],
    ['staged-crlf.txt', Buffer.from('third\r\n\r\nfourth\r\n')],
  ];
  for (const [path, bytes] of committed) writeFileSync(join(root, path), bytes);
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'committed bytes');
  for (const [path, bytes] of staged) writeFileSync(join(root, path), bytes);
  git(root, 'add', '.');
  const entries = collectChangeset(root, 'main').entries;
  for (const [path, bytes] of committed) {
    const entry = entryFor(entries, path, 'committed');
    assert.equal(entry?.kind, 'file', path);
    assert.deepEqual(entry?.content, bytes, path);
  }
  for (const [path, bytes] of staged) {
    const entry = entryFor(entries, path, 'staged');
    assert.equal(entry?.kind, 'file', path);
    assert.deepEqual(entry?.content, bytes, path);
  }
});

test('symlink entries carry their link target as blob content', (t) => {
  const root = initRepository('preflight-blob-symlink-');
  git(root, 'config', 'core.symlinks', 'true');
  try { symlinkSync('seed.txt', join(root, 'link-to-seed')); } catch { t.skip('symlinks unavailable on this machine'); return; }
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'symlink');
  const entry = entryFor(collectChangeset(root, 'main').entries, 'link-to-seed', 'committed');
  assert.equal(entry?.kind, 'symlink');
  assert.deepEqual(entry?.content, Buffer.from('seed.txt'));
});

test('renamed and added destinations read their blob content', () => {
  const root = initRepository('preflight-rename-copy-');
  git(root, 'mv', 'seed.txt', 'renamed.txt');
  writeFileSync(join(root, 'copied.txt'), 'copied\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'rename and copy');
  const entries = collectChangeset(root, 'main').entries;
  const renamed = entryFor(entries, 'renamed.txt', 'committed');
  assert.equal(renamed?.status, 'renamed');
  assert.equal(renamed?.oldPath, 'seed.txt');
  assert.deepEqual(renamed?.content, Buffer.from('seed\n'));
  // Rename detection is `-M` only, so an unrelated new file is reported as added, not as a copy.
  const copied = entryFor(entries, 'copied.txt', 'committed');
  assert.equal(copied?.status, 'added');
  assert.deepEqual(copied?.content, Buffer.from('copied\n'));
});

test('deleted files and submodule gitlinks carry no blob content', () => {
  const root = initRepository('preflight-deleted-gitlink-');
  git(root, 'rm', '-q', 'seed.txt');
  git(root, 'update-index', '--add', '--cacheinfo', '160000,0123456789abcdef0123456789abcdef01234567,vendor/sub');
  git(root, 'commit', '-q', '-m', 'delete file and add gitlink');
  const entries = collectChangeset(root, 'main').entries;
  const deleted = entryFor(entries, 'seed.txt', 'committed');
  assert.equal(deleted?.status, 'deleted');
  assert.equal(deleted?.content, undefined);
  const gitlink = entryFor(entries, 'vendor/sub', 'committed');
  assert.equal(gitlink?.kind, 'submodule');
  assert.equal(gitlink?.content, undefined);
});

test('a missing blob object makes the changeset fail with PreflightToolError', () => {
  const root = initRepository('preflight-missing-object-');
  writeFileSync(join(root, 'present.txt'), 'present\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'present');
  const blobId = gitText(root, 'rev-parse', 'HEAD:present.txt');
  const looseObject = join(root, '.git', 'objects', blobId.slice(0, 2), blobId.slice(2));
  assert.ok(existsSync(looseObject), 'setup expects a loose blob object');
  rmSync(looseObject);
  assert.throws(() => collectChangeset(root, 'main'), error => error instanceof PreflightToolError && /cat-file/.test(error.message));
});

test('a missing staged blob object makes the changeset fail with PreflightToolError', () => {
  const root = initRepository('preflight-missing-staged-');
  writeFileSync(join(root, 'present-staged.txt'), 'present\n');
  git(root, 'add', '.');
  const blobId = gitText(root, 'rev-parse', ':present-staged.txt');
  const looseObject = join(root, '.git', 'objects', blobId.slice(0, 2), blobId.slice(2));
  assert.ok(existsSync(looseObject), 'setup expects a loose blob object');
  rmSync(looseObject);
  assert.throws(() => collectChangeset(root, 'main'), error => error instanceof PreflightToolError && /cat-file/.test(error.message));
});

test('paths with spaces and non-ASCII characters read their blob content', () => {
  const root = initRepository('preflight-names-');
  const committedName = 'committed name café ✓.txt';
  const stagedName = 'staged name über.txt';
  writeFileSync(join(root, committedName), 'committed café\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'committed name');
  writeFileSync(join(root, stagedName), 'staged über\n');
  git(root, 'add', '.');
  const entries = collectChangeset(root, 'main').entries;
  assert.deepEqual(entryFor(entries, committedName, 'committed')?.content, Buffer.from('committed café\n'));
  assert.deepEqual(entryFor(entries, stagedName, 'staged')?.content, Buffer.from('staged über\n'));
});

test('a path containing a newline reads its blob through the single-object fallback', (t) => {
  const root = initRepository('preflight-newline-');
  const newlineName = 'line\nbreak.txt';
  try { writeFileSync(join(root, newlineName), 'first\r\nsecond\n'); } catch { t.skip('paths containing a newline are unavailable on this platform'); return; }
  writeFileSync(join(root, 'plain.txt'), 'plain\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'newline path');
  const entries = collectChangeset(root, 'main').entries;
  assert.deepEqual(entryFor(entries, newlineName, 'committed')?.content, Buffer.from('first\r\nsecond\n'));
  assert.deepEqual(entryFor(entries, 'plain.txt', 'committed')?.content, Buffer.from('plain\n'));
});

test('committed and staged blobs are read with one cat-file batch per pass', () => {
  const root = initRepository('preflight-spawn-count-');
  for (const name of ['committed-a.txt', 'committed-b.txt', 'committed-c.txt']) writeFileSync(join(root, name), `${name}\n`);
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'committed files');
  for (const name of ['staged-a.txt', 'staged-b.txt', 'staged-c.txt']) writeFileSync(join(root, name), `${name}\n`);
  git(root, 'add', '.');
  // GIT_TRACE makes every git process this test spawns append a line to a file, so the
  // count of cat-file invocations can be read without mocking spawnSync.
  const tracePath = join(makeTempRoot('preflight-trace-'), 'git-trace.log');
  const previous = process.env.GIT_TRACE;
  process.env.GIT_TRACE = tracePath;
  try {
    collectChangeset(root, 'main');
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = previous;
  }
  const traceLines = readFileSync(tracePath, 'utf8').split(/\r?\n/);
  const batchSpawns = traceLines.filter(line => /trace: built-in: git .*cat-file --batch/.test(line)).length;
  const blobSpawns = traceLines.filter(line => /trace: built-in: git .*cat-file blob/.test(line)).length;
  assert.equal(batchSpawns, 2, 'one cat-file --batch for the committed pass and one for the staged pass');
  assert.equal(blobSpawns, 0, 'no per-blob cat-file blob invocation');
});

test('a blob batch larger than its capture limit falls back to per-blob reads', () => {
  const root = initRepository('preflight-batch-overflow-');
  writeFileSync(join(root, 'committed-a.txt'), 'alpha\n');
  writeFileSync(join(root, 'committed-b.txt'), 'bravo\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'committed files');
  writeFileSync(join(root, 'staged.txt'), 'staged\n');
  git(root, 'add', '.');
  // A 16-byte limit is far below the size of the batch reply, so the batch overflows and every blob is read singly.
  const entries = collectChangeset(root, 'main', 'option', { blobBatchMaxBuffer: 16 }).entries;
  assert.deepEqual(entryFor(entries, 'committed-a.txt', 'committed')?.content, Buffer.from('alpha\n'));
  assert.deepEqual(entryFor(entries, 'committed-b.txt', 'committed')?.content, Buffer.from('bravo\n'));
  assert.deepEqual(entryFor(entries, 'staged.txt', 'staged')?.content, Buffer.from('staged\n'));
});

test('a missing blob object still throws PreflightToolError after the overflow fallback starts', () => {
  const root = initRepository('preflight-overflow-missing-');
  writeFileSync(join(root, 'a-present.txt'), 'present\n');
  writeFileSync(join(root, 'b-missing.txt'), 'missing\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'present and missing');
  const blobId = gitText(root, 'rev-parse', 'HEAD:b-missing.txt');
  const looseObject = join(root, '.git', 'objects', blobId.slice(0, 2), blobId.slice(2));
  assert.ok(existsSync(looseObject), 'setup expects a loose blob object');
  rmSync(looseObject);
  // The 16-byte limit overflows the batch, so a-present.txt is read singly before b-missing.txt throws.
  assert.throws(() => collectChangeset(root, 'main', 'option', { blobBatchMaxBuffer: 16 }), error => error instanceof PreflightToolError && /cat-file/.test(error.message));
});

test('a newline path and a batchable path both read their blobs under the overflow fallback', (t) => {
  const root = initRepository('preflight-overflow-newline-');
  const newlineName = 'line\nbreak.txt';
  try { writeFileSync(join(root, newlineName), 'first\r\nsecond\n'); } catch { t.skip('paths containing a newline are unavailable on this platform'); return; }
  writeFileSync(join(root, 'plain.txt'), 'plain\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'newline path');
  const entries = collectChangeset(root, 'main', 'option', { blobBatchMaxBuffer: 16 }).entries;
  assert.deepEqual(entryFor(entries, newlineName, 'committed')?.content, Buffer.from('first\r\nsecond\n'));
  assert.deepEqual(entryFor(entries, 'plain.txt', 'committed')?.content, Buffer.from('plain\n'));
});

test('cat-file batch parser splits replies and rejects missing, malformed, and trailing output', () => {
  const oid = 'a'.repeat(40);
  const replies = Buffer.concat([Buffer.from(`${oid} blob 3\nabc\n`), Buffer.from(`${oid} blob 0\n\n`)]);
  const parsed = parseCatFileBatch(replies, ['one', 'two']);
  assert.deepEqual(parsed.get('one'), Buffer.from('abc'));
  assert.deepEqual(parsed.get('two'), Buffer.alloc(0));
  assert.throws(() => parseCatFileBatch(Buffer.from('ghost missing\n'), ['ghost']), error => error instanceof PreflightToolError && /could not find ghost/.test(error.message));
  assert.throws(() => parseCatFileBatch(Buffer.from('abc'), ['x']), error => error instanceof PreflightToolError && /malformed output for x/.test(error.message), 'no header line terminator');
  assert.throws(() => parseCatFileBatch(Buffer.from('not a header\n'), ['x']), error => error instanceof PreflightToolError && /malformed output for x/.test(error.message), 'header does not match');
  assert.throws(() => parseCatFileBatch(Buffer.from(`${oid} blob 5\nabc\n`), ['x']), error => error instanceof PreflightToolError && /malformed output for x/.test(error.message), 'size exceeds output');
  assert.throws(() => parseCatFileBatch(Buffer.from(`${oid} blob 3\nabcX`), ['x']), error => error instanceof PreflightToolError && /malformed output for x/.test(error.message), 'content not followed by newline');
  assert.throws(() => parseCatFileBatch(Buffer.from(`${oid} blob 0\n\nextra`), ['x']), error => error instanceof PreflightToolError && /unexpected trailing output/.test(error.message), 'bytes after the last reply');
});
