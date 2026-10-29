import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadNativeDefinitions } from '../src/native-installer.ts';
import type { PermissionRule } from '../src/permission-reconciliation.ts';

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
const definitions = loadNativeDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));
const permissionRules = (role: typeof roles[number]) => definitions[role].permissions as PermissionRule[];
const hasRule = (role: typeof roles[number], action: string, resource: string, effect: PermissionRule['effect']) => permissionRules(role).some(rule => rule.action === action && rule.resource === resource && rule.effect === effect);

test('native roles preserve fixed model variants and deny before native exceptions', () => {
  for (const role of roles) {
    const text = template(role);
    const assigned = expectedAssignments[role];
    assert.ok(text.includes(`model: ${assigned.model}#${assigned.reasoning}\n`), role);
    assert.ok(text.includes(`mode: ${role === 'lead' ? 'primary' : 'subagent'}\n`), role);
    assert.deepEqual(permissionRules(role)[0], { action: '*', resource: '*', effect: 'deny' });
    assert.ok(!text.includes('harness_status') && !text.includes('harness_action'), role);
    assert.ok(hasRule(role, 'read', '*', 'allow'), role);
  }
});

test('native Lead delegates only to named roles and owns conversational approvals', () => {
  const text = template('lead');
  assert.deepEqual(permissionRules('lead').filter(rule => rule.action === 'subagent' && rule.effect === 'allow').map(rule => rule.resource), roles.filter(role => role !== 'lead'));
  assert.match(text, /WAIT for explicit human approval/);
  assert.match(text, /final approval before pushing\/opening a PR/);
  assert.match(text, /missing, ask again/);
  assert.match(text, /Evidence capture\/publication is optional/);
  assert.ok(!permissionRules('lead').some(rule => ['shell', 'edit', 'execute', 'webfetch', 'websearch'].includes(rule.action)));
  for (const role of roles.filter(role => role !== 'lead')) assert.ok(!permissionRules(role).some(rule => rule.action === 'subagent'), role);
});

test('native operational roles expose shell and keep edit defaults role-scoped', () => {
  for (const role of ['operator', 'external', 'implementer', 'reviewer', 'qa'] as const) {
    assert.ok(hasRule(role, 'shell', '*', 'ask'), role);
  }
  for (const role of ['researcher', 'planner'] as const) {
    assert.ok(!permissionRules(role).some(rule => ['shell', 'edit'].includes(rule.action)), role);
  }
  assert.ok(hasRule('implementer', 'edit', '*', 'allow'));
  assert.ok(hasRule('operator', 'edit', '*', 'ask'));
  for (const role of ['external', 'reviewer', 'qa'] as const) assert.ok(!permissionRules(role).some(rule => rule.action === 'edit'), role);
});

test('External source permission exceptions are narrowly scoped and merge stays denied', () => {
  assert.ok(hasRule('external', 'shell', '*', 'ask'));
  assert.ok(hasRule('external', 'shell', 'git push', 'allow'));
  assert.ok(hasRule('external', 'shell', 'git push *', 'allow'));
  for (const executable of ['gh', 'gh.exe']) {
    for (const command of ['pr view', 'pr create', 'pr edit', 'pr comment', 'pr review', 'issue create', 'issue edit', 'issue comment', 'workflow run', 'run rerun', 'run cancel']) {
      assert.ok(hasRule('external', 'shell', `${executable} ${command}`, 'allow'));
      assert.ok(hasRule('external', 'shell', `${executable} ${command} *`, 'allow'));
    }
    assert.ok(hasRule('external', 'shell', `${executable} pr merge`, 'deny'));
    assert.ok(hasRule('external', 'shell', `${executable} pr merge *`, 'deny'));
    assert.ok(!permissionRules('external').some(rule => rule.action === 'shell' && rule.resource === `${executable} *` && rule.effect === 'allow'));
  }
  assert.ok(hasRule('external', 'execute', '*', 'allow'));
});

test('Lead and External require evidence for missing native tools without broadening access', () => {
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
  assert.ok(hasRule('external', 'shell', '*', 'ask'));
  assert.ok(!permissionRules('lead').some(rule => ['shell', 'execute'].includes(rule.action)));
});

