// SMK-PS / SMK-PI: harness:setup and project-scope harness:integrations write only marked AGENTS.md sections.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSandbox, tree, type Sandbox } from './support/sandbox.ts';
import { ask, setupSteps } from './support/steps.ts';
import { expandStoredPath } from '../src/shared-locations.ts';

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
    const result = await box.run('setup-native-project.ts', ['--scope', 'project', '--project', box.project], { steps: setupSteps('./gradlew assembleDebug', 'save', [['detekt', './gradlew detekt']]) });
    assert.equal(result.code, 0, result.transcript);
    const text = agentsMd();
    assert.ok(text.includes(pristine.get('AGENTS.md')!.trim()), 'original instructions preserved');
    const section = text.slice(text.indexOf('<!-- advanced-harness:project:start -->'), text.indexOf('<!-- advanced-harness:project:end -->'));
    const settings = JSON.parse(section.slice(section.indexOf('```json') + 7, section.lastIndexOf('```')));
    assert.equal(settings.shell, 'bash');
    assert.equal(settings.device.preference, 'emulator');
    assert.equal(settings.checks.build.status, 'configured');
    assert.equal(settings.checks.lint.status, 'unconfigured');
    assert.deepEqual(settings.additionalChecks, [{ name: 'detekt', command: './gradlew detekt' }], 'additional gate saved next to, not instead of, lint');
    assert.equal(existsSync(join(box.project, '.opencode', 'harness.project.json')), false, 'no legacy profile file');
    assert.match(settings.worktreeDirectory, /^\$HOME\//, 'default locations under home are saved in the portable form');
    assert.match(settings.memoryPath, /^\$HOME\//, 'default locations under home are saved in the portable form');
    assert.equal(settings.projectRoot, undefined, 'portable settings carry no machine path');
    assert.deepEqual(readdirSync(expandStoredPath(settings.worktreeDirectory, box.home)), [], 'setup creates the worktree parent but no Git worktrees');
    assert.equal(readFileSync(expandStoredPath(settings.memoryPath, box.home), 'utf8'), '# Shared Operator memory\n\n', 'setup creates a header-only shared memory file');
  });

  it('SMK-PS-03 typing policy at the preflight prompt saves the default policy file with the commit hint', async () => {
    // A fresh sandbox: the shared box already holds settings from SMK-PS-02, which would change the prompts.
    const fresh = createSandbox('context-policy');
    try {
      const result = await fresh.run('setup-native-project.ts', ['--scope', 'project', '--project', fresh.project], { steps: setupSteps('./gradlew assembleDebug', 'save', [], 'policy') });
      assert.equal(result.code, 0, result.transcript);
      assert.deepEqual(result.unansweredSteps, []);
      assert.deepEqual(JSON.parse(readFileSync(join(fresh.project, '.harness', 'preflight.json'), 'utf8')), { version: 1, checks: { 'path-policy': { enabled: true, severity: 'block' } } });
      assert.match(result.transcript, /Preflight policy saved: .*\.harness[\\/]preflight\.json\. Commit \.harness\/preflight\.json: preflight reads it from origin\/HEAD/);
    } finally {
      fresh.dispose();
    }
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
