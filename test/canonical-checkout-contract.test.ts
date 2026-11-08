import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadNativeDefinitions } from '../src/native-installer.ts';
import type { PermissionRule } from '../src/permission-reconciliation.ts';

// #172 / ADR-004: the canonical checkout receives only remote updates. These checks pin the
// wording in the role contracts, workflow command, and docs, and confirm that no permission changed.
// Assertions use short key phrases so that harmless rewrapping does not break them.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const normalize = (text: string) => text.replace(/\s+/g, ' ');
const definitions = loadNativeDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));

// OpenCode evaluates ordered rules last-match-wins; `*` and `?` are wildcards.
function effectOf(rules: PermissionRule[], command: string): string | undefined {
  const wildcard = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's');
  return rules.filter(rule => rule.action === 'shell' && rule.resource !== undefined && wildcard(rule.resource).test(command)).at(-1)?.effect;
}

const bootstrapPhrases = [
  'receives only remote updates',
  'fast-forward-only update of the base branch',
  'Not allowed there: edits, commits, merges, rebases, or switching branches',
  'applies only when the project uses task worktrees',
  'a single-checkout project is not affected',
  'inspect the canonical checkout read-only',
  "`<base>` is the project's configured base branch (`baseBranch` in project context)",
  'if it is missing or ambiguous, Operator asks Lead',
  '"Dirty" means any staged, unstaged, or untracked change',
  '"mid-operation" means a merge, rebase, cherry-pick, revert, or similar operation in progress',
  'if it is dirty, mid-operation, not on the base branch, or detached',
  'never repair it automatically',
  'with `<base>` and the canonical checkout path',
  'External runs `git fetch`',
  'ahead of or diverged from `origin/<base>`',
  'External reports and waits for the human, with no repair',
  '`git merge --ff-only origin/<base>`',
  'if the fast-forward is not possible, External reports and waits, and never repairs',
  'Create the task worktree from the updated base',
  'Other existing worktrees do not block bootstrap',
];

const retiredPhrases = [
  'untouched canonical changes do not block bootstrap',
  'branch from the local base',
  'refresh the base with `git fetch` (never pull',
  '(merge, rebase, or cherry-pick in progress)',
  'Lead asks External to fetch',
  'Lead asks External to fast-forward',
];

test('Operator contract states the canonical checkout rule, read-only pre-check, and fast-forward handoff', () => {
  const sourceText = normalize(read('../agents/operator.md'));
  const loaded = normalize(definitions.operator.system);
  for (const text of [sourceText, loaded]) {
    for (const phrase of bootstrapPhrases) assert.ok(text.includes(phrase), phrase);
    for (const phrase of retiredPhrases) assert.ok(!text.includes(phrase), phrase);
    // Operator's git fetch is retained but optional; the bootstrap fetch belongs to External.
    assert.ok(text.includes('retained but optional; not part of bootstrap'), 'Operator fetch is retained but not part of bootstrap');
    assert.ok(text.includes("the bootstrap fetch is External's"), 'bootstrap fetch is External\'s');
  }
});

test('External contract allows only the narrow bootstrap fast-forward and adds no allow rule', () => {
  const sourceText = normalize(read('../agents/external.md'));
  const loaded = normalize(definitions.external.system);
  for (const text of [sourceText, loaded]) {
    assert.ok(text.includes("local Git is Operator's job, with one narrow exception"), 'narrow exception to local Git ownership');
    assert.ok(text.includes('with `<base>` and the canonical checkout path'), 'Lead passes base and path');
    assert.ok(text.includes('not dirty (any staged, unstaged, or untracked change)'), 'dirty stop condition');
    assert.ok(text.includes('External runs `git fetch` there'), 'External fetches first');
    assert.ok(text.includes('ahead of or diverged from `origin/<base>`'), 'ahead or diverged stop');
    assert.ok(text.includes('wait for the human, with no repair'), 'ahead or diverged stop waits for the human');
    assert.ok(text.includes('Otherwise External runs `git merge --ff-only origin/<base>`'), 'fast-forward only when not ahead or diverged');
    assert.ok(text.includes('If the fast-forward is not possible, report the observed state to Lead and wait; never repair it'));
    assert.ok(text.includes('Never pull, force, reset, rebase, cherry-pick, switch branches, or edit, commit, or merge in the canonical checkout'));
    assert.ok(text.includes('The canonical-checkout bootstrap fast-forward (`git fetch`, then `git merge --ff-only origin/<base>`) adds no allow rule: it stays ASK'));
    for (const phrase of retiredPhrases) assert.ok(!text.includes(phrase), phrase);
  }
});

