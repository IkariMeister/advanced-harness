import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextData, contextPath, prepareContextFiles, updateContext } from '../src/project-context.ts';
import { askGlobalIntegrations, askProjectIntegrations, checkSelectedIntegrations, emptyGlobalIntegrations, legacyIntegrationContext, optionalDiscoveryPrompt, parseGlobalIntegrations, validateGlobalIntegrations, validateProjectIntegrations, type GlobalIntegrations } from '../src/integration-context.ts';
import { nativeToolDiscoveryGuidance, updateConnectionConfig } from '../src/integration-setup.ts';
import { saveSetup } from '../src/project-setup.ts';

function fixture(t: { after: (callback: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'harness-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('all optional integrations can be skipped globally and per project without extra questions or endpoints', async () => {
  for (const scope of ['global', 'project']) {
    const answers = ['none', 'none', 'none'];
    const ask = async () => { assert.ok(answers.length); return answers.shift()!; };
    const result = scope === 'global' ? (await askGlobalIntegrations({}, emptyGlobalIntegrations(), ask)).settings : await askProjectIntegrations({}, emptyGlobalIntegrations(), undefined, ask);
    assert.equal(answers.length, 0);
    assert.equal(result.github, null); assert.equal(result.jira, null); assert.equal(result.design, null);
  }
  assert.equal(updateConnectionConfig('{}\n', [], [], false), '{}\n');
});

test('global preferences never contain repositories, Jira projects/mappings, or credentials', async () => {
  const answers = ['gh', 'github.com', 'jira-company', 'none'];
  const result = await askGlobalIntegrations({ 'jira-company': { type: 'remote' } }, emptyGlobalIntegrations(), async () => answers.shift()!);
  assert.deepEqual(result.settings, { version: 1, github: { backend: 'gh', hostname: 'github.com' }, jira: { server: 'jira-company' }, design: null });
  assert.deepEqual(parseGlobalIntegrations(JSON.stringify(result.settings)), result.settings);
  assert.throws(() => validateGlobalIntegrations({ ...result.settings, github: { ...result.settings.github, repository: 'private/app' } }));
  assert.throws(() => validateGlobalIntegrations({ ...result.settings, jira: { server: 'jira-company', projectKey: 'PRIVATE' } }));
  assert.throws(() => validateGlobalIntegrations({ ...result.settings, token: 'secret' }));
});

test('global new optional design server remains disabled and carries no project data', async () => {
  const answers = ['none', 'none', 'figma', 'new', 'design-team', 'https://supplied.test/mcp'];
  const result = await askGlobalIntegrations({}, emptyGlobalIntegrations(), async () => { assert.ok(answers.length); return answers.shift()!; });
  assert.deepEqual(result.settings.design, { kind: 'figma', server: 'design-team' });
  assert.equal(result.choices[0]!.create!.disabled, true);
  assert.equal(result.settings.github, null);
  assert.equal(result.settings.jira, null);
});

test('project context records optional GitHub only and can override global defaults to none', async () => {
  const defaults: GlobalIntegrations = { version: 1, github: { backend: 'gh', hostname: 'github.com' }, jira: { server: 'jira' }, design: { kind: 'figma', server: 'design' } };
  const answers = ['gh', 'github.com', 'none', 'none', 'owner/app'];
  const project = await askProjectIntegrations({ jira: { type: 'remote' }, design: { type: 'remote' } }, defaults, undefined, async () => { assert.ok(answers.length); return answers.shift()!; });
  assert.deepEqual(project.github, { backend: 'gh', hostname: 'github.com', repository: 'owner/app' });
  assert.equal(project.jira, null); assert.equal(project.design, null);
  const skip = ['none', 'none', 'none'];
  const none = await askProjectIntegrations({}, defaults, project, async () => skip.shift()!);
  assert.equal(none.github, null);
  assert.equal(defaults.jira!.server, 'jira'); // Global defaults were not mutated.
});

test('project Jira mappings are explicit/pending while global defaults remain repository-free', async () => {
  const answers = ['none', 'jira', 'none', 'APP', '-', 'In Progress', '-', '-'];
  const result = await askProjectIntegrations({ jira: { type: 'remote' } }, emptyGlobalIntegrations(), undefined, async () => { assert.ok(answers.length); return answers.shift()!; });
  assert.equal(result.jira!.projectKey, 'APP');
  assert.equal(result.jira!.destinations.ready, null);
  assert.equal(result.jira!.destinations.inProgress, 'In Progress');
  assert.equal(result.verification, 'unverified');
  assert.throws(() => validateProjectIntegrations({ ...result, verification: 'passed' }));
});

test('none checks call neither OpenCode nor gh, while gh-only avoids MCP entirely', async () => {
  const directory = process.cwd();
  const noCall = async () => { throw new Error('Must not be called'); };
  assert.deepEqual(await checkSelectedIntegrations({ directory }, emptyGlobalIntegrations(), noCall, noCall), []);
  const ghOnly: GlobalIntegrations = { ...emptyGlobalIntegrations(), github: { backend: 'gh', hostname: 'github.com' } };
  const result = await checkSelectedIntegrations({ directory }, ghOnly, noCall, async hostname => { assert.equal(hostname, 'github.com'); return { service: 'github', name: 'gh', status: 'connected', message: 'auth status only' }; });
  assert.equal(result.length, 1);
});

test('optional discovery guidance separates native tools from catalog search across all backends', () => {
  const selections: GlobalIntegrations[] = [
    emptyGlobalIntegrations(),
    { ...emptyGlobalIntegrations(), github: { backend: 'gh', hostname: 'github.com' } },
    { version: 1, github: { backend: 'mcp', server: 'github' }, jira: { server: 'jira' }, design: { kind: 'figma', server: 'design' } },
  ];
  for (const settings of selections) {
    const original = JSON.stringify(settings);
    const prompt = optionalDiscoveryPrompt(settings);
    assert.ok(prompt.includes(nativeToolDiscoveryGuidance));
    assert.match(prompt, /Native shell is separate from the Code Mode catalog/);
    assert.match(prompt, /empty catalog search or model self-report does not prove shell is unavailable/);
    assert.match(prompt, /actual authorized invocation\/error or captured offered-tool evidence/);
    assert.match(prompt, /availability as unverified/);
    assert.match(prompt, /keeping ASK prompts intact/);
    assert.match(prompt, /separately approved read-only diagnostic/);
    assert.match(prompt, /do not invoke service tools or gh yet/);
    assert.match(prompt, /does not authorize lifecycle writes, publishing, or merging/);
    assert.match(prompt, /do not treat none as a setup blocker/);
    assert.equal(JSON.stringify(settings), original);
  }
  assert.match(optionalDiscoveryPrompt(selections[0]!), /Optional MCP selections: none\. GitHub backend: none/);
});

test('embedded settings preserve unrelated context bytes, BOM/CRLF, and independent sections', () => {
  const original = '\uFEFF# Existing rules\r\nNever remove these.\r\n';
  const project = { baseBranch: 'main', command: './gradlew assembleDebug' };
  const first = updateContext(original, 'project', project, ['Setup is not approval.']);
  const both = updateContext(first, 'integrations', { version: 2, github: null, jira: null, design: null, verification: 'unverified' }, ['Every integration is optional.']);
  assert.ok(both.startsWith(original));
  assert.ok(!both.replaceAll('\r\n', '').includes('\n'));
  assert.deepEqual(contextData(both, 'project'), project);
  assert.equal(updateContext(both, 'integrations', contextData(both, 'integrations'), ['Every integration is optional.']), both);
  assert.deepEqual(contextData(updateContext(both, 'project', { baseBranch: 'develop' }, []), 'integrations'), contextData(both, 'integrations'));
});

test('malformed markers/fences/duplicate JSON are rejected rather than silently replaced', () => {
  assert.throws(() => contextData('<!-- advanced-harness:project:start -->', 'project'), /Ambiguous/);
  const text = '<!-- advanced-harness:project:start -->\n```json\n{"a":1,"a":2}\n```\n<!-- advanced-harness:project:end -->';
  assert.throws(() => contextData(text, 'project'), /Invalid/);
  assert.throws(() => contextData(text.replace('\n```\n<!--', '\n<!--'), 'project'), /Ambiguous/);
});

test('payload marker strings roundtrip without becoming section boundaries or changing other sections', () => {
  const markers = ['project', 'integrations'].flatMap(section => ['start', 'end'].map(edge => `<!-- advanced-harness:${section}:${edge} -->`));
  const data = { command: `Write-Output '${markers.join(' ')}'`, comparison: 'a < b', literalEscape: '\\u003c' };
  for (const eol of ['\n', '\r\n']) {
    for (const section of ['project', 'integrations'] as const) {
      const other = section === 'project' ? 'integrations' : 'project';
      const original = `\uFEFF# Human rules${eol}Keep these.${eol}`;
      const previous = updateContext(original, other, { note: 'unchanged' }, []);
      const updated = updateContext(previous, section, data, []);
      assert.ok(updated.startsWith(previous));
      assert.ok(!updated.replaceAll(eol, '').includes('\n'));
      assert.ok(updated.includes('\\u003c!-- advanced-harness:'));
      assert.deepEqual(contextData(updated, section), data);
      assert.deepEqual(contextData(updated, other), { note: 'unchanged' });
      assert.equal(updateContext(updated, section, contextData(updated, section), []), updated);
      for (const marker of markers) assert.equal(updated.split(marker).length - 1, 1);
    }
  }
});

test('project setup saves only context files and leaves legacy/OpenCode files untouched', t => {
  const root = fixture(t);
  mkdirSync(join(root, '.opencode'));
  const legacy = join(root, '.opencode', 'harness.project.json');
  writeFileSync(legacy, 'old settings retained');
  const opencode = join(root, '.opencode', 'opencode.jsonc');
  writeFileSync(opencode, '{"model":"unchanged/model"}');
  const original = '# Human project rules\n';
  writeFileSync(join(root, 'AGENTS.md'), original);
  const target = contextPath(root);
  const updated = updateContext(original, 'project', { baseBranch: 'main' }, []);
  saveSetup(prepareContextFiles(root, target, original, updated), join(root, 'backups'));
  assert.equal(readFileSync(legacy, 'utf8'), 'old settings retained');
  assert.equal(readFileSync(opencode, 'utf8'), '{"model":"unchanged/model"}');
  assert.ok(readFileSync(target, 'utf8').startsWith(original));
  assert.equal(existsSync(join(root, '.opencode', 'harness.integrations.json')), false);
});

test('alternate Markdown context is explicitly referenced from AGENTS and updates are idempotent', t => {
  const root = fixture(t);
  const target = contextPath(root, 'docs/HARNESS.md');
  const updated = updateContext(undefined, 'integrations', { github: null }, []);
  const files = prepareContextFiles(root, target, undefined, updated);
  assert.equal(files.length, 2);
  saveSetup(files, join(root, 'backups'));
  assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /Read `docs\/HARNESS.md`/);
  assert.equal(prepareContextFiles(root, target, updated, updated).length, 1);
  assert.throws(() => contextPath(root, '../outside.md'), /inside/);
  assert.throws(() => contextPath(root, '.opencode/config.json'), /Markdown/);
});

test('explicit legacy conversion produces context data but does not migrate or delete files', () => {
  const context = legacyIntegrationContext(JSON.stringify({ version: 1, github: { backend: 'gh', hostname: 'github.com', repository: 'owner/app' }, jira: { server: 'jira', projectKey: 'APP', destinations: { ready: null, inProgress: null, inReview: null, done: null } }, verification: 'unverified' }));
  assert.equal(context.version, 2); assert.equal(context.design, null);
  assert.equal(context.github!.repository, 'owner/app');
});

test('CLI help describes global/optional/context scopes and refuses piped confirmations', () => {
  const script = fileURLToPath(new URL('../scripts/configure-integrations.ts', import.meta.url));
  assert.match(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }), /Every integration is optional/);
  assert.throws(() => execFileSync(process.execPath, [script, '--scope', 'global'], { input: 'integrations\n', stdio: 'pipe' }), /interactive terminal/);
});
