import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseDocument, stringify } from 'yaml';
import test from 'node:test';
import { loadNativeDefinitions, nativeRoles, type NativeDefinition } from '../src/native-installer.ts';
import { loadRoleDefinition, loadRoleDefinitions } from '../src/role-definitions.ts';
import { compileOpenCodeRole, compileOpenCodeRoles } from '../src/opencode-role-compiler.ts';
import { isOpenCodeGuardrailRule, openCodeGuardrailRules } from '../src/security-guardrails.ts';
import { lowerOpenCodePolicy, type CapabilityPolicy } from '../src/capability-policy.ts';
import type { PermissionRule } from '../src/permission-reconciliation.ts';
import { operatorAdvisoryLines, operatorFallbackLines } from './operator-claude-wording.ts';

const agents = new URL('../agents/', import.meta.url);
const source = (role: typeof nativeRoles[number]) => readFileSync(new URL(`${role}.md`, agents), 'utf8');
const legacyAgents = new URL('./fixtures/legacy-role-sources/', import.meta.url);
const legacySource = (role: typeof nativeRoles[number]) => readFileSync(new URL(`${role}.md`, legacyAgents), 'utf8');
function editFrontmatter(text: string, edit: (header: Record<string, unknown>) => void): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)!;
  const header = parseDocument(match[1]!).toJSON() as Record<string, unknown>;
  edit(header);
  return `---\n${stringify(header, { lineWidth: 0 })}---\n${match[2]}`;
}

const capturedArtifact = JSON.parse(readFileSync(new URL('./fixtures/compiled-role-definitions.json', import.meta.url), 'utf8')) as {
  provenance: string;
  definitions: Record<typeof nativeRoles[number], NativeDefinition>;
};
const legacyNormalizedDefinitions = () => capturedArtifact.definitions;

