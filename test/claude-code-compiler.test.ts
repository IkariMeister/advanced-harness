import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { loadRoleDefinitions } from '../src/role-definitions.ts';
import { nativeRoles } from '../src/native-role-types.ts';
import { HOST_MODEL_PRESETS } from '../src/host-registry.ts';
import {
  claudeChildRoles,
  claudeDisclosures,
  claudeManagedTools,
  claudeSettingsAsk,
  claudeSettingsDeny,
  compileClaudeLeadBlock,
  compileClaudeSubagentFile,
  mapClaudeRolePolicy,
  mappingsFor,
  mergeClaudeMemory,
  mergeClaudeSettings,
} from '../src/claude-code-compiler.ts';

const agentsDirectory = fileURLToPath(new URL('../agents/', import.meta.url));
const definitions = loadRoleDefinitions(agentsDirectory);
const mappings = mappingsFor(definitions);

function frontmatter(text: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, 'frontmatter present');
  return parseYaml(match[1]!) as Record<string, unknown>;
}

const toolNames = (role: string) => mappings[role as keyof typeof mappings].tools.map(tool => tool.replace(/\(.*$/, ''));

test('lead receives only read, question, and exact child delegation; no edit or shell', () => {
  assert.deepEqual(mappings.lead.tools, ['Read', 'Glob', 'Grep', 'AskUserQuestion', 'Agent(operator, external, researcher, planner, implementer, reviewer, qa)']);
  assert.deepEqual(mappings.lead.disallowedTools, ['Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch']);
});

test('child roles cannot spawn agents and receive only their mapped tools', () => {
  for (const role of claudeChildRoles) {
    assert.ok(mappings[role].disallowedTools.includes('Agent'), role);
    assert.ok(!mappings[role].tools.some(tool => tool.startsWith('Agent')), role);
  }
  assert.deepEqual(mappings.researcher.tools, ['Read', 'Glob', 'Grep']);
  assert.deepEqual(mappings.planner.tools, ['Read', 'Glob', 'Grep']);
  assert.deepEqual(mappings.operator.tools, ['Read', 'Glob', 'Grep', 'Edit', 'Write']);
  assert.deepEqual(mappings.implementer.tools, ['Read', 'Glob', 'Grep', 'Edit', 'Write']);
});

test('Bash is withheld wherever per-role git/gh deny patterns cannot be scoped; External keeps prompted Bash', () => {
  for (const role of ['operator', 'implementer', 'reviewer', 'qa'] as const) {
    assert.ok(!toolNames(role).includes('Bash'), role);
    assert.ok(mappings[role].disallowedTools.includes('Bash'), role);
    assert.ok(mappings[role].unsupported.some(line => line.includes('cannot be scoped per role')), role);
  }
  assert.ok(toolNames('external').includes('Bash'));
  assert.ok(!mappings.external.tools.some(tool => tool.startsWith('Edit') || tool === 'Write'));
});

test('no Claude role receives MCP or Code Mode identities; they are reported as unsupported', () => {
  for (const role of nativeRoles) {
    assert.ok(mappings[role].tools.every(tool => !tool.startsWith('mcp__')), role);
  }
  assert.ok(mappings.external.unsupported.some(line => /mcp\.tool/.test(line)));
  assert.ok(mappings.external.unsupported.some(line => /code-mode\.execute/.test(line)));
  assert.ok(claudeDisclosures(mappings).some(line => /external: mcp\.tool/.test(line)));
});

test('tools and disallowed tools form a complete, non-overlapping partition for every role', () => {
  for (const role of nativeRoles) {
    const allowed = new Set(toolNames(role));
    for (const denied of mappings[role].disallowedTools) assert.ok(!allowed.has(denied), `${role} ${denied}`);
    for (const tool of claudeManagedTools) {
      assert.ok(allowed.has(tool) || mappings[role].disallowedTools.includes(tool), `${role} ${tool}`);
    }
  }
});

test('no generated disallowedTools uses a Bash(pattern) specifier, which would remove the whole Bash tool', () => {
  for (const role of nativeRoles) assert.ok(mappings[role].disallowedTools.every(tool => !tool.includes('(')), role);
});

test('compiled subagent frontmatter is valid and uses the README model presets', () => {
  const expectedModels = { lead: 'sonnet', operator: 'haiku', external: 'haiku', researcher: 'sonnet', planner: 'opus', implementer: 'sonnet', reviewer: 'opus', qa: 'sonnet' };
  for (const role of nativeRoles) {
    const text = compileClaudeSubagentFile(role, definitions[role], mappings[role]);
    const meta = frontmatter(text);
    assert.equal(meta.name, role);
    assert.equal(meta.model, expectedModels[role]);
    assert.equal(meta.model, HOST_MODEL_PRESETS['claude-code'][role].model);
    assert.equal(typeof meta.description, 'string');
    assert.equal(meta.tools, mappings[role].tools.join(', '));
    if (mappings[role].disallowedTools.length) assert.equal(meta.disallowedTools, mappings[role].disallowedTools.join(', '));
    assert.ok(text.includes(definitions[role].instructions.trim()));
  }
});

test('settings merge adds lead, gh pr merge denies, and .env ask rules while preserving unrelated content', () => {
  const merged = JSON.parse(mergeClaudeSettings(JSON.stringify({ model: 'opus', permissions: { allow: ['Read(./docs/**)'], deny: ['Bash(rm -rf *)'] } })));
  assert.equal(merged.model, 'opus');
  assert.equal(merged.agent, 'lead');
  assert.deepEqual(merged.permissions.allow, ['Read(./docs/**)']);
  assert.deepEqual(merged.permissions.deny, ['Bash(rm -rf *)', ...claudeSettingsDeny]);
  assert.deepEqual(merged.permissions.ask, [...claudeSettingsAsk]);
  for (const rule of ['Bash(gh pr merge)', 'Bash(gh pr merge *)', 'Bash(gh.exe pr merge)', 'Bash(gh.exe pr merge *)']) assert.ok(merged.permissions.deny.includes(rule));
});

test('settings merge is idempotent and creates a fresh file when absent', () => {
  const first = mergeClaudeSettings(undefined);
  assert.equal(mergeClaudeSettings(first), first);
  assert.equal(JSON.parse(first).agent, 'lead');
});

test('settings merge refuses invalid JSON, non-object roots, and a different default agent without changing input', () => {
  assert.throws(() => mergeClaudeSettings('{ // comment\n}'), /not strict JSON/);
  assert.throws(() => mergeClaudeSettings('[]'), /root must be a JSON object/);
  assert.throws(() => mergeClaudeSettings('{"agent":"other"}'), /different default agent/);
  assert.throws(() => mergeClaudeSettings('{"permissions":[]}'), /permissions must be a JSON object/);
});

test('CLAUDE.md is created with the marked block and @AGENTS.md reference', () => {
  const block = compileClaudeLeadBlock(mappings);
  const created = mergeClaudeMemory(undefined, block);
  assert.match(created, /^<!-- advanced-harness:lead:start -->\n## Advanced Harness Lead orchestration/);
  assert.match(created, /<!-- advanced-harness:lead:end -->\n\n@AGENTS\.md\n$/);
  assert.match(created, /MCP service aliases/);
  assert.equal(mergeClaudeMemory(created, block), created);
});

test('CLAUDE.md merge preserves user content, replaces only the managed block, and appends a missing reference', () => {
  const block = compileClaudeLeadBlock(mappings);
  const existing = '# My notes\n\nKeep this.\n\n<!-- advanced-harness:lead:start -->\nold\n<!-- advanced-harness:lead:end -->\n\nTail note\n';
  const merged = mergeClaudeMemory(existing, block);
  assert.ok(merged.startsWith('# My notes\n\nKeep this.\n\n<!-- advanced-harness:lead:start -->'));
  assert.ok(!merged.includes('\nold\n'));
  assert.ok(merged.includes('Tail note'));
  assert.ok(merged.split('\n').some(line => line.trim() === '@AGENTS.md'));
  assert.equal(mergeClaudeMemory(merged, block), merged);
});

test('CLAUDE.md merge refuses malformed or duplicate markers', () => {
  const block = compileClaudeLeadBlock(mappings);
  assert.throws(() => mergeClaudeMemory('<!-- advanced-harness:lead:start -->\nno end', block), /malformed or duplicate/);
  const twice = '<!-- advanced-harness:lead:start -->\na\n<!-- advanced-harness:lead:end -->\n<!-- advanced-harness:lead:start -->\nb\n<!-- advanced-harness:lead:end -->\n';
  assert.throws(() => mergeClaudeMemory(twice, block), /malformed or duplicate/);
  const reversed = '<!-- advanced-harness:lead:end -->\n<!-- advanced-harness:lead:start -->\n';
  assert.throws(() => mergeClaudeMemory(reversed, block), /out of order/);
});

test('mapping is a pure function of the policy and never mutates role definitions', () => {
  const before = JSON.stringify(definitions);
  for (const role of nativeRoles) mapClaudeRolePolicy(role, definitions[role].deployment.opencode.policy);
  assert.equal(JSON.stringify(definitions), before);
});
