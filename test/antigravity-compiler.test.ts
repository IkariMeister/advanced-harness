import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadRoleDefinitions } from '../src/role-definitions.ts';
import { loadWorkflowCommands } from '../src/workflow-commands.ts';
import {
  compileAntigravitySubagentSpec,
  compileLeadOrchestrationRule,
  compileAntigravityHooks,
  compileAntigravityMcpConfig,
  compileAntigravitySkill,
  mergeAntigravityHooksConfig,
  mergeAntigravityMcpConfig,
  getAntigravityMergeGuardMjsSource,
} from '../src/antigravity-compiler.ts';

const rolesDir = fileURLToPath(new URL('../agents/', import.meta.url));
const commandsDir = fileURLToPath(new URL('../commands/', import.meta.url));
const roles = loadRoleDefinitions(rolesDir);
const commands = loadWorkflowCommands(commandsDir);

test('compileAntigravitySubagentSpec maps each role to correct tool groups and model tiers', () => {
  const operator = compileAntigravitySubagentSpec('operator', roles.operator);
  assert.equal(operator.enableWriteTools, true);
  assert.equal(operator.enableMCPTools, false);
  assert.equal(operator.model, 'flash_lite');

  const external = compileAntigravitySubagentSpec('external', roles.external);
  assert.equal(external.enableWriteTools, true);
  assert.equal(external.enableMCPTools, true);
  assert.equal(external.model, 'flash_lite');

  const implementer = compileAntigravitySubagentSpec('implementer', roles.implementer);
  assert.equal(implementer.enableWriteTools, true);
  assert.equal(implementer.enableMCPTools, false);
  assert.equal(implementer.model, 'flash');

  const reviewer = compileAntigravitySubagentSpec('reviewer', roles.reviewer);
  assert.equal(reviewer.enableWriteTools, true);
  assert.equal(reviewer.enableMCPTools, false);
  assert.equal(reviewer.model, 'pro');

  const planner = compileAntigravitySubagentSpec('planner', roles.planner);
  assert.equal(planner.enableWriteTools, false);
  assert.equal(planner.enableMCPTools, false);
  assert.equal(planner.model, 'pro');

  const qa = compileAntigravitySubagentSpec('qa', roles.qa);
  assert.equal(qa.enableWriteTools, true);
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

test('compileLeadOrchestrationRule grants command-running roles write tools with edit restrictions', () => {
  const rule = compileLeadOrchestrationRule(roles);
  const writeToolsFor = (role: string) => {
    const row = rule.content.split('\n').find(line => line.startsWith(`| **${role}** |`));
    assert.ok(row, `missing table row for ${role}`);
    return row.split('|')[3]?.trim();
  };

  assert.equal(writeToolsFor('external'), 'true');
  assert.equal(writeToolsFor('reviewer'), 'true');
  assert.equal(writeToolsFor('qa'), 'true');
  assert.equal(writeToolsFor('researcher'), 'false');
  assert.equal(writeToolsFor('planner'), 'false');
  assert.ok(rule.content.includes('Write Tools (edits + `run_command`)'));
  assert.match(rule.content, /External, Reviewer, and QA have write tools enabled only so they can run commands; they must never use file-edit tools/);
});

test('compileLeadOrchestrationRule tells Lead to reuse existing subagent definitions', () => {
  const rule = compileLeadOrchestrationRule(roles);
  assert.ok(rule.content.includes('## Subagent Definition Lifecycle'));
  assert.match(rule.content, /already exists, do not retry it; invoke the existing child with `invoke_subagent`/);
  assert.match(rule.content, /does not match the table above .* Stop and ask the human to start a fresh session/);
});

test('compileAntigravityHooks configures PreToolUse gh pr merge guard', () => {
  const hooks = compileAntigravityHooks('/path/to/antigravity-merge-guard.mjs');
  assert.ok(hooks['gh-pr-merge-guard']);
  assert.equal(hooks['gh-pr-merge-guard'].enabled, true);
  assert.ok(hooks['gh-pr-merge-guard'].PreToolUse);
  const preToolUse = hooks['gh-pr-merge-guard'].PreToolUse;
  assert.ok(preToolUse);
  const firstHook = preToolUse[0];
  assert.ok(firstHook);
  assert.equal(firstHook.matcher, 'run_command');
  assert.ok(firstHook.hooks[0]?.command.includes('antigravity-merge-guard.mjs'));
});

test('compileAntigravityHooks leaves the guard path unquoted so Windows hosts can resolve it (#94)', () => {
  const windowsPath = 'C:\\Users\\dev\\.gemini\\config\\scripts\\antigravity-merge-guard.mjs';
  const hooks = compileAntigravityHooks(windowsPath, 'win32');
  assert.equal(hooks['gh-pr-merge-guard']?.PreToolUse?.[0]?.hooks[0]?.command, `node ${windowsPath}`);

  const posixPath = '/home/dev/.gemini/config/scripts/antigravity-merge-guard.mjs';
  assert.equal(compileAntigravityHooks(posixPath, 'linux')['gh-pr-merge-guard']?.PreToolUse?.[0]?.hooks[0]?.command, `node ${posixPath}`);
});

test('compileAntigravityHooks rejects whitespace guard paths on Windows and keeps quoting elsewhere', () => {
  const spaced = 'C:\\Users\\Jane Doe\\.gemini\\config\\scripts\\antigravity-merge-guard.mjs';
  assert.throws(() => compileAntigravityHooks(spaced, 'win32'), /path contains whitespace.*no spaces/s);
  assert.throws(() => mergeAntigravityHooksConfig(undefined, spaced, undefined, 'win32'), /path contains whitespace/);

  const posixSpaced = '/home/jane/My Projects/app/.agents/scripts/antigravity-merge-guard.mjs';
  assert.equal(compileAntigravityHooks(posixSpaced, 'linux')['gh-pr-merge-guard']?.PreToolUse?.[0]?.hooks[0]?.command, `node "${posixSpaced}"`);
});

test('mergeAntigravityHooksConfig upgrades the legacy quoted guard without prior ownership evidence', () => {
  const guardPath = 'C:\\Users\\dev\\.gemini\\config\\scripts\\antigravity-merge-guard.mjs';
  const legacy = JSON.stringify({
    'other-hook': { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './check.sh' }] }] },
    'gh-pr-merge-guard': {
      enabled: true,
      PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: `node "${guardPath}"`, timeout: 10 }] }],
    },
  });

  const merged = mergeAntigravityHooksConfig(legacy, guardPath, undefined, 'win32');
  assert.equal(merged['gh-pr-merge-guard']?.PreToolUse?.[0]?.hooks[0]?.command, `node ${guardPath}`);
  assert.ok(merged['other-hook']);

  // A quoted command for a different script is still an unowned conflict
  const foreign = legacy.replace('antigravity-merge-guard.mjs', 'someone-else.mjs');
  assert.throws(() => mergeAntigravityHooksConfig(foreign, guardPath, undefined, 'win32'), /Conflicting unowned "gh-pr-merge-guard"/);
});