// #144: Operator may refresh the base with `git fetch`, written out independently of the sources.
function withOperatorFetch(definitions: Record<typeof nativeRoles[number], NativeDefinition>): Record<typeof nativeRoles[number], NativeDefinition> {
  const operator = definitions.operator;
  const permissions = operator.permissions as Array<{ action: string; resource: string; effect: string }>;
  const index = permissions.findIndex(rule => rule.action === 'shell' && rule.resource === 'git fetch *' && rule.effect === 'deny');
  assert.notEqual(index, -1, 'historical snapshot denies git fetch for Operator');
  permissions.splice(index, 1,
    { action: 'shell', resource: 'git fetch', effect: 'allow' },
    { action: 'shell', resource: 'git fetch *', effect: 'allow' },
    { action: 'shell', resource: 'git fetch *--upl*', effect: 'deny' },
    { action: 'shell', resource: 'git fetch -u*', effect: 'deny' },
    { action: 'shell', resource: 'git fetch * -u*', effect: 'deny' });
  const shellAsk = permissions.findIndex(rule => rule.action === 'shell' && rule.resource === '*' && rule.effect === 'ask');
  assert.notEqual(shellAsk, -1, 'Operator retains the general shell ask rule');
  permissions.splice(shellAsk + 1, 0,
    { action: 'shell', resource: 'npm run harness:preflight -- *', effect: 'allow' },
    { action: 'shell', resource: 'npm run harness:preflight -- *&&*', effect: 'ask' },
    { action: 'shell', resource: 'npm run harness:preflight -- *;*', effect: 'ask' },
    { action: 'shell', resource: 'npm run harness:preflight -- *|*', effect: 'ask' },
    { action: 'shell', resource: 'npm run harness:preflight -- *$(*)*', effect: 'ask' });
  // #172: the canonical checkout receives only remote updates; External fast-forwards the base during bootstrap.
  const previous = 'existing worktrees and untouched canonical changes do not block bootstrap; stop and ask\nLead only if settings are missing/invalid, target branch/worktree already exists, or\ncreation fails. Never discard unrelated changes or perform remote Git/API/MCP\noperations; External owns those. Command patterns are workflow aids, not a sandbox;\ndo not use scripts/aliases to bypass role ownership.';
  assert.ok(operator.system.includes(previous));
  operator.system = operator.system.replace(previous, [
    'existing worktrees do not block bootstrap; stop and ask',
    'Lead only if settings are missing/invalid, target branch/worktree already exists, or',
    "creation fails. The canonical checkout (the repository's primary working directory,",
    'not a task worktree) receives only remote updates: read-only inspection, and a',
    'fast-forward-only update of the base branch. Not allowed there: edits, commits, merges,',
    'rebases, or switching branches; that work goes in a task worktree. This rule applies only',
    'when the project uses task worktrees (a worktreeDirectory is configured); a single-checkout',
    "project is not affected. `<base>` is the project's configured base branch (`baseBranch` in",
    'project context); if it is missing or ambiguous, Operator asks Lead. "Dirty" means any',
    'staged, unstaged, or untracked change (anything `git status` reports); "mid-operation"',
    'means a merge, rebase, cherry-pick, revert, or similar operation in progress. Bootstrap',
    'order: (1) inspect the canonical checkout read-only; (2) if it is dirty, mid-operation,',
    'not on the base branch, or detached, report the observed state and wait for human',
    'confirmation; never repair it automatically. (3) Otherwise Lead relays the step to External',
    'with `<base>` and the canonical checkout path. External runs `git fetch`, then checks',
    'read-only (for example, `git rev-list --left-right --count <base>...origin/<base>`) whether',
    'local `<base>` is ahead of or diverged from `origin/<base>`. If it is, External reports and',
    'waits for the human, with no repair. Otherwise External runs `git merge --ff-only',
    'origin/<base>`; if the fast-forward is not possible, External reports and waits, and never',
    'repairs. (4) Create the task worktree from the updated base. Never discard unrelated changes',
    'or perform other remote Git/API/MCP operations; External owns those. Command patterns are',
    'workflow aids, not a sandbox; do not use scripts/aliases to bypass role ownership.',
    '',
    ...operatorAdvisoryLines,
  ].join('\n'));
  const closing = 'local Git/worktrees/memory/cleanup; escalate services and remote Git to External\nthrough Lead.';
  assert.ok(operator.system.includes(closing));
  operator.system = operator.system.replace(closing, [
    'local Git/worktrees/memory/cleanup, including read-only canonical checkout inspection and',
    'the `git fetch` exception (retained but optional; not part of bootstrap; the bootstrap fetch is',
    "External's); External fast-forwards the base during bootstrap; escalate services and all other",
    'remote Git to External through Lead.',
  ].join('\n'));
  // #200 / ADR-005: the Claude Code fallback paragraph appended after the closing paragraph.
  const lastLine = 'Lead; do not broaden permissions, substitute roles/models, or retry automatically.';
  assert.ok(operator.system.includes(lastLine));
  operator.system = operator.system.replace(lastLine, [
    lastLine,
    '',
    ...operatorFallbackLines,
  ].join('\n'));
  // #176: Operator reads the shared locations from project context instead of an "agreed" path.
  const agreed = 'Maintain one agreed shared MEMORY.md outside application worktrees. Write serialized';
  assert.ok(operator.system.includes(agreed));
  operator.system = operator.system.replace(agreed, 'Read worktreeDirectory and memoryPath from the project (or interim paths) settings in\nAGENTS.md or the context file it links. A valid configured value settles the question:\ndo not ask about it. $$HOME/ means the current user\'s home directory on this machine.\nStop and ask Lead only if a value is missing or invalid, the two sections disagree, or\nan absolute path was saved for a projectRoot that is not this repository on this\nmachine (in a paths section, an absolute path that does not exist here). Never search\nthe workspace for MEMORY.md or create one there.\n\nMaintain the one shared MEMORY.md at memoryPath, outside application worktrees. Write serialized');
  return definitions;
}

