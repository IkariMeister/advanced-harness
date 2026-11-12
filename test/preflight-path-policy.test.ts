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
