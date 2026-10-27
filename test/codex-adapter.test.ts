import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileCodexAgent, compileCodexMergeRule, diagnoseCodex, installCodex, validateCodexToml } from '../src/codex-adapter.ts';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import { askHostSelection } from '../src/host-registry.ts';
import { saveInstallation } from '../src/native-installer.ts';

function roleAnswers(model: string, finalAnswer = 'install'): string[] {
  return ['', ...Array.from({ length: 8 }, () => [model, 'medium']).flat(), finalAnswer];
}

test('Codex agent serializes only supported explicit role fields and validates TOML', () => {
  const text = compileCodexAgent('lead', 'gpt-example', 'high', 'Lead role', 'Ask the human before writes.');
  assert.match(text, /^name = "lead"/m);
  assert.match(text, /^model = "gpt-example"/m);
  assert.match(text, /^model_reasoning_effort = "high"/m);
  validateCodexToml(text);
  assert.throws(() => compileCodexAgent('lead', '', 'medium', 'x', 'y'));
  assert.throws(() => validateCodexToml('[duplicate]\nx = 1\n[duplicate]\ny = 2'));
  assert.throws(() => validateCodexToml('x = [not_toml]'));
  assert.throws(() => validateCodexToml('x = {broken}'));
  assert.throws(() => validateCodexToml('a = 1\n[a]'));
  for (const invalid of [
    'a = 1\na.b = 2',
    'a.b = 2\na = 1',
    'x = { a = 1, a.b = 2 }',
    'x = { a.b = 2, a = 1 }',
    'x = { a = { b = 1 }, a.c = 2 }',
  ]) assert.throws(() => validateCodexToml(invalid));
  for (const invalid of ['x = +0x1', 'x = -0b1', 'x = 01', 'x = 01.2', 'x = 01e2', 'x = 1_', 'x = 1__0', 'x = 0x_1']) assert.throws(() => validateCodexToml(invalid));
  for (const valid of ['x = 0x1', 'x = 0o7', 'x = 0b1', 'x = +0', 'x = -1', 'x = 1_000', 'x = 1.2', 'x = 1e2', 'x = 1.2e-2', 'x = { a = 1, b = { c = 2 } }']) validateCodexToml(valid);
  assert.match(compileCodexMergeRule(), /decision = "forbidden"/);
  assert.match(compileCodexMergeRule(), /indirect\/API routes are not blocked/);
});

test('Codex cancellation creates no target files or backups; explicit choices install idempotently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-harness-'));
  const project = join(root, 'project'), home = join(root, 'home');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(project); mkdirSync(home);
  const answers: string[] = ['', ...Array.from({ length: 8 }, () => ['gpt-example', 'medium']).flat(), 'cancel'];
  const ask = async () => answers.shift() ?? '';
  const output: string[] = [];
  assert.equal(await installCodex({ scope: 'project', project, home, ask, output: value => output.push(value), error() {} }), 0);
  assert.equal(existsSync(join(project, '.codex')), false);
  assert.equal(existsSync(join(home, 'Projects', 'advanced-harness-backups')), false);

  const installAnswers: string[] = ['', ...Array.from({ length: 8 }, () => ['gpt-example', 'medium']).flat(), 'install'];
  assert.equal(await installCodex({ scope: 'project', project, home, ask: async () => installAnswers.shift() ?? '', output: value => output.push(value), error() {} }), 0);
  assert.equal(readFileSync(join(project, '.codex', 'agents', 'lead.toml'), 'utf8').includes('gpt-example'), true);
  assert.equal((await diagnoseCodex({ project, home })).ok, true);
  const rerunAnswers: string[] = ['', ...Array.from({ length: 8 }, () => ['gpt-example', 'medium']).flat(), 'install'];
  assert.equal(await installCodex({ scope: 'project', project, home, ask: async () => rerunAnswers.shift() ?? '', output: value => output.push(value), error() {} }), 0);
  assert.equal(readdirSync(join(project, '.codex', 'agents')).length, 8);
  const receipts = readdirSync(join(home, 'Projects', 'advanced-harness-backups')).filter(name => name.startsWith('native-install-'));
  assert.equal(receipts.length, 1, 'idempotent update must not churn its host-scoped receipt');
});

