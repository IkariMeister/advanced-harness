import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import { nativeRoles, parseConfiguration } from '../src/native-installer.ts';
import { discoverReceiptChain } from '../src/receipt-lineage.ts';

function createDummyInstalledConfig(): Record<string, unknown> {
  return {
    agents: Object.fromEntries(
      nativeRoles.map(role => [
        role,
        {
          description: `Custom desc of ${role}`,
          mode: role === 'lead' ? 'primary' : 'subagent',
          model: 'custom/model#low',
          permissions: [],
          system: `Old system prompt for ${role}`,
          customField: 'keep-custom'
        }
      ])
    )
  };
}

test('update flow cancellation makes no configuration or recovery writes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-update-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const config = join(project, 'opencode.json');
  const initialJson = JSON.stringify(createDummyInstalledConfig(), null, 2);
  writeFileSync(config, initialJson);

  const answer = (question: string) => {
    if (question.startsWith('Check remote')) return 'no';
    if (question.includes('system prompt to latest')) return 'no';
    if (question.startsWith('Type update')) return 'cancel';
    throw new Error(`Unexpected question: ${question}`);
  };

  const output: string[] = [];
  const status = await runUpdateFlow(
    { scope: 'project', project },
    {
      ask: async q => answer(q),
      output: text => output.push(text),
      error: text => output.push(text),
      home: root,
      recoveryDirectory: join(root, 'recovery'),
      runCommand: () => ''
    }
  );

  assert.equal(status, 0);
  assert.equal(readFileSync(config, 'utf8'), initialJson);
  assert.equal(existsSync(join(root, 'recovery')), false);
  assert.ok(output.some(line => line.includes('Update cancelled. No files or receipts were modified.')));
});

test('update flow default-on-Enter keeps installed system prompt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-update-default-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const config = join(project, 'opencode.json');
  const dummy = createDummyInstalledConfig();
  writeFileSync(config, JSON.stringify(dummy, null, 2));

  const answer = (question: string) => {
    if (question.startsWith('Check remote')) return 'no';
    // Empty string simulates pressing Enter on default [no]
    if (question.includes('system prompt to latest')) return '';
    if (question.startsWith('Type update')) return 'update';
    throw new Error(`Unexpected question: ${question}`);
  };

  const output: string[] = [];
  const status = await runUpdateFlow(
    { scope: 'project', project },
    {
      ask: async q => answer(q),
      output: text => output.push(text),
      error: text => output.push(text),
      home: root,
      recoveryDirectory: join(root, 'recovery'),
      runCommand: (cmd, args) => {
        if (args[0] === 'rev-parse') return '1111222233334444';
        return '';
      },
      verify: async () => ({ ok: true, checks: [] } as never),
      printReport: () => {}
    }
  );

  assert.equal(status, 0);
  const saved = parseConfiguration(readFileSync(config, 'utf8'), config);
  const agents = saved.agents as Record<string, Record<string, unknown>>;
  // lead system prompt was kept as Old system prompt
  assert.equal(agents.lead?.system, 'Old system prompt for lead');
  // custom field preserved
  assert.equal(agents.lead?.customField, 'keep-custom');
  // model preserved
  assert.equal(agents.lead?.model, 'custom/model#low');
});

test('update flow applies prompt when explicitly selected and records harness version stamp', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-update-apply-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const config = join(project, 'opencode.json');
  const dummy = createDummyInstalledConfig();
  writeFileSync(config, JSON.stringify(dummy, null, 2));

  const answer = (question: string) => {
    if (question.startsWith('Check remote')) return 'no';
    if (question.includes('Update lead system prompt')) return 'yes';
    if (question.includes('system prompt to latest')) return 'no';
    if (question.startsWith('Type update')) return 'update';
    throw new Error(`Unexpected question: ${question}`);
  };

  const output: string[] = [];
  const status = await runUpdateFlow(
    { scope: 'project', project },
    {
      ask: async q => answer(q),
      output: text => output.push(text),
      error: text => output.push(text),
      home: root,
      recoveryDirectory: join(root, 'recovery'),
      runCommand: (cmd, args) => {
        if (args[0] === 'rev-parse') return 'deadbeef1234';
        if (args[0] === 'status') return '';
        return '';
      },
      verify: async () => ({ ok: true, checks: [] } as never),
      printReport: () => {}
    }
  );

  assert.equal(status, 0);
  const saved = parseConfiguration(readFileSync(config, 'utf8'), config);
  const agents = saved.agents as Record<string, Record<string, unknown>>;
  // Lead prompt was updated away from Old system prompt
  assert.notEqual(agents.lead?.system, 'Old system prompt for lead');
  // Other roles were kept
  assert.equal(agents.operator?.system, 'Old system prompt for operator');

  // Verify finalized v2 receipt contains harnessVersion stamp
  const chain = discoverReceiptChain(join(root, 'recovery'), config);
  assert.ok(chain.head);
  assert.equal(chain.head.receipt.version, 2);
  assert.deepEqual(chain.head.receipt.harnessVersion, {
    version: '0.1.0',
    commit: 'deadbeef1234'
  });
});

test('update flow checkRemote reports newer remote version and prints pull guidance without pulling', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-update-remote-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const config = join(project, 'opencode.json');
  writeFileSync(config, JSON.stringify(createDummyInstalledConfig(), null, 2));

  const answer = (question: string) => {
    if (question.startsWith('Check remote')) return 'yes';
    if (question.includes('system prompt to latest')) return 'no';
    if (question.startsWith('Type update')) return 'cancel';
    throw new Error(`Unexpected question: ${question}`);
  };

  const output: string[] = [];
  await runUpdateFlow(
    { scope: 'project', project },
    {
      ask: async q => answer(q),
      output: text => output.push(text),
      error: text => output.push(text),
      home: root,
      recoveryDirectory: join(root, 'recovery'),
      runCommand: (cmd, args) => {
        if (args[0] === 'ls-remote') return 'ffffffffffffffffffffffffffffffffffffffff\trefs/heads/main';
        if (args[0] === 'rev-parse') return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        if (args[0] === 'merge-base' && args[1] === '--is-ancestor' && args[2] === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' && args[3] === 'ffffffffffffffffffffffffffffffffffffffff') return '';
        throw new Error('git error');
      }
    }
  );

  assert.ok(output.some(line => line.includes('NOTICE: A newer version of the harness is available on origin/main.')));
  assert.ok(output.some(line => line.includes('git pull origin main')));
});

test('update flow pending-write or finalization failure retains pending recovery evidence', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-update-fail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const config = join(project, 'opencode.json');
  writeFileSync(config, JSON.stringify(createDummyInstalledConfig(), null, 2));

  const answer = (question: string) => {
    if (question.startsWith('Check remote')) return 'no';
    if (question.includes('system prompt to latest')) return 'no';
    if (question.startsWith('Type update')) return 'update';
    throw new Error(`Unexpected question: ${question}`);
  };

  const output: string[] = [];
  await assert.rejects(
    async () => {
      await runUpdateFlow(
        { scope: 'project', project },
        {
          ask: async q => answer(q),
          output: text => output.push(text),
          error: text => output.push(text),
          home: root,
          recoveryDirectory: join(root, 'recovery'),
          runCommand: (cmd, args) => {
            if (args[0] === 'rev-parse') return '1111222233334444';
            return '';
          },
          finalize: () => { throw new Error('simulated finalization failure'); }
        }
      );
    },
    /simulated finalization failure/
  );

  assert.ok(output.some(line => line.includes('receipt finalization failed; pending evidence retained')));
});
