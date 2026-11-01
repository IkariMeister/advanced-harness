import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRoot } from './temp-directory.ts';
import { checkNames, prepareSetup, runSetupFlow, runSharedLocationStep, validateProfile, type ProjectProfile } from '../src/project-setup.ts';
import { contextData, hasContextSection, removeContext, updateContext } from '../src/project-context.ts';
import { createSharedLocations, defaultLocations, planSharedLocations, projectId, validateLocations, validatePathsSettings } from '../src/shared-locations.ts';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import { nativeRoles } from '../src/native-installer.ts';
import { compileLeadOrchestrationRule } from '../src/antigravity-compiler.ts';
import { loadRoleDefinitions } from '../src/role-definitions.ts';
import { fileURLToPath } from 'node:url';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = makeTempRoot('harness-shared-locations-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'app');
  const home = join(root, 'home');
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(home);
  return { root, project, home, backups: join(root, 'backups') };
}
function profile(project: string, root: string): ProjectProfile {
  return { version: 1, projectRoot: project, baseBranch: 'main', shell: 'bash', checks: Object.fromEntries(checkNames.map(name => [name, { status: 'unconfigured' }])) as ProjectProfile['checks'], device: { preference: 'ask' }, worktreeDirectory: join(root, 'trees'), memoryPath: join(root, 'data', 'MEMORY.md') };
}
/** Scripted prompts: each entry is [question prefix, answer]; any other prompt fails the test. */
function script(steps: [string, string][]) {
  const prompts: string[] = [];
  const ask = async (question: string) => {
    prompts.push(question);
    const step = steps.shift();
    assert.ok(step && question.startsWith(step[0]), `unexpected prompt: ${question} (expected ${step?.[0]})`);
    return step[1];
  };
  return { ask, prompts, remaining: steps };
}

test('default locations are per project, outside the checkout, and validated', t => {
  const { project, home } = fixture(t);
  const defaults = defaultLocations(project, {}, home);
  assert.equal(defaults.worktreeDirectory, join(home, 'Projects', 'advanced-harness-worktrees', projectId(project)));
  assert.equal(defaults.memoryPath, join(home, 'Projects', 'advanced-harness-data', projectId(project), 'MEMORY.md'));
  assert.deepEqual(defaultLocations(project, { worktreeParentDirectory: join(home, 'w'), memoryParentDirectory: join(home, 'm') }, home).memoryPath, join(home, 'm', projectId(project), 'MEMORY.md'));
  assert.deepEqual(validatePathsSettings(project, { version: 1, ...defaults }), { version: 1, ...defaults });
  for (const bad of [{ ...defaults }, { version: 1, ...defaults, extra: true }, { version: 1, ...defaults, memoryPath: join(project, 'MEMORY.md') }, { version: 1, ...defaults, memoryPath: join(home, 'notes.md') }, { version: 1, ...defaults, memoryPath: join(defaults.worktreeDirectory, 'MEMORY.md') }]) assert.throws(() => validatePathsSettings(project, bad), JSON.stringify(bad));
});

test('location plan creates only missing locations and never overwrites MEMORY.md', t => {
  const { root, project } = fixture(t);
  const locations = { worktreeDirectory: join(root, 'trees'), memoryPath: join(root, 'data', 'MEMORY.md') };
  const plan = planSharedLocations(project, locations);
  assert.deepEqual(plan, { projectRoot: project, locations, directories: [locations.worktreeDirectory, join(root, 'data')], memoryFile: locations.memoryPath });
  assert.deepEqual(createSharedLocations(plan), [locations.worktreeDirectory, join(root, 'data'), locations.memoryPath]);
  assert.equal(readFileSync(locations.memoryPath, 'utf8'), '# Shared Operator memory\n\n');
  writeFileSync(locations.memoryPath, '# Shared Operator memory\n\n- kept\n');
  assert.deepEqual(planSharedLocations(project, locations), { projectRoot: project, locations, directories: [] });
  assert.throws(() => createSharedLocations({ projectRoot: project, locations, directories: [], memoryFile: locations.memoryPath }), /left untouched/);
  assert.equal(readFileSync(locations.memoryPath, 'utf8'), '# Shared Operator memory\n\n- kept\n');
  rmSync(locations.worktreeDirectory, { recursive: true });
  writeFileSync(locations.worktreeDirectory, 'not a directory');
  assert.throws(() => planSharedLocations(project, locations), /not a regular directory/);
});

