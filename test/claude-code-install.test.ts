import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { makeTempRoot } from './temp-directory.ts';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import { diagnoseClaudeCode } from '../src/claude-code-adapter.ts';
import { diagnoseHost } from '../src/native-diagnostics.ts';
import { claudeChildRoles, claudeSettingsDeny } from '../src/claude-code-compiler.ts';
import { nativeRoles } from '../src/native-role-types.ts';
import { discoverReceiptChain } from '../src/receipt-lineage.ts';

type Answer = (question: string, suggested?: string) => string;

function harness(t: { after(fn: () => void): void }, answer: Answer = () => '') {
  const root = makeTempRoot('claude-install-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const recovery = join(root, 'recovery');
  const output: string[] = [];
  const errors: string[] = [];
  const prompts: string[] = [];
  const deps = {
    ask: async (question: string, suggested?: string) => { prompts.push(question); return answer(question, suggested); },
    output: (message: string) => { output.push(message); },
    error: (message: string) => { errors.push(message); },
    home: root,
    recoveryDirectory: recovery,
  };
  return { root, project, recovery, output, errors, prompts, deps };
}

const install = (h: ReturnType<typeof harness>, host = 'claude-code', scope = 'project') =>
  runInstallerFlow({ scope, project: h.project, host }, h.deps);

const backupCount = (recovery: string) => existsSync(recovery) ? readdirSync(recovery).length : 0;

const confirmOnly = (answer: string): Answer => question => question.startsWith('Type yes') ? answer : '';

test('Enter at the Claude confirmation cancels with no project files, backups, or receipts', async t => {
  const h = harness(t, confirmOnly(''));
  assert.equal(await install(h), 1);
  assert.equal(existsSync(join(h.project, 'CLAUDE.md')), false);
  assert.equal(existsSync(join(h.project, '.claude')), false);
  assert.equal(existsSync(h.recovery), false);
  assert.ok(h.output.some(line => /Installation canceled by user\. No files written\./.test(line)));
  assert.equal(h.prompts.filter(question => question.startsWith('Type yes')).length, 1, 'Enter is not retried or defaulted to yes');
});

test('an explicit no and an unrecognized answer both cancel without writes', async t => {
  for (const answer of ['no', 'maybe']) {
    const h = harness(t, confirmOnly(answer));
    assert.equal(await install(h), 1, answer);
    assert.equal(existsSync(join(h.project, 'CLAUDE.md')), false, answer);
    assert.equal(existsSync(join(h.project, '.claude')), false, answer);
    assert.equal(existsSync(h.recovery), false, answer);
  }
});

test('typing yes installs the full project footprint, and a repeated run writes no backups or receipts', async t => {
  const h = harness(t, confirmOnly('yes'));
  assert.equal(await install(h), 0);
  assert.ok(existsSync(join(h.project, 'CLAUDE.md')));
  for (const role of nativeRoles) assert.ok(existsSync(join(h.project, '.claude', 'agents', `${role}.md`)), role);
  for (const id of ['start-issue', 'review-pr', 'address-pr-feedback', 'report-defect', 'assess-debt', 'grill-me']) {
    assert.ok(existsSync(join(h.project, '.claude', 'commands', `${id}.md`)), id);
  }
  assert.ok(existsSync(join(h.project, '.claude', 'settings.json')));
  assert.equal(existsSync(join(h.project, '.mcp.json')), false, 'no MCP mapping is written');
  assert.equal(existsSync(join(h.project, '.opencode')), false);
  const settings = JSON.parse(readFileSync(join(h.project, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.agent, 'lead');
  for (const rule of claudeSettingsDeny) assert.ok(settings.permissions.deny.includes(rule));
  const leadText = readFileSync(join(h.project, '.claude', 'agents', 'lead.md'), 'utf8');
  assert.match(leadText, /tools: Read, Glob, Grep, AskUserQuestion, "?Agent\(operator/);
  for (const child of claudeChildRoles) assert.match(leadText, new RegExp(child));

  const backupsBefore = backupCount(h.recovery);
  const second = harness(t, confirmOnly('yes'));
  second.deps.recoveryDirectory = h.recovery;
  second.deps.home = h.root;
  const repeatedProject = h.project;
  const repeated = await runInstallerFlow({ scope: 'project', project: repeatedProject, host: 'claude-code' }, second.deps);
  assert.equal(repeated, 0);
  assert.equal(backupCount(h.recovery), backupsBefore, 'no new backup or receipt for an unchanged install');
  assert.ok(second.output.some(line => /No selected file needs changes/.test(line)));
  assert.equal(second.prompts.filter(question => question.startsWith('Type yes')).length, 0, 'no confirmation prompt for a no-op');
});

test('a customized command is preserved by default and replaced only on explicit overwrite, with a backup', async t => {
  const h = harness(t, confirmOnly('yes'));
  mkdirSync(join(h.project, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(h.project, '.claude', 'commands', 'start-issue.md'), 'my custom start\n');
  assert.equal(await install(h), 0);
  assert.equal(readFileSync(join(h.project, '.claude', 'commands', 'start-issue.md'), 'utf8'), 'my custom start\n');
  assert.ok(h.output.some(line => /Preserving customized file: \.claude\/commands\/start-issue\.md/.test(line)));

  const overwrite = harness(t, (question) => question.includes('Overwrite customized') ? 'yes' : question.startsWith('Type yes') ? 'yes' : '');
  overwrite.deps.recoveryDirectory = h.recovery;
  overwrite.deps.home = h.root;
  const overwriteProject = h.project;
  const status = await runInstallerFlow({ scope: 'project', project: overwriteProject, host: 'claude-code' }, overwrite.deps);
  assert.equal(status, 0);
  assert.notEqual(readFileSync(join(h.project, '.claude', 'commands', 'start-issue.md'), 'utf8'), 'my custom start\n');
  assert.ok(backupCount(h.recovery) > 0);
});

test('Enter on a customized-file overwrite prompt preserves the file (default no)', async t => {
  const h = harness(t, (question) => question.startsWith('Type yes') ? 'yes' : '');
  mkdirSync(join(h.project, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(h.project, '.claude', 'agents', 'qa.md'), 'custom qa\n');
  assert.equal(await install(h), 0);
  assert.equal(readFileSync(join(h.project, '.claude', 'agents', 'qa.md'), 'utf8'), 'custom qa\n');
});

test('global scope is refused before any write', async t => {
  const h = harness(t, confirmOnly('yes'));
  assert.equal(await runInstallerFlow({ scope: 'global', host: 'claude-code' }, h.deps), 2);
  assert.ok(h.errors.some(line => /project-scoped/.test(line)));
  assert.equal(existsSync(h.recovery), false);
  assert.equal(existsSync(join(h.project, 'CLAUDE.md')), false);
});

test('a conflicting default agent in settings blocks installation without writing any file', async t => {
  const h = harness(t, confirmOnly('yes'));
  mkdirSync(join(h.project, '.claude'), { recursive: true });
  writeFileSync(join(h.project, '.claude', 'settings.json'), '{"agent":"other"}\n');
  assert.equal(await install(h), 2);
  assert.ok(h.errors.some(line => /different default agent/.test(line)));
  assert.equal(readFileSync(join(h.project, '.claude', 'settings.json'), 'utf8'), '{"agent":"other"}\n');
  assert.equal(existsSync(join(h.project, 'CLAUDE.md')), false);
  assert.equal(existsSync(h.recovery), false);
});

test('malformed CLAUDE.md markers block installation without writes', async t => {
  const h = harness(t, confirmOnly('yes'));
  writeFileSync(join(h.project, 'CLAUDE.md'), '<!-- advanced-harness:lead:start -->\nno end\n');
  assert.equal(await install(h), 2);
  assert.ok(h.errors.some(line => /malformed or duplicate/.test(line)));
  assert.equal(readFileSync(join(h.project, 'CLAUDE.md'), 'utf8'), '<!-- advanced-harness:lead:start -->\nno end\n');
  assert.equal(existsSync(join(h.project, '.claude')), false);
});

test('user content in CLAUDE.md and unrelated settings keys survive installation', async t => {
  const h = harness(t, confirmOnly('yes'));
  writeFileSync(join(h.project, 'CLAUDE.md'), '# Team notes\n\nUse pnpm.\n');
  mkdirSync(join(h.project, '.claude'), { recursive: true });
  writeFileSync(join(h.project, '.claude', 'settings.json'), JSON.stringify({ env: { FOO: '1' }, permissions: { deny: ['Bash(curl *)'] } }, null, 2) + '\n');
  assert.equal(await install(h), 0);
  const memory = readFileSync(join(h.project, 'CLAUDE.md'), 'utf8');
  assert.ok(memory.startsWith('# Team notes\n\nUse pnpm.'));
  assert.ok(memory.includes('@AGENTS.md'));
  const settings = JSON.parse(readFileSync(join(h.project, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.env, { FOO: '1' });
  assert.ok(settings.permissions.deny.includes('Bash(curl *)'));
  for (const rule of claudeSettingsDeny) assert.ok(settings.permissions.deny.includes(rule));
});

test('mixed and unsupported selections still fail closed before any Claude write', async t => {
  for (const host of ['claude-code,codex', 'opencode,claude-code', 'cursor']) {
    const h = harness(t, confirmOnly('yes'));
    assert.equal(await runInstallerFlow({ scope: 'project', project: h.project, host }, h.deps), 2, host);
    assert.equal(existsSync(join(h.project, 'CLAUDE.md')), false, host);
    assert.equal(existsSync(h.recovery), false, host);
  }
});

test('update routes claude-code to the same adapter and is a no-op when current', async t => {
  const h = harness(t, confirmOnly('yes'));
  assert.equal(await install(h), 0);
  const backupsBefore = backupCount(h.recovery);
  const status = await runUpdateFlow({ scope: 'project', project: h.project, host: 'claude-code' }, {
    ...h.deps,
    ask: async (question: string, suggested?: string) => (question.startsWith('Type yes') ? 'yes' : suggested ?? ''),
  });
  assert.equal(status, 0);
  assert.equal(backupCount(h.recovery), backupsBefore);
});

test('doctor passes after installation and reports tampering with subagents, settings, and CLAUDE.md', async t => {
  const h = harness(t, confirmOnly('yes'));
  assert.equal(await install(h), 0);
  const healthy = await diagnoseClaudeCode({ project: h.project });
  assert.equal(healthy.ok, true, healthy.issues.join('\n'));
  assert.ok(healthy.notes.some(note => /not verified/.test(note)));
  assert.ok(healthy.notes.some(note => /Withheld or unsupported: .*mcp\.tool/.test(note)));

  const leadPath = join(h.project, '.claude', 'agents', 'lead.md');
  const lead = readFileSync(leadPath, 'utf8');
  // A different valid model is an explicit choice, not tampering; an invalid value is reported.
  writeFileSync(leadPath, lead.replace('model: sonnet', 'model: opus'));
  const otherModel = await diagnoseClaudeCode({ project: h.project });
  assert.equal(otherModel.ok, true, otherModel.issues.join('\n'));
  writeFileSync(leadPath, lead.replace('model: sonnet', 'model: "two words"'));
  const badModel = await diagnoseClaudeCode({ project: h.project });
  assert.equal(badModel.ok, false);
  assert.ok(badModel.issues.some(issue => /lead\.md model "two words" is missing or invalid/.test(issue)), badModel.issues.join('\n'));
  writeFileSync(leadPath, lead);

  const settingsPath = join(h.project, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.permissions.deny = settings.permissions.deny.filter((rule: string) => rule !== 'Bash(gh pr merge *)');
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  const weakened = await diagnoseClaudeCode({ project: h.project });
  assert.ok(weakened.issues.some(issue => /missing deny rule Bash\(gh pr merge \*\)/.test(issue)));

  writeFileSync(join(h.project, 'CLAUDE.md'), '# nothing managed here\n');
  const noBlock = await diagnoseClaudeCode({ project: h.project });
  assert.ok(noBlock.issues.some(issue => /CLAUDE\.md Lead orchestration block/.test(issue)));
});

test('doctor reports an uninstalled project and the registered host diagnostics return it', async t => {
  const h = harness(t, confirmOnly('yes'));
  const empty = await diagnoseClaudeCode({ project: h.project });
  assert.equal(empty.ok, false);
  assert.match(empty.issues[0]!, /not installed/);
  const host = await diagnoseHost('claude-code', { project: h.project, home: h.root });
  assert.equal(host.installed, false);
  assert.equal(host.ok, false);
  assert.equal(host.rolePresets.lead.model, 'sonnet');
});

test('registered host diagnostics report healthy after a successful install', async t => {
  const h = harness(t, confirmOnly('yes'));
  assert.equal(await install(h), 0);
  const host = await diagnoseHost('claude-code', { project: h.project, home: h.root });
  assert.equal(host.installed, true);
  assert.equal(host.ok, true, host.issues.join('\n'));
  assert.ok(host.notes.some(note => /runtime discovery|not verified/i.test(note)));
});

const outsideBlockNote = 'My team note outside the block.';
const claudeOverwritePrompt = (question: string) => question.startsWith('Overwrite customized/unowned file CLAUDE.md');

/** Runs the real installer flow against an existing harness; each call records its own prompts. */
async function runWith(h: ReturnType<typeof harness>, answer: Answer, extra: { agentsDirectory?: string } = {}) {
  const prompts: string[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const status = await runInstallerFlow({ scope: 'project', project: h.project, host: 'claude-code' }, {
    ask: async (question, suggested) => { prompts.push(question); return answer(question, suggested); },
    output: message => { output.push(message); },
    error: message => { errors.push(message); },
    home: h.root,
    recoveryDirectory: h.recovery,
    ...extra,
  });
  return { status, prompts, output, errors };
}

test('a hand-edited Lead block is preserved on Enter or no, with no CLAUDE.md write or backup', async t => {
  const h = harness(t, confirmOnly('yes'));
  assert.equal(await install(h), 0);
  const edited = readFileSync(join(h.project, 'CLAUDE.md'), 'utf8').replace('## Advanced Harness Lead orchestration', '## Advanced Harness Lead orchestration\n\nHAND EDIT INSIDE BLOCK');
  writeFileSync(join(h.project, 'CLAUDE.md'), edited);
  const backupsBefore = backupCount(h.recovery);
  for (const answer of ['', 'no']) {
    const run = await runWith(h, question => claudeOverwritePrompt(question) ? answer : confirmOnly('yes')(question));
    assert.equal(run.status, 0, answer);
    assert.ok(run.prompts.some(claudeOverwritePrompt), `prompt shown for ${JSON.stringify(answer)}`);
    assert.equal(readFileSync(join(h.project, 'CLAUDE.md'), 'utf8'), edited, `untouched for ${JSON.stringify(answer)}`);
    assert.ok(run.output.some(line => /Preserving customized file: CLAUDE\.md/.test(line)));
  }
  assert.equal(backupCount(h.recovery), backupsBefore, 'declining writes no backup');
});

test('an explicit yes overwrites the hand-edited Lead block and keeps a backup', async t => {
  const h = harness(t, confirmOnly('yes'));
  assert.equal(await install(h), 0);
  const fresh = readFileSync(join(h.project, 'CLAUDE.md'), 'utf8');
  writeFileSync(join(h.project, 'CLAUDE.md'), fresh.replace('## Advanced Harness Lead orchestration', '## Advanced Harness Lead orchestration\n\nHAND EDIT INSIDE BLOCK'));
  const backupsBefore = backupCount(h.recovery);
  const run = await runWith(h, question => claudeOverwritePrompt(question) || question.startsWith('Type yes') ? 'yes' : '');
  assert.equal(run.status, 0);
  const restored = readFileSync(join(h.project, 'CLAUDE.md'), 'utf8');
  assert.ok(!restored.includes('HAND EDIT INSIDE BLOCK'));
  assert.equal(restored, fresh);
  assert.ok(backupCount(h.recovery) > backupsBefore, 'a backup of the hand-edited file was written');
});

test('a Lead block the harness wrote earlier (owned via receipt) updates without any overwrite prompt', async t => {
  const h = harness(t, confirmOnly('yes'));
  assert.equal(await install(h), 0);
  // A child policy change alters the compiled Lead block; the previously written block is still receipt-owned.
  const changedAgents = join(h.root, 'agents-changed');
  mkdirSync(changedAgents);
  const sourceAgents = fileURLToPath(new URL('../agents/', import.meta.url));
  for (const role of nativeRoles) {
    let text = readFileSync(join(sourceAgents, `${role}.md`), 'utf8');
    if (role === 'researcher') text = text.replace('effect: allow\n      binding:\n        host: opencode\n        action: grep', 'effect: deny\n      binding:\n        host: opencode\n        action: grep');
    writeFileSync(join(changedAgents, `${role}.md`), text);
  }
  const before = readFileSync(join(h.project, 'CLAUDE.md'), 'utf8');
  const run = await runWith(h, question => question.startsWith('Type yes') ? 'yes' : '', { agentsDirectory: changedAgents });
  assert.equal(run.status, 0, run.errors.join('\n'));
  assert.ok(!run.prompts.some(claudeOverwritePrompt), 'no overwrite prompt for a harness-owned block');
  const after = readFileSync(join(h.project, 'CLAUDE.md'), 'utf8');
  assert.notEqual(after, before);
  assert.ok(after.includes('| `researcher` | `sonnet` | Read, Glob |'));
  assert.ok(!after.includes('| `researcher` | `sonnet` | Read, Glob, Grep |'));
});

test('text outside the Lead block edited by the user never triggers the overwrite prompt', async t => {
  const h = harness(t, confirmOnly('yes'));
  assert.equal(await install(h), 0);
  writeFileSync(join(h.project, 'CLAUDE.md'), readFileSync(join(h.project, 'CLAUDE.md'), 'utf8') + `\n${outsideBlockNote}\n`);
  const run = await runWith(h, () => '');
  assert.equal(run.status, 0);
  assert.ok(!run.prompts.some(claudeOverwritePrompt));
  assert.ok(readFileSync(join(h.project, 'CLAUDE.md'), 'utf8').includes(outsideBlockNote));
});

test('install stamps harnessVersion on the Claude Code receipt and prints it before confirmation', async t => {
  const commit = 'c'.repeat(40);
  let versionBeforeConfirm = false;
  const h = harness(t, question => {
    if (!question.startsWith('Type yes')) return '';
    versionBeforeConfirm = h.output.includes(`Harness version: 9.8.7 (${commit})`);
    return 'yes';
  });
  const harnessRoot = join(h.root, 'checkout');
  mkdirSync(harnessRoot);
  writeFileSync(join(harnessRoot, 'package.json'), JSON.stringify({ version: '9.8.7' }));
  const runCommand = (_executable: string, args: string[]) => args[0] === 'rev-parse' ? commit : '';
  assert.equal(await runInstallerFlow({ scope: 'project', project: h.project, host: 'claude-code' }, { ...h.deps, harnessRoot, runCommand }), 0);
  assert.equal(versionBeforeConfirm, true, 'version line printed before the final confirmation');
  const head = discoverReceiptChain(h.recovery, join(h.project, '.claude', 'settings.json'), 'claude-code').head;
  assert.deepEqual(head?.receipt.version === 2 ? head.receipt.harnessVersion : undefined, { version: '9.8.7', commit });
});

const modelPrompt = (question: string) => /^(\w+): Claude Code model \(/.exec(question)?.[1];
const frontmatterModel = (h: ReturnType<typeof harness>, role: string) => /^model: (.*)$/m.exec(readFileSync(join(h.project, '.claude', 'agents', `${role}.md`), 'utf8'))?.[1];

test('per-role Claude Code models accept a listed number, an alias, or a full ID and update the Lead table', async t => {
  const h = harness(t, (question, suggested) => {
    const role = modelPrompt(question);
    if (role === 'planner') return '3';
    if (role === 'reviewer') return 'inherit';
    if (role === 'implementer') return 'claude-sonnet-5-5';
    if (role) return '';
    return question.startsWith('Type yes') ? 'yes' : suggested ?? '';
  });
  assert.equal(await install(h), 0, h.errors.join('\n'));
  assert.equal(frontmatterModel(h, 'planner'), 'haiku');
  assert.equal(frontmatterModel(h, 'reviewer'), 'inherit');
  assert.equal(frontmatterModel(h, 'implementer'), 'claude-sonnet-5-5');
  assert.equal(frontmatterModel(h, 'lead'), 'sonnet', 'Enter keeps the preset on a fresh install');
  const memory = readFileSync(join(h.project, 'CLAUDE.md'), 'utf8');
  assert.match(memory, /\| `planner` \| `haiku` \|/);
  assert.match(memory, /\| `implementer` \| `claude-sonnet-5-5` \|/);
  assert.ok(h.output.some(line => /discovery is unsupported and availability is unverified/.test(line)));
  assert.ok(h.output.includes('  implementer: claude-sonnet-5-5 is not a documented alias; it is written as typed and its availability is unverified.'));
  assert.equal((await diagnoseClaudeCode({ project: h.project })).ok, true);
});

test('a rerun suggests installed models; Enter keeps them with no writes, and a change rewrites only affected files', async t => {
  const h = harness(t, (question) => modelPrompt(question) === 'planner' ? 'haiku' : confirmOnly('yes')(question));
  assert.equal(await install(h), 0);
  const suggestions: Record<string, string | undefined> = {};
  const keep = await runWith(h, (question, suggested) => { const role = modelPrompt(question); if (role) suggestions[role] = suggested; return confirmOnly('yes')(question); });
  assert.equal(keep.status, 0);
  assert.equal(suggestions.planner, 'haiku');
  assert.equal(suggestions.reviewer, 'opus');
  assert.ok(keep.output.some(line => /No selected file needs changes/.test(line)));

  const researcherBefore = readFileSync(join(h.project, '.claude', 'agents', 'researcher.md'), 'utf8');
  const change = await runWith(h, question => modelPrompt(question) === 'qa' ? 'opus' : confirmOnly('yes')(question));
  assert.equal(change.status, 0, change.errors.join('\n'));
  assert.equal(frontmatterModel(h, 'qa'), 'opus');
  assert.equal(frontmatterModel(h, 'planner'), 'haiku');
  assert.match(readFileSync(join(h.project, 'CLAUDE.md'), 'utf8'), /\| `qa` \| `opus` \|/);
  assert.equal(readFileSync(join(h.project, '.claude', 'agents', 'researcher.md'), 'utf8'), researcherBefore);
  assert.ok(change.output.includes('  .claude/agents/qa.md (update)'));
  assert.ok(change.output.includes('  .claude/agents/researcher.md (current (up to date))'));
});

test('three invalid model answers stop before any file, backup, or receipt', async t => {
  const h = harness(t, question => modelPrompt(question) === 'external' ? 'two words' : confirmOnly('yes')(question));
  assert.equal(await install(h), 2);
  assert.equal(h.prompts.filter(question => modelPrompt(question) === 'external').length, 3);
  assert.ok(h.errors.some(line => /external remained invalid after 3 attempts\. No files were changed\./.test(line)));
  assert.equal(h.prompts.some(question => question.startsWith('Type yes')), false);
  assert.equal(existsSync(join(h.project, '.claude')), false);
  assert.equal(existsSync(join(h.project, 'CLAUDE.md')), false);
  assert.equal(existsSync(h.recovery), false);
});

test('an invalid answer is retried, and a closed model prompt stops without writes', async t => {
  let tries = 0;
  const retried = harness(t, question => modelPrompt(question) === 'lead' && tries++ === 0 ? 'bad value' : confirmOnly('yes')(question));
  assert.equal(await install(retried), 0);
  assert.equal(frontmatterModel(retried, 'lead'), 'sonnet');
  assert.ok(retried.output.some(line => /without spaces for lead; nothing is substituted/.test(line)));

  const closed = harness(t);
  closed.deps.ask = async question => { if (modelPrompt(question)) throw new Error('stdin closed'); return ''; };
  assert.equal(await install(closed), 2);
  assert.ok(closed.errors.includes('Claude Code model prompt was closed or rejected. No files were changed.'));
  assert.equal(existsSync(join(closed.project, '.claude')), false);
  assert.equal(existsSync(closed.recovery), false);
});

test('declining overwrite of a customized role file reports that its entered model was not applied', async t => {
  const h = harness(t, confirmOnly('yes'));
  assert.equal(await install(h), 0);
  const plannerPath = join(h.project, '.claude', 'agents', 'planner.md');
  const customized = `${readFileSync(plannerPath, 'utf8')}\nTeam addition.\n`;
  writeFileSync(plannerPath, customized);
  const run = await runWith(h, question => modelPrompt(question) === 'planner' ? 'haiku' : question.startsWith('Overwrite customized/unowned file .claude/agents/planner.md') ? 'no' : confirmOnly('yes')(question));
  assert.equal(run.status, 0, run.errors.join('\n'));
  assert.ok(run.output.includes('  Preserving customized file: .claude/agents/planner.md; the model entered for it was not applied'));
  assert.equal(readFileSync(plannerPath, 'utf8'), customized);
});

test('Claude Code update uses the same per-role model prompts', async t => {
  const h = harness(t, confirmOnly('yes'));
  assert.equal(await install(h), 0);
  const prompts: string[] = [];
  const status = await runUpdateFlow({ scope: 'project', project: h.project, host: 'claude-code' }, {
    ask: async question => { prompts.push(question); return modelPrompt(question) === 'operator' ? 'sonnet' : confirmOnly('yes')(question); },
    output: () => {}, error: () => {}, home: h.root, recoveryDirectory: h.recovery,
    sharedLocations: async () => 'skipped' as const,
  });
  assert.equal(status, 0);
  assert.equal(prompts.filter(question => modelPrompt(question)).length, nativeRoles.length);
  assert.equal(frontmatterModel(h, 'operator'), 'sonnet');
});
