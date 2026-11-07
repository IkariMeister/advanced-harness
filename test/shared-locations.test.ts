import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { makeTempRoot } from './temp-directory.ts';
import { checkNames, prepareSetup, resolveProjectLocations, runSetupFlow, runSharedLocationStep, validateProfile, type ProjectProfile } from '../src/project-setup.ts';
import { contextData, hasContextSection, removeContext, updateContext } from '../src/project-context.ts';
import { createSharedLocations, defaultLocations, expandStoredPath, isPortablePath, legacyProjectId, legacyWorktreeLocations, mainCheckoutRoot, planSharedLocations, projectId, resolveLocationSettings, sameProject, toStoredPath, validateLocationShape, validateLocations, validatePathsSettings } from '../src/shared-locations.ts';
import { diagnoseSharedLocations } from '../src/shared-location-diagnostics.ts';
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
  const steps = script([['Parent directory', join(root, 'trees')], ['Shared MEMORY.md', inside], ['Parent directory', join(root, 'trees')], ['Shared MEMORY.md', join(root, 'data', 'MEMORY.md')], ['Type paths', 'paths']]);
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

  // Once recorded and present, repeat runs do not ask at all.
  assert.equal(await runSharedLocationStep(project, { ask: async question => assert.fail(question), output: () => {}, home, backupParent: backups }), 'current');
});

test('update step: asked to change, embedded settings are retried on invalid paths and rewritten in a linked context file', async t => {
  const { root, project, home, backups } = fixture(t);
  mkdirSync(join(project, 'docs'));
  const context = join(project, 'docs', 'HARNESS.md');
  const settings = profile(project, root);
  for (const file of prepareSetup(project, settings, undefined, context)) writeFileSync(file.path, file.updated);
  const moved = join(root, 'shared', 'MEMORY.md');
  const outputs: string[] = [];
  const steps = script([['Parent directory', ''], ['Shared MEMORY.md', join(project, 'MEMORY.md')], ['Parent directory', ''], ['Shared MEMORY.md', moved], ['Type paths', 'paths']]);
  assert.equal(await runSharedLocationStep(project, { ask: steps.ask, output: message => outputs.push(message), home, backupParent: backups, changeLocations: true }), 'saved');
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
  const steps = script([['Parent directory', recorded.worktreeDirectory], ['Shared MEMORY.md', recorded.memoryPath], ['Type paths', 'paths']]);
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
  assert.match(rule.content, /Do not ask about valid configured values/);
});

test('role sources, compiled for every host, carry the read-do-not-ask rule and drop the "agreed" wording', () => {
  const roles = loadRoleDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));
  const compact = (text: string) => text.replace(/\s+/g, ' ');
  assert.match(compact(roles.operator.instructions), /A valid configured value settles the question: do not ask about it\./);
  assert.match(compact(roles.operator.instructions), /Never search the workspace for MEMORY\.md or create one there\./);
  assert.match(compact(roles.lead.instructions), /do not ask about valid configured values/);
  for (const role of Object.values(roles)) assert.doesNotMatch(compact(role.instructions), /agreed (shared MEMORY|worktree)/, role.id);
  const command = readFileSync(new URL('../commands/start-issue.md', import.meta.url), 'utf8');
  assert.match(command, /do not ask about valid values/);
});

/** A real repository with a linked worktree, so identity is tested against what Git writes. */
function gitProject(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(makeTempRoot('harness-shared-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const main = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(main);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe' });
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'README.md'), 'x\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  const parent = join(home, 'trees');
  mkdirSync(parent);
  const worktree = join(parent, 'task-a');
  git(main, 'worktree', 'add', '-q', '-b', 'task-a', worktree);
  const second = join(parent, 'task-b');
  git(main, 'worktree', 'add', '-q', '-b', 'task-b', second);
  return { root, home, main, parent, worktree, second, git, backups: join(root, 'backups') };
}

test('all worktrees of a repository share one project ID; the main checkout keeps its ID; clones stay separate', t => {
  const { root, home, main, worktree, second, git } = gitProject(t);
  assert.equal(mainCheckoutRoot(worktree), main);
  assert.equal(mainCheckoutRoot(main), main);
  assert.equal(projectId(worktree), projectId(main));
  assert.equal(projectId(second), projectId(main));
  assert.equal(projectId(main), legacyProjectId(main), 'the main checkout keeps its existing ID, so its memory is still found');
  assert.notEqual(legacyProjectId(worktree), projectId(worktree));
  assert.deepEqual(defaultLocations(worktree, {}, home), defaultLocations(main, {}, home));
  assert.ok(sameProject(worktree, second));

  const clone = join(root, 'clone');
  git(root, 'clone', '-q', main, clone);
  assert.notEqual(projectId(clone), projectId(main));
  assert.equal(sameProject(clone, main), false);

  const plain = join(root, 'not-git');
  mkdirSync(plain);
  assert.equal(mainCheckoutRoot(plain), plain);
  assert.equal(projectId(plain), legacyProjectId(plain));
});

