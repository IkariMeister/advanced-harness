import test from 'node:test';
import assert from 'node:assert/strict';
import { filterHostTools, hostAgentRoles, hostToolNames, hostToolOptions, isHostAgentRole } from '../spike/opencode/host-adapter-policy.ts';
import { roles } from '../src/protocol.ts';

const adversarialCatalog = () => Object.fromEntries([
  hostToolNames.status, hostToolNames.action, hostToolNames.proposePlan, hostToolNames.reportFinding,
  'shell', 'edit', 'write', 'subagent', 'execute', 'jira_search', 'human_approve', 'harness_decide',
].map(name => [name, {}]));

test('OpenCode adapter gives Planner only status and plan proposal tools', () => {
  const tools = adversarialCatalog();
  filterHostTools('planner', tools);
  assert.deepEqual(Object.keys(tools).sort(), [hostToolNames.proposePlan, hostToolNames.status].sort());
});

test('OpenCode adapter gives Implementer no approval or alternate execution tools', () => {
  const tools = adversarialCatalog();
  filterHostTools('implementer', tools);
  assert.deepEqual(Object.keys(tools).sort(), [hostToolNames.action, hostToolNames.status].sort());
});

test('Lead can delegate but has no direct action, shell, or human-control tools', () => {
  const tools = adversarialCatalog();
  filterHostTools('lead', tools);
  assert.deepEqual(Object.keys(tools).sort(), ['harness_status', 'subagent'].sort());
});

test('review and external roles get finding reporting; unknown roles fail closed', () => {
  const reviewer = adversarialCatalog();
  filterHostTools('reviewer', reviewer);
  assert.deepEqual(Object.keys(reviewer).sort(), [hostToolNames.action, hostToolNames.reportFinding, hostToolNames.status].sort());

  const unknown = adversarialCatalog();
  filterHostTools('unrecognized-role', unknown);
  assert.deepEqual(Object.keys(unknown), [hostToolNames.status]);
  assert.equal(isHostAgentRole('unrecognized-role'), false);
});

test('OpenCode adapter role IDs stay aligned with the controller role map', () => {
  assert.deepEqual([...hostAgentRoles], [...roles]);
});

test('host tools use ordinary function mode so context filtering can enforce roles', () => {
  for (const name of Object.values(hostToolNames)) {
    assert.deepEqual(hostToolOptions(name), { permission: name, codemode: false });
  }
});
