import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathPolicyCheck } from '../src/preflight/path-policy.ts';

const change = (path: string, status: 'added' | 'deleted' | 'renamed' = 'added', oldPath?: string) => ({ path, ...(oldPath ? { oldPath } : {}), status, origin: 'untracked' as const, content: Buffer.from('x') });
const run = (entries: ReturnType<typeof change>[], globs?: readonly string[]) => pathPolicyCheck(globs).run({ worktree: '/', changeset: { top: '/', base: 'main', baseSource: 'option', mergeBase: '', head: '', entries } });

test('sensitive path patterns are case-insensitive and normalize Windows separators', async () => {
  assert.equal((await run([change('Secrets\\ID_RSA.pub')])).status, 'block');
  assert.equal((await run([change('ROOT/.ENV.local')])).status, 'block');
  assert.equal((await run([change('release/BUILD/app.bin')])).status, 'block');
});

test('path policy skips deletions, checks rename destinations, and accepts replaced glob lists', async () => {
  assert.equal((await run([change('old.pem', 'deleted')])).status, 'pass');
  assert.equal((await run([change('safe.txt', 'renamed', 'old.pem')])).status, 'pass');
  assert.equal((await run([change('assets/custom.bin')], ['**/*.bin'])).status, 'block');
  assert.equal((await run([change('assets/custom.bin')], ['**/*.pem'])).status, 'pass');
});

test('** and the **/ directory form match line terminators (CR, LF, U+2028, U+2029) in a path', async () => {
  const lineSeparator = String.fromCharCode(0x2028);
  const paragraphSeparator = String.fromCharCode(0x2029);
  assert.equal((await run([change(`release/a${lineSeparator}b.bin`)], ['release/**'])).status, 'block', '** matches U+2028 in a path');
  assert.equal((await run([change(`release/a${paragraphSeparator}b.bin`)], ['release/**'])).status, 'block', '** matches U+2029 in a path');
  assert.equal((await run([change('release/a\r\nb.bin')], ['release/**'])).status, 'block', '** matches CR/LF in a path');
  assert.equal((await run([change(`assets/a${lineSeparator}b/custom.bin`)], ['**/*.bin'])).status, 'block', '**/ crosses U+2028 in a directory name');
  assert.equal((await run([change(`assets/a${paragraphSeparator}b/custom.bin`)], ['**/*.bin'])).status, 'block', '**/ crosses U+2029 in a directory name');
  assert.equal((await run([change('assets/a\nb/custom.bin')], ['**/*.bin'])).status, 'block', '**/ crosses LF in a directory name');
  assert.equal((await run([change('x\r\ny/keys/key.txt')], ['**/keys/**'])).status, 'block', 'the default-style **/keys/** crosses CR/LF');
  assert.equal((await run([change(`lib${lineSeparator}/root.pem`)], ['**/*.pem'])).status, 'block', '**/ matches a root-level file whose directory has U+2028');
});

test('recursive wildcards do not widen: the match stays anchored, and * and ? stay within one path segment', async () => {
  const lineSeparator = String.fromCharCode(0x2028);
  assert.equal((await run([change('other/release/a.bin')], ['release/**'])).status, 'pass', 'the glob is anchored at the start of the path');
  assert.equal((await run([change('assets/a.binx')], ['**/*.bin'])).status, 'pass', 'the suffix still has to match');
  assert.equal((await run([change('certs/root.pem')], ['*.pem'])).status, 'pass', '* does not cross a directory separator');
  assert.equal((await run([change(`certs/a${lineSeparator}b.pem`)], ['*.pem'])).status, 'pass', '* does not cross a directory separator even beside U+2028');
  assert.equal((await run([change(`root${lineSeparator}.pem`)], ['*.pem'])).status, 'block', '* matches a line terminator inside one segment');
  assert.equal((await run([change('\r.pem')], ['?.pem'])).status, 'block', '? matches one line terminator inside one segment');
  assert.equal((await run([change('ab.pem')], ['?.pem'])).status, 'pass', '? matches exactly one character');
  assert.equal((await run([change('dir/a.pem')], ['dir?a.pem'])).status, 'pass', '? does not match a directory separator');
});
