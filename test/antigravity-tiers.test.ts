import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRoot } from './temp-directory.ts';
import { diagnoseAntigravity, installAntigravity } from '../src/antigravity-adapter.ts';
import { parseAntigravityLeadRuleTiers } from '../src/antigravity-compiler.ts';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import type { Ask } from '../src/native-installer.ts';

const rolesDir = fileURLToPath(new URL('../agents/', import.meta.url));
const commandsDir = fileURLToPath(new URL('../commands/', import.meta.url));

const tierPrompt = (question: string) => /^(\w+): Antigravity model tier \(/.exec(question)?.[1];

function sandbox(t: { after(fn: () => void): void }) {
  const root = makeTempRoot('ag-tiers-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(project);
  mkdirSync(home);
  const recovery = join(root, 'recovery');
  return { root, project, home, recovery, rule: join(project, '.agents', 'rules', 'advanced-harness-lead.md') };
}

/** Answers tier prompts from `tiers` (Enter otherwise), accepts other suggestions, and confirms with `confirmation`. */
function answers(tiers: Record<string, string> = {}, confirmation = 'yes', extra: (question: string) => string | undefined = () => undefined) {
  const prompts: string[] = [];
  const suggestions: Record<string, string | undefined> = {};
  const ask: Ask = async (question, suggested) => {
    prompts.push(question);
    const custom = extra(question);
    if (custom !== undefined) return custom;
    const role = tierPrompt(question);
    if (role) { suggestions[role] = suggested; return tiers[role] ?? ''; }
    if (question.startsWith('Type yes to install the Antigravity')) return confirmation;
    return suggested ?? '';
  };
  return { ask, prompts, suggestions };
}

async function install(box: ReturnType<typeof sandbox>, ask: Ask, output: string[] = [], errors: string[] = []) {
  return installAntigravity({
    scope: 'project', project: box.project, home: box.home, recoveryDirectory: box.recovery,
    agentsDirectory: rolesDir, commandsDirectory: commandsDir,
    ask, output: message => output.push(message), error: message => errors.push(message),
  });
}

test('child tiers accept a listed number or a tier name, Lead is not prompted, and the rule table records them', async t => {
  const box = sandbox(t);
  const output: string[] = [];
  const { ask, prompts } = answers({ planner: '3', reviewer: 'inherit', qa: 'pro' });
  assert.equal(await install(box, ask, output), 0);
  assert.deepEqual(parseAntigravityLeadRuleTiers(readFileSync(box.rule, 'utf8')), {
    operator: 'flash_lite', external: 'flash_lite', researcher: 'flash', planner: 'flash', implementer: 'flash', reviewer: 'inherit', qa: 'pro',
  });
  assert.equal(prompts.some(question => tierPrompt(question) === 'lead'), false);
  assert.ok(output.some(line => /Exact per-role model binding and model discovery are unsupported/.test(line)));
  assert.ok(output.includes('  lead: inherit (session model)'));
  assert.ok(output.includes('  qa (runtime tier pro, not changed by preferences): unconfigured'));
  const doctor = await diagnoseAntigravity({ project: box.project, home: box.home });
  assert.ok(doctor.notes.some(note => note.includes('planner=flash') && note.includes('qa=pro')), doctor.notes.join('\n'));
});

test('a rerun suggests installed tiers; Enter keeps them with no writes, and a change rewrites only the Lead rule', async t => {
  const box = sandbox(t);
  assert.equal(await install(box, answers({ planner: 'flash' }).ask), 0);
  const skill = join(box.project, '.agents', 'skills', 'start-issue', 'SKILL.md');
  const skillBefore = readFileSync(skill, 'utf8');

  const keep = answers();
  const keepOutput: string[] = [];
  assert.equal(await install(box, keep.ask, keepOutput), 0);
  assert.equal(keep.suggestions.planner, 'flash');
  assert.equal(keep.suggestions.reviewer, 'pro');
  assert.ok(keepOutput.includes('  .agents/rules/advanced-harness-lead.md (current (up to date))'));

  const changeOutput: string[] = [];
  assert.equal(await install(box, answers({ implementer: 'pro' }).ask, changeOutput), 0);
  assert.ok(changeOutput.includes('  .agents/rules/advanced-harness-lead.md (update)'));
  const tiers = parseAntigravityLeadRuleTiers(readFileSync(box.rule, 'utf8'));
  assert.equal(tiers.implementer, 'pro');
  assert.equal(tiers.planner, 'flash');
  assert.equal(readFileSync(skill, 'utf8'), skillBefore);
});

test('three invalid tier answers stop before any file, backup, or receipt', async t => {
  const box = sandbox(t);
  const errors: string[] = [];
  const { ask, prompts } = answers({ external: 'gemini-ultra' });
  assert.equal(await install(box, ask, [], errors), 2);
  assert.equal(prompts.filter(question => tierPrompt(question) === 'external').length, 3);
  assert.ok(errors.includes('Antigravity tier for external remained invalid after 3 attempts. No files were changed.'));
  assert.equal(prompts.some(question => question.startsWith('Type yes')), false);
  assert.equal(existsSync(join(box.project, '.agents')), false);
  assert.equal(existsSync(box.recovery), false);
});

test('an invalid tier is retried, and a closed tier prompt stops without writes', async t => {
  const box = sandbox(t);
  let tries = 0;
  const output: string[] = [];
  assert.equal(await install(box, answers({}, 'yes', question => tierPrompt(question) === 'operator' && tries++ === 0 ? '9' : undefined).ask, output), 0);
  assert.equal(parseAntigravityLeadRuleTiers(readFileSync(box.rule, 'utf8')).operator, 'flash_lite');
  assert.ok(output.some(line => /one of inherit, flash_lite, flash, pro for operator; nothing is substituted/.test(line)));

  const closed = sandbox(t);
  const errors: string[] = [];
  assert.equal(await install(closed, async question => { if (tierPrompt(question)) throw new Error('stdin closed'); return ''; }, [], errors), 2);
  assert.ok(errors.includes('Antigravity tier prompt was closed or rejected. No files were changed.'));
  assert.equal(existsSync(join(closed.project, '.agents')), false);
  assert.equal(existsSync(closed.recovery), false);
});

test('cancelling after choosing tiers writes nothing', async t => {
  const box = sandbox(t);
  const output: string[] = [];
  assert.equal(await install(box, answers({ planner: 'flash' }, '').ask, output), 1);
  assert.ok(output.includes('Installation canceled by user. No files written.'));
  assert.equal(existsSync(join(box.project, '.agents')), false);
  assert.equal(existsSync(box.recovery), false);
});

test('declining overwrite of a customized Lead rule reports that the entered tiers were not applied', async t => {
  const box = sandbox(t);
  assert.equal(await install(box, answers().ask), 0);
  const customized = `${readFileSync(box.rule, 'utf8')}\nTeam addition.\n`;
  writeFileSync(box.rule, customized);
  const output: string[] = [];
  const { ask } = answers({ qa: 'pro' }, 'yes', question => question.startsWith('Overwrite customized/unowned file .agents/rules/advanced-harness-lead.md') ? 'no' : undefined);
  assert.equal(await install(box, ask, output), 0);
  assert.ok(output.includes('  Preserving customized file: .agents/rules/advanced-harness-lead.md; the tiers entered above were not applied'));
  assert.equal(readFileSync(box.rule, 'utf8'), customized);
});

test('doctor reports a missing or invalid tier in the installed Lead rule', async t => {
  const box = sandbox(t);
  assert.equal(await install(box, answers().ask), 0);
  const rule = readFileSync(box.rule, 'utf8');
  writeFileSync(box.rule, rule.replace(/(\| \*\*planner\*\* \| )`pro`/, '$1`ultra`').replace(/^\| \*\*qa\*\*.*\n/m, ''));
  const doctor = await diagnoseAntigravity({ project: box.project, home: box.home });
  assert.equal(doctor.ok, false);
  assert.ok(doctor.issues.includes('Project Lead rule tier for planner "ultra" is invalid; rerun the installer to choose one explicitly.'), doctor.issues.join('\n'));
  assert.ok(doctor.issues.includes('Project Lead rule tier for qa is missing; rerun the installer to choose one explicitly.'));
});

test('Antigravity update uses the same per-role tier prompts', async t => {
  const box = sandbox(t);
  assert.equal(await install(box, answers().ask), 0);
  const { ask, prompts } = answers({ researcher: 'pro' });
  const status = await runUpdateFlow({ scope: 'project', project: box.project, host: 'antigravity' }, {
    ask, output: () => {}, error: () => {}, home: box.home, recoveryDirectory: box.recovery,
    agentsDirectory: rolesDir, workflowCommandsDirectory: commandsDir,
    sharedLocations: async () => 'skipped' as const,
  });
  assert.equal(status, 0);
  assert.equal(prompts.filter(question => tierPrompt(question)).length, 7);
  assert.equal(parseAntigravityLeadRuleTiers(readFileSync(box.rule, 'utf8')).researcher, 'pro');
});
