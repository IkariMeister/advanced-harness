import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    assert.deepEqual(tree(box.project), pristine);
    assert.equal(existsSync(box.recoveryDirectory), false);
  });

  it('CX-02 install, doctor, defaults, and stale confirmation remain sandboxed', async () => {
    const installed = await box.run('install-native-harness.ts', args(), { steps: installAnswers('fixture/model', 'install') });
    assert.equal(installed.code, 0, installed.transcript);
    const config = join(box.project, '.codex', 'config.toml');
    const configText = readFileSync(config, 'utf8');
    assert.match(configText, /sandbox_mode = "read-only"/);
    assert.match(configText, /enabled = false/);
    assert.match(configText, /disabled_tools = \["tool_x"\]/);
    assert.ok(configText.includes('# smoke-owned original\r\n\r\n'));
    assert.ok(configText.includes('[mcp_servers."fixture.server"] # keep this comment\r\nenabled = false\r\n'));
    assert.equal(readFileSync(join(box.project, 'AGENTS.md'), 'utf8'), pristine.get('AGENTS.md'));
    const doctor = await box.run('diagnose-native-harness.ts', ['--host', 'codex', '--project', box.project]);
    assert.equal(doctor.code, 0, doctor.transcript);
    const updateSteps = [ask('Existing Codex MCP server ID', ''), ask('Exact tool names on fixture.server', ''), ...roles.flatMap(role => [ask(`${role}: explicitly assigned Codex model ID`, ''), ask(`${role}: reasoning effort`, '')]), ask('Type install to apply', 'install')];
    const updated = await box.run('update-native-harness.ts', args(), { steps: updateSteps });
    assert.equal(updated.code, 0, updated.transcript);
    assert.deepEqual(updated.unansweredSteps, []);
    assert.match(readFileSync(join(box.project, '.codex', 'agents', 'lead.toml'), 'utf8'), /model = "fixture\/model"/);
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
});