// #169: QA spells out that Git/GitHub shell commands are denied and Git context comes from Operator through Lead.
function withQaGitContext(definitions: Record<typeof nativeRoles[number], NativeDefinition>): Record<typeof nativeRoles[number], NativeDefinition> {
  const qa = definitions.qa;
  const preflightAnchor = 'On interruption or uncertain verification execution, report observed outcomes and';
  assert.ok(qa.system.includes(preflightAnchor), 'historical QA snapshot retains its verification/resume contract');
  qa.system = qa.system.replace(preflightAnchor, [
    'Installed prompts do not ship docs. Repository navigation is [the preflight handoff guide](https://github.com/IkariMeister/advanced-harness/blob/main/docs/preflight.md#operator-evidence-handoff); authoritative instructions must be `docs/preflight.md` in the matching confirmed harness checkout. If checkout/version or guide cannot be confirmed, ask Lead and stop; do not fetch another version. Consume Operator\'s exact command, JSON/status, and worktree/branch/HEAD/working-change identity; do not execute the Git-backed wrapper or other Git commands. Assess supplied evidence and ask Lead for missing or stale evidence. The JSON `approved` field is an automated verdict, never human approval; waived checks remain waived, not passed.',
    preflightAnchor,
  ].join('\n'));
  const previous = 'publish, merge, approve work, delegate, or change models. Request Git information from\nOperator and design/service context from External through Lead. Do not use shell/scripts\nto bypass role ownership. Test/device outputs are expected, not authorization for\nsource edits.';
  assert.ok(qa.system.includes(previous));
  qa.system = qa.system.replace(previous, 'publish, merge, approve work, delegate, or change models. Operator owns local Git: shell\ncommands that run `git` or `gh` are denied for QA, including read-only ones such as\nstatus, diff, log, or rev-parse, and any compound command that contains one. Use the\nbranch, HEAD, and changed-file context Lead supplies; if it is missing, ask Lead to get\nit from Operator. Do not retry a denied command in another form. Request design/service\ncontext from External through Lead. Do not use shell/scripts to bypass role ownership.\nTest/device outputs are expected, not authorization for source edits.');
  return definitions;
}
// #172: External's narrow bootstrap fast-forward of the canonical checkout's base, written out independently of the sources.
function withExternalBootstrap(definitions: Record<typeof nativeRoles[number], NativeDefinition>): Record<typeof nativeRoles[number], NativeDefinition> {
  const external = definitions.external;
  const shellNote = 'else stays ASK. These ALLOW rules do not authorize writes conversationally: obtain';
  assert.ok(external.system.includes(shellNote));
  external.system = external.system.replace(shellNote, [
    'else stays ASK. The canonical-checkout bootstrap fast-forward (`git fetch`, then',
    '`git merge --ff-only origin/<base>`) adds no allow rule: it stays ASK, and each run needs the',
    "human's approval at its prompt. These ALLOW rules do not authorize writes conversationally: obtain",
  ].join('\n'));
  const previous = 'state when the human asks Lead to verify it for cleanup; local Git is Operator\'s job.\nDo not perform application edits or approve plans/findings yourself.';
  assert.ok(external.system.includes(previous));
  external.system = external.system.replace(previous, [
    "state when the human asks Lead to verify it for cleanup; local Git is Operator's job, with one",
    'narrow exception. During task bootstrap, when Lead relays it with `<base>` and the canonical',
    "checkout path after Operator's read-only inspection found the canonical checkout not dirty (any",
    'staged, unstaged, or untracked change), not mid-operation (a merge, rebase, cherry-pick, revert,',
    'or similar operation in progress), and on the base branch, External runs `git fetch` there, then',
    'checks read-only (for example, `git rev-list --left-right --count <base>...origin/<base>`) whether',
    'local `<base>` is ahead of or diverged from `origin/<base>`. If it is, report the observed state',
    'to Lead and wait for the human, with no repair. Otherwise External runs `git merge --ff-only',
    'origin/<base>`. If the fast-forward is not possible, report the observed state to Lead and wait;',
    'never repair it. Never pull, force, reset, rebase, cherry-pick, switch branches, or edit, commit,',
    'or merge in the canonical checkout; that work goes in a task worktree through Operator.',
    'Do not perform application edits or approve plans/findings yourself.',
  ].join('\n'));
  return definitions;
}

