import test from 'node:test';
import assert from 'node:assert/strict';
import { filterToolCatalog, harnessToolNames, roleMayUseAction } from '../spike/opencode/policy.ts';
import { ApprovalChallenges } from '../spike/opencode/challenge.ts';

test('per-agent catalog removes shell, MCP, execute, filesystem writes, and unassigned agent actions', () => {
  const catalog: Record<string, unknown> = Object.fromEntries([
    'read', 'glob', 'grep', 'shell', 'edit', 'write', 'patch', 'execute', 'subagent',
    'jira_searchIssue', 'figma_getFile', harnessToolNames.status, harnessToolNames.propose, harnessToolNames.apply,
  ].map(name => [name, {}]));

  filterToolCatalog('planner', catalog);
  assert.deepEqual(Object.keys(catalog).sort(), [
    'glob', 'grep', 'harness_demo_propose', 'harness_demo_status', 'read',
  ]);
});

test('unknown agents fail closed and cannot see even the ordinary project tools', () => {
  const catalog: Record<string, unknown> = { shell: {}, read: {}, [harnessToolNames.status]: {}, [harnessToolNames.apply]: {} };
  filterToolCatalog('unrecognized-agent', catalog);
  assert.deepEqual(Object.keys(catalog), [harnessToolNames.status]);
});

test('role ownership is checked independently of tool visibility', () => {
  assert.equal(roleMayUseAction('planner', harnessToolNames.propose), true);
  assert.equal(roleMayUseAction('implementer', harnessToolNames.propose), false);
  assert.equal(roleMayUseAction(undefined, harnessToolNames.apply), false);
  assert.equal(roleMayUseAction('qa', harnessToolNames.status), true);
  assert.equal(roleMayUseAction('lead', 'harness_future_admin_tool'), false);
});

test('approval challenge is revision-bound, expires, and can only be consumed once', () => {
  let now = 1_000;
  const challenges = new ApprovalChallenges(() => now, 50, 3);
  const nonce = challenges.issue('plan-A');
  assert.equal(challenges.consume('plan-B', nonce), false);
  assert.equal(challenges.consume('plan-A', nonce), false, 'wrong-target attempt burns the one-time nonce');
  const valid = challenges.issue('plan-A');
  assert.equal(challenges.consume('plan-A', valid), true);
  assert.equal(challenges.consume('plan-A', valid), false, 'replay rejected');
  const expired = challenges.issue('plan-A');
  now += 50;
  assert.equal(challenges.consume('plan-A', expired), false, 'expiry boundary is closed');
});