test('a broken .git file falls back to the checkout itself rather than guessing another project', t => {
  const { root } = fixture(t);
  const broken = join(root, 'broken');
  mkdirSync(broken);
  for (const content of ['not a pointer\n', 'gitdir: missing/dir\n']) {
    writeFileSync(join(broken, '.git'), content);
    assert.equal(mainCheckoutRoot(broken), broken);
  }
  // A submodule's git directory has no commondir, so it remains its own project.
  mkdirSync(join(root, 'modules', 'sub'), { recursive: true });
  writeFileSync(join(broken, '.git'), `gitdir: ${join(root, 'modules', 'sub')}\n`);
  assert.equal(mainCheckoutRoot(broken), broken);
});

test('portable paths expand per machine, refuse traversal, and only paths under home become portable', () => {
  const home = resolve('/home-a');
  assert.equal(isPortablePath('$HOME/data/MEMORY.md'), true);
  assert.equal(isPortablePath('$HOME/../other/MEMORY.md'), false);
  assert.equal(isPortablePath('$HOME'), false);
  assert.equal(expandStoredPath('$HOME/data/MEMORY.md', home), join(home, 'data', 'MEMORY.md'));
  assert.equal(expandStoredPath('$HOME/data/MEMORY.md', resolve('/home-b')), join(resolve('/home-b'), 'data', 'MEMORY.md'));
  assert.equal(toStoredPath(join(home, 'data', 'MEMORY.md'), home), '$HOME/data/MEMORY.md');
  assert.equal(toStoredPath(resolve('/elsewhere/MEMORY.md'), home), resolve('/elsewhere/MEMORY.md'));
  assert.equal(toStoredPath(home, home), home);
  for (const memoryPath of ['$HOME/../MEMORY.md', 'data/MEMORY.md', '~/MEMORY.md']) {
    assert.throws(() => validateLocationShape({ worktreeDirectory: '$HOME/trees', memoryPath }, home), /absolute or start with \$HOME/);
  }
});

test('committed settings resolve identically from every worktree, including one under the worktree parent', t => {
  const { home, main, parent, worktree, second } = gitProject(t);
  const stored = { worktreeDirectory: '$HOME/trees', memoryPath: '$HOME/data/MEMORY.md' };
  const expected = { worktreeDirectory: parent, memoryPath: join(home, 'data', 'MEMORY.md') };
  for (const checkout of [main, worktree, second]) {
    writeFileSync(join(checkout, 'AGENTS.md'), updateContext('# App\n', 'project', { ...profile(main, home), projectRoot: undefined, ...stored }, ['note']));
    const resolution = resolveProjectLocations(checkout, home);
    assert.equal(resolution.status, 'resolved', JSON.stringify(resolution));
    if (resolution.status !== 'resolved') continue;
    assert.deepEqual(resolution.locations, expected);
    assert.equal(resolution.source, 'project');
    assert.equal(resolution.portable, true);
  }
});

test('absolute settings saved for the main checkout work from a worktree; a location inside the worktree does not', t => {
  const { home, main, parent, worktree } = gitProject(t);
  const settings = { ...profile(main, home), worktreeDirectory: parent, memoryPath: join(home, 'data', 'MEMORY.md') };
  assert.equal(resolveLocationSettings(worktree, { project: settings }, home).status, 'resolved');
  assert.equal(resolveLocationSettings(main, { project: settings }, home).status, 'resolved');
  assert.equal(resolveLocationSettings(worktree, { project: { ...settings, memoryPath: join(worktree, 'MEMORY.md') } }, home).status, 'invalid');
  assert.equal(resolveLocationSettings(worktree, { project: { ...settings, projectRoot: join(parent, 'long-gone') } }, home).status, 'conflict', 'a removed legacy worktree root cannot be proven local, so it stops and asks');
});

