import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocumentation } from '../src/documentation-check.ts';

test('documentation checker accepts local links, fragments, paths, references, scripts, and workflow commands', async t => {
  const root = await mkdtemp(join(tmpdir(), 'docs-check-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['docs', 'agents', 'commands', 'skills', '.github/workflows']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'true', 'docs:check': 'true' } }));
  await writeFile(join(root, 'docs', 'target.md'), '# Target heading\n\n## RDD — Requirements-Driven Development\n');
  await writeFile(join(root, 'README.md'), '# Root\n\n## RDD — Requirements-Driven Development\n\n[local](docs/target.md#target-heading) and [adr](docs/target.md#rdd--requirements-driven-development), plus [same](#rdd--requirements-driven-development) and [ref][target].\n\n[target]: docs/target.md\n\n`npm run test` `docs/target.md` `/start-issue`\n\n```text\nnpm run docs:check\n```\n\n```md\n[fixture](missing.md)\nnpm run fixture-only\n```\n');
  await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'steps:\n  - run: npm run test\n');
  assert.deepEqual(checkDocumentation(root), []);
});

test('documentation checker reports broken paths, destinations, references, fragments, and script names with locations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'docs-check-bad-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['docs', 'agents', 'commands', 'skills', '.github/workflows']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
  await writeFile(join(root, 'docs', 'target.md'), '# Target heading\n');
  await writeFile(join(root, 'README.md'), '# Start\n\n## Target heading\n\n[missing](nope.md) [fragment](#absent) [same-bad](#target--heading) [cross-bad](docs/target.md#target--heading) [ref][no-ref]\n\n`npm run nope` `docs/nope.md` `/start-isssue`\n\n```bash\nnpm run absent-in-fence\n```\n');
  await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'steps:\n  - run: npm run missing\n');
  const errors = checkDocumentation(root);
  assert.ok(errors.some(e => /Missing local link/.test(e.message)));
  assert.ok(errors.some(e => /Missing heading fragment/.test(e.message)));
  assert.equal(errors.filter(e => /Missing heading fragment: (?:#target--heading|docs\/target\.md#target--heading)/.test(e.message)).length, 2);
  assert.ok(errors.some(e => /Undefined Markdown reference/.test(e.message)));
  assert.ok(errors.some(e => /Unknown npm run script/.test(e.message)));
  assert.ok(errors.some(e => /Repository-relative path/.test(e.message)));
  assert.ok(errors.some(e => /Unknown workflow npm run script/.test(e.message)));
  assert.ok(errors.some(e => /Unknown native workflow command/.test(e.message)));
  assert.ok(errors.some(e => /Unknown npm run script: absent-in-fence/.test(e.message)));
});

test('machine-local paths, external destinations, and placeholders are documented exclusions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'docs-check-excluded-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['docs', 'agents', 'commands', 'skills']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, 'README.md'), '[external](https://example.invalid) [local](C:\\Users\\name\\file.md) [placeholder]({{path}})\n');
  assert.deepEqual(checkDocumentation(root), []);
});

test('documentation discovery checks root Markdown and recursively checks only the four documentation trees', async t => {
  const root = await mkdtemp(join(tmpdir(), 'docs-check-bounds-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['docs/nested', 'agents/nested', 'commands/nested', 'skills/nested', '.worktrees/hidden', 'other/nested']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
  const bad = '[broken](missing.md)';
  await writeFile(join(root, 'README.md'), `# Root\n\n${bad}\n`);
  for (const dir of ['docs/nested', 'agents/nested', 'commands/nested', 'skills/nested']) await writeFile(join(root, dir, 'checked.md'), `# Nested\n\n${bad}\n`);
  await writeFile(join(root, '.worktrees', 'hidden', 'ignored.md'), `# Hidden\n\n${bad}\n`);
  await writeFile(join(root, 'other', 'nested', 'ignored.md'), `# Unrelated\n\n${bad}\n`);
  const errors = checkDocumentation(root).filter(error => /Missing local link/.test(error.message));
  assert.deepEqual(errors.map(error => error.file), [
    'agents/nested/checked.md', 'commands/nested/checked.md', 'docs/nested/checked.md', 'README.md', 'skills/nested/checked.md',
  ]);
});