test('Lead contract states the canonical checkout rule and the bootstrap sequence', () => {
  const sourceText = normalize(read('../agents/lead.md'));
  const loaded = normalize(definitions.lead.system);
  for (const text of [sourceText, loaded]) {
    assert.ok(text.includes('Sequence: Operator bootstrap/worktree, in this order: read-only inspection of the canonical checkout;'), 'sequence step');
    assert.ok(text.includes('mid-operation (a merge, rebase, cherry-pick, revert, or similar operation in progress)'), 'mid-operation definition');
    assert.ok(text.includes('passing the base branch and canonical checkout path'), 'Lead passes base and path');
    assert.ok(text.includes('ahead of or diverged from origin/<base>'), 'Lead reports the ahead or diverged stop');
    assert.ok(text.includes('Operator creates task worktrees without blocking on other existing worktrees unless target branch/worktree collides. The canonical checkout receives only remote updates'));
    assert.ok(text.includes('Edits, commits, merges, rebases, and branch switches there are not allowed; that work goes in a task worktree.'));
    for (const phrase of retiredPhrases) assert.ok(!text.includes(phrase), phrase);
  }
});

test('start-issue workflow command states the canonical inspection and fast-forward step in source and OpenCode output', () => {
  const source = normalize(read('../commands/start-issue.md'));
  const opencode = normalize(read('../.opencode/commands/start-issue.md'));
  for (const text of [source, opencode]) {
    assert.ok(text.includes('Before any worktree is created, Operator inspects the canonical checkout read-only.'));
    assert.ok(text.includes("`<base>` is the project's configured base branch (`baseBranch` in project context)"), '<base> definition');
    assert.ok(text.includes('if it is missing or ambiguous, Operator asks Lead'));
    assert.ok(text.includes('any staged, unstaged, or untracked change, as `git status` reports'), 'dirty definition');
    assert.ok(text.includes('mid-operation (a merge, rebase, cherry-pick, revert, or similar operation in progress)'), 'mid-operation definition');
    assert.ok(text.includes('Operator reports the observed state and waits for explicit human confirmation'));
    assert.ok(text.includes('with `<base>` and the canonical checkout path'));
    assert.ok(text.includes('ahead of or diverged from `origin/<base>`'));
    assert.ok(text.includes('Otherwise External runs `git merge --ff-only origin/<base>`'));
    assert.ok(text.includes('prepares an isolated task worktree from the updated base'));
    for (const phrase of retiredPhrases) assert.ok(!text.includes(phrase), phrase);
  }
  // The generated OpenCode output must match the canonical body exactly (see commands/README.md).
  const bodyOf = (text: string) => text.slice(text.indexOf('\n---\n') + '\n---\n'.length);
  assert.equal(bodyOf(read('../.opencode/commands/start-issue.md')), bodyOf(read('../commands/start-issue.md')));
});