// #221: External inline review comment payload validation
function withExternalReviewPayload(definitions: Record<typeof nativeRoles[number], NativeDefinition>): Record<typeof nativeRoles[number], NativeDefinition> {
  const external = definitions.external;
  const previous = 'remote/service state read-only. If inspection confirms the mutation already completed as\napproved, report the verified outcome to Lead without repeating the push, PR, issue,\ncomment, review, or transition. If inspection shows the mutation did not complete,\npartially applied, diverged, or remains inconclusive, report exact observed versus\nexpected state to Lead and wait for explicit human confirmation before retrying or\nrepairing. Avoid duplicate comments, uploads, PRs, or conflicting pushes.';
  assert.ok(external.system.includes(previous));
  external.system = external.system.replace(previous, [
    'remote/service state read-only. When submitting pull request review comments via GitHub REST',
    'API, distinguish standalone comments (`POST /repos/{owner}/{repo}/pulls/{pull_number}/comments`)',
    'from batch reviews (`POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`): format inline comment',
    'payloads strictly per API schema. Standalone comments require root-level fields: integer line parameters',
    'with `-F line=<number>` (never string `-f`), `commit_id` matching the PR head SHA, `path`, `body`, and',
    '`side` (`RIGHT` for new code, `LEFT` for removed lines). Batch reviews submit inline comments inside the',
    '`comments[]` array, where each comment object requires `path`, `body`, integer `line` (e.g. within an',
    'input JSON payload: `{"comments":[{"path":"...","line":<number>,"body":"...","side":"RIGHT"}]}`), and',
    'optional top-level review `event` (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`). For both endpoints, ensure',
    'target lines fall within the PR diff hunk. If inspection confirms the mutation already completed as',
    'approved, report the verified outcome to Lead without repeating the push, PR, issue, comment, review,',
    'or transition. If inspection shows the mutation did not complete, partially applied, diverged, or remains',
    'inconclusive, report exact observed versus expected state to Lead and wait for explicit human confirmation',
    'before retrying or repairing. Avoid duplicate comments, uploads, PRs, or conflicting pushes.',
  ].join('\n'));
  return definitions;
}

// #186: External's publication gate consumes Operator's preflight evidence, independently of source wording.
function withExternalPreflightHandoff(definitions: Record<typeof nativeRoles[number], NativeDefinition>): Record<typeof nativeRoles[number], NativeDefinition> {
  const external = definitions.external;
  const anchor = "Do not push or open a PR until Lead supplies the human's explicit final approval of";
  assert.ok(external.system.includes(anchor), 'historical External snapshot contains the publication approval gate');
  external.system = external.system.replace(anchor, [
    'Before publishing, use `docs/preflight.md` in the matching confirmed harness checkout. Installed prompts do not ship docs; repository navigation is [the publication handoff guide](https://github.com/IkariMeister/advanced-harness/blob/main/docs/preflight.md#publication-handoff-and-manual-smoke), not authority for the installed version. If the checkout/version or guide cannot be confirmed, stop and ask Lead, never fetch silently. Require the exact Operator handoff and quoted scoped exception if any; stop on missing or malformed/inconsistent/stale/blocked/inconclusive evidence. Immediately before an authorized push, compare expected prior remote branch/PR head with authoritative remote state; do not treat legitimate newer unpublished local HEAD as stale solely because it differs from prior remote HEAD. Stop on unexpected remote/head/feedback/local state or uncertainty. After push, verify remote HEAD equals approved handoff HEAD. Inspect uncertain writes read-only; never retry automatically. Final human publication approval remains separate.',
    '',
    anchor,
  ].join('\n'));
  return definitions;
}