test('Codex MCP changes require actual selected IDs/tools, disable routes, and preserve unrelated TOML', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-mcp-'));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project); mkdirSync(home);
  const configDir = join(project, '.codex'); mkdirSync(configDir);
  writeFileSync(join(configDir, 'config.toml'), 'model = "existing-model"\n\n[mcp_servers.real_server]\nenabled = true\nrequired = true\ncommand = "real-mcp"\nargs = ["--safe"]\n\n  [mcp_servers.unselected] # indented table header\nenabled = true\n\n  [mcp_servers.unselected.tools.some_tool]\napproval_mode = "auto"\n');
  const answers = ['real_server', 'merge_tool', ...Array.from({ length: 8 }, () => ['custom/model', 'low']).flat(), 'install'];
  const result = await installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error() {} });
  assert.equal(result, 0);
  const saved = readFileSync(join(configDir, 'config.toml'), 'utf8');
  assert.match(saved, /^sandbox_mode = "read-only"/m);
  assert.match(saved, /^approval_policy = "on-request"/m);
  assert.match(saved, /model = "existing-model"/);
  const selectedSection = saved.split('[mcp_servers.unselected]')[0]!;
  const unselectedSection = saved.split('[mcp_servers.unselected]')[1]!;
  assert.match(selectedSection, /enabled = false/);
  assert.match(selectedSection, /disabled_tools = \["merge_tool"\]/);
  assert.match(unselectedSection, /enabled = true/);
  assert.doesNotMatch(unselectedSection, /disabled_tools/);
  assert.match(saved, /command = "real-mcp"/);
  assert.match(saved, /required = true/);
  assert.doesNotMatch(selectedSection, /approval_mode/);
  assert.match(unselectedSection, /approval_mode = "auto"/);
  const report = await diagnoseCodex({ project, home });
  assert.equal(report.ok, true, report.issues.join('; '));
});

test('Codex doctor fails closed on malformed TOML and MCP route remains disabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-doctor-'));
  const codex = join(root, '.codex');
  const { mkdirSync } = await import('node:fs'); mkdirSync(codex);
  writeFileSync(join(codex, 'config.toml'), 'not valid toml');
  const report = await diagnoseCodex({ project: root, home: root });
  assert.equal(report.ok, false);
  assert.match(report.issues.join(' '), /Malformed|Unsupported/);
});

test('Codex rejects malformed supported-subset TOML before prompts, backups, receipts, or writes', async () => {
  for (const invalid of [
    'x = [not_toml]\n', 'x = {broken}\n', 'a = 1\n[a]\n',
    'a = 1\na.b = 2\n', 'a.b = 2\na = 1\n', 'x = { a = 1, a.b = 2 }\n',
    'x = +0x1\n', 'x = 01.2\n',
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'codex-invalid-'));
    const project = join(root, 'project'), home = join(root, 'home');
    const { mkdirSync } = await import('node:fs'); mkdirSync(project); mkdirSync(home);
    const configDir = join(project, '.codex'); mkdirSync(configDir);
    const configPath = join(configDir, 'config.toml'); writeFileSync(configPath, invalid);
    let prompts = 0;
    await assert.rejects(installCodex({ scope: 'project', project, home, ask: async () => { prompts++; return 'install'; }, output() {}, error() {} }));
    assert.equal(prompts, 0);
    assert.equal(readFileSync(configPath, 'utf8'), invalid);
    assert.equal(existsSync(join(home, 'Projects', 'advanced-harness-backups')), false);
  }
});

test('actual installer flow routes Codex selection and cancellation leaves no artifacts, backups, or receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-flow-'));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project); mkdirSync(home);
  const answers = ['', ...Array.from({ length: 8 }, () => ['gpt-explicit', 'medium']).flat(), 'no'];
  const output: string[] = [];
  const status = await runInstallerFlow({ host: 'codex', scope: 'project', project }, {
    ask: async () => answers.shift() ?? '', output: message => output.push(message), error: message => output.push(message), cwd: root, home,
  });
  assert.equal(status, 0);
  assert.equal(existsSync(join(project, '.codex')), false);
  assert.equal(existsSync(join(home, 'Projects', 'advanced-harness-backups')), false);
  assert.ok(output.some(line => line.includes('Cancelled.')));
});

test('Codex installer and updater route both project and global scopes to their separate targets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-routing-'));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project); mkdirSync(home);
  const runInstall = (scope: 'project' | 'global', model: string) => {
    const answers = roleAnswers(model);
    return runInstallerFlow({ host: 'codex', scope, ...(scope === 'project' ? { project } : {}) }, {
      ask: async () => answers.shift() ?? '', output() {}, error() {}, cwd: root, home,
    });
  };
  const runUpdate = (scope: 'project' | 'global', model: string) => {
    const answers = roleAnswers(model);
    return runUpdateFlow({ host: 'codex', scope, ...(scope === 'project' ? { project } : {}) }, {
      ask: async () => answers.shift() ?? '', output() {}, error() {}, cwd: root, home,
    });
  };
  assert.equal(await runInstall('project', 'project-model'), 0);
  assert.equal(await runUpdate('project', 'project-updated-model'), 0);
  assert.equal(await runInstall('global', 'global-model'), 0);
  assert.equal(await runUpdate('global', 'global-updated-model'), 0);
  assert.match(readFileSync(join(project, '.codex', 'agents', 'lead.toml'), 'utf8'), /project-updated-model/);
  assert.match(readFileSync(join(home, '.codex', 'agents', 'lead.toml'), 'utf8'), /global-updated-model/);
  assert.equal(existsSync(join(project, '.codex', '.advanced-harness-state.json')), true);
  assert.equal(existsSync(join(home, '.codex', '.advanced-harness-state.json')), true);
});