test('stop conditions define dirty and mid-operation wherever they appear, and <base> where it is defined', () => {
  const stopSurfaces = [
    '../agents/operator.md',
    '../agents/lead.md',
    '../agents/external.md',
    '../commands/start-issue.md',
    '../.opencode/commands/start-issue.md',
    '../README.md',
    '../docs/task-workflows.md',
    '../docs/opencode-native-workflow.md',
    '../docs/adr/0004-canonical-checkout-remote-updates-only.md',
  ];
  for (const file of stopSurfaces) {
    const text = normalize(read(file));
    assert.ok(text.includes('any staged, unstaged, or untracked change'), `${file} defines dirty`);
    assert.ok(text.includes('a merge, rebase, cherry-pick, revert, or similar operation in progress'), `${file} defines mid-operation`);
  }
  for (const file of ['../agents/operator.md', '../commands/start-issue.md', '../.opencode/commands/start-issue.md', '../docs/adr/0004-canonical-checkout-remote-updates-only.md']) {
    assert.ok(normalize(read(file)).includes("`<base>` is the project's configured base branch (`baseBranch` in project context)"), `${file} defines <base>`);
  }
});

test('glossary defines canonical checkout and the ADR index lists ADR-004', () => {
  const glossary = read('../docs/glossary.md');
  assert.match(glossary, /\| \*\*canonical checkout\*\* \| A repository's primary working directory, the one that is not a task worktree\./);
  assert.match(glossary, /\| \*\*base branch\*\* \|/);
  assert.match(glossary, /\| \*\*dirty\*\* \|/);
  assert.match(glossary, /\| \*\*mid-operation\*\* \|/);
  const index = read('../docs/adr/README.md');
  assert.match(index, /\[ADR-004\]\(0004-canonical-checkout-remote-updates-only\.md\)/);
  assert.ok(existsSync(new URL('../docs/adr/0004-canonical-checkout-remote-updates-only.md', import.meta.url)), 'ADR-004 file exists');
});

test('workflow docs repeat the ahead-or-diverged stop and the retained Operator fetch note', () => {
  const docs = {
    readme: normalize(read('../README.md')),
    agentsReadme: normalize(read('../agents/README.md')),
    workflow: normalize(read('../docs/opencode-native-workflow.md')),
    tasks: normalize(read('../docs/task-workflows.md')),
    adr: normalize(read('../docs/adr/0004-canonical-checkout-remote-updates-only.md')),
  };
  for (const [name, text] of Object.entries(docs)) {
    assert.ok(text.includes('ahead of or diverged from'), `${name} states the ahead or diverged stop`);
    assert.ok(text.includes('--ff-only'), `${name} names the fast-forward-only merge`);
  }
  for (const name of ['readme', 'agentsReadme', 'workflow', 'adr'] as const) {
    assert.ok(docs[name].includes('retained but optional; not part of bootstrap'), `${name} marks the Operator fetch as not part of bootstrap`);
  }
});

test('Operator still denies git pull and still allows git fetch', () => {
  const rules = definitions.operator.permissions as PermissionRule[];
  assert.equal(effectOf(rules, 'git pull origin main'), 'deny');
  assert.equal(effectOf(rules, 'git pull --ff-only origin main'), 'deny');
  assert.equal(effectOf(rules, 'git fetch'), 'allow');
  assert.equal(effectOf(rules, 'git fetch origin main'), 'allow');
  // Operator has no merge allow rule: a fast-forward in the canonical checkout is External's step.
  assert.notEqual(effectOf(rules, 'git merge --ff-only origin/main'), 'allow');
});

test('External permission rules gain no allow rule for merge or pull', () => {
  const rules = definitions.external.permissions as PermissionRule[];
  assert.equal(effectOf(rules, 'git merge --ff-only origin/main'), 'ask');
  assert.equal(effectOf(rules, 'git merge origin/main'), 'ask');
  assert.equal(effectOf(rules, 'git pull --ff-only origin main'), 'ask');
  for (const rule of rules) {
    if (rule.action === 'shell' && rule.effect === 'allow') assert.ok(!/merge|pull/.test(rule.resource ?? ''), `unexpected allow rule ${rule.resource}`);
  }
});
