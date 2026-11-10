import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { loadRoleDefinitions } from '../src/role-definitions.ts';
import { nativeRoles } from '../src/native-role-types.ts';
import { HOST_MODEL_PRESETS } from '../src/host-registry.ts';
import {
  claudeAdvisories,
  claudeChildRoles,
  claudeDisclosures,
  claudeManagedTools,
  claudeOperatorShellDenies,
  claudeSettingsAsk,
  claudeSettingsDeny,
  compileClaudeLeadBlock,
  compileClaudeSubagentFile,
  mapClaudeRolePolicy,
  mappingsFor,
  mergeClaudeMemory,
  mergeClaudeSettings,
} from '../src/claude-code-compiler.ts';
import type { CapabilityPolicy, CapabilityRule } from '../src/capability-policy.ts';

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
  assert.deepEqual(mappings.operator.tools, ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
  assert.deepEqual(mappings.implementer.tools, ['Read', 'Glob', 'Grep', 'Edit', 'Write']);
});

test('Bash is withheld for Implementer, Reviewer, and QA, where per-role git/gh deny patterns cannot be scoped; External keeps prompted Bash', () => {
  for (const role of ['implementer', 'reviewer', 'qa'] as const) {
    assert.ok(!toolNames(role).includes('Bash'), role);
    assert.ok(mappings[role].disallowedTools.includes('Bash'), role);
    assert.ok(mappings[role].unsupported.some(line => line.includes('cannot be scoped per role')), role);
  }
  assert.ok(toolNames('external').includes('Bash'));
  assert.ok(!mappings.external.tools.some(tool => tool.startsWith('Edit') || tool === 'Write'));
  assert.ok(!toolNames('lead').includes('Bash'));
});

test('Operator has Bash through the listed exception: fetch denies are project settings, remote Git and gh denies are advisory', () => {
  assert.ok(!mappings.operator.disallowedTools.includes('Bash'));
  assert.ok(!mappings.operator.unsupported.some(line => line.includes('shell.run')), 'no shell.run line is unsupported for Operator');
  assert.deepEqual(mappings.operator.advisory.map(line => /shell "([^"]+)"/.exec(line)?.[1]), ['git push *', 'git pull *', 'git clone *', 'gh *']);
  assert.equal(claudeAdvisories(mappings).length, 4);
  const promoted = mappings.operator.mapped.filter(line => line.includes('is enforced by project settings (Bash(git fetch'));
  assert.equal(promoted.length, 3);
  for (const pattern of ['git fetch *--upl*', 'git fetch -u*', 'git fetch * -u*']) assert.ok(promoted.some(line => line.includes(`shell "${pattern}" deny`)), pattern);
});

test('project settings deny the Operator fetch upload-pack and -u forms for every session, and not the advisory remote Git or gh patterns', () => {
  for (const rule of ['Bash(git fetch *--upl*)', 'Bash(git fetch -u*)', 'Bash(git fetch * -u*)']) assert.ok(claudeSettingsDeny.includes(rule), rule);
  for (const rule of ['Bash(gh *)', 'Bash(git push *)', 'Bash(git pull *)', 'Bash(git clone *)']) assert.ok(!claudeSettingsDeny.includes(rule), rule);
});

test('the Operator exception is closed: unlisted denies, other roles, and a different base shell effect still withhold Bash', () => {
  const base: CapabilityPolicy = definitions.operator.deployment.opencode.policy;
  const withRule = (rule: CapabilityRule): CapabilityPolicy => ({ ...base, rules: [...base.rules, rule] });
  const shellDeny = (value: string): CapabilityRule => ({ capability: 'shell.run', resource: { kind: 'native-pattern', host: 'opencode', value }, effect: 'deny', binding: { host: 'opencode', action: 'shell' } });
  const unlisted = mapClaudeRolePolicy('operator', withRule(shellDeny('git rebase *')));
  assert.ok(!unlisted.tools.includes('Bash'), 'unlisted deny');
  assert.deepEqual(unlisted.advisory, [], 'withheld Bash discloses no advisory exception line');
  assert.ok(!unlisted.mapped.some(line => line.includes('is enforced by project settings (Bash(git fetch')), 'withheld Bash discloses no promoted fetch line');
  assert.ok(!mapClaudeRolePolicy('implementer', base).tools.includes('Bash'), 'Operator policy mapped as implementer');
  assert.ok(!mapClaudeRolePolicy('operator', withRule({ capability: 'shell.run', resource: { kind: 'all' }, effect: 'allow', binding: { host: 'opencode', action: 'shell' } })).tools.includes('Bash'), 'base shell allow');
});

test('the Operator exception needs the full listed deny set: removing any listed deny withholds Bash, reports it unsupported, and discloses no exception lines', () => {
  const base: CapabilityPolicy = definitions.operator.deployment.opencode.policy;
  for (const listed of Object.keys(claudeOperatorShellDenies)) {
    const withoutListed = { ...base, rules: base.rules.filter(rule => !(rule.resource.kind === 'native-pattern' && rule.resource.value === listed)) };
    const mapping = mapClaudeRolePolicy('operator', withoutListed);
    assert.ok(!mapping.tools.includes('Bash'), `${listed}: Bash withheld`);
    assert.ok(mapping.disallowedTools.includes('Bash'), `${listed}: Bash disallowed`);
    assert.ok(mapping.unsupported.some(line => line.includes('no longer match the ADR-005 exception list') && line.includes(listed)), `${listed}: unsupported line`);
    assert.deepEqual(mapping.advisory, [], `${listed}: advisory empty`);
    assert.ok(!mapping.mapped.some(line => line.includes('is enforced by project settings (Bash(git fetch')), `${listed}: no promoted fetch line`);
  }
});

test('Lead block states the Operator advisory denies and the roles without Bash', () => {
  const block = compileClaudeLeadBlock(mappings);
  assert.ok(block.includes('Implementer, Reviewer, and QA have no Bash tool'));
  assert.ok(!block.includes('Operator, Implementer, Reviewer, and QA have no Bash'));
  assert.ok(block.includes('its `git push`, `git pull`, `git clone`, and `gh` denies are advisory, not enforced'));
  assert.ok(block.includes('| `operator` | `haiku` | Read, Glob, Grep, Edit, Write, Bash |'));
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
  const reviewerFile = compileClaudeSubagentFile('reviewer', definitions.reviewer, mappings.reviewer);
  assert.match(reviewerFile, /\*\*re-run\*\* versus \*\*judged from evidence only\*\*/);
  assert.match(reviewerFile, /Where the host withholds command execution from Reviewer \(for example Claude\s+Code\)/);
  assert.match(compileClaudeSubagentFile('planner', definitions.planner, mappings.planner), /Author and maintain architectural decision records \(ADRs\)/);
  assert.match(compileClaudeSubagentFile('implementer', definitions.implementer, mappings.implementer), /affected implementation documentation/);
  assert.match(compileClaudeSubagentFile('lead', definitions.lead, mappings.lead), /Track\s+the documentation requirement and approval state/);
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