const currentNormalizedDefinitions = () => withExternalPreflightHandoff(withExternalReviewPayload(withExternalBootstrap(withQaGitContext(withOperatorFetch(structuredClone(legacyNormalizedDefinitions()))))));

test('strict role source compiler preserves current normalized OpenCode definitions for all roles', () => {
  const baseline = legacyNormalizedDefinitions();
  assert.match(capturedArtifact.provenance, /reconstructed after v2 source migration/i);
  const agentsDirectory = fileURLToPath(agents);
  const currentDefinitions = loadRoleDefinitions(agentsDirectory);
  const compiled = compileOpenCodeRoles(currentDefinitions);
  assert.deepEqual(compiled.diagnostics, []);
  assert.deepEqual(loadNativeDefinitions(fileURLToPath(legacyAgents)), baseline, 'historical sources normalize to their independent historical snapshot');
  const expectedCurrent = currentNormalizedDefinitions();
  for (const role of ['lead', 'operator', 'planner', 'implementer', 'reviewer'] as const) {
    expectedCurrent[role].system = currentDefinitions[role].instructions;
  }
  const reviewerSnapshot = readFileSync(new URL('./fixtures/current-reviewer-system.txt', import.meta.url), 'utf8').trim();
  const expectedReviewer = reviewerSnapshot.replace(
    '## Risk-tiered review',
    'Installed prompts do not ship docs. Repository navigation is [the preflight handoff guide](https://github.com/IkariMeister/advanced-harness/blob/main/docs/preflight.md#operator-evidence-handoff); authoritative instructions must be `docs/preflight.md` in the matching confirmed harness checkout. If checkout/version or guide cannot be confirmed, ask Lead and stop; do not fetch another version. Consume the exact Operator command, JSON/status, and worktree/branch/HEAD/working-change identity; do not run the Git-backed wrapper or other Git commands. Assess supplied evidence and request missing/stale evidence through Lead. The JSON `approved` field is an automated verdict, not human approval. Record waived checks as waived, never passed.\n\n## Risk-tiered review',
  );
  assert.equal(currentDefinitions.reviewer.instructions, expectedReviewer, 'reviewer instructions match the independent current-reviewer snapshot plus accepted handoff guidance');
  expectedCurrent.reviewer.system = expectedReviewer;
  assert.deepEqual(compiled.definitions, expectedCurrent, 'current compiler output preserves historical definitions except the updated role contract bodies and Operator fetch change');
  assert.deepEqual(loadNativeDefinitions(agentsDirectory), expectedCurrent, 'current native loader output matches the independent expected full definitions');
});

test('loader validates role-specific mode, model syntax, description, and instructions', () => {
  for (const role of nativeRoles) {
    const text = legacySource(role);
    const expectedMode = role === 'lead' ? 'primary' : 'subagent';
    assert.equal(loadRoleDefinition(text, role).orchestration, expectedMode);
    assert.throws(() => loadRoleDefinition(text.replace(`mode: ${expectedMode}`, `mode: ${expectedMode === 'primary' ? 'subagent' : 'primary'}`), role), /mode/i);
    assert.throws(() => loadRoleDefinition(text.replace(/model: .+/, 'model: invalid-model'), role), /model/i);
    assert.throws(() => loadRoleDefinition(text.replace(/description: .+/, 'description: ""'), role), /description/i);
    assert.throws(() => loadRoleDefinition(text.replace(/---\r?\n([\s\S]*?)\r?\n---\r?\n[\s\S]*/, '---\n$1\n---\n   \n'), role), /instructions/i);
  }
});

