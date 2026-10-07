import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roles } from '../src/protocol.ts';

const models = {
  lead: 'openai/gpt-6-astra#medium',
  operator: 'openai/gpt-5.3-codex-spark#low',
  external: 'openai/gpt-5.3-codex-spark#low',
  researcher: 'openai/gpt-6-luna#medium',
  planner: 'openai/gpt-6.1-sol#medium',
  implementer: 'openai/gpt-6-luna#low',
  reviewer: 'openai/gpt-6.1-sol#low',
  qa: 'openai/gpt-6-luna#low',
} as const;

test('Markdown agent templates preserve fixed models and deny before role exceptions', () => {
  for (const role of roles) {
    const text = readFileSync(new URL(`../spike/opencode/agents/${role}.md`, import.meta.url), 'utf8');
    assert.ok(text.includes(`model: ${models[role]}\n`), role);
    assert.ok(text.includes(`mode: ${role === 'lead' ? 'primary' : 'subagent'}\n`), role);
    assert.match(text, /permissions:\n  - \{ action: "\*", resource: "\*", effect: deny \}/);
    const allowLines = text.split('\n').filter(line => line.includes('effect: allow'));
    for (const line of allowLines) {
      assert.match(line, /action: (harness_status|harness_action|harness_propose_plan|harness_report_finding|subagent|read),/);
      if (line.includes('action: subagent')) assert.equal(role, 'lead');
      if (line.includes('action: read')) {
        assert.equal(role, 'researcher');
        assert.ok(line.includes('__HARNESS_FIXTURE__/**') || line.includes('"fixture/greeting.txt"'));
      }
    }
  }
});

test('Lead permits only the seven named harness children', () => {
  const text = readFileSync(new URL('../spike/opencode/agents/lead.md', import.meta.url), 'utf8');
  const delegated = [...text.matchAll(/action: subagent, resource: (\w+), effect: allow/g)].map(match => match[1]);
  assert.deepEqual(delegated, roles.filter(role => role !== 'lead'));
});

test('smoke-test preparation generates both agent layouts with fixture-bound reads and no host plugin', () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../examples/prepare-agent-smoke-test.ts', import.meta.url))], { encoding: 'utf8' });
  const root = /^Disposable project: (.+)$/m.exec(output)?.[1]?.trim();
  assert.ok(root);
  try {
    for (const role of roles) {
      const plural: string = readFileSync(join(root, '.opencode', 'agents', `${role}.md`), 'utf8');
      assert.equal(plural, readFileSync(join(root, '.opencode', 'agent', `${role}.md`), 'utf8'));
      assert.ok(!plural.includes('__HARNESS_FIXTURE__'));
      if (role === 'researcher') assert.ok(plural.includes(`${join(root, 'fixture').replaceAll('\\', '/')}/**`));
    }
    assert.equal(readFileSync(join(root, 'fixture', 'greeting.txt'), 'utf8'), 'HELLO_FROM_DISPOSABLE_FIXTURE\n');
    const config = JSON.parse(readFileSync(join(root, '.opencode', 'opencode.jsonc'), 'utf8'));
    assert.equal(config.default_agent, 'lead');
    assert.equal(config.plugins, undefined);
    assert.deepEqual(config.permissions, [{ action: '*', resource: '*', effect: 'deny' }]);
  } finally {
    // Only the unique fixture created by this test process is removed.
    rmSync(root, { recursive: true });
  }
});