/** Directory link that needs no OS privilege on Windows (junction); skips where links are not allowed. */
function link(t: { skip: (message: string) => void }, target: string, path: string): boolean {
  try { symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir'); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Directory links require OS privilege'); return false; } throw error; }
}

test('linked ancestors that land inside the checkout are rejected before planning and creating anything', t => {
  const { root, project } = fixture(t);
  if (!link(t, project, join(root, 'via-link'))) return;
  const throughLink = { worktreeDirectory: join(root, 'trees'), memoryPath: join(root, 'via-link', 'data', 'MEMORY.md') };
  validateLocations(project, throughLink); // The lexical check alone is fooled.
  assert.throws(() => planSharedLocations(project, throughLink), /symlinks\/junctions are resolved/);
  assert.throws(() => planSharedLocations(project, { worktreeDirectory: join(root, 'via-link', 'trees'), memoryPath: join(root, 'data', 'MEMORY.md') }), /symlinks\/junctions are resolved/);
  assert.equal(existsSync(join(project, 'data')) || existsSync(join(project, 'trees')), false);
  // A linked checkout path is resolved the same way, so legitimate outside paths still pass.
  if (!link(t, project, join(root, 'app-link'))) return;
  assert.equal(planSharedLocations(join(root, 'app-link'), { worktreeDirectory: join(root, 'trees'), memoryPath: join(root, 'data', 'MEMORY.md') }).memoryFile, join(root, 'data', 'MEMORY.md'));
});

test('creation revalidates when an ancestor is swapped for a link after the preview', t => {
  const { root, project } = fixture(t);
  const locations = { worktreeDirectory: join(root, 'trees'), memoryPath: join(root, 'shared', 'data', 'MEMORY.md') };
  mkdirSync(join(root, 'shared'));
  const plan = planSharedLocations(project, locations);
  rmSync(join(root, 'shared'), { recursive: true });
  if (!link(t, project, join(root, 'shared'))) return;
  assert.throws(() => createSharedLocations(plan), /symlinks\/junctions are resolved/);
  assert.equal(existsSync(join(project, 'data')), false, 'nothing created inside the checkout');
  assert.equal(existsSync(locations.worktreeDirectory), false, 'nothing created at all');
});

test('setup and update refuse linked memory paths that land inside the checkout', async t => {
  const { root, project, home, backups } = fixture(t);
  if (!link(t, project, join(root, 'via-link'))) return;
  const inside = join(root, 'via-link', 'data', 'MEMORY.md');
  const original = '# App rules\n';
  writeFileSync(join(project, 'AGENTS.md'), original);
  await assert.rejects(runSetupFlow({ project }, {
    ask: async (question, suggested) => question.startsWith('Shared MEMORY.md') ? inside : question.startsWith('Command shell') ? 'bash' : question.startsWith('Full preview') ? 'save' : suggested ?? '',
    output: () => {}, error: () => {}, home, xdgConfigHome: join(root, 'xdg'), recoveryDirectory: backups,
  }), /symlinks\/junctions are resolved/);
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), original);
  assert.equal(existsSync(join(project, 'data')) || existsSync(backups), false);

  writeFileSync(join(project, 'AGENTS.md'), updateContext(original, 'paths', { version: 1, worktreeDirectory: join(root, 'trees'), memoryPath: join(root, 'data', 'MEMORY.md') }, ['interim']));
  const outputs: string[] = [];
  const steps = script([['Parent directory', ''], ['Shared MEMORY.md', inside], ['Parent directory', ''], ['Shared MEMORY.md', ''], ['Type paths', 'paths']]);
  assert.equal(await runSharedLocationStep(project, { ask: steps.ask, output: message => outputs.push(message), home, backupParent: backups }), 'saved');
  assert.match(outputs.join('\n'), /symlinks\/junctions are resolved\. No files changed\. Enter different paths\./);
  assert.equal(existsSync(join(project, 'data')), false);
  assert.equal(readFileSync(join(root, 'data', 'MEMORY.md'), 'utf8'), '# Shared Operator memory\n\n');
});

test('paths sections can be detected and removed without disturbing other instructions', () => {
  const original = '# Rules\r\nKeep.\r\n';
  const withPaths = updateContext(original, 'paths', { version: 1, worktreeDirectory: '/x', memoryPath: '/y/MEMORY.md' }, ['note']);
  assert.ok(hasContextSection(withPaths, 'paths'));
  assert.equal(removeContext(withPaths, 'paths'), original);
  assert.equal(removeContext(original, 'paths'), original);
  assert.ok(hasContextSection('<!-- advanced-harness:project:start -->\nlegacy\n<!-- advanced-harness:project:end -->', 'project'));
});

