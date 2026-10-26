import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadRoleDefinitions } from '../src/role-definitions.ts';
import {
  compileAntigravitySubagentSpec,
  compileLeadOrchestrationRule,
  compileAntigravityHooks,
  compileAntigravityMcpConfig,
} from '../src/antigravity-compiler.ts';

const rolesDir = fileURLToPath(new URL('../agents/', import.meta.url));
const roles = loadRoleDefinitions(rolesDir);

test('compileAntigravitySubagentSpec maps each role to correct tool groups and model tiers', () => {
  const operator = compileAntigravitySubagentSpec('operator', roles.operator);
  assert.equal(operator.enableWriteTools, true);
  assert.equal(operator.enableMCPTools, false);
  assert.equal(operator.model, 'flash_lite');

  const external = compileAntigravitySubagentSpec('external', roles.external);
  assert.equal(external.enableWriteTools, false);
  assert.equal(external.enableMCPTools, true);
  assert.equal(external.model, 'flash_lite');

  const implementer = compileAntigravitySubagentSpec('implementer', roles.implementer);
  assert.equal(implementer.enableWriteTools, true);
  assert.equal(implementer.enableMCPTools, false);
  assert.equal(implementer.model, 'flash');

  const reviewer = compileAntigravitySubagentSpec('reviewer', roles.reviewer);
  assert.equal(reviewer.enableWriteTools, false);
  assert.equal(reviewer.enableMCPTools, false);
  assert.equal(reviewer.model, 'pro');

  const planner = compileAntigravitySubagentSpec('planner', roles.planner);
  assert.equal(planner.enableWriteTools, false);
  assert.equal(planner.enableMCPTools, false);
  assert.equal(planner.model, 'pro');

  const qa = compileAntigravitySubagentSpec('qa', roles.qa);
  assert.equal(qa.enableWriteTools, false);
  assert.equal(qa.enableMCPTools, false);
  assert.equal(qa.model, 'flash');

  const researcher = compileAntigravitySubagentSpec('researcher', roles.researcher);
  assert.equal(researcher.enableWriteTools, false);
  assert.equal(researcher.enableMCPTools, false);
  assert.equal(researcher.model, 'flash');
});

test('compileLeadOrchestrationRule generates valid rule conforming to 24KB limit', () => {
  const rule = compileLeadOrchestrationRule(roles);
  assert.equal(rule.path, '.agents/rules/advanced-harness-lead.md');
  assert.ok(rule.content.includes('Lead Orchestrator Rule'));
  assert.ok(rule.content.includes('define_subagent'));
  assert.ok(rule.content.includes('external'));
  assert.ok(rule.content.includes('operator'));
  assert.ok(rule.content.includes('implementer'));

  const byteLength = Buffer.byteLength(rule.content, 'utf8');
  assert.ok(byteLength <= 24000, `Lead rule must be <= 24,000 bytes, got ${byteLength}`);
});

test('compileAntigravityHooks configures PreToolUse gh pr merge guard', () => {
  const hooks = compileAntigravityHooks('scripts/antigravity-merge-guard.ts');
  assert.ok(hooks['gh-pr-merge-guard']);
  assert.equal(hooks['gh-pr-merge-guard'].enabled, true);
  assert.ok(hooks['gh-pr-merge-guard'].PreToolUse);
  const preToolUse = hooks['gh-pr-merge-guard'].PreToolUse;
  assert.ok(preToolUse);
  const firstHook = preToolUse[0];
  assert.ok(firstHook);
  assert.equal(firstHook.matcher, 'run_command');
  assert.ok(firstHook.hooks[0]?.command.includes('antigravity-merge-guard.ts'));
});

test('compileAntigravityMcpConfig structures servers map without inventing values', () => {
  const mcp = compileAntigravityMcpConfig({
    jira: { url: 'https://jira.example.com/mcp' },
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
  });
  assert.ok(mcp.mcpServers.jira);
  assert.equal(mcp.mcpServers.jira.url, 'https://jira.example.com/mcp');
  assert.ok(mcp.mcpServers.github);
  assert.deepEqual(mcp.mcpServers.github.args, ['-y', '@modelcontextprotocol/server-github']);
});