test('loader rejects unknown and duplicate YAML fields and malformed permission records without mutations', t => {
  const dir = mkdtempSync(join(tmpdir(), 'role-definition-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const role of nativeRoles) writeFileSync(join(dir, `${role}.md`), legacySource(role));
  const leadPath = join(dir, 'lead.md');
  const valid = readFileSync(leadPath, 'utf8');
  const invalid = [
    valid.replace('description:', 'unknown: value\ndescription:'),
    valid.replace('description:', 'description: duplicate\ndescription:'),
    valid.replace('effect: deny', 'effect: maybe'),
    valid.replace('action: "*"', 'action: ""'),
    valid.replace('resource: "*"', 'resource: ""'),
    valid.replace('effect: deny', 'effect: deny, extra: yes'),
    valid.replace('effect: deny', 'effect: [deny]'),
    valid.replace('effect: deny', 'effect: 1'),
    valid.replace('effect: deny', 'effect: true'),
    valid.replace('permissions:', 'permissions: invalid')
  ];
  for (const candidate of invalid) {
    writeFileSync(leadPath, candidate);
    assert.throws(() => loadRoleDefinitions(dir));
    assert.equal(readFileSync(leadPath, 'utf8'), candidate);
  }
  assert.deepEqual(readdirSync(dir).sort(), [...nativeRoles.map(role => `${role}.md`)].sort());
});

test('OpenCode role compiler returns independent ordered permission data', () => {
  const definitions = loadRoleDefinitions(fileURLToPath(agents));
  const sourceDefinition = definitions.external;
  const compiled = compileOpenCodeRole(sourceDefinition);
  const lowered = lowerOpenCodePolicy('external', sourceDefinition.deployment.opencode.policy);
  assert.deepEqual(compiled.diagnostics, []);
  assert.deepEqual(compiled.definition?.permissions, [...lowered.permissions!, ...openCodeGuardrailRules(lowered.permissions!)]);
  assert.deepEqual(compiled.definition?.permissions[0], lowered.permissions?.[0]);
  assert.notEqual(compiled.definition?.permissions, lowered.permissions);
  assert.notEqual(compiled.definition?.permissions[0], lowered.permissions?.[0]);
});

test('Operator may git fetch but not run upload-pack or other remote Git (#144)', () => {
  const rules = loadNativeDefinitions(fileURLToPath(agents)).operator.permissions as Array<{ action: string; resource?: string; effect: string }>;
  // OpenCode evaluates ordered rules last-match-wins; `*` and `?` are wildcards.
  const wildcard = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's');
  const effect = (command: string) => rules.filter(rule => (rule.action === 'shell' || rule.action === '*') && (rule.resource === undefined || wildcard(rule.resource).test(command))).at(-1)?.effect;
  assert.equal(effect('git fetch'), 'allow');
  assert.equal(effect('git fetch origin main'), 'allow');
  assert.equal(effect('git fetch --prune origin'), 'allow');
  assert.equal(effect('git fetch origin feature-ui'), 'allow', 'a -u inside a ref name is not an option');
  // --upload-pack runs a command; Git also accepts any unambiguous prefix (--upl is the shortest).
  for (const command of ['git fetch --upload-pack=evil origin', 'git fetch origin --upload-pack evil', 'git fetch --upl=evil origin', 'git fetch origin --uplo evil']) assert.equal(effect(command), 'deny', command);
  assert.equal(effect('git fetch --no-upload-pack origin'), 'allow', 'the negated option runs nothing');
  // -u is --update-head-ok for fetch in Git 2.55, but is upload-pack for clone/fetch-pack: denied defensively.
  for (const command of ['git fetch -u evil origin', 'git fetch -uevil origin', 'git fetch origin -u evil', 'git fetch origin -uevil']) assert.equal(effect(command), 'deny', command);
  assert.equal(effect('git pull origin main'), 'deny');
  assert.equal(effect('git push origin main'), 'deny');
  assert.equal(effect('git status'), 'ask');
});

test('Operator preflight permission is narrow and preserves unrelated shell asks and remote Git denies', () => {
  const rules = loadNativeDefinitions(fileURLToPath(agents)).operator.permissions as Array<{ action: string; resource?: string; effect: string }>;
  // Match the existing helper semantics: native command patterns use * and ? wildcards.
  const wildcard = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's');
  const effect = (command: string) => rules.filter(rule => (rule.action === 'shell' || rule.action === '*') && (rule.resource === undefined || wildcard(rule.resource).test(command))).at(-1)?.effect;
  assert.equal(effect('npm run harness:preflight -- --worktree task --base main --task 186 --json'), 'allow');
  for (const separator of [' && ', '&&', ' ; ', ';', ' | ', '|', '$(echo x)']) {
    assert.equal(effect(`npm run harness:preflight -- --worktree task ${separator}git push origin main`), 'ask', separator);
  }
  assert.equal(effect('npm run test'), 'ask');
  assert.equal(effect('npm run typecheck'), 'ask');
  for (const command of ['git push origin main', 'git pull origin main', 'git clone https://example.invalid/repo']) assert.equal(effect(command), 'deny', command);
  assert.ok(!rules.some(rule => rule.action === 'shell' && rule.effect === 'allow' && wildcard(rule.resource ?? '').test('npm run typecheck')), 'broad npm allow mutation must be rejected');
});

