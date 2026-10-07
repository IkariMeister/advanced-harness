import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { createController } from '../src/controller.ts';
import { agentIpcDispatch, startAgentIpcHost } from '../src/host-ipc.ts';
import { reviewPlanInConsole } from '../src/host-console.ts';
import { snapshotDirectory } from '../src/snapshot.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'advanced-harness-host-test-'));
  const worktree = join(root, 'worktree');
  const ipc = join(root, 'ipc');
  mkdirSync(worktree);
  writeFileSync(join(worktree, 'app.txt'), 'unchanged');
  const controller = createController({
    database: join(root, 'state.sqlite'), project: root, feature: 'host-test', worktree,
    snapshot: () => snapshotDirectory(worktree),
    handlers: {
      push: { input: z.strictObject({}), async execute() { return { status: 'passed', summary: 'pushed' }; } },
    },
  });
  let host: Awaited<ReturnType<typeof startAgentIpcHost>> | undefined;
  t.after(async () => {
    await host?.close();
    controller.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, ipc, controller, start: async () => { host = await startAgentIpcHost({ controller, directory: ipc }); return host; } };
}

test('role-specific IPC dispatch cannot choose a role or reach human decisions', async t => {
  const { controller, start } = fixture(t);
  const host = await start();
  if (process.platform !== 'win32') {
    assert.equal(statSync(host.endpoints.planner).mode & 0o777, 0o600);
  }
  const planner = host.endpoints.planner;
  await agentIpcDispatch(planner, 'harness.propose-plan', 'A plan proposed through the planner endpoint.');
  const view = await agentIpcDispatch(planner, 'harness.status', null) as { plan: { text: string }; target: string };
  assert.equal(view.plan.text, 'A plan proposed through the planner endpoint.');
  assert.equal(typeof view.target, 'string');

  await assert.rejects(agentIpcDispatch(planner, 'harness.decide', { kind: 'approve-plan', target: view.target }), /unavailable/);
  await assert.rejects(agentIpcDispatch(planner, 'harness.action', {
    id: 'forged-role', action: 'push', input: {}, role: 'external',
  }), /Unrecognized key/);
  await assert.rejects(agentIpcDispatch(planner, 'harness.action', {
    id: 'wrong-role-action', action: 'push', input: {},
  }), /different agent/);
  assert.equal(controller.human.status().planApproval, null);
});

test('a second host cannot steal or unlink endpoints owned by the running host', async t => {
  const { ipc, controller, start } = fixture(t);
  const first = await start();
  await assert.rejects(startAgentIpcHost({ controller, directory: ipc }));
  const status = await agentIpcDispatch(first.endpoints.planner, 'harness.status', null);
  assert.ok(status);
});

test('host console requires an interactive TTY and explicitly approves the displayed target', async t => {
  const { controller } = fixture(t);
  controller.bindAgent('planner').proposePlan('A concrete demo plan.');
  const view = controller.human.status();
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  const output = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  output.isTTY = true;
  const shown: string[] = [];
  output.on('data', chunk => shown.push(String(chunk)));
  const approval = reviewPlanInConsole(controller.human, input, output);
  setImmediate(() => input.write(`approve ${view.target}\n`));
  assert.equal(await approval, true);
  assert.equal(controller.human.status().planApproval, controller.human.status().planTarget);
  assert.match(shown.join(''), new RegExp(view.target));
});

test('a revision change while the host prompt is open makes the typed approval stale', async t => {
  const { controller } = fixture(t);
  const planner = controller.bindAgent('planner');
  planner.proposePlan('Plan revision one.');
  const first = controller.human.status();
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  const output = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  output.isTTY = true;
  const approval = reviewPlanInConsole(controller.human, input, output);
  output.once('data', () => {
    planner.proposePlan('Plan revision two.');
    input.write(`approve ${first.target}\n`);
  });
  await assert.rejects(approval, /Stale confirmation/);
  assert.equal(controller.human.status().planApproval, null);
});
