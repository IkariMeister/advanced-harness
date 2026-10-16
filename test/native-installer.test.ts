import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askAssignments, chooseConfiguration, configuredModels, discoverConfigurations, findMarkdownConflicts, loadNativeDefinitions, modelReference, nativeRoles, parseConfiguration, projectConfiguration, saveInstallation, suggestedModel, updateNativeConfiguration, type ConfigSource, type NativeRole } from '../src/native-installer.ts';

const definitions = loadNativeDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));
const assignments = Object.fromEntries(nativeRoles.map(role => [role, `local/${role}#low`])) as Record<NativeRole, string>;
const source = (value: Record<string, unknown>): ConfigSource => ({ path: 'test.jsonc', text: JSON.stringify(value), value });
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'advanced-harness-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }

test('installer reads all native templates and accepts custom/provider model references', () => {
  assert.deepEqual(Object.keys(definitions), [...nativeRoles]);
  assert.ok(definitions.lead.system.includes('WAIT for explicit human approval'));
  assert.equal(modelReference({ providerID: 'company', model: 'deployment', variant: 'fast' }), 'company/deployment#fast');
  assert.equal(modelReference('openrouter/anthropic/model#high'), 'openrouter/anthropic/model#high');
  for (const value of ['bare-model', 'provider/', 'provider/model#', 'provider/model\ninjection', 'provider/model#bad/variant', null]) assert.equal(modelReference(value), undefined);
});

test('installer lists configured model IDs/variants, not credentials, and uses latest role preferences', () => {
  const sources = [source({ model: 'base/default', providers: { company: { settings: { apiKey: 'SECRET' }, models: { active: { variants: [{ id: 'fast' }] }, disabled: { disabled: true } } } }, agents: { lead: { model: 'base/lead#high' } } }), source({ agents: { lead: { model: { providerID: 'company', model: 'active', variant: 'fast' } } } })];
  assert.deepEqual(configuredModels(sources), ['base/default', 'base/lead#high', 'company/active', 'company/active#fast']);
  assert.equal(suggestedModel('lead', sources, 'fallback/model'), 'company/active#fast');
  assert.equal(suggestedModel('qa', sources, 'fallback/model'), 'base/default');
  assert.equal(suggestedModel('qa', [], definitions.qa.model), definitions.qa.model);
});

test('installer asks model and reasoning assignment for every role and retries invalid input', async () => {
  const prompts: string[] = [];
  const responses = ['invalid', '1', 'bad variant', 'fast', ...nativeRoles.slice(1).flatMap(() => ['company/custom', '-'])];
  const result = await askAssignments(definitions, [source({ model: 'company/current' })], async question => {
    prompts.push(question);
    const answer = responses.shift();
    assert.notEqual(answer, undefined);
    return answer!;
  });
  assert.equal(result.lead, 'company/current#fast');
  for (const role of nativeRoles.slice(1)) assert.equal(result[role], 'company/custom');
  assert.equal(prompts.length, 18);
  assert.equal(responses.length, 0);
});

test('none is a real variant name; only dash explicitly removes the variant', async () => {
  const responses = nativeRoles.flatMap(() => ['company/model#none', '']);
  const result = await askAssignments(definitions, [], async () => responses.shift()!);
  for (const role of nativeRoles) assert.equal(result[role], 'company/model#none');
});