test('compileAntigravitySkill generates reusable skill without placeholder arguments', () => {
  const startIssue = compileAntigravitySkill('start-issue', commands['start-issue'], 'project');
  assert.equal(startIssue.relativePath, '.agents/skills/start-issue/SKILL.md');
  assert.ok(startIssue.content.includes('name: start-issue'));
  assert.ok(startIssue.content.includes('user\'s current chat invocation prompt'));
  assert.ok(!startIssue.content.includes('$ARGUMENTS'));
  assert.ok(!startIssue.content.includes('workflow instructions'));

  const defect = compileAntigravitySkill('report-defect', commands['report-defect'], 'global');
  assert.equal(defect.relativePath, 'skills/report-defect/SKILL.md');
  assert.ok(defect.content.includes('name: report-defect'));
  assert.ok(defect.content.includes('parent issue key/URL'));
  assert.ok(!defect.content.includes('$1'));
  assert.ok(!defect.content.includes('$2'));
  assert.ok(!defect.content.includes('issue-id'));
});

test('mergeAntigravityHooksConfig preserves unrelated hooks and rejects malformed JSON', () => {
  const existing = JSON.stringify({
    'lint-checker': {
      PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './scripts/lint.sh' }] }],
    },
  }, null, 2);

  const merged = mergeAntigravityHooksConfig(existing, '/path/to/guard.mjs');
  assert.ok(merged['lint-checker']);
  assert.ok(merged['gh-pr-merge-guard']);

  // Malformed JSON throws
  assert.throws(() => mergeAntigravityHooksConfig('{ bad json', '/path/to/guard.mjs'), /Malformed existing hooks\.json/);

  // Conflicting unowned definition throws even if matcher is run_command
  const conflictCustomCommand = JSON.stringify({
    'gh-pr-merge-guard': {
      PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './custom-script.sh' }] }],
    },
  });
  assert.throws(
    () => mergeAntigravityHooksConfig(conflictCustomCommand, '/path/to/guard.mjs'),
    /Conflicting unowned "gh-pr-merge-guard"/
  );

  // Disabled unowned definition throws
  const conflictDisabled = JSON.stringify({
    'gh-pr-merge-guard': {
      enabled: false,
      PreToolUse: [],
    },
  });
  assert.throws(
    () => mergeAntigravityHooksConfig(conflictDisabled, '/path/to/guard.mjs'),
    /Conflicting unowned "gh-pr-merge-guard"/
  );

  // Updating an attributable receipt-owned definition succeeds
  const priorOwned = compileAntigravityHooks('/old/path/guard.mjs');
  const priorOwnedText = JSON.stringify(priorOwned, null, 2);
  const updatedFromPrior = mergeAntigravityHooksConfig(priorOwnedText, '/new/path/guard.mjs', priorOwnedText);
  const guard = updatedFromPrior['gh-pr-merge-guard'];
  assert.ok(guard && guard.PreToolUse && guard.PreToolUse[0]?.hooks[0]?.command.includes('/new/path/guard.mjs'));
});

test('mergeAntigravityMcpConfig preserves unrelated servers and top-level fields', () => {
  const existing = JSON.stringify({
    customTopLevel: true,
    mcpServers: {
      customServer: { command: 'node', args: ['server.js'] },
    },
  }, null, 2);

  const merged = mergeAntigravityMcpConfig(existing, {
    newServer: { url: 'https://example.com/mcp' },
  });

  assert.equal((merged as any).customTopLevel, true);
  assert.ok(merged.mcpServers.customServer);
  assert.ok(merged.mcpServers.newServer);

  // Malformed JSON throws
  assert.throws(() => mergeAntigravityMcpConfig('{ bad json'), /Malformed existing mcp_config\.json/);
});