test('setup lists missing locations, creates them only on save, and supersedes an interim paths section', async t => {
  const { root, project, home, backups } = fixture(t);
  const recorded = { worktreeDirectory: join(root, 'recorded-trees'), memoryPath: join(root, 'recorded', 'MEMORY.md') };
  const original = updateContext('# App rules\n', 'paths', { version: 1, ...recorded }, ['interim']);
  writeFileSync(join(project, 'AGENTS.md'), original);
  for (const confirmation of ['', 'save']) {
    const outputs: string[] = [];
    const shown: Record<string, string | undefined> = {};
    await runSetupFlow({ project }, {
      ask: async (question, suggested) => { shown[question] = suggested; return question.startsWith('Full preview') ? confirmation : question.startsWith('Command shell') ? 'bash' : ''; },
      output: message => outputs.push(message), error: message => outputs.push(message), home, xdgConfigHome: join(root, 'xdg'), recoveryDirectory: backups,
    });
    assert.equal(shown['Parent directory for future worktrees (outside the checkout)'], recorded.worktreeDirectory);
    assert.equal(shown['Shared MEMORY.md path (outside checkout/worktrees)'], recorded.memoryPath);
    assert.ok(outputs.includes(`  ${recorded.memoryPath} (new shared MEMORY.md, header only)`));
    if (!confirmation) {
      assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), original);
      assert.equal(existsSync(recorded.memoryPath) || existsSync(recorded.worktreeDirectory) || existsSync(backups), false);
    }
  }
  const saved = readFileSync(join(project, 'AGENTS.md'), 'utf8');
  assert.equal(hasContextSection(saved, 'paths'), false);
  assert.equal(validateProfile(contextData(saved, 'project')).memoryPath, recorded.memoryPath);
  assert.ok(saved.includes('never search the workspace for MEMORY.md'));
  assert.equal(readFileSync(recorded.memoryPath, 'utf8'), '# Shared Operator memory\n\n');
  assert.ok(existsSync(recorded.worktreeDirectory));
});

test('update step points never-configured projects to setup without prompting', async t => {
  const { project, home, backups } = fixture(t);
  const outputs: string[] = [];
  const status = await runSharedLocationStep(project, { ask: async question => assert.fail(question), output: message => outputs.push(message), home, backupParent: backups });
  assert.equal(status, 'skipped');
  assert.match(outputs.join('\n'), /Run harness:setup/);
});

test('update step: legacy profile paths are used only after migrate; Enter at the preview writes nothing', async t => {
  const { root, project, home, backups } = fixture(t);
  const agents = '# App\n\n<!-- advanced-harness:project:start -->\nRead `.opencode/harness.project.json` before planning.\n<!-- advanced-harness:project:end -->\n';
  writeFileSync(join(project, 'AGENTS.md'), agents);
  mkdirSync(join(project, '.opencode'));
  const legacy = profile(project, root);
  writeFileSync(join(project, '.opencode', 'harness.project.json'), JSON.stringify(legacy));
  const declined = script([['Type migrate', 'no'], ['Parent directory', ''], ['Shared MEMORY.md', ''], ['Type paths', '']]);
  const outputs: string[] = [];
  assert.equal(await runSharedLocationStep(project, { ask: declined.ask, output: message => outputs.push(message), home, backupParent: backups }), 'skipped');
  assert.ok(outputs.includes(`  ${defaultLocations(project, {}, home).memoryPath} (new shared MEMORY.md, header only)`), 'defaults suggested without migrate');
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), agents);
  assert.equal(existsSync(join(home, 'Projects')) || existsSync(backups), false);

  const migrated = script([['Type migrate', 'migrate'], ['Parent directory', ''], ['Shared MEMORY.md', ''], ['Type paths', 'paths']]);
  assert.equal(await runSharedLocationStep(project, { ask: migrated.ask, output: () => {}, home, backupParent: backups }), 'saved');
  const saved = readFileSync(join(project, 'AGENTS.md'), 'utf8');
  assert.ok(saved.startsWith(agents), 'legacy instructions preserved');
  assert.deepEqual(contextData(saved, 'paths'), { version: 1, worktreeDirectory: legacy.worktreeDirectory, memoryPath: legacy.memoryPath });
  assert.equal(readFileSync(legacy.memoryPath, 'utf8'), '# Shared Operator memory\n\n');
  assert.equal(readFileSync(join(project, '.opencode', 'harness.project.json'), 'utf8'), JSON.stringify(legacy), 'legacy file untouched');

  // Once recorded and present, repeat runs only confirm the paths and need no preview.
  const repeat = script([['Parent directory', ''], ['Shared MEMORY.md', '']]);
  assert.equal(await runSharedLocationStep(project, { ask: repeat.ask, output: () => {}, home, backupParent: backups }), 'current');
});

