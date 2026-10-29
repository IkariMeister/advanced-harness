// SMK-HS: interactive host prompt for install and update accepts one host and re-asks multi-host answers (#88).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createSandbox, tree, type Sandbox } from './support/sandbox.ts';
import { ask, openCodeInstall } from './support/steps.ts';

const multiHostNotice = /Select one host\. Multi-host and all selections are not supported/g;

describe('SMK-HS host selection prompt (non-TTY piped answers)', () => {
  let box: Sandbox;
  let pristine: Map<string, string>;
  const args = () => ['--scope', 'project', '--project', box.project];
  before(() => { box = createSandbox('host-select'); pristine = tree(box.project); });
  after(() => box.dispose());

  it('SMK-HS-01 install re-asks comma-separated and all answers, then cancels the chosen host with no writes', async () => {
    const result = await box.run('install-native-harness.ts', args(), { steps: [
      ask('Select host (', 'opencode, claude-code, antigravity'),
      ask('Select host (', 'all'),
      ask('Select host (', 'claude-code'),
      ask('Type yes to install the Claude Code harness'),
    ] });
    assert.equal(result.code, 1, result.transcript);
    assert.deepEqual(result.unansweredSteps, []);
    assert.match(result.stdout, /Installation canceled by user\. No files written\./);
    assert.doesNotMatch(result.stdout, /comma-separated, or all/);
    assert.equal(result.stderr.match(multiHostNotice)?.length, 2);
    assert.doesNotMatch(result.stderr, /Multi-host simultaneous installation is not supported/);
    assert.deepEqual(tree(box.project), pristine);
    assert.equal(existsSync(box.recoveryDirectory), false);
  });

  it('SMK-HS-02 Enter at the install host prompt keeps the opencode default', async () => {
    const result = await box.run('install-native-harness.ts', args(), { steps: [ask('Select host (opencode, claude-code, antigravity, codex, cursor) [opencode]'), ...openCodeInstall('')] });
    assert.equal(result.code, 0, result.transcript);
    assert.deepEqual(result.unansweredSteps, []);
    assert.match(result.stdout, /Cancelled\. No files were changed\./);
    assert.deepEqual(tree(box.project), pristine);
    assert.equal(existsSync(box.recoveryDirectory), false);
  });

  it('SMK-HS-03 update re-asks a multi-host answer and passes the single chosen host to the flow', async () => {
    const result = await box.run('update-native-harness.ts', args(), { steps: [
      ask('Select host (', 'claude-code,antigravity'),
      ask('Select host (', 'codex'),
    ] });
    assert.equal(result.code, 2, result.transcript);
    assert.deepEqual(result.unansweredSteps, []);
    assert.equal(result.stderr.match(multiHostNotice)?.length, 1);
    assert.match(result.stderr, /Update blocked: .*issue #45/);
    assert.doesNotMatch(result.stderr, /Multi-host simultaneous update is not supported/);
    assert.deepEqual(tree(box.project), pristine);
    assert.equal(existsSync(box.recoveryDirectory), false);
  });
});