test('JSONC installation preserves comments, root choices, credentials, MCP, plugins, and unrelated agent fields', () => {
  const original = `{
  // Keep this comment and credential expression.
  "model": "existing/default", "default_agent": "build",
  "providers": { "company": { "settings": { "apiKey": "{env:KEY}" } } },
  "mcp": { "servers": { "custom": { "type": "remote", "url": "https://example.test/mcp" } } },
  "plugins": ["unrelated-plugin"],
  "agents": { "other": { "model": "existing/other" }, "lead": { "color": "#abcdef", "steps": 8, "hidden": true, "disabled": true, "system": "old", "permissions": [] } },
}`;
  const updated = updateNativeConfiguration(original, definitions, assignments, false);
  const value = parseConfiguration(updated, 'test');
  const before = parseConfiguration(original, 'test');
  assert.ok(updated.includes('// Keep this comment and credential expression.'));
  for (const key of ['model', 'default_agent', 'providers', 'mcp', 'plugins']) assert.deepEqual(value[key], before[key], key);
  const agents = value.agents as Record<string, Record<string, unknown>>;
  assert.deepEqual(agents.other, { model: 'existing/other' });
  assert.equal(agents.lead?.color, '#abcdef');
  assert.equal(agents.lead?.steps, 8);
  assert.equal(agents.lead?.hidden, true);
  assert.equal(agents.lead?.disabled, true);
  for (const role of nativeRoles) {
    assert.equal(agents[role]?.model, assignments[role]);
    assert.equal(agents[role]?.system, role === 'lead' ? 'old' : definitions[role].system);
    assert.deepEqual(agents[role]?.permissions, definitions[role].permissions);
  }
  assert.equal(value.$schema, 'https://opencode.ai/config.json');
});

test('custom managed fields survive; only unchanged evidence or explicit selections refresh them', () => {
  const original = JSON.stringify({ agents: { lead: { description: 'custom', mode: 'custom-mode', system: 'previous managed prompt' } } });
  const inspect = (options: Parameters<typeof updateNativeConfiguration>[6]) => (parseConfiguration(updateNativeConfiguration(original, definitions, assignments, false, false, [], options), 'test').agents as Record<string, Record<string, unknown>>).lead!;
  assert.equal(inspect({}).system, 'previous managed prompt');
  const refreshed = inspect({ managedFields: { lead: { description: 'previous description', system: 'previous managed prompt' } } });
  assert.equal(refreshed.description, 'custom');
  assert.equal(refreshed.mode, 'custom-mode');
  assert.equal(refreshed.system, definitions.lead.system);
  assert.equal(inspect({ replaceFields: { lead: ['mode'] } }).mode, definitions.lead.mode);
});

test('default-agent/model changes require separate opt-ins; BOM and CRLF are preserved', () => {
  const original = '\uFEFF{\r\n  "model": "existing/default",\r\n  "default_agent": "build"\r\n}\r\n';
  const updated = updateNativeConfiguration(original, definitions, assignments, true, true);
  assert.ok(updated.startsWith('\uFEFF'));
  assert.ok(!updated.replaceAll('\r\n', '').includes('\n'));
  const value = parseConfiguration(updated, 'test');
  assert.equal(value.default_agent, 'lead');
  assert.equal(value.model, 'local/lead');
  assert.equal((value.agents as Record<string, Record<string, unknown>>).lead?.model, 'local/lead#low');
});

test('reinstall preserves customized model representations unless explicitly replaced', () => {
  const original = JSON.stringify({ agents: {
    lead: { model: { providerID: 'openai', model: 'gpt-6-luna', variant: 'low', custom: 'keep' }, color: 'violet', permissions: [{ action: 'shell', resource: 'git status', effect: 'deny' }] },
  } });
  const preserved = parseConfiguration(updateNativeConfiguration(original, definitions, assignments, false), 'preserved').agents as Record<string, Record<string, unknown>>;
  assert.deepEqual(preserved.lead!.model, { providerID: 'openai', model: 'gpt-6-luna', variant: 'low', custom: 'keep' });
  assert.equal(preserved.lead!.color, 'violet');
  assert.deepEqual(preserved.lead!.permissions, [{ action: 'shell', resource: 'git status', effect: 'deny' }, ...definitions.lead.permissions]);
  const replaced = parseConfiguration(updateNativeConfiguration(original, definitions, assignments, false, false, ['lead']), 'replaced').agents as Record<string, Record<string, unknown>>;
  assert.equal(replaced.lead!.model, assignments.lead);
});

test('invalid, duplicate, non-object and ambiguous configurations are never rewritten', t => {
  for (const text of ['{broken', '[]', '{"agents":[]}', '{"model":"one/a","model":"two/b"}']) assert.throws(() => parseConfiguration(text, 'test'));
  assert.throws(() => updateNativeConfiguration('{"agents":{"lead":"not-an-object"}}', definitions, assignments, false));
  const root = fixture(t);
  write(join(root, 'opencode.json'), '{}');
  write(join(root, 'opencode.jsonc'), '{}');
  assert.throws(() => chooseConfiguration(root), /Both/);
});

