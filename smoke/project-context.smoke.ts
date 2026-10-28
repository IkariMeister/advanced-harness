// SMK-PS / SMK-PI: harness:setup and project-scope harness:integrations write only marked AGENTS.md sections.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSandbox, tree, type Sandbox } from './support/sandbox.ts';
import { ask } from './support/steps.ts';

const setupSteps = (build: string, confirmation: string) => [
  ask('Command shell', 'bash'),
  ask('Base branch'),
  ask('build: confirm command', build),
  ask('lint: confirm command'),
  ask('unit: confirm command'),
  ask('roborazzi: confirm command'),
  ask('runtime: confirm command'),
  ask('e2e: confirm command'),
  ask('Device preference', 'emulator'),
  ask('Optional device serial'),
  ask('Parent directory for future worktrees'),
  ask('Shared MEMORY.md path'),
  ask('Full preview: type save', confirmation),
];

describe('SMK-PS project setup + SMK-PI project integrations (non-TTY piped answers)', () => {
  let box: Sandbox;
  let pristine: Map<string, string>;
  const agentsMd = () => readFileSync(join(box.project, 'AGENTS.md'), 'utf8');
  before(() => { box = createSandbox('context'); pristine = tree(box.project); });
  after(() => box.dispose());

  it('SMK-PS-01 Enter at the setup preview cancels with no files or backups', async () => {
    const result = await box.run('setup-native-project.ts', ['--scope', 'project', '--project', box.project], { steps: setupSteps('./gradlew assembleDebug', '') });
    assert.equal(result.code, 0, result.transcript);
    assert.deepEqual(result.unansweredSteps, []);
    assert.match(result.stdout, /Cancelled\. Nothing changed: no files written and no backups created\./);
    assert.deepEqual(tree(box.project), pristine);
    assert.equal(existsSync(box.recoveryDirectory), false);
  });

  it('SMK-PS-02 saving writes a marked settings section and preserves existing AGENTS.md content', async () => {
    const result = await box.run('setup-native-project.ts', ['--scope', 'project', '--project', box.project], { steps: setupSteps('./gradlew assembleDebug', 'save') });
    assert.equal(result.code, 0, result.transcript);
    const text = agentsMd();
    assert.ok(text.includes(pristine.get('AGENTS.md')!.trim()), 'original instructions preserved');
    const section = text.slice(text.indexOf('<!-- advanced-harness:project:start -->'), text.indexOf('<!-- advanced-harness:project:end -->'));
    const settings = JSON.parse(section.slice(section.indexOf('```json') + 7, section.lastIndexOf('```')));
    assert.equal(settings.shell, 'bash');
    assert.equal(settings.device.preference, 'emulator');
    assert.equal(settings.checks.build.status, 'configured');
    assert.equal(settings.checks.lint.status, 'unconfigured');
    assert.equal(existsSync(join(box.project, '.opencode', 'harness.project.json')), false, 'no legacy profile file');
    assert.equal(existsSync(settings.worktreeDirectory), false, 'setup does not create worktrees');
  });

  it('SMK-PI-01 project integrations (gh + repository) add their own section without touching setup settings', async () => {
    const before = agentsMd();
    const setupSection = before.slice(before.indexOf('<!-- advanced-harness:project:start -->'), before.indexOf('<!-- advanced-harness:project:end -->'));
    const result = await box.run('configure-integrations.ts', ['--scope', 'project', '--project', box.project], { steps: [
      ask('GitHub backend', 'gh'), ask('GitHub hostname for gh'), ask('jira: alias'), ask('Design source'),
      ask('Project GitHub owner/repository', 'example/smoke-android-app'), ask('Type integrations to save', 'integrations'),
    ] });
    assert.equal(result.code, 0, result.transcript);
    assert.deepEqual(result.unansweredSteps, []);
    const after = agentsMd();
    assert.ok(after.includes(setupSection), 'setup section unchanged');
    assert.match(after, /example\/smoke-android-app/);
    assert.equal(existsSync(join(box.project, 'opencode.json')) || existsSync(join(box.project, 'opencode.jsonc')), false, 'no project OpenCode config created');
    assert.deepEqual(box.openCodeCalls(), [], 'no connection checks without --check');
  });
});