test('another machine\'s absolute settings never take effect and are never created', t => {
  const { root, project, home } = fixture(t);
  const foreign = { worktreeDirectory: join(root, 'teammate', 'trees'), memoryPath: join(root, 'teammate', 'data', 'MEMORY.md') };
  const project_ = resolveLocationSettings(project, { project: { ...foreign, projectRoot: join(root, 'teammate', 'app') } }, home);
  assert.equal(project_.status, 'conflict');
  assert.match((project_ as { reason: string }).reason, /not this repository on this machine/);
  const paths = resolveLocationSettings(project, { paths: foreign }, home);
  assert.equal(paths.status, 'conflict');
  assert.match((paths as { reason: string }).reason, /does not exist on this machine/);
  assert.equal(existsSync(join(root, 'teammate')), false);
  // A Windows path committed to a repository opened elsewhere is foreign, not a relative path.
  const windows = { worktreeDirectory: 'C:/Users/teammate/trees', memoryPath: 'C:/Users/teammate/data/MEMORY.md' };
  validateLocationShape(windows, home);
  if (process.platform !== 'win32') assert.equal(resolveLocationSettings(project, { paths: windows }, home).status, 'conflict');
  assert.equal(resolveLocationSettings(project, {}, home).status, 'missing');
  assert.equal(resolveLocationSettings(project, { project: { worktreeDirectory: '$HOME/a', memoryPath: '$HOME/m/MEMORY.md' }, paths: { worktreeDirectory: '$HOME/b', memoryPath: '$HOME/m/MEMORY.md' } }, home).status, 'conflict');
  assert.equal(resolveLocationSettings(project, { project: { worktreeDirectory: '$HOME/a', memoryPath: '$HOME/m/MEMORY.md' }, paths: { worktreeDirectory: join(home, 'a'), memoryPath: join(home, 'm', 'MEMORY.md') } }, home).status, 'resolved', 'the same place in two forms is not a conflict');
});

test('portable locations are still checked after links are resolved', t => {
  const { root, project, home } = fixture(t);
  if (!link(t, project, join(home, 'via-link'))) return;
  const resolution = resolveLocationSettings(project, { paths: { worktreeDirectory: '$HOME/trees', memoryPath: '$HOME/via-link/data/MEMORY.md' } }, home);
  assert.equal(resolution.status, 'invalid');
  assert.match((resolution as { reason: string }).reason, /symlinks\/junctions are resolved/);
  assert.equal(existsSync(join(project, 'data')) || existsSync(join(root, 'trees')), false);
});