test('configuration discovery includes global and ancestor sources in V2 order', t => {
  const root = fixture(t);
  const global = join(root, 'global');
  const parent = join(root, 'projects');
  const project = join(parent, 'app');
  const globalFile = join(global, 'opencode.jsonc');
  const parentFile = join(parent, 'opencode.json');
  const projectFile = join(project, 'opencode.json');
  const ancestorHidden = join(parent, '.opencode', 'opencode.jsonc');
  for (const path of [globalFile, parentFile, projectFile, ancestorHidden]) write(path, '{}');
  const sources = discoverConfigurations(project, global);
  const relevant = sources.map(item => item.path).filter(path => path.startsWith(root));
  assert.deepEqual(relevant, [globalFile, parentFile, projectFile, ancestorHidden]);
  assert.equal(projectConfiguration(project, sources), join(project, '.opencode', 'opencode.jsonc'));
  write(join(project, '.opencode', 'opencode.json'), '{}');
  assert.equal(projectConfiguration(project, sources), join(project, '.opencode', 'opencode.json'));
});

test('Markdown conflicts include ancestors without config files, but not plain source templates', t => {
  const root = fixture(t);
  const project = join(root, 'app');
  const global = join(root, 'global');
  const target = join(project, 'opencode.jsonc');
  const ancestor = join(root, '.opencode', 'agents', 'lead.md');
  const compatibility = join(project, '.opencode', 'agent', 'planner.md');
  for (const path of [ancestor, compatibility, join(project, 'agents', 'qa.md')]) write(path, 'existing');
  const conflicts = findMarkdownConflicts([], target, global, project);
  assert.ok(conflicts.includes(ancestor));
  assert.ok(conflicts.includes(compatibility));
  assert.equal(conflicts.length, 2);
});

test('save creates an exact backup, updates atomically, and preserves concurrent user work', t => {
  const root = fixture(t);
  const target = join(root, 'app', 'opencode.jsonc');
  const original = '{"model":"existing/model"}\n';
  write(target, original);
  const updated = updateNativeConfiguration(original, definitions, assignments, false);
  const backup = saveInstallation(target, original, updated, join(root, 'backups'));
  assert.ok(backup);
  assert.equal(readFileSync(backup, 'utf8'), original);
  assert.equal(readFileSync(target, 'utf8'), updated);
  write(target, '{"user":"new work"}');
  assert.throws(() => saveInstallation(target, updated, '{}', join(root, 'other-backups')), /changed/);
  assert.equal(readFileSync(target, 'utf8'), '{"user":"new work"}');
  assert.equal(existsSync(join(root, 'other-backups')), false);
});

test('new installation does not need an existing config or manufacture a backup', t => {
  const root = fixture(t);
  const target = join(root, 'new', 'opencode.jsonc');
  const updated = updateNativeConfiguration('{}\n', definitions, assignments, true);
  assert.equal(saveInstallation(target, undefined, updated, join(root, 'backups')), undefined);
  assert.equal(existsSync(join(root, 'backups')), false);
  assert.equal(parseConfiguration(readFileSync(target, 'utf8'), target).default_agent, 'lead');
});

test('non-regular config targets are rejected before backups or replacement', t => {
  const root = fixture(t);
  const target = join(root, 'opencode.json');
  mkdirSync(target);
  assert.throws(() => saveInstallation(target, undefined, '{}', join(root, 'backups')), /non-regular/);
  assert.equal(existsSync(target), true);
  assert.equal(existsSync(join(root, 'backups')), false);
});

test('installer help is noninteractive and normal installation refuses piped input without writes', t => {
  const root = fixture(t);
  const script = fileURLToPath(new URL('../scripts/install-native-harness.ts', import.meta.url));
  assert.match(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }), /harness:install/);
  assert.throws(() => execFileSync(process.execPath, [script, '--scope', 'project', '--project', root], { stdio: 'pipe', input: 'install\n' }), /interactive terminal/);
  assert.equal(existsSync(join(root, 'opencode.jsonc')), false);
});
