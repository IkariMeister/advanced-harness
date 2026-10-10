import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadNativeDefinitions } from '../src/native-installer.ts';

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

test('Lead and External require evidence for missing native tools without broadening access', () => {
  const definitions = loadNativeDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));
  for (const role of ['lead', 'external'] as const) {
    const text = definitions[role].system.replace(/\s+/g, ' ');
    assert.match(text, /Native shell[\s\S]*separate from the[\s\S]*Code Mode catalog/, role);
    assert.match(text, /empty catalog search[\s\S]*does not prove shell is unavailable/, role);
    assert.match(text, /actual authorized invocation\/error[\s\S]*or captured offered-tool evidence/, role);
    assert.match(text, /availability as[\s\S]*unverified/, role);
    assert.match(text, /separately approved read-only/, role);
    assert.match(text, /ASK prompts intact/, role);
    assert.match(text, /broaden[\s\S]*permissions/, role);
    assert.match(text, /restart the service/, role);
    assert.match(text, /probes automatically/, role);
  }
  assert.match(definitions.lead.system, /child's self-report is not tool-exposure evidence/);
  assert.match(definitions.external.system, /tools actually exposed within approved scope/);
  assert.match(definitions.external.system, /diagnostic approval does not authorize publishing/);
  assert.ok(permissionLines('external').includes('  - { action: shell, resource: "*", effect: ask }'));
  assert.ok(!permissionLines('lead').some(line => /action: (shell|execute),/.test(line)));
});

test('native MCP and web permissions belong only to External and do not imply connections', () => {
  for (const role of roles) {
    const externalLines = permissionLines(role).filter(line => /action: (execute|webfetch|websearch),|action: "(jira|github|figma|stitch)_\*"/.test(line));
    assert.equal(externalLines.length, role === 'external' ? 7 : 0, role);
  }
});

test('Lead, External, and product docs honor optional services without design fallback', () => {
  const definitions = loadNativeDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));
  for (const role of ['lead', 'external'] as const) {
    const text = definitions[role].system.replace(/\s+/g, ' ');
    assert.match(text, /GitHub, Jira, and design are individually optional|Respect none/, role);
    assert.match(text, /project\/task acceptance criteria/, role);
    assert.match(text, /Use only the explicitly selected design source; never silently substitute/, role);
    assert.doesNotMatch(text, /Figma first|Prefer Figma|otherwise Stitch|otherwise Jira/, role);
  }
  assert.match(definitions.external.system.replace(/\s+/g, ' '), /only when Jira is selected and the human has approved the state mapping and update scope/);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Jira\/design access is not a general setup prerequisite/);
  assert.match(readme, /project\/task acceptance criteria/);
  assert.match(readme, /are implemented locally with automated tests/);
  assert.doesNotMatch(readme, /Jira remains the source of acceptance criteria|Model access validation, project setup, integrations, and a real Android pilot remain to be delivered/);
});

test('native implementation and verification templates require human scope and treat evidence as optional', () => {
  assert.match(template('implementer'), /If Lead has not/);
  assert.match(template('implementer'), /without\nchanging files/);
  assert.match(template('planner'), /waits for explicit\nhuman approval/);
  for (const role of ['implementer', 'reviewer', 'qa', 'external'] as const) assert.match(template(role), /optional unless/, role);
  for (const role of ['operator', 'implementer', 'reviewer', 'qa'] as const) assert.ok(permissionLines(role).includes('  - { action: shell, resource: "gh *", effect: deny }'), role);
});