test('native MCP and web permissions belong only to External and do not imply connections', () => {
  for (const role of roles) {
    const externalLines = permissionRules(role).filter(rule => ['execute', 'webfetch', 'websearch'].includes(rule.action) || /^(jira|github|figma|stitch)_\*$/.test(rule.action));
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
  for (const role of ['operator', 'implementer', 'reviewer', 'qa'] as const) assert.ok(hasRule(role, 'shell', 'gh *', 'deny'), role);
});

test('all native roles distinguish offered tools, configured policy, invocation, and ownership', () => {
  const docs = readFileSync(new URL('../docs/opencode-native-workflow.md', import.meta.url), 'utf8');
  const guide = readFileSync(new URL('../agents/README.md', import.meta.url), 'utf8');
  for (const role of roles) {
    const text = template(role).replace(/\s+/g, ' ');
    assert.match(text, /Capability reporting/, role);
    assert.match(text, /offered/, role);
    assert.match(text, /permissions?/, role);
    assert.match(text, /invocation|invoked|outcomes|results|result/, role);
    assert.match(text, /ownership|owns|owner/, role);
  }
  assert.match(docs, /tools actually offered\/visible/);
  assert.match(docs, /configured allow\/ask\/deny policy/);
  assert.match(docs, /observed invocation and its result/);
  assert.match(docs, /task ownership/);
  assert.match(guide, /Direct MCP tools and nested Code Mode actions/);
});

test('tool guidance distinguishes native shell, direct MCP, nested actions, and escalation', () => {
  const workflow = readFileSync(new URL('../docs/opencode-native-workflow.md', import.meta.url), 'utf8');
  const troubleshooting = readFileSync(new URL('../docs/tool-troubleshooting.md', import.meta.url), 'utf8');
  const configuration = readFileSync(new URL('../docs/configuration.md', import.meta.url), 'utf8');
  for (const text of [workflow, troubleshooting, configuration].map(value => value.replace(/\s+/g, ' '))) {
    assert.match(text, /native[^.]{0,80}(?:separate|separately)[^.]{0,100}(?:Code Mode|catalog)/i);
    assert.match(text, /Direct MCP[^.]*nested Code Mode/i);
    assert.match(text, /unverified/);
    assert.match(text, /permission[^\n]*(?:plan approval|plan)/i);
  }
  assert.match(troubleshooting, /Operator handles local Git/);
  assert.match(troubleshooting, /External handles/);
  assert.match(troubleshooting, /Do not grant permissions,?\s*switch roles\/models, retry, or restart/);
});

test('permission documentation separates narrow External ALLOW from conversational authorization', () => {
  const workflow = readFileSync(new URL('../docs/opencode-native-workflow.md', import.meta.url), 'utf8');
  const configuration = readFileSync(new URL('../docs/configuration.md', import.meta.url), 'utf8');
  const external = template('external');
  for (const text of [workflow, configuration, external].map(value => value.replace(/\s+/g, ' '))) {
    assert.match(text, /git push/);
    assert.match(text, /workflow run/);
    assert.match(text, /run rerun\/cancel/);
    assert.match(text, /pr merge/);
    assert.match(text, /explicit human request/);
    assert.match(text, /not a sandbox|not.*approval gate|does not authorize|do not authorize/);
  }
  assert.match(workflow, /other shell\/gh operations remain ASK/);
  assert.match(configuration, /MCP tool mappings stay ASK|preserves ASK for unresolved MCP tool mappings/);
});

test('BH-010: native agent templates enforce non-destructive resume and unconfirmed approval reporting', () => {
  const lead = template('lead');
  const operator = template('operator');
  const external = template('external');
  const implementer = template('implementer');
  const reviewer = template('reviewer');
  const qa = template('qa');

  // Lead resume checklist, unconfirmed status, and non-inference
  const leadClean = lead.replace(/\s+/g, ' ');
  assert.match(leadClean, /On interruption, compaction, or lost context/);
  assert.match(leadClean, /preserve existing local and remote work untouched/);
  assert.match(leadClean, /resume checklist/);
  assert.match(leadClean, /unconfirmed/);
  assert.match(leadClean, /never infer plan, fix, publishing, or cleanup approval from existing diffs, commits, child reports, or dated notes/);
  assert.match(leadClean, /Wait for explicit human confirmation before resuming/);
  assert.match(leadClean, /return any material plan change to the human/);

  // Operator non-destructive read-only inspection and preservation
  const operatorClean = operator.replace(/\s+/g, ' ');
  assert.match(operatorClean, /On interruption or context loss/);
  assert.match(operatorClean, /preserve uncommitted and unpushed work untouched/);
  assert.match(operatorClean, /wait for Lead's human-confirmed resume/);

  // Implementer waiting for human re-confirmation on lost context
  const implementerClean = implementer.replace(/\s+/g, ' ');
  assert.match(implementerClean, /On interruption, lost context, or uncertain outcomes, preserve existing files untouched/);
  assert.match(implementerClean, /wait for explicit human re-confirmation/);
  assert.match(implementerClean, /Existing worktree changes never constitute plan approval/);

  // Reviewer and QA reporting observed vs unrun without claiming pass
  const reviewerClean = reviewer.replace(/\s+/g, ' ');
  assert.match(reviewerClean, /On interruption or uncertain check execution/);
  assert.match(reviewerClean, /do not infer a pass from partial runs/);
  assert.match(reviewerClean, /Wait for Lead's human-confirmed resume/);
  const qaClean = qa.replace(/\s+/g, ' ');
  assert.match(qaClean, /On interruption or uncertain verification execution/);
  assert.match(qaClean, /wait for Lead's human-confirmed resume/);
});

test('BH-010: native templates and docs enforce two-branch inspect-before-retry rule for uncertain mutations', () => {
  const lead = template('lead');
  const operator = template('operator');
  const external = template('external');
  const workflow = readFileSync(new URL('../docs/opencode-native-workflow.md', import.meta.url), 'utf8');
  const taskWorkflows = readFileSync(new URL('../docs/task-workflows.md', import.meta.url), 'utf8');
  const troubleshooting = readFileSync(new URL('../docs/tool-troubleshooting.md', import.meta.url), 'utf8');

  for (const raw of [lead, operator, external, workflow, taskWorkflows, troubleshooting]) {
    const text = raw.replace(/\s+/g, ' ');
    assert.match(text, /inspect.*read-only|read-only.*inspect/i);
    assert.match(text, /already completed|verified outcome|verified completion|verified result/i);
    assert.match(text, /without repeating/i);
    assert.match(text, /wait for (?:explicit )?human confirmation before (?:retrying|repairing)|wait for human confirmation before (?:retrying|repairing)|wait for (?:explicit )?human confirmation before retrying/i);
  }

  // Disclaims automatic recovery or workflow database
  for (const text of [lead, operator, workflow]) {
    assert.match(text, /workflow database|workflow engine/);
    assert.match(text, /automatic recovery/);
  }
});

test('BH-012: Lead and Operator enforce bootstrap rules, conflict precedence, and approved rule promotion', () => {
  const lead = template('lead').replace(/\s+/g, ' ');
  const operator = template('operator').replace(/\s+/g, ' ');

  // Conflict precedence
  assert.match(lead, /Precedence is Current Human Decision > AGENTS\.md > MEMORY\.md/);
  assert.match(operator, /(?:Order of precedence|Precedence) is Current Human Decision > AGENTS\.md > MEMORY\.md/);

  // Non-blocking bootstrap
  assert.match(lead, /Operator creates task worktrees without blocking on other existing worktrees unless target branch\/worktree collides/);
  assert.match(operator, /Other existing worktrees and untouched canonical changes do not block bootstrap/);
  assert.match(operator, /stop and ask Lead only if settings are missing\/invalid, target branch\/worktree already exists, or creation fails/);

  // Serialized memory updates and rejection of secrets/logs
  assert.match(operator, /Write serialized updates using baseline verification/);
  assert.match(operator, /reject secrets or operational log dumps/);

  // Rule consolidation
  assert.match(lead, /Present candidate memory learnings for individual or batch disposition/);
  assert.match(lead, /Promoted rules require an explicit diff preview and human approval before publication, rejecting secrets or local operational paths and preserving embedded sections/);
  assert.match(operator, /Evaluate candidate learnings once for approved consolidation into AGENTS\.md/);
  assert.match(operator, /Never promote secrets or machine-local worktree paths/);
});