test('update step: embedded settings are confirmed, retried on invalid paths, and rewritten in a linked context file', async t => {
  const { root, project, home, backups } = fixture(t);
  mkdirSync(join(project, 'docs'));
  const context = join(project, 'docs', 'HARNESS.md');
  const settings = profile(project, root);
  for (const file of prepareSetup(project, settings, undefined, context)) writeFileSync(file.path, file.updated);
  const moved = join(root, 'shared', 'MEMORY.md');
  const outputs: string[] = [];
  const steps = script([['Parent directory', ''], ['Shared MEMORY.md', join(project, 'MEMORY.md')], ['Parent directory', ''], ['Shared MEMORY.md', moved], ['Type paths', 'paths']]);
  assert.equal(await runSharedLocationStep(project, { ask: steps.ask, output: message => outputs.push(message), home, backupParent: backups }), 'saved');
  assert.match(outputs.join('\n'), /outside the application checkout/);
  assert.equal(validateProfile(contextData(readFileSync(context, 'utf8'), 'project')).memoryPath, moved);
  assert.ok(existsSync(moved) && existsSync(settings.worktreeDirectory));
  assert.equal(existsSync(settings.memoryPath), false, 'old path is not created');
});

test('harness:update settles shared locations before the host update, independent of host cancellation', async t => {
  const { root, project, home } = fixture(t);
  writeFileSync(join(project, 'opencode.json'), JSON.stringify({ agents: Object.fromEntries(nativeRoles.map(role => [role, { description: 'd', mode: role === 'lead' ? 'primary' : 'subagent', model: 'custom/model#low', permissions: [], system: 'old' }])) }));
  const recorded = { worktreeDirectory: join(root, 'trees'), memoryPath: join(root, 'data', 'MEMORY.md') };
  writeFileSync(join(project, 'AGENTS.md'), updateContext('# App\n', 'paths', { version: 1, ...recorded }, ['interim']));
  const steps = script([['Parent directory', ''], ['Shared MEMORY.md', ''], ['Type paths', 'paths']]);
  const status = await runUpdateFlow({ scope: 'project', project, checkRemote: false }, {
    ask: async question => steps.remaining.length ? steps.ask(question) : question.includes('system prompt to latest') ? 'no' : question.startsWith('Choose new models') ? 'no' : question.startsWith('Type update') ? 'cancel' : assert.fail(question),
    output: () => {}, error: () => {}, home, xdgConfigHome: join(root, 'xdg'), recoveryDirectory: join(root, 'recovery'), runCommand: () => '',
  });
  assert.equal(status, 0);
  assert.equal(steps.remaining.length, 0);
  assert.equal(readFileSync(recorded.memoryPath, 'utf8'), '# Shared Operator memory\n\n');

  let called = 0;
  await runUpdateFlow({ scope: 'global', checkRemote: false }, {
    ask: async question => question.includes('system prompt to latest') ? 'no' : question.startsWith('Choose new models') ? 'no' : question.startsWith('Type update') ? 'cancel' : '',
    output: () => {}, error: () => {}, home, xdgConfigHome: join(root, 'xdg'), recoveryDirectory: join(root, 'recovery'), runCommand: () => '',
    sharedLocations: async () => { called++; return 'skipped'; },
  }).catch(() => undefined);
  assert.equal(called, 0, 'global scope has no project shared locations');
});

test('Antigravity Lead rule points agents at the recorded locations instead of the workspace', () => {
  const rule = compileLeadOrchestrationRule(loadRoleDefinitions(fileURLToPath(new URL('../agents/', import.meta.url))));
  assert.match(rule.content, /`worktreeDirectory`/);
  assert.match(rule.content, /`memoryPath`/);
  assert.match(rule.content, /never search the workspace for `MEMORY\.md`/);
});