test('capability normalization round-trips ordered OpenCode rules without changing policy semantics', () => {
  const definitions = loadRoleDefinitions(fileURLToPath(agents));
  for (const role of nativeRoles) {
    const policy = definitions[role].deployment.opencode.policy;
    const lowered = lowerOpenCodePolicy(role, policy);
    assert.deepEqual(lowered.diagnostics, [], role);
    const sourcePermissions = currentNormalizedDefinitions()[role].permissions.filter(rule => !isOpenCodeGuardrailRule(rule as PermissionRule));
    assert.notEqual(lowered.permissions, legacyNormalizedDefinitions()[role].permissions, `${role}: normalized permissions are independently allocated from the original snapshot`);
    assert.deepEqual(lowered.permissions, sourcePermissions, role);
    assert.deepEqual(currentNormalizedDefinitions()[role].permissions, [...lowered.permissions!, ...openCodeGuardrailRules(lowered.permissions!)], role);
    assert.deepEqual(policy.rules.map(rule => rule.binding.action), sourcePermissions.map(rule => (rule as { action: string }).action));
  }
  const leadRules = definitions.lead.deployment.opencode.policy.rules;
  assert.deepEqual(leadRules[0], { capability: 'all', resource: { kind: 'all' }, effect: 'deny', binding: { host: 'opencode', action: '*' } });
  assert.ok(leadRules.some(rule => rule.binding.action === 'read' && rule.resource.kind === 'native-pattern' && rule.resource.value === '*.env' && rule.effect === 'ask'));
  const externalRules = definitions.external.deployment.opencode.policy.rules;
  assert.ok(externalRules.some(rule => rule.capability === 'shell.run' && rule.binding.action === 'shell' && rule.effect === 'ask'));
  assert.ok(externalRules.some(rule => rule.binding.action === 'shell' && rule.resource.kind === 'native-pattern' && rule.resource.value === 'gh.exe pr merge' && rule.effect === 'deny'));
  assert.ok(externalRules.some(rule => rule.capability === 'code-mode.execute' && rule.binding.action === 'execute'));
  for (const action of ['jira_*', 'github_*', 'figma_*', 'stitch_*']) assert.ok(externalRules.some(rule => rule.capability === 'mcp.tool' && rule.binding.action === action));
});