test('update flow: valid settings are not asked about from any worktree; a missing location asks only to create it', async t => {
  const { home, main, parent, worktree, backups } = gitProject(t);
  const memoryPath = join(home, 'data', 'MEMORY.md');
  const stored = { worktreeDirectory: '$HOME/trees', memoryPath: '$HOME/data/MEMORY.md' };
  const { projectRoot: _unused, ...portable } = { ...profile(main, home), ...stored };
  writeFileSync(join(worktree, 'AGENTS.md'), updateContext('# App\n', 'project', portable, ['note']));
  const original = readFileSync(join(worktree, 'AGENTS.md'), 'utf8');

  // Missing MEMORY.md: Enter skips, with no writes or backups.
  const skipped = script([['Type paths', '']]);
  const outputs: string[] = [];
  assert.equal(await runSharedLocationStep(worktree, { ask: skipped.ask, output: message => outputs.push(message), home, backupParent: backups }), 'skipped');
  assert.ok(outputs.includes(`  ${memoryPath} (new shared MEMORY.md, header only)`));
  assert.doesNotMatch(outputs.join('\n'), /another checkout/);
  assert.equal(existsSync(memoryPath) || existsSync(backups), false);

  const created = script([['Type paths', 'paths']]);
  assert.equal(await runSharedLocationStep(worktree, { ask: created.ask, output: () => {}, home, backupParent: backups }), 'saved');
  assert.equal(readFileSync(memoryPath, 'utf8'), '# Shared Operator memory\n\n');
  assert.equal(readFileSync(join(worktree, 'AGENTS.md'), 'utf8'), original);

  const quiet: string[] = [];
  assert.equal(await runSharedLocationStep(worktree, { ask: async question => assert.fail(question), output: message => quiet.push(message), home, backupParent: backups }), 'current');
  assert.match(quiet.join('\n'), new RegExp(`recorded and present: \\$HOME/trees \\(on this machine: ${parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
  assert.equal(existsSync(backups), false);
});

test('update flow: --change-shared-locations reopens prompts, Enter keeps the saved form, and cancelling writes nothing', async t => {
  const { root, project, home, backups } = fixture(t);
  const settings = profile(project, root);
  const original = updateContext('# App\n', 'project', settings, ['note']);
  writeFileSync(join(project, 'AGENTS.md'), original);
  mkdirSync(settings.worktreeDirectory, { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(settings.memoryPath, '# Shared Operator memory\n\n');

  const keep = script([['Parent directory', ''], ['Shared MEMORY.md', '']]);
  assert.equal(await runSharedLocationStep(project, { ask: keep.ask, output: () => {}, home, backupParent: backups, changeLocations: true }), 'current');
  assert.equal(keep.remaining.length, 0);
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), original);

  const moved = join(home, 'moved', 'MEMORY.md');
  const cancelled = script([['Parent directory', ''], ['Shared MEMORY.md', moved], ['Type paths', '']]);
  assert.equal(await runSharedLocationStep(project, { ask: cancelled.ask, output: () => {}, home, backupParent: backups, changeLocations: true }), 'skipped');
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), original);
  assert.equal(existsSync(moved) || existsSync(backups), false, 'cancelling leaves no writes or backups');

  // Explicitly typing a $HOME path is the consent that converts one location to the portable form.
  const converted = script([['Parent directory', ''], ['Shared MEMORY.md', '$HOME/moved/MEMORY.md'], ['Type paths', 'paths']]);
  assert.equal(await runSharedLocationStep(project, { ask: converted.ask, output: () => {}, home, backupParent: backups, changeLocations: true }), 'saved');
  const saved = validateProfile(contextData(readFileSync(join(project, 'AGENTS.md'), 'utf8'), 'project'), home);
  assert.equal(saved.memoryPath, '$HOME/moved/MEMORY.md');
  assert.equal(saved.worktreeDirectory, settings.worktreeDirectory, 'the other absolute location is kept');
  assert.equal(saved.projectRoot, project, 'a remaining absolute location keeps its projectRoot');
  assert.ok(existsSync(moved));
});

test('update flow: a foreign profile asks, suggests this machine\'s defaults, and saves portable settings without projectRoot', async t => {
  const { root, project, home, backups } = fixture(t);
  const foreign = { ...profile(join(root, 'teammate', 'app'), join(root, 'teammate')) };
  const original = updateContext('# App\n', 'project', foreign, ['note']);
  writeFileSync(join(project, 'AGENTS.md'), original);
  const shown: (string | undefined)[] = [];
  const answers = (answer: string) => async (question: string, suggested?: string) => {
    shown.push(suggested);
    return question.startsWith('Type paths') ? answer : '';
  };
  const outputs: string[] = [];
  assert.equal(await runSharedLocationStep(project, { ask: answers(''), output: message => outputs.push(message), home, backupParent: backups }), 'skipped');
  assert.match(outputs.join('\n'), /not this repository on this machine/);
  const defaults = defaultLocations(project, {}, home);
  assert.deepEqual(shown.slice(0, 2), [defaults.worktreeDirectory, defaults.memoryPath]);
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), original);
  assert.equal(existsSync(join(root, 'teammate')) || existsSync(backups), false);

  assert.equal(await runSharedLocationStep(project, { ask: answers('paths'), output: () => {}, home, backupParent: backups }), 'saved');
  const saved = validateProfile(contextData(readFileSync(join(project, 'AGENTS.md'), 'utf8'), 'project'), home);
  assert.equal(saved.projectRoot, undefined);
  assert.ok(isPortablePath(saved.memoryPath) && isPortablePath(saved.worktreeDirectory));
  assert.equal(existsSync(defaults.memoryPath), true);
  assert.equal(existsSync(join(root, 'teammate')), false);
});

test('update flow: unverified absolute interim paths are not suggested or retained; cancellation writes nothing', async t => {
  const { root, project, home, backups } = fixture(t);
  const foreign = { worktreeDirectory: join(root, 'teammate', 'trees'), memoryPath: join(root, 'teammate', 'data', 'MEMORY.md') };
  const original = updateContext('# App\n', 'paths', { version: 1, ...foreign }, ['note']);
  writeFileSync(join(project, 'AGENTS.md'), original);

  const defaults = defaultLocations(project, {}, home);
  const suggestions: (string | undefined)[] = [];
  const choices = script([['Parent directory', ''], ['Shared MEMORY.md', ''], ['Type paths', '']]);
  const ask = async (question: string, suggested?: string) => { suggestions.push(suggested); return choices.ask(question); };
  const outputs: string[] = [];
  assert.equal(await runSharedLocationStep(project, { ask, output: message => outputs.push(message), home, backupParent: backups }), 'skipped');
  assert.deepEqual(choices.remaining, []);
  assert.deepEqual(suggestions.slice(0, 2), [defaults.worktreeDirectory, defaults.memoryPath]);
  assert.match(outputs.join('\n'), /does not exist on this machine/);
  assert.deepEqual(choices.prompts.length, 3);
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), original);
  assert.equal(existsSync(join(root, 'teammate')) || existsSync(defaults.worktreeDirectory) || existsSync(backups), false);
});

test('update flow: unverified interim paths are replaced only after explicit confirmation', async t => {
  const { root, project, home, backups } = fixture(t);
  const foreign = { worktreeDirectory: join(root, 'teammate', 'trees'), memoryPath: join(root, 'teammate', 'data', 'MEMORY.md') };
  const original = updateContext('# App\n', 'paths', { version: 1, ...foreign }, ['note']);
  writeFileSync(join(project, 'AGENTS.md'), original);

  const defaults = defaultLocations(project, {}, home);
  const choices = script([['Parent directory', ''], ['Shared MEMORY.md', ''], ['Type paths', 'paths']]);
  assert.equal(await runSharedLocationStep(project, { ask: choices.ask, output: () => {}, home, backupParent: backups }), 'saved');
  const saved = contextData(readFileSync(join(project, 'AGENTS.md'), 'utf8'), 'paths') as { worktreeDirectory: string; memoryPath: string };
  assert.equal(saved.worktreeDirectory, toStoredPath(defaults.worktreeDirectory, home));
  assert.equal(saved.memoryPath, toStoredPath(defaults.memoryPath, home));
  assert.equal(existsSync(join(root, 'teammate')), false);
  assert.equal(existsSync(backups), true);
  assert.equal(existsSync(defaults.worktreeDirectory), true);
  assert.equal(readFileSync(defaults.memoryPath, 'utf8'), '# Shared Operator memory\n\n');
});

test('setup from a worktree saves portable settings without machine paths and works from a sibling', async t => {
  const { root, home, main, parent, worktree, second, backups } = gitProject(t);
  const outputs: string[] = [];
  const ask = (confirmation: string) => async (question: string) => question.startsWith('Full preview') ? confirmation : question.startsWith('Command shell') ? 'bash' : question.startsWith('Parent directory') ? parent : '';
  const options = { output: (message: string) => outputs.push(message), error: () => {}, home, xdgConfigHome: join(root, 'xdg'), recoveryDirectory: backups };

  await runSetupFlow({ project: worktree }, { ask: ask(''), ...options });
  assert.equal(existsSync(join(worktree, 'AGENTS.md')) || existsSync(backups), false, 'cancelling leaves no writes or backups');
  assert.equal(existsSync(defaultLocations(main, {}, home).memoryPath), false);

  await runSetupFlow({ project: worktree }, { ask: ask('save'), ...options });
  const text = readFileSync(join(worktree, 'AGENTS.md'), 'utf8');
  const saved = validateProfile(contextData(text, 'project'), home);
  assert.equal(saved.projectRoot, undefined);
  assert.equal(saved.worktreeDirectory, '$HOME/trees');
  assert.ok(!text.includes(home), 'no machine path reaches the committed section');
  assert.match(outputs.join('\n'), /Worktree parent: \$HOME\/trees \(on this machine: /);
  assert.equal(readFileSync(defaultLocations(main, {}, home).memoryPath, 'utf8'), '# Shared Operator memory\n\n', 'the same memory file for every worktree');

  writeFileSync(join(second, 'AGENTS.md'), text);
  assert.equal(await runSharedLocationStep(second, { ask: async question => assert.fail(question), output: () => {}, home, backupParent: backups }), 'current');
});

test('existing memory under a worktree\'s old ID is offered only after migrate and never moved', async t => {
  const { home, main, worktree, parent, backups } = gitProject(t);
  const legacy = join(home, 'Projects', 'advanced-harness-data', legacyProjectId(worktree), 'MEMORY.md');
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, '# Shared Operator memory\n\n- kept\n');
  assert.equal(legacyWorktreeLocations(worktree, {}, home)?.memoryPath, legacy);
  assert.equal(legacyWorktreeLocations(main, {}, home), undefined);

  writeFileSync(join(worktree, 'AGENTS.md'), '# App\n\n<!-- advanced-harness:project:start -->\nlegacy\n<!-- advanced-harness:project:end -->\n');
  const original = readFileSync(join(worktree, 'AGENTS.md'), 'utf8');
  const suggestions: (string | undefined)[] = [];
  const run = (migrate: string, confirm: string) => runSharedLocationStep(worktree, {
    ask: async (question, suggested) => {
      suggestions.push(suggested);
      if (question.startsWith('Type migrate')) return migrate;
      if (question.startsWith('Parent directory')) return parent;
      return question.startsWith('Type paths') ? confirm : '';
    },
    output: () => {}, home, backupParent: backups,
  });
  assert.equal(await run('no', ''), 'skipped');
  assert.ok(suggestions.includes(defaultLocations(worktree, {}, home).memoryPath));
  assert.ok(!suggestions.includes(legacy));
  assert.equal(readFileSync(join(worktree, 'AGENTS.md'), 'utf8'), original);
  assert.equal(existsSync(backups), false);

  suggestions.length = 0;
  assert.equal(await run('migrate', 'paths'), 'saved');
  assert.ok(suggestions.includes(legacy));
  assert.equal(readFileSync(legacy, 'utf8'), '# Shared Operator memory\n\n- kept\n', 'existing memory is reused untouched');
  assert.equal(contextData(readFileSync(join(worktree, 'AGENTS.md'), 'utf8'), 'paths') !== undefined, true);
});

test('doctor reports each resolved path and source, notes missing settings, and fails invalid and conflicting ones', t => {
  const { root, project, home } = fixture(t);
  const missing = diagnoseSharedLocations(project, { home });
  assert.equal(missing.status, 'not-configured');
  assert.deepEqual(missing.issues, [], 'missing settings never fail doctor');
  assert.match(missing.notes[0]!, /Run harness:setup/);

  writeFileSync(join(project, 'AGENTS.md'), updateContext('# App\n', 'paths', { version: 1, worktreeDirectory: '$HOME/trees', memoryPath: '$HOME/data/MEMORY.md' }, ['note']));
  const portable = diagnoseSharedLocations(project, { home });
  assert.equal(portable.status, 'resolved');
  assert.deepEqual(portable.issues, []);
  assert.match(portable.notes[0]!, /Worktree parent: .*trees \(source: interim paths section, saved as \$HOME\/trees\)/);
  assert.match(portable.notes[1]!, /Shared memory: .*MEMORY\.md \(source: interim paths section, saved as \$HOME\/data\/MEMORY\.md\)/);
  assert.match(portable.notes.join('\n'), /does not exist yet/);
  assert.equal(existsSync(join(home, 'trees')), false, 'doctor creates nothing');

  const settings = profile(project, root);
  writeFileSync(join(project, 'AGENTS.md'), updateContext('# App\n', 'project', settings, ['note']));
  const absolute = diagnoseSharedLocations(project, { home });
  assert.match(absolute.notes[0]!, /source: project section, saved as an absolute path/);
  assert.match(absolute.notes.join('\n'), /specific to this machine/);

  writeFileSync(join(project, 'AGENTS.md'), updateContext('# App\n', 'project', { ...settings, projectRoot: join(root, 'other') }, ['note']));
  const foreign = diagnoseSharedLocations(project, { home });
  assert.equal(foreign.status, 'conflict');
  assert.match(foreign.issues[0]!, /not this repository on this machine/);

  writeFileSync(join(project, 'AGENTS.md'), '<!-- advanced-harness:paths:start -->\n```json\n{"version":1,"worktreeDirectory":"relative","memoryPath":"x/MEMORY.md"}\n```\n<!-- advanced-harness:paths:end -->\n');
  assert.equal(diagnoseSharedLocations(project, { home }).status, 'invalid');
});

test('harness:doctor prints the shared-location report and exits 1 on a conflict', t => {
  const { root, project, home } = fixture(t);
  writeFileSync(join(project, 'AGENTS.md'), updateContext('# App\n', 'project', { ...profile(project, root), projectRoot: join(root, 'other') }, ['note']));
  const script = fileURLToPath(new URL('../scripts/diagnose-native-harness.ts', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--project', project, '--scope', 'project', '--host', 'cursor'], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') } });
  assert.match(result.stdout, /Shared locations: conflict/);
  assert.match(result.stderr, /FAIL: .*not this repository on this machine/);
  assert.equal(result.status, 1);
});