test('customized Codex roles and shared skills default to preserve; AGENTS is never modified', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-preserve-'));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project); mkdirSync(home);
  const rolePath = join(project, '.codex', 'agents', 'lead.toml');
  const skillPath = join(project, '.agents', 'skills', 'start-issue', 'SKILL.md');
  const agentsPath = join(project, 'AGENTS.md');
  mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
  mkdirSync(join(project, '.agents', 'skills', 'start-issue'), { recursive: true });
  const customRole = 'name = "lead"\n# customized role remains user-owned\n';
  const customSkill = '---\nname: start-issue\ndescription: My customized skill\n---\nKeep this skill.\n';
  const projectInstructions = '# Existing project workflow\nLeave every byte intact.\n';
  writeFileSync(rolePath, customRole); writeFileSync(skillPath, customSkill); writeFileSync(agentsPath, projectInstructions);
  const answers = ['', ...Array.from({ length: 8 }, () => ['chosen-model', 'medium']).flat(), 'no', 'install'];
  const output: string[] = [];
  const status = await installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output: value => output.push(value), error() {} });
  assert.equal(status, 1, 'preserving a required role file leaves installation explicitly incomplete');
  assert.equal(readFileSync(rolePath, 'utf8'), customRole);
  assert.equal(readFileSync(skillPath, 'utf8'), customSkill);
  assert.equal(readFileSync(agentsPath, 'utf8'), projectInstructions);
  assert.ok(output.some(line => line.includes('preserved: lead')));
  const receiptName = readdirSync(join(home, 'Projects', 'advanced-harness-backups')).find(name => name.startsWith('native-install-'))!;
  const receipt = JSON.parse(readFileSync(join(home, 'Projects', 'advanced-harness-backups', receiptName), 'utf8')) as { managedFiles: Array<{ path: string }> };
  assert.equal(receipt.managedFiles.some(item => item.path === rolePath || item.path === skillPath || item.path === agentsPath), false);
});

test('Codex confirmation-time config drift is refused before backup or receipt creation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-drift-'));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project); mkdirSync(home);
  const configDir = join(project, '.codex'); mkdirSync(configDir);
  const configPath = join(configDir, 'config.toml');
  const original = 'model = "original-model"\n'; writeFileSync(configPath, original);
  const answers = roleAnswers('drift-model');
  let changed = false;
  await assert.rejects(installCodex({ scope: 'project', project, home, ask: async question => {
    const answer = answers.shift() ?? '';
    if (question.includes('Type install')) { writeFileSync(configPath, 'model = "concurrent-user-model"\n'); changed = true; return 'install'; }
    return answer;
  }, output() {}, error() {} }), /changed while confirmation was open/);
  assert.equal(changed, true);
  assert.equal(readFileSync(configPath, 'utf8'), 'model = "concurrent-user-model"\n');
  assert.equal(existsSync(join(project, '.codex', 'agents', 'lead.toml')), false);
  assert.equal(existsSync(join(home, 'Projects', 'advanced-harness-backups')), false);
});

test('Codex partial file failure leaves the pending receipt and prior successful file for recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-partial-'));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project); mkdirSync(home);
  let saves = 0;
  const save = (...args: Parameters<typeof saveInstallation>) => {
    saves++;
    if (saves === 2) throw new Error('injected second-file failure');
    return saveInstallation(...args);
  };
  const errors: string[] = [];
  const answers = roleAnswers('partial-model');
  await assert.rejects(installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error: message => errors.push(message), save }), /injected second-file failure/);
  assert.match(readFileSync(join(project, '.codex', 'config.toml'), 'utf8'), /sandbox_mode = "read-only"/);
  assert.equal(existsSync(join(project, '.codex', 'agents', 'lead.toml')), false);
  const recovery = join(home, 'Projects', 'advanced-harness-backups');
  const receiptName = readdirSync(recovery).find(name => name.startsWith('native-install-'))!;
  const pending = JSON.parse(readFileSync(join(recovery, receiptName), 'utf8')) as { status: string; complete: boolean };
  assert.equal(pending.status, 'pending');
  assert.equal(pending.complete, false);
  assert.ok(errors.some(message => message.includes('pending recovery evidence retained')));
});

test('CLI-used host selection retries; Enter defaults scope/project and cancels without writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-prompt-flow-'));
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const answers = ['unknown-host', 'codex', 'invalid-scope', '', '', '', ...Array.from({ length: 8 }, () => ['explicit-model', 'medium']).flat(), ''];
  const ask = async () => answers.shift() ?? '';
  const hosts = await askHostSelection(ask, 'opencode');
  const output: string[] = [];
  const status = await runInstallerFlow({ host: hosts.join(',') }, { ask, output: message => output.push(message), error: message => output.push(message), cwd: root, home });
  assert.equal(status, 0);
  assert.ok(output.some(line => line.includes('Cancelled. No files, backups, or receipts were written.')));
  assert.equal(existsSync(join(root, '.codex')), false);
  assert.equal(existsSync(join(home, 'Projects', 'advanced-harness-backups')), false);
});
