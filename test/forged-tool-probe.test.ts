import test from 'node:test';
import assert from 'node:assert/strict';
import { forgedToolCall, probePreflight, probeVerdict, stripOpenCodeEnvironment } from '../spike/opencode/forged-tool-probe.ts';

test('scripted provider emits exact direct and wrapper control/probe calls', () => {
  assert.deepEqual(forgedToolCall('status-control'), { name: 'harness_status', arguments: '{}' });
  assert.equal(forgedToolCall('hidden-shell').name, 'shell');
  const wrapper = forgedToolCall('wrapper-hidden-shell');
  assert.equal(wrapper.name, 'multi_tool_use.parallel');
  assert.deepEqual(JSON.parse(wrapper.arguments), { tool_uses: [{ recipient_name: 'functions.shell', parameters: { command: 'echo HARNESS_WRAPPER_DENY_PROBE' } }] });
  assert.equal(JSON.parse(forgedToolCall('wrapper-status-control').arguments).tool_uses[0].recipient_name, 'functions.harness_status');
});

test('runtime probe never counts absent execution or missing control as success', () => {
  assert.match(probeVerdict('status-control', [], 'unknown tool'), /inconclusive/);
  assert.match(probeVerdict('hidden-shell', [], ''), /inconclusive/);
  assert.equal(probeVerdict('hidden-shell', [], 'Tool not found'), 'rejection-observed');
  assert.equal(probeVerdict('wrapper-status-control', ['status-executed'], ''), 'wrapper-control-passed');
  assert.match(probeVerdict('wrapper-hidden-shell', ['shell-executed'], 'denied'), /FAILED/);
  assert.equal(probeVerdict('hidden-shell', [], 'Tool is not available for this request: shell'), 'rejection-observed');
  assert.equal(probeVerdict('wrapper-hidden-shell', [], 'No tool named "multi_tool_use.parallel" is currently available.'), 'wrapper-unavailable: recipient enforcement untested');
});

test('adversarial preflight requires executed control, registered canary, and filtered catalog', () => {
  const valid = [{ event: 'status-executed' }, { event: 'registry', tools: ['shell', 'harness_status'] }, { event: 'catalog', tools: ['harness_status'] }];
  assert.equal(probePreflight(valid), true);
  for (let index = 0; index < valid.length; index++) assert.equal(probePreflight(valid.filter((_, i) => i !== index)), false);
  assert.equal(probePreflight([{ event: 'status-executed' }, { event: 'registry', tools: ['shell'] }, { event: 'catalog', tools: ['shell', 'harness_status'] }]), false);
});

test('child runtime cannot inherit the parent OpenCode session or configuration overrides', () => {
  const env = { PATH: 'keep', OPENCODE: 'parent', OPENCODE_SESSION_ID: 'parent-session', opencode_config_content: 'parent-config' };
  assert.deepEqual(stripOpenCodeEnvironment(env), { PATH: 'keep' });
  assert.equal(env.OPENCODE_SESSION_ID, 'parent-session');
});
