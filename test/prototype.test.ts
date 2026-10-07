import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createController } from '../src/controller.ts';
import { agentBoundary } from '../src/agent-boundary.ts';
import { snapshotDirectory } from '../src/snapshot.ts';
import { GateError } from '../src/protocol.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'advanced-harness-test-'));
  const worktree = join(root, 'worktree');
  mkdirSync(worktree);
  writeFileSync(join(worktree, 'app.txt'), 'initial');
  const events: string[] = [];
  const controller = createController({
    database: join(root, 'state.sqlite'), project: root, feature: 'feature-a', worktree,
    snapshot: () => snapshotDirectory(worktree),
    handlers: {
      'edit-code': { input: z.strictObject({ content: z.string() }), async execute(input: unknown) {
        events.push('edit'); const value = z.strictObject({ content: z.string() }).parse(input);
        writeFileSync(join(worktree, 'app.txt'), value.content); return { status: 'passed', summary: 'edited' };
      } },
      review: { input: z.strictObject({}), async execute() { events.push('review'); return { status: 'passed', summary: 'review ok' }; } },
      build: { input: z.strictObject({}), async execute() { events.push('build'); return { status: 'passed', summary: 'build ok' }; } },
      lint: { input: z.strictObject({}), async execute() { events.push('lint'); return { status: 'passed', summary: 'lint ok' }; } },
      'unit-test': { input: z.strictObject({}), async execute() { events.push('unit-test'); return { status: 'passed', summary: 'unit ok' }; } },
      'screenshot-test': { input: z.strictObject({}), async execute() { events.push('screenshot-test'); return { status: 'passed', summary: 'screenshots ok' }; } },
      qa: { input: z.strictObject({}), async execute() { events.push('qa'); return { status: 'passed', summary: 'qa ok' }; } },
      push: { input: z.strictObject({}), async execute() { events.push('push'); return { status: 'passed', summary: 'pushed' }; } },
      'open-pr': { input: z.strictObject({}), async execute() { events.push('open-pr'); return { status: 'passed', summary: 'pr opened' }; } },
    },
  });
  t.after(() => { try { controller.close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  return { root, worktree, events, controller };
}

function request(id: string, action: string, input: object = {}, findings: string[] = []) {
  return { id, action, input, findings };
}
async function rejected(promise: Promise<unknown>, message: RegExp) {
  await assert.rejects(promise, error => error instanceof GateError && message.test(error.message));
}
async function approvePlan(controller: ReturnType<typeof createController>) {
  const planner = controller.bindAgent('planner');
  planner.proposePlan('Implement the approved isolated feature.');
  const status = controller.human.status();
  controller.human.decide({ kind: 'approve-plan', target: status.target });
}
async function verifyAll(controller: ReturnType<typeof createController>) {
  for (const check of ['review', 'build', 'lint', 'unit-test', 'screenshot-test', 'qa'] as const) {
    const role = check === 'qa' ? 'qa' : 'reviewer';
    await controller.bindAgent(role).execute(request(`run-${check}`, check));
  }
}

test('plan gate blocks edits until human approval', async t => {
  const { controller, worktree } = fixture(t);
  controller.bindAgent('planner').proposePlan('Change the isolated app fixture.');
  const implementer = agentBoundary(controller.bindAgent('implementer'));
  await rejected(implementer.dispatch('harness.action', request('unauthorized', 'edit-code', { content: 'no' })), /Plan approval/);
  assert.equal((await import('node:fs')).readFileSync(join(worktree, 'app.txt'), 'utf8'), 'initial');
  const status = controller.human.status();
  controller.human.decide({ kind: 'approve-plan', target: status.target });
  await implementer.dispatch('harness.action', request('authorized', 'edit-code', { content: 'approved' }));
});

test('approved plan enables initial edit and code changes invalidate verification and approvals', async t => {
  const { controller, events } = fixture(t);
  const implementer = controller.bindAgent('implementer');
  await rejected(implementer.execute(request('blocked', 'edit-code', { content: 'no' })), /concrete plan/);
  await approvePlan(controller);
  await implementer.execute(request('first-edit', 'edit-code', { content: 'v1' }));
  await verifyAll(controller);
  const status = controller.human.status();
  controller.human.decide({ kind: 'approve-implementation', target: status.target });
  await rejected(implementer.execute(request('unscoped-edit', 'edit-code', { content: 'v2' })), /accepted finding/);
  assert.equal(events.filter(e => e === 'edit').length, 1);
});

test('wrong agent and generic shell/tool escape attempts are denied', async t => {
  const { controller } = fixture(t);
  await approvePlan(controller);
  const reviewer = agentBoundary(controller.bindAgent('reviewer'));
  await assert.rejects(reviewer.dispatch('harness.action', request('wrong-owner', 'edit-code', { content: 'bad' })), /different agent/);
  await assert.rejects(reviewer.dispatch('shell.execute', { command: 'git push' }), /unavailable/);
  await assert.rejects(reviewer.dispatch('harness.action', { ...request('inject-role', 'review'), role: 'external' }), /Unrecognized key/);
});

test('planner cannot invoke human controls; stale approval and blanket approval are rejected', async t => {
  const { controller } = fixture(t);
  const planner = controller.bindAgent('planner');
  planner.proposePlan('Plan v1');
  const first = controller.human.status();
  const agentSurface = agentBoundary(planner) as unknown as Record<string, (input: unknown) => unknown>;
  assert.equal('decide' in agentSurface, false);
  assert.throws(() => controller.human.decide({ kind: 'approve-everything', target: first.target }), /discriminator/);
  planner.proposePlan('Plan v2');
  assert.throws(() => controller.human.decide({ kind: 'approve-plan', target: first.target }), /Stale confirmation/);
});

test('overrides are gate- and revision-scoped, and incomplete checks block approval', async t => {
  const { controller } = fixture(t);
  await approvePlan(controller);
  await controller.bindAgent('implementer').execute(request('edit', 'edit-code', { content: 'v1' }));
  const status = controller.human.status();
  controller.human.decide({ kind: 'override', target: status.target, gate: 'build', reason: 'Human explicitly waives build for prototype test' });
  assert.throws(() => controller.human.decide({ kind: 'approve-implementation', target: controller.human.status().target }), /review must pass/);
  const reviewer = controller.bindAgent('reviewer');
  await reviewer.execute(request('review', 'review'));
  await rejected(controller.bindAgent('implementer').execute(request('edit-without-finding', 'edit-code', { content: 'v2' })), /accepted finding/);
});

test('accepted feedback permits only scoped fixes, batch decisions bind exact findings', async t => {
  const { controller, events } = fixture(t);
  const external = controller.bindAgent('external');
  external.reportFinding({ id: 'f-1', text: 'Fix the reported issue' });
  const status = controller.human.status();
  assert.throws(() => controller.human.decide({ kind: 'findings', target: status.target,
    entries: [{ id: 'f-1', revision: 1, decision: 'accepted' }, { id: 'future', revision: 1, decision: 'accepted' }] }), /Stale or already/);
  controller.human.decide({ kind: 'findings', target: status.target, entries: [{ id: 'f-1', revision: 1, decision: 'accepted' }] });
  await approvePlan(controller);
  await controller.bindAgent('implementer').execute(request('fix-one', 'edit-code', { content: 'fixed' }, ['f-1']));
  assert.deepEqual(events, ['edit']);
  assert.equal(controller.human.status().findings[0]?.decision, 'fixed');
});

test('approved follow-up fix invalidates all verification and implementation approval', async t => {
  const { controller } = fixture(t);
  await approvePlan(controller);
  const implementer = controller.bindAgent('implementer');
  await implementer.execute(request('initial', 'edit-code', { content: 'initial implementation' }));
  await verifyAll(controller);
  let status = controller.human.status();
  controller.human.decide({ kind: 'approve-implementation', target: status.target });
  controller.bindAgent('external').reportFinding({ id: 'review-fix', text: 'Resolve reviewer feedback' });
  status = controller.human.status();
  controller.human.decide({ kind: 'findings', target: status.target, entries: [{ id: 'review-fix', revision: 1, decision: 'accepted' }] });
  await implementer.execute(request('follow-up-fix', 'edit-code', { content: 'fixed implementation' }, ['review-fix']));
  status = controller.human.status();
  assert.equal(status.implementationApproval, null);
  for (const check of ['review', 'build', 'lint', 'unit-test', 'screenshot-test', 'qa'] as const) assert.equal(status.checks[check], null);
  await rejected(Promise.resolve().then(() => controller.human.decide({ kind: 'approve-implementation', target: status.target })), /review must pass/);
});

test('finding approval is bound to exact target and stale batches fail', async t => {
  const { controller } = fixture(t);
  await approvePlan(controller);
  controller.bindAgent('external').reportFinding({ id: 'one', text: 'First' });
  const status = controller.human.status();
  controller.human.decide({ kind: 'findings', target: status.target, entries: [{ id: 'one', revision: 1, decision: 'discarded' }] });
  controller.bindAgent('reviewer').reportFinding({ id: 'two', text: 'New issue' });
  assert.throws(() => controller.human.decide({ kind: 'findings', target: status.target, entries: [{ id: 'one', revision: 1, decision: 'accepted' }] }), /Stale confirmation/);
});

test('all checks are required before implementation approval, then PR requires push and approved revision', async t => {
  const { controller, events } = fixture(t);
  await approvePlan(controller);
  await controller.bindAgent('implementer').execute(request('edit', 'edit-code', { content: 'ready' }));
  const status = controller.human.status();
  assert.throws(() => controller.human.decide({ kind: 'approve-implementation', target: status.target }), /review must pass/);
  await verifyAll(controller);
  const ready = controller.human.status();
  controller.human.decide({ kind: 'approve-implementation', target: ready.target });
  const external = controller.bindAgent('external');
  await rejected(external.execute(request('pr-too-early', 'open-pr')), /Push the approved revision/);
  await external.execute(request('push', 'push'));
  await external.execute(request('open-pr', 'open-pr'));
  assert.equal(events.at(-1), 'open-pr');
});

test('input validation fails closed and identical completed request replays without duplicate side effect', async t => {
  const { controller, events } = fixture(t);
  await approvePlan(controller);
  const impl = controller.bindAgent('implementer');
  await assert.rejects(impl.execute({ ...request('bad-input', 'edit-code', { content: 'no', extra: true }) }), /Unrecognized key/);
  const edit = request('once', 'edit-code', { content: 'same' });
  await impl.execute(edit);
  assert.deepEqual(await impl.execute(edit), { replayed: true, result: { status: 'passed', summary: 'edited' } });
  assert.equal(events.filter(e => e === 'edit').length, 1);
  await assert.rejects(impl.execute(request('once', 'edit-code', { content: 'different' })), /reused with different input/);
});

test('uncertain remote action requires human reconciliation and resume after restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'advanced-harness-restart-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worktree = join(root, 'worktree'); mkdirSync(worktree); writeFileSync(join(worktree, 'file'), 'v0');
  let fail = true;
  const options = {
    database: join(root, 'state.sqlite'), project: root, feature: 'recovery', worktree,
    snapshot: () => snapshotDirectory(worktree), handlers: {
      'edit-code': { input: z.strictObject({ content: z.string() }), async execute(input: unknown) {
        const { content } = z.strictObject({ content: z.string() }).parse(input);
        writeFileSync(join(worktree, 'file'), content);
        return { status: 'passed' as const, summary: 'edited' };
      } },
      review: { input: z.strictObject({}), async execute() { return { status: 'passed' as const, summary: 'review' }; } },
      build: { input: z.strictObject({}), async execute() { return { status: 'passed' as const, summary: 'build' }; } },
      lint: { input: z.strictObject({}), async execute() { return { status: 'passed' as const, summary: 'lint' }; } },
      'unit-test': { input: z.strictObject({}), async execute() { return { status: 'passed' as const, summary: 'unit' }; } },
      'screenshot-test': { input: z.strictObject({}), async execute() { return { status: 'passed' as const, summary: 'screenshots' }; } },
      qa: { input: z.strictObject({}), async execute() { return { status: 'passed' as const, summary: 'qa' }; } },
      push: { input: z.strictObject({}), async execute() {
        if (fail) throw new Error('network dropped after request');
        return { status: 'passed' as const, summary: 'pushed' };
      } },
    },
  };
  const first = createController(options);
  await approvePlan(first);
  await first.bindAgent('implementer').execute(request('edit-before-push', 'edit-code', { content: 'ready' }));
  await verifyAll(first);
  let current = first.human.status();
  first.human.decide({ kind: 'approve-implementation', target: current.target });
  await assert.rejects(first.bindAgent('external').execute(request('push-one', 'push')), /network dropped/);
  assert.equal(first.human.status().operations['push-one']?.status, 'uncertain');
  first.close();
  const second = createController(options);
  t.after(() => { try { second.close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  const paused = second.human.status();
  assert.ok(paused.paused);
  assert.equal(paused.operations['push-one']?.status, 'uncertain');
  await rejected(second.bindAgent('external').execute(request('push-before-reconcile', 'push')), /paused|reconcile|resume/i);
  second.human.decide({ kind: 'reconcile', target: paused.target, operation: 'push-one', outcome: 'not-completed', reason: 'Confirmed no remote push was created' });
  current = second.human.status();
  second.human.decide({ kind: 'resume', target: current.target });
  fail = false;
  await second.bindAgent('external').execute(request('push-two', 'push'));
  assert.equal(second.human.status().operations['push-two']?.result?.status, 'passed');
  second.close();
});

test('unexpected file mutation during verification fails closed and invalidates evidence', async t => {
  const root = mkdtempSync(join(tmpdir(), 'advanced-harness-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worktree = join(root, 'worktree'); mkdirSync(worktree); writeFileSync(join(worktree, 'file'), 'v0');
  const controller = createController({ database: join(root, 'state.sqlite'), project: root, feature: 'race', worktree,
    snapshot: () => snapshotDirectory(worktree), handlers: { build: { input: z.strictObject({}), async execute() {
      writeFileSync(join(worktree, 'file'), 'mutated'); return { status: 'passed', summary: 'should not be trusted' };
    } } } });
  await approvePlan(controller);
  await assert.rejects(controller.bindAgent('reviewer').execute(request('build-race', 'build')), /reconcile/i);
  assert.ok(controller.human.status().paused);
  assert.equal(controller.human.status().checks.build, null);
  controller.close();
});

test('one active controller per project and operational DB must stay outside the worktree', async t => {
  const { root, worktree, controller } = fixture(t);
  assert.throws(() => createController({ database: join(worktree, 'leak.sqlite'), project: root, feature: 'leak', worktree, snapshot: () => snapshotDirectory(worktree), handlers: {} }), /outside the worktree/);
  assert.throws(() => createController({ database: join(root, 'state.sqlite'), project: root, feature: 'feature-b', worktree, snapshot: () => snapshotDirectory(worktree), handlers: {} }), /Another feature is active/);
  // Existing controller remains usable after rejected acquisitions.
  assert.equal(controller.human.status().feature, 'feature-a');
});
