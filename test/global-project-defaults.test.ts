import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeTempRoot } from './temp-directory.ts';
import { emptyGlobalProjectDefaults, globalDefaultsNotice, lookupGlobalDefaults, parseGlobalProjectDefaults, runSetupFlow, type GlobalProjectDefaults, type SetupFlowOptions } from '../src/project-setup.ts';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import { nativeRoles } from '../src/native-installer.ts';

const MIGRATE = 'Type migrate';
const CONFIRM = 'Full preview';

function fixture(t: TestContext) {
  const root = makeTempRoot('harness-global-defaults-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), xdg = join(root, 'xdg'), recovery = join(root, 'recovery');
  mkdirSync(home);
  return {
    root, home, xdg, recovery,
    canonical: join(xdg, 'advanced-harness', 'project-defaults.json'),
    legacy: join(xdg, 'opencode', 'harness.project.json'),
  };
}

function defaults(home: string, baseBranch: string, parent: string): GlobalProjectDefaults {
  return {
    ...emptyGlobalProjectDefaults(home),
    baseBranch,
    shell: 'cmd',
    worktreeParentDirectory: join(home, parent, 'trees'),
    memoryParentDirectory: join(home, parent, 'data'),
  };
}

function write(path: string, text: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return text;
}

/** Deliberately not the format setup writes, so byte-preservation failures are visible. */
const legacyText = (value: GlobalProjectDefaults) => `${JSON.stringify(value)}\r\n`;

function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) { entries[relative(root, path)] = '<dir>'; walk(path); }
      else entries[relative(root, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return entries;
}

/** Answers like the real CLI: an unscripted prompt is Enter, which `ask` returns as an empty string. */
function terminal(answers: Record<string, string | (() => string)> = {}) {
  const questions: { question: string; suggested: string | undefined }[] = [];
  const outputs: string[] = [];
  return {
    questions, outputs,
    output: (message: string) => { outputs.push(message); },
    error: (message: string) => { outputs.push(`ERROR: ${message}`); },
    ask: async (question: string, suggested?: string) => {
      questions.push({ question, suggested });
      for (const [prefix, answer] of Object.entries(answers)) {
        if (question.startsWith(prefix)) return typeof answer === 'function' ? answer() : answer;
      }
      return '';
    },
    asked: (prefix: string) => questions.some(entry => entry.question.startsWith(prefix)),
    suggested: (value: string) => questions.some(entry => entry.suggested?.includes(value)),
    said: (text: string) => outputs.some(line => line.includes(text)),
  };
}

function runGlobal(box: ReturnType<typeof fixture>, io: ReturnType<typeof terminal>, options: SetupFlowOptions = { global: true }) {
  return runSetupFlow(options, { ask: io.ask, output: io.output, error: io.error, home: box.home, xdgConfigHome: box.xdg, recoveryDirectory: box.recovery, cwd: box.root, environment: {} });
}

test('global setup saves only to the new path when no defaults exist', async t => {
  const box = fixture(t);
  const io = terminal({ [CONFIRM]: 'save' });
  assert.equal(await runGlobal(box, io), 0);
  assert.equal(parseGlobalProjectDefaults(readFileSync(box.canonical, 'utf8')).version, 1);
  assert.equal(existsSync(join(box.xdg, 'opencode')), false, 'no opencode directory is created');
  assert.equal(existsSync(box.recovery), false, 'a new file needs no backup');
  assert.equal(io.asked(MIGRATE), false);
});

test('the config home comes from the override, then XDG_CONFIG_HOME, then ~/.config; empty counts as unset', t => {
  const { home, xdg } = fixture(t);
  const inHome = join(home, '.config', 'advanced-harness', 'project-defaults.json');
  assert.equal(lookupGlobalDefaults({ home, environment: {} }).canonicalPath, inHome);
  assert.equal(lookupGlobalDefaults({ home, environment: { XDG_CONFIG_HOME: '' } }).canonicalPath, inHome);
  assert.equal(lookupGlobalDefaults({ home, environment: { XDG_CONFIG_HOME: xdg } }).canonicalPath, join(xdg, 'advanced-harness', 'project-defaults.json'));
  assert.equal(lookupGlobalDefaults({ home, environment: { XDG_CONFIG_HOME: join(home, 'other') }, xdgConfigHome: xdg }).legacyPath, join(xdg, 'opencode', 'harness.project.json'));
});

test('setup without XDG_CONFIG_HOME reads the old file and saves under ~/.config', async t => {
  const box = fixture(t);
  const legacy = join(box.home, '.config', 'opencode', 'harness.project.json');
  const before = write(legacy, legacyText(defaults(box.home, 'legacy-base', 'old')));
  const io = terminal({ [MIGRATE]: 'migrate', [CONFIRM]: 'save' });
  await runSetupFlow({ global: true }, { ask: io.ask, output: io.output, error: io.error, home: box.home, recoveryDirectory: box.recovery, environment: {} });
  assert.equal(parseGlobalProjectDefaults(readFileSync(join(box.home, '.config', 'advanced-harness', 'project-defaults.json'), 'utf8')).baseBranch, 'legacy-base');
  assert.equal(readFileSync(legacy, 'utf8'), before);
});

test('lookup picks the new file first and never falls back from a malformed one', t => {
  const box = fixture(t);
  const options = { home: box.home, environment: {}, xdgConfigHome: box.xdg };
  const none = lookupGlobalDefaults(options);
  assert.deepEqual([none.source, none.defaults, none.invalid], ['none', undefined, false]);
  assert.equal(globalDefaultsNotice(none), undefined);

  write(box.legacy, 'not json');
  const badLegacy = lookupGlobalDefaults(options);
  assert.deepEqual([badLegacy.source, badLegacy.defaults, badLegacy.invalid], ['legacy', undefined, true]);
  assert.equal(globalDefaultsNotice(badLegacy), undefined);

  write(box.legacy, legacyText(defaults(box.home, 'legacy-base', 'old')));
  const legacy = lookupGlobalDefaults(options);
  assert.deepEqual([legacy.source, legacy.defaults?.baseBranch, legacy.canonicalText], ['legacy', 'legacy-base', undefined]);
  assert.match(globalDefaultsNotice(legacy)!, /old location/);

  const text = write(box.canonical, JSON.stringify(defaults(box.home, 'new-base', 'new')));
  const both = lookupGlobalDefaults(options);
  assert.deepEqual([both.source, both.defaults?.baseBranch, both.canonicalText], ['canonical', 'new-base', text]);
  assert.equal(globalDefaultsNotice(both), undefined);

  write(box.canonical, '{ broken');
  const badNew = lookupGlobalDefaults(options);
  assert.deepEqual([badNew.source, badNew.defaults, badNew.invalid, badNew.canonicalText], ['canonical', undefined, true, '{ broken']);
  assert.match(globalDefaultsNotice(badNew)!, /invalid data/);
});

for (const [name, options, answers] of [
  ['--global', { global: true }, {}],
  ['the scope prompt defaulting to global on Enter', {}, {}],
  ['the scope prompt retrying after an invalid answer', {}, { 'Setup scope': (() => { let calls = 0; return () => calls++ === 0 ? 'nonsense' : 'global'; })() }],
] as [string, SetupFlowOptions, Record<string, string | (() => string)>][]) {
  test(`typing migrate then save moves old values to the new file via ${name}`, async t => {
    const box = fixture(t);
    const before = write(box.legacy, legacyText(defaults(box.home, 'legacy-base', 'old')));
    const io = terminal({ ...answers, [MIGRATE]: ' migrate ', [CONFIRM]: 'save' });
    assert.equal(await runGlobal(box, io, options), 0);
    const saved = parseGlobalProjectDefaults(readFileSync(box.canonical, 'utf8'));
    assert.equal(saved.baseBranch, 'legacy-base');
    assert.equal(saved.shell, 'cmd');
    assert.equal(saved.worktreeParentDirectory, join(box.home, 'old', 'trees'));
    assert.equal(readFileSync(box.legacy, 'utf8'), before, 'old file is byte-identical');
    assert.equal(existsSync(box.recovery), false, 'no backup: the new file did not exist and the old one was not replaced');
    assert.ok(io.said(`no longer read once this is saved: ${box.legacy}`));
    const nextRun = lookupGlobalDefaults({ home: box.home, environment: {}, xdgConfigHome: box.xdg });
    assert.equal(nextRun.source, 'canonical');
  });
}

for (const [name, answer] of [['Enter', ''], ['no', 'no'], ['a near miss', 'Migrate please']] as const) {
  test(`declining migrate with ${name} does not load old values, and the preview discloses the old file`, async t => {
    const box = fixture(t);
    const before = write(box.legacy, legacyText(defaults(box.home, 'legacy-base', 'old')));
    const io = terminal({ [MIGRATE]: answer, [CONFIRM]: 'save' });
    assert.equal(await runGlobal(box, io), 0);
    assert.equal(io.suggested('legacy-base'), false);
    assert.equal(io.suggested(join('old', 'trees')), false);
    const saved = parseGlobalProjectDefaults(readFileSync(box.canonical, 'utf8'));
    assert.equal(saved.baseBranch, 'main');
    assert.ok(io.said(`no longer read once this is saved: ${box.legacy}`));
    assert.equal(readFileSync(box.legacy, 'utf8'), before);
  });
}

for (const [name, answers] of [
  ['Enter at the final prompt after migrate', { [MIGRATE]: 'migrate' }],
  ['typing cancel after migrate', { [MIGRATE]: 'migrate', [CONFIRM]: 'cancel' }],
  ['an unknown final answer after migrate', { [MIGRATE]: 'migrate', [CONFIRM]: 'yes' }],
  ['Enter at both prompts', {}],
  ['typing cancel after declining migrate', { [MIGRATE]: 'no', [CONFIRM]: 'cancel' }],
] as [string, Record<string, string>][]) {
  test(`cancelling with ${name} leaves no file, directory, or backup`, async t => {
    const box = fixture(t);
    write(box.legacy, legacyText(defaults(box.home, 'legacy-base', 'old')));
    const before = snapshot(box.root);
    const io = terminal(answers);
    assert.equal(await runGlobal(box, io), 0);
    assert.deepEqual(snapshot(box.root), before);
    assert.ok(io.said('Nothing changed: no files written and no backups created.'));
  });
}

for (const prompt of [MIGRATE, 'Default base branch', CONFIRM]) {
  test(`a prompt closed at "${prompt}" leaves no writes`, async t => {
    const box = fixture(t);
    write(box.legacy, legacyText(defaults(box.home, 'legacy-base', 'old')));
    const before = snapshot(box.root);
    const io = terminal({ [prompt]: () => { throw new Error('readline was closed'); } });
    await assert.rejects(runGlobal(box, io), /readline was closed/);
    assert.deepEqual(snapshot(box.root), before);
  });
}

test('a new file appearing during the prompts is not overwritten', async t => {
  const box = fixture(t);
  const before = write(box.legacy, legacyText(defaults(box.home, 'legacy-base', 'old')));
  const concurrent = JSON.stringify(defaults(box.home, 'concurrent', 'other'));
  const io = terminal({ [MIGRATE]: 'migrate', [CONFIRM]: () => { write(box.canonical, concurrent); return 'save'; } });
  await assert.rejects(runGlobal(box, io), /changed during setup/);
  assert.equal(readFileSync(box.canonical, 'utf8'), concurrent);
  assert.equal(readFileSync(box.legacy, 'utf8'), before);
  assert.equal(existsSync(box.recovery), false);
});

test('a malformed old file is not offered for migration, stays untouched, and does not block setup', async t => {
  const box = fixture(t);
  write(box.legacy, '{ "version": 99 }');
  const io = terminal({ [CONFIRM]: 'save' });
  assert.equal(await runGlobal(box, io), 0);
  assert.equal(io.asked(MIGRATE), false);
  assert.ok(io.said('contain invalid data'));
  assert.equal(readFileSync(box.legacy, 'utf8'), '{ "version": 99 }');
  assert.equal(parseGlobalProjectDefaults(readFileSync(box.canonical, 'utf8')).baseBranch, 'main');
});

test('with both files, global setup edits the new file, backs it up, and ignores the old one', async t => {
  const box = fixture(t);
  const before = write(box.legacy, legacyText(defaults(box.home, 'legacy-base', 'old')));
  const previous = write(box.canonical, JSON.stringify(defaults(box.home, 'new-base', 'new')));
  const io = terminal({ [CONFIRM]: 'save' });
  assert.equal(await runGlobal(box, io), 0);
  assert.equal(io.asked(MIGRATE), false);
  assert.equal(io.suggested('legacy-base'), false);
  assert.equal(parseGlobalProjectDefaults(readFileSync(box.canonical, 'utf8')).baseBranch, 'new-base');
  assert.equal(readFileSync(box.legacy, 'utf8'), before);
  const backups = Object.entries(snapshot(box.recovery)).filter(([, contents]) => contents !== '<dir>');
  assert.deepEqual(backups.map(([, contents]) => contents), [previous]);
});

test('a malformed new file gives no suggestions and does not fall back to the old file', async t => {
  const box = fixture(t);
  const before = write(box.legacy, legacyText(defaults(box.home, 'legacy-base', 'old')));
  write(box.canonical, '{ broken');
  const io = terminal();
  assert.equal(await runGlobal(box, io), 0);
  assert.equal(io.asked(MIGRATE), false);
  assert.equal(io.suggested('legacy-base'), false);
  assert.ok(io.said('invalid data'));
  assert.equal(readFileSync(box.canonical, 'utf8'), '{ broken');
  assert.equal(readFileSync(box.legacy, 'utf8'), before);
});

function runProject(box: ReturnType<typeof fixture>, project: string, io: ReturnType<typeof terminal>) {
  return runSetupFlow({ project }, { ask: io.ask, output: io.output, error: io.error, home: box.home, xdgConfigHome: box.xdg, recoveryDirectory: box.recovery, cwd: box.root, environment: {} });
}

test('project setup falls back to the old file without a migrate prompt, and cancel writes nothing', async t => {
  const box = fixture(t);
  const project = join(box.root, 'app'); mkdirSync(project);
  write(box.legacy, legacyText(defaults(box.home, 'legacy-base', 'old')));
  const before = snapshot(box.root);
  const io = terminal();
  assert.equal(await runProject(box, project, io), 0);
  assert.equal(io.asked(MIGRATE), false);
  assert.ok(io.suggested(join('old', 'trees')), 'old worktree parent is suggested');
  assert.ok(io.said('old location'));
  assert.deepEqual(snapshot(box.root), before);
});

test('saving project setup with the old file writes neither global path', async t => {
  const box = fixture(t);
  const project = join(box.root, 'app'); mkdirSync(project);
  const before = write(box.legacy, legacyText(defaults(box.home, 'legacy-base', 'old')));
  const io = terminal({ [CONFIRM]: 'save' });
  assert.equal(await runProject(box, project, io), 0);
  assert.equal(existsSync(join(project, 'AGENTS.md')), true);
  assert.equal(existsSync(box.canonical), false);
  assert.equal(readFileSync(box.legacy, 'utf8'), before);
});

test('project setup prefers the new file and warns about a malformed one', async t => {
  const box = fixture(t);
  const project = join(box.root, 'app'); mkdirSync(project);
  write(box.legacy, legacyText(defaults(box.home, 'legacy-base', 'old')));
  write(box.canonical, JSON.stringify(defaults(box.home, 'new-base', 'new')));
  const preferred = terminal();
  await runProject(box, project, preferred);
  assert.ok(preferred.suggested(join('new', 'trees')));
  assert.equal(preferred.suggested(join('old', 'trees')), false);
  assert.equal(preferred.said('old location'), false);

  write(box.canonical, '{ broken');
  const broken = terminal();
  await runProject(box, project, broken);
  assert.equal(broken.suggested(join('old', 'trees')), false);
  assert.ok(broken.said('invalid data'));
});

function updateFixture(box: ReturnType<typeof fixture>): string {
  const project = join(box.root, 'app'); mkdirSync(project);
  writeFileSync(join(project, 'opencode.json'), JSON.stringify({ agents: Object.fromEntries(nativeRoles.map(role => [role, { description: 'd', mode: role === 'lead' ? 'primary' : 'subagent', model: 'custom/model#low', permissions: [], system: 'old' }])) }));
  writeFileSync(join(project, 'AGENTS.md'), '# App\n\n<!-- advanced-harness:project:start -->\nolder instructions\n<!-- advanced-harness:project:end -->\n');
  return project;
}

function runUpdate(box: ReturnType<typeof fixture>, project: string, io: ReturnType<typeof terminal>) {
  return runUpdateFlow({ scope: 'project', project, checkRemote: false }, { ask: io.ask, output: io.output, error: io.error, home: box.home, xdgConfigHome: box.xdg, recoveryDirectory: box.recovery, runCommand: () => '' });
}

const cancelUpdate = { 'Choose new models': 'no', 'Type update': 'cancel' };

test('harness:update reads the old file as a fallback, offers no migration, and writes nothing on skip and cancel', async t => {
  const box = fixture(t);
  const project = updateFixture(box);
  write(box.legacy, legacyText(defaults(box.home, 'legacy-base', 'old')));
  const before = snapshot(box.root);
  const io = terminal(cancelUpdate);
  assert.equal(await runUpdate(box, project, io), 0);
  assert.ok(io.suggested(join('old', 'trees')));
  assert.ok(io.said('old location'));
  assert.equal(io.asked(MIGRATE), false);
  assert.deepEqual(snapshot(box.root), before);
});

test('harness:update prefers the new file and ignores a malformed old file', async t => {
  const box = fixture(t);
  const project = updateFixture(box);
  write(box.legacy, legacyText(defaults(box.home, 'legacy-base', 'old')));
  write(box.canonical, JSON.stringify(defaults(box.home, 'new-base', 'new')));
  const preferred = terminal(cancelUpdate);
  await runUpdate(box, project, preferred);
  assert.ok(preferred.suggested(join('new', 'trees')));
  assert.equal(preferred.suggested(join('old', 'trees')), false);
  assert.equal(preferred.said('old location'), false);

  rmSync(box.canonical);
  write(box.legacy, 'not json');
  const malformed = terminal(cancelUpdate);
  await runUpdate(box, project, malformed);
  assert.equal(malformed.suggested(join('old', 'trees')), false);
  assert.equal(readFileSync(box.legacy, 'utf8'), 'not json');
});
