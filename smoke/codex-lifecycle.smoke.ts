import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ask, roles } from './support/steps.ts';
import { createSandbox, tree, type Sandbox } from './support/sandbox.ts';

describe('SMK-CX Codex project lifecycle (non-TTY piped answers)', () => {
  let box: Sandbox;
  let pristine: Map<string, string>;
  const args = () => ['--host', 'codex', '--scope', 'project', '--project', box.project];
  const installAnswers = (model: string, confirmation: string) => [ask('Existing Codex MCP server ID', 'fixture.server'), ask('Exact tool names on fixture.server', 'tool_x'), ...roles.flatMap(role => [ask(`${role}: explicitly assigned Codex model ID`, model), ask(`${role}: reasoning effort`, 'medium')]), ask('Type install to apply', confirmation)];
  before(() => {
    box = createSandbox('codex');
    const config = join(box.project, '.codex', 'config.toml'); mkdirSync(join(box.project, '.codex'), { recursive: true });
    writeFileSync(config, '# smoke-owned original\r\n\r\n[mcp_servers."fixture.server"] # keep this comment\r\nenabled = true\r\n');
    pristine = tree(box.project);
  });
  after(() => box.dispose());

  it('CX-01 cancellation changes nothing and writes no receipts', async () => {
    const result = await box.run('install-native-harness.ts', args(), { steps: installAnswers('fixture/model', 'cancel') });
    assert.equal(result.code, 0, result.transcript);
    assert.deepEqual(result.unansweredSteps, []);
    assert.match(result.stdout, /Cancelled\. No files, backups, or receipts were written/);
    const projectBefore = new Map(pristine);
    projectBefore.set('.git/config', tree(box.project).get('.git/config')!);
    assert.deepEqual(tree(box.project), projectBefore);
    assert.equal(existsSync(box.recoveryDirectory), false);
  });

  it('CX-02 install, doctor, defaults, and stale confirmation remain sandboxed', async () => {
    const installed = await box.run('install-native-harness.ts', args(), { steps: installAnswers('fixture/model', 'install') });
    assert.equal(installed.code, 0, installed.transcript);
    const config = join(box.project, '.codex', 'config.toml');
    const configText = readFileSync(config, 'utf8');
    assert.equal(configText, '# smoke-owned original\r\n\r\nsandbox_mode = "read-only"\r\n\r\napproval_policy = "on-request"\r\n\r\n[mcp_servers."fixture.server"] # keep this comment\r\nenabled = false\r\ndisabled_tools = ["tool_x"]\r\n');
    assert.equal(readFileSync(join(box.project, 'AGENTS.md'), 'utf8'), pristine.get('AGENTS.md'));
    const { diagnoseCodex } = await import('../src/codex-adapter.ts');
    const projectReport = await diagnoseCodex({ project: box.project, home: box.home });
    assert.equal(projectReport.ok, true, projectReport.issues.join('\n'));
    const updateSteps = [ask('Existing Codex MCP server ID', ''), ask('Exact tool names on fixture.server', ''), ...roles.flatMap(role => [ask(`${role}: explicitly assigned Codex model ID`, ''), ask(`${role}: reasoning effort`, '')]), ask('Type install to apply', 'install')];
    const updated = await box.run('update-native-harness.ts', args(), { steps: updateSteps });
    assert.equal(updated.code, 0, updated.transcript);
    assert.deepEqual(updated.unansweredSteps, []);
    for (const role of roles) {
      const roleText = readFileSync(join(box.project, '.codex', 'agents', `${role}.toml`), 'utf8');
      assert.match(roleText, /model = "fixture\/model"/);
      assert.match(roleText, /model_reasoning_effort = "medium"/);
    }
    const state = JSON.parse(readFileSync(join(box.project, '.codex', '.advanced-harness-state.json'), 'utf8')) as { selectedMcpServers: string[]; disabledTools: Record<string, string[]> };
    assert.deepEqual(state.selectedMcpServers, ['fixture.server']);
    assert.deepEqual(state.disabledTools, { 'fixture.server': ['tool_x'] });
    assert.equal(readFileSync(config, 'utf8'), '# smoke-owned original\r\n\r\nsandbox_mode = "read-only"\r\n\r\napproval_policy = "on-request"\r\n\r\n[mcp_servers."fixture.server"] # keep this comment\r\nenabled = false\r\ndisabled_tools = ["tool_x"]\r\n');
    const roleFile = join(box.project, '.codex', 'agents', 'lead.toml');
    const beforeRecovery = tree(box.recoveryDirectory);
    const beforeProject = tree(box.project);
    const staleSteps = [ask('Existing Codex MCP server ID', ''), ask('Exact tool names on fixture.server', ''), ...roles.flatMap(role => [ask(`${role}: explicitly assigned Codex model ID`, 'changed/model'), ask(`${role}: reasoning effort`, 'medium')]), ask('Type install to apply', 'install')];
    const stale = await box.run('install-native-harness.ts', args(), {
      steps: staleSteps,
      onPrompt: prompt => {
        if (prompt.includes('Type install to apply')) writeFileSync(roleFile, '# concurrent edit after review snapshot\n');
      },
    });
    assert.notEqual(stale.code, 0, stale.transcript);
    assert.match(stale.transcript, /File changed while confirmation was open/);
    assert.equal(readFileSync(roleFile, 'utf8'), '# concurrent edit after review snapshot\n');
    const expectedProject = new Map(beforeProject);
    expectedProject.set('.codex/agents/lead.toml', '# concurrent edit after review snapshot\n');
    assert.deepEqual(tree(box.project), expectedProject, 'stale refusal must make no writes beyond the injected concurrent edit');
    assert.deepEqual(tree(box.recoveryDirectory), beforeRecovery);
  });

  it('CX-03 global install and doctor stay separate from the project and real home', async () => {
    // realHomeFingerprintOf joins each entry onto homedir(), so watched paths must be home-relative. Only harness-written
    // paths are watched: the rest of a real ~/.codex (sessions, logs, databases) is live and may be locked by Codex Desktop.
    const watched = ['.codex/config.toml', '.codex/agents', '.codex/rules', '.codex/.advanced-harness-state.json', '.agents/skills', 'Projects/advanced-harness-backups'];
    const { realHomeFingerprintOf } = await import('./support/sandbox.ts');
    // Prove the guard resolves and hashes a real directory (and never returns its contents) by pointing
    // homedir() at a fixture that holds a secret-like file.
    const homeVariable = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const fixtureHome = join(box.root, 'fingerprint-home');
    mkdirSync(join(fixtureHome, '.codex'), { recursive: true });
    writeFileSync(join(fixtureHome, '.codex', 'auth.json'), 'SECRET-LIKE-SENTINEL-do-not-log');
    const savedHome = process.env[homeVariable];
    process.env[homeVariable] = fixtureHome;
    let fixtureFingerprint: string | undefined;
    try { fixtureFingerprint = realHomeFingerprintOf(['.codex']).get('.codex'); }
    finally { if (savedHome === undefined) delete process.env[homeVariable]; else process.env[homeVariable] = savedHome; }
    assert.match(fixtureFingerprint ?? '', /^directory:auth\.json:file:\d+:[a-f0-9]{64}$/);
    assert.doesNotMatch(fixtureFingerprint ?? '', /SECRET-LIKE-SENTINEL/);
    const before = realHomeFingerprintOf(watched);
    const cancel = await box.run('install-native-harness.ts', ['--host', 'codex', '--scope', 'global'], { steps: [ask('Existing Codex MCP server ID', ''), ...roles.flatMap(role => [ask(`${role}: explicitly assigned Codex model ID`, 'global/model'), ask(`${role}: reasoning effort`, 'medium')]), ask('Type install to apply', 'cancel')] });
    assert.equal(cancel.code, 0, cancel.transcript);
    assert.equal(existsSync(join(box.home, '.codex')), false);
    const projectBeforeGlobalInstall = tree(box.project);
    const steps = [ask('Existing Codex MCP server ID', ''), ...roles.flatMap(role => [ask(`${role}: explicitly assigned Codex model ID`, 'global/model'), ask(`${role}: reasoning effort`, 'medium')]), ask('Type install to apply', 'install')];
    const result = await box.run('install-native-harness.ts', ['--host', 'codex', '--scope', 'global'], { steps });
    assert.equal(result.code, 0, result.transcript);
    assert.deepEqual(tree(box.project), projectBeforeGlobalInstall);
    const { diagnoseCodex } = await import('../src/codex-adapter.ts');
    const doctor = await diagnoseCodex({ project: box.project, home: box.home });
    assert.equal(doctor.ok, false, 'CX-02 intentionally injected a project role edit at the stale-confirmation boundary');
    assert.ok(doctor.issues.some(issue => issue.includes('lead')));
    assert.deepEqual(realHomeFingerprintOf(watched), before, 'real-home protected roots remain unchanged');
    assert.ok(existsSync(join(box.home, '.codex', 'config.toml')));
    assert.ok(existsSync(join(box.home, '.agents', 'skills')));
    const { diagnoseCodex: diagnoseGlobalReport } = await import('../src/codex-adapter.ts');
    const globalReport = await diagnoseGlobalReport({ home: box.home });
    assert.equal(globalReport.ok, true, globalReport.issues.join('\n'));
    const update = await box.run('update-native-harness.ts', ['--host', 'codex', '--scope', 'global'], { steps: [ask('Existing Codex MCP server ID', ''), ...roles.flatMap(role => [ask(`${role}: explicitly assigned Codex model ID`, ''), ask(`${role}: reasoning effort`, '')]), ask('Type install to apply', 'install')] });
    assert.equal(update.code, 0, update.transcript);
    assert.deepEqual(realHomeFingerprintOf(watched), before, 'real-home protected roots unchanged after global update');
    const { diagnoseCodex: diagnoseGlobal } = await import('../src/codex-adapter.ts');
    const globalDoctor = await diagnoseGlobal({ home: box.home });
    assert.equal(globalDoctor.ok, true, globalDoctor.issues.join('\n'));
  });

  it('CX-05 doctor independently reports tampered route/tool, missing role/rules and preserves customized shared artifacts by default', async () => {
    const previousBox = box;
    box = createSandbox('codex-cx05-independent');
    previousBox.dispose();
    const configPath = join(box.project, '.codex', 'config.toml'); mkdirSync(join(box.project, '.codex'), { recursive: true });
    writeFileSync(configPath, '[mcp_servers."fixture.server"]\nenabled = true\ndisabled_tools = []\n');
    const answers = [ask('Existing Codex MCP server ID', 'fixture.server'), ask('Exact tool names on fixture.server', 'tool_x'), ...roles.flatMap(role => [ask(`${role}: explicitly assigned Codex model ID`, 'fixture/model'), ask(`${role}: reasoning effort`, 'medium')]), ask('Type install to apply', 'install')];
    const fresh = await box.run('install-native-harness.ts', args(), { steps: answers });
    assert.equal(fresh.code, 0, fresh.transcript);
    assert.deepEqual(fresh.unansweredSteps, []);
    const freshConfig = readFileSync(join(box.project, '.codex', 'config.toml'), 'utf8');
    assert.match(freshConfig, /^sandbox_mode = "read-only"/m);
    assert.match(freshConfig, /^approval_policy = "on-request"/m);
    assert.match(freshConfig, /enabled = false/);
    assert.match(freshConfig, /disabled_tools = \["tool_x"\]/);
    const config = join(box.project, '.codex', 'config.toml');
    writeFileSync(config, readFileSync(config, 'utf8').replace('enabled = false', 'enabled = true').replace('disabled_tools = ["tool_x"]', 'disabled_tools = []'));
    const role = join(box.project, '.codex', 'agents', 'researcher.toml');
    const roleBefore = readFileSync(role, 'utf8'); writeFileSync(role, roleBefore.replace('model = "fixture/model"', 'model = "custom/model"'));
    const rules = join(box.project, '.codex', 'rules', 'advanced-harness.rules');
    const rulesBefore = readFileSync(rules, 'utf8'); writeFileSync(rules, '# user rules preserved\n' + rulesBefore);
    const skill = join(box.project, '.agents', 'skills', 'start-issue', 'SKILL.md');
    const skillBefore = readFileSync(skill, 'utf8'); writeFileSync(skill, '# other host shared skill\n');
    const doctor = await box.run('diagnose-native-harness.ts', ['--host', 'codex', '--project', box.project]);
    assert.notEqual(doctor.code, 0);
    assert.match(doctor.transcript, /not disabled pending validation/);
    assert.match(doctor.transcript, /not disabled/);
    writeFileSync(role, roleBefore); writeFileSync(config, readFileSync(config, 'utf8').replace('enabled = true', 'enabled = false').replace('disabled_tools = []', 'disabled_tools = ["tool_x"]'));
    rmSync(join(box.project, '.codex', 'agents', 'reviewer.toml'));
    writeFileSync(join(box.project, '.codex', 'agents', 'researcher.toml'), roleBefore.replace('model = "fixture/model"', 'model = "custom/model"'));
    const prompts = [ask('Existing Codex MCP server ID', ''), ask('Exact tool names on fixture.server', ''), ...roles.flatMap(name => [ask(`${name}: explicitly assigned Codex model ID`, 'fixture/model'), ask(`${name}: reasoning effort`, 'medium')]), { prompt: /Overwrite customized\/unowned Codex agent[^\n]*researcher\.toml[^\n]*: $/, answer: 'no' }, { prompt: /Type install to apply[^\n]*: $/, answer: 'install' }];
    const rerun = await box.run('install-native-harness.ts', args(), { steps: prompts });
    assert.equal(rerun.code, 0, rerun.transcript);
    assert.deepEqual(rerun.unansweredSteps, []);
    assert.equal(readFileSync(skill, 'utf8'), '# other host shared skill\n');
    assert.match(readFileSync(rules, 'utf8'), /# user rules preserved/);
    assert.equal(readFileSync(join(box.project, '.codex', 'agents', 'reviewer.toml'), 'utf8').includes('model = "fixture/model"'), true);
    const affirmative = [ask('Existing Codex MCP server ID', ''), ask('Exact tool names on fixture.server', ''), ...roles.flatMap(name => [ask(`${name}: explicitly assigned Codex model ID`, 'fixture/model'), ask(`${name}: reasoning effort`, 'medium')]), { prompt: /Overwrite customized\/unowned Codex agent[^\n]*researcher\.toml[^\n]*: $/, answer: 'yes' }, { prompt: /Type install to apply[^\n]*: $/, answer: 'install' }];
    const completed = await box.run('install-native-harness.ts', args(), { steps: affirmative });
    assert.equal(completed.code, 0, completed.transcript);
    assert.deepEqual(completed.unansweredSteps, []);
    assert.doesNotMatch(readFileSync(join(box.project, '.codex', 'agents', 'researcher.toml'), 'utf8'), /custom\/model/);
    assert.ok(skillBefore.length > 0);
  });

  it('CX-04 invalid model/effort choices fail after three attempts with no target writes', async () => {
    for (const field of ['model', 'effort'] as const) {
      const root = join(box.root, `retry-${field}`); mkdirSync(root);
      const project = join(root, 'project'); mkdirSync(project);
      const beforeProject = tree(project), beforeHome = tree(box.home), beforeRecovery = tree(box.recoveryDirectory);
      const prompts = [ask('Existing Codex MCP server ID', ''), ...(field === 'model' ? [ask('explicitly assigned Codex model ID', '-'), ask('explicitly assigned Codex model ID', '-'), ask('explicitly assigned Codex model ID', '-')] : [ask('explicitly assigned Codex model ID', 'valid/model'), ask('reasoning effort', 'bogus'), ask('reasoning effort', 'bogus'), ask('reasoning effort', 'bogus')])];
      const failed = await box.run('install-native-harness.ts', ['--host', 'codex', '--scope', 'project', '--project', project], { steps: prompts, cwd: project });
      assert.notEqual(failed.code, 0, failed.transcript);
      assert.match(failed.transcript, /3 attempts/);
      assert.deepEqual(tree(project), beforeProject, `invalid ${field} answers must not write to the project`);
      assert.deepEqual(tree(box.home), beforeHome, `invalid ${field} answers must not write to the sandbox home`);
      assert.deepEqual(tree(box.recoveryDirectory), beforeRecovery, `invalid ${field} answers must not write recovery evidence`);
    }
  });
});
