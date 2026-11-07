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

async function docsFixture(t: { after: (fn: () => Promise<void>) => void }, scripts: Record<string, string> = { test: 'true' }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'docs-check-case-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['docs', 'agents', 'commands', 'skills', '.github/workflows']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts }));
  await writeFile(join(root, 'docs', 'target.md'), '# Target heading\n');
  return root;
}
const summary = (root: string) => checkDocumentation(root).map(error => `${error.file}:${error.line}: ${error.message}`);

test('malformed percent-encoding is reported per link and does not abort the check', async t => {
  const root = await docsFixture(t);
  await writeFile(join(root, 'README.md'), '# Root\n\n[report](50%.md) [frag](#100%) [cross](docs/target.md#bad%zz)\n\n[missing](nope.md)\n');
  assert.deepEqual(summary(root), [
    'README.md:3: Malformed percent-encoding in link: #100%',
    'README.md:3: Malformed percent-encoding in link: 50%.md',
    'README.md:3: Malformed percent-encoding in link: docs/target.md#bad%zz',
    'README.md:5: Missing local link/image destination: nope.md',
  ]);
});

test('inline code spans are not read as links or reference links', async t => {
  const root = await docsFixture(t);
  await writeFile(join(root, 'README.md'), '# Root\n\nIndex `matrix[i][j]`, show `[text](missing.md)` and ``[a][b] `x` ``.\n\nStill checked: [real](missing.md) [ref][nope]\n');
  assert.deepEqual(summary(root), [
    'README.md:5: Missing local link/image destination: missing.md',
    'README.md:5: Undefined Markdown reference definition: nope',
  ]);
});

test('inline repository paths ignore line and fragment suffixes and skip placeholders anywhere', async t => {
  const root = await docsFixture(t);
  await writeFile(join(root, 'README.md'), [
    '# Root', '',
    '`docs/target.md:12` `docs/target.md:12:3` `docs/target.md:12-20` `docs/target.md#target-heading` `docs/target.md`.',
    '`docs/adr/<id>.md` `docs/{name}.md` `docs/$NAME.md` `docs/*.md`',
    '`docs/nope.md:3` `docs/gone.md#section`', '',
  ].join('\n'));
  assert.deepEqual(summary(root), [
    'README.md:5: Repository-relative path does not exist: docs/gone.md',
    'README.md:5: Repository-relative path does not exist: docs/nope.md',
  ]);
});

test('a fence closes only on the same marker, at least as long, so nested examples stay fenced', async t => {
  const root = await docsFixture(t);
  await writeFile(join(root, 'README.md'), [
    '# Root', '',
    '````md', '```bash', 'npm run absent-in-nested-example', '```', '[fixture](missing-in-example.md)', '````', '',
    '~~~md', '```', '[tilde](missing-in-tilde.md)', '~~~', '',
    '[after](missing-after.md)', '',
  ].join('\n'));
  assert.deepEqual(summary(root), ['README.md:15: Missing local link/image destination: missing-after.md']);
});

test('setext headings, linked heading text, and HTML anchors are valid fragment targets', async t => {
  const root = await docsFixture(t);
  await writeFile(join(root, 'docs', 'other.md'), '# Other\n');
  await writeFile(join(root, 'docs', 'guide.md'), [
    '---', 'title: Front matter is not a heading', '---', '',
    'Overview', '========', '',
    'Section two', '-----------', '',
    '- list item', '---', '',
    '## [Codex](other.md) limits', '',
    '<a id="setup"></a>', '',
    '```md', '<a id="fenced"></a>', '```', '',
  ].join('\n'));
  await writeFile(join(root, 'README.md'), '# Root\n\n[a](docs/guide.md#overview) [b](docs/guide.md#section-two) [c](docs/guide.md#codex-limits) [d](docs/guide.md#setup)\n\n[e](docs/guide.md#title-front-matter-is-not-a-heading) [f](docs/guide.md#list-item) [g](docs/guide.md#fenced)\n');
  assert.deepEqual(summary(root), [
    'README.md:5: Missing heading fragment: docs/guide.md#fenced',
    'README.md:5: Missing heading fragment: docs/guide.md#list-item',
    'README.md:5: Missing heading fragment: docs/guide.md#title-front-matter-is-not-a-heading',
  ]);
});

test('npm options before the script name are not read as script names', async t => {
  const root = await docsFixture(t, { test: 'true', 'docs:check': 'true' });
  await writeFile(join(root, 'README.md'), '# Root\n\n`npm run -s docs:check`, npm run --silent test, and first npm run test: then `npm run --loglevel=warn test`.\n\n`npm run -s nope`\n');
  await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'steps:\n  - run: npm run --silent docs:check\n  - run: npm run -s absent\n');
  assert.deepEqual(summary(root), [
    '.github/workflows/ci.yml:3: Unknown workflow npm run script: absent',
    'README.md:5: Unknown npm run script: nope',
  ]);
});
