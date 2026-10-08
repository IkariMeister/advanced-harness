import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const roles = ['lead', 'operator', 'external', 'researcher', 'planner', 'implementer', 'reviewer', 'qa'] as const;
const expectedAssignments = {
  lead: { model: 'openai/gpt-6-astra', reasoning: 'medium' },
  operator: { model: 'openai/gpt-5.3-codex-spark', reasoning: 'low' },
  external: { model: 'openai/gpt-5.3-codex-spark', reasoning: 'low' },
  researcher: { model: 'openai/gpt-6-luna', reasoning: 'medium' },
  planner: { model: 'openai/gpt-6.1-sol', reasoning: 'medium' },
  implementer: { model: 'openai/gpt-6-luna', reasoning: 'low' },
  reviewer: { model: 'openai/gpt-6.1-sol', reasoning: 'low' },
  qa: { model: 'openai/gpt-6-luna', reasoning: 'low' },
} as const;
const template = (role: typeof roles[number]) => readFileSync(new URL(`../agents/${role}.md`, import.meta.url), 'utf8');
const permissionLines = (role: typeof roles[number]) => template(role).split('\n').filter(line => line.startsWith('  - { action:'));

test('native roles preserve fixed model variants and deny before native exceptions', () => {
  for (const role of roles) {
    const text = template(role);
    const assigned = expectedAssignments[role];
    assert.ok(text.includes(`model: ${assigned.model}#${assigned.reasoning}\n`), role);
    assert.ok(text.includes(`mode: ${role === 'lead' ? 'primary' : 'subagent'}\n`), role);
    assert.equal(permissionLines(role)[0], '  - { action: "*", resource: "*", effect: deny }');
    assert.ok(!text.includes('harness_status') && !text.includes('harness_action'), role);
    assert.ok(permissionLines(role).some(line => line.includes('action: read,') && line.includes('effect: allow')), role);
  }
});

test('native Lead delegates only to named roles and owns conversational approvals', () => {
  const text = template('lead');
  assert.deepEqual([...text.matchAll(/action: subagent, resource: (\w+), effect: allow/g)].map(match => match[1]), roles.filter(role => role !== 'lead'));
  assert.match(text, /WAIT for explicit human approval/);
  assert.match(text, /final approval before pushing\/opening a PR/);
  assert.match(text, /missing, ask again/);
  assert.match(text, /Evidence capture\/publication is optional/);
  assert.ok(!permissionLines('lead').some(line => /action: (shell|edit|execute|webfetch|websearch),/.test(line)));
  for (const role of roles.filter(role => role !== 'lead')) assert.ok(!permissionLines(role).some(line => line.includes('action: subagent,')), role);
});

test('native operational roles expose shell and keep edit defaults role-scoped', () => {
  for (const role of ['operator', 'external', 'implementer', 'reviewer', 'qa'] as const) {
    assert.ok(permissionLines(role).includes('  - { action: shell, resource: "*", effect: ask }'), role);
  }
  for (const role of ['researcher', 'planner'] as const) {
    assert.ok(!permissionLines(role).some(line => /action: (shell|edit),/.test(line)), role);
  }
  assert.ok(permissionLines('implementer').includes('  - { action: edit, resource: "*", effect: allow }'));
  assert.ok(permissionLines('operator').includes('  - { action: edit, resource: "*", effect: ask }'));
  for (const role of ['external', 'reviewer', 'qa'] as const) assert.ok(!permissionLines(role).some(line => line.includes('action: edit,')), role);
});

test('native MCP and web permissions belong only to External and do not imply connections', () => {
  for (const role of roles) {
    const externalLines = permissionLines(role).filter(line => /action: (execute|webfetch|websearch),|action: "(jira|github|figma|stitch)_\*"/.test(line));
    assert.equal(externalLines.length, role === 'external' ? 7 : 0, role);
  }
});

test('native implementation and verification templates require human scope and treat evidence as optional', () => {
  assert.match(template('implementer'), /If Lead has not/);
  assert.match(template('implementer'), /without\nchanging files/);
  assert.match(template('planner'), /waits for explicit\nhuman approval/);
  for (const role of ['implementer', 'reviewer', 'qa', 'external'] as const) assert.match(template(role), /optional unless/, role);
  for (const role of ['operator', 'implementer', 'reviewer', 'qa'] as const) assert.ok(permissionLines(role).includes('  - { action: shell, resource: "gh *", effect: deny }'), role);
});