test('v2 role sources reject unsupported versions, duplicate authorities, malformed nested policy, and mismatches', () => {
  const valid = source('lead');
  const badSources = [
    editFrontmatter(valid, header => { header.schemaVersion = 3; }),
    editFrontmatter(valid, header => { header.permissions = []; }),
    editFrontmatter(valid, header => { header.unknown = true; }),
    editFrontmatter(valid, header => { (header.policy as Record<string, unknown>).schemaVersion = 2; }),
    editFrontmatter(valid, header => { (header.policy as Record<string, unknown>).resolution = 'unordered'; }),
    editFrontmatter(valid, header => { const rules = (header.policy as { rules: Record<string, unknown>[] }).rules; rules[0]!.extra = true; }),
    editFrontmatter(valid, header => { const rules = (header.policy as { rules: Record<string, unknown>[] }).rules; rules[0]!.effect = ['deny']; }),
    editFrontmatter(valid, header => { const rules = (header.policy as { rules: { binding: Record<string, unknown> }[] }).rules; rules[0]!.binding.host = 'codex'; }),
    editFrontmatter(valid, header => { const rules = (header.policy as { rules: Record<string, unknown>[] }).rules; (rules[0]!.binding as Record<string, unknown>).action = 'shell'; }),
    editFrontmatter(valid, header => { const rules = (header.policy as { rules: { resource: Record<string, unknown> }[] }).rules; rules[0]!.resource.kind = 'unsupported'; }),
    editFrontmatter(valid, header => { (header.policy as Record<string, unknown>).resolution = 'first-match'; })
  ];
  for (const candidate of badSources) assert.throws(() => loadRoleDefinition(candidate, 'lead'));
  assert.throws(() => loadRoleDefinition(valid.replace('schemaVersion: 2', 'schemaVersion: 1'), 'lead'), /version/i);
});

test('unsupported capability actions and invalid internal bindings/selectors produce structured diagnostics', () => {
  const raw = legacySource('lead').replace('action: read,', 'action: future_action,');
  const role = loadRoleDefinition(raw, 'lead');
  assert.equal(role.diagnostics[0]?.code, 'unknown-capability');
  assert.equal(role.diagnostics[0]?.role, 'lead');
  const result = compileOpenCodeRole(role);
  assert.equal(result.definition, undefined);
  assert.equal(result.diagnostics[0]?.code, 'unknown-capability');
  for (const inherited of ['constructor', 'toString', '__proto__']) {
    const inheritedAction = loadRoleDefinition(legacySource('lead').replace('action: read,', `action: ${inherited},`), 'lead');
    assert.ok(inheritedAction.diagnostics.some(item => item.code === 'unknown-capability' && item.message.includes(inherited)));
  }

  const valid = loadRoleDefinitions(fileURLToPath(agents)).lead;
  const mismatch = structuredClone(valid);
  mismatch.deployment.opencode.policy.rules[0]!.binding.action = 'shell';
  const binding = compileOpenCodeRole(mismatch);
  assert.equal(binding.definition, undefined);
  assert.ok(binding.diagnostics.some(item => item.code === 'invalid-binding'));

  const inheritedBinding = structuredClone(valid);
  inheritedBinding.deployment.opencode.policy.rules[0]!.binding.action = 'constructor';
  const inheritedResult = compileOpenCodeRole(inheritedBinding);
  assert.ok(inheritedResult.diagnostics.some(item => item.code === 'unknown-capability'));
  assert.equal(inheritedResult.definition, undefined);

  const selector = structuredClone(valid.deployment.opencode.policy) as CapabilityPolicy;
  (selector.rules[0]!.resource as unknown as { kind: string }).kind = 'unmapped';
  const selectorResult = lowerOpenCodePolicy('lead', selector);
  assert.equal(selectorResult.permissions, undefined);
  assert.ok(selectorResult.diagnostics.some(item => item.code === 'unresolved-selector'));

  const unknownPrecedence = lowerOpenCodePolicy('lead', { schemaVersion: 1, rules: undefined } as unknown as CapabilityPolicy);
  assert.ok(unknownPrecedence.diagnostics.some(item => item.code === 'unresolved-precedence'));
});
