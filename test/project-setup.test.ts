import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askProfile, checkNames, inspectProject, parseProfile, prepareSetup, saveSetup, suggestedCommands, updateProjectInstructions, validateProfile, type ProjectProfile } from '../src/project-setup.ts';
import { contextData, updateContext } from '../src/project-context.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'harness-project-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'android-app');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(join(project, 'settings.gradle.kts'), 'include(":app")');
  mkdirSync(join(project, 'app'));
  writeFileSync(join(project, 'app', 'build.gradle.kts'), 'plugins { id("com.android.application"); id("io.github.takahirom.roborazzi") }');
  writeFileSync(join(project, 'gradlew'), 'THIS MUST NEVER BE EXECUTED');
  writeFileSync(join(project, 'gradlew.bat'), 'THIS MUST NEVER BE EXECUTED');
  return { root, project };
}
function profile(root: string, project: string): ProjectProfile {
  return { version: 1, projectRoot: project, baseBranch: 'main', shell: 'bash', checks: Object.fromEntries(checkNames.map(name => [name, { status: 'unconfigured' }])) as ProjectProfile['checks'], device: { preference: 'physical-first' }, worktreeDirectory: join(root, 'worktrees'), memoryPath: join(root, 'data', 'MEMORY.md') };
}

test('bounded inspection detects Gradle/modules/wrappers without executing scripts, and preserves AGENTS content', t => {
  const { project } = fixture(t);
  writeFileSync(join(project, 'AGENTS.md'), '# Existing rules\nDo not replace these.\n');
  mkdirSync(join(project, 'build'));
  writeFileSync(join(project, 'build', 'build.gradle'), 'ignore generated files');
  const result = inspectProject(project);
  assert.deepEqual(result.gradleFiles.sort(), ['app/build.gradle.kts', 'settings.gradle.kts']);
  assert.deepEqual(result.androidModules, ['app']);
  assert.equal(result.roborazzi, true);
  assert.deepEqual(result.wrappers, { bash: true, windows: true });
  assert.equal(result.agents, '# Existing rules\nDo not replace these.\n');
  assert.equal(suggestedCommands(result, 'bash').build, './gradlew :app:assembleDebug');
  assert.equal(suggestedCommands(result, 'powershell').unit, '.\\gradlew.bat :app:testDebugUnitTest');
  assert.equal(suggestedCommands(result, 'cmd').roborazzi, 'gradlew.bat :app:verifyRoborazziDebug');
  assert.equal(suggestedCommands(result, 'bash').runtime, undefined);
  assert.deepEqual(suggestedCommands({ ...result, wrappers: { bash: false, windows: false } }, 'bash'), {});
  assert.deepEqual(suggestedCommands({ ...result, wrappers: { bash: true, windows: false } }, 'powershell'), {});
});

test('inspection rejects missing Git/Gradle roots instead of assuming an Android app', t => {
  const { root } = fixture(t);
  assert.throws(() => inspectProject(root), /Git checkout/);
  mkdirSync(join(root, '.git'));
  assert.throws(() => inspectProject(root), /Gradle/);
});

test('profile validation leaves unknown checks unconfigured, and rejects malformed commands/device/paths', t => {
  const { root, project } = fixture(t);
  const valid = profile(root, project);
  assert.equal(validateProfile(valid), valid);
  assert.deepEqual(parseProfile(JSON.stringify(valid)), valid);
  for (const mutation of [
    { version: 2 }, { baseBranch: '../invalid' }, { baseBranch: 'with space' }, { baseBranch: '@' }, { baseBranch: 'foo/.hidden' }, { shell: 'invented' }, { humanNotes: 'preserve instead of silently dropping' },
    { checks: {} }, { checks: { ...valid.checks, build: { status: 'waived' } } },
    { checks: { ...valid.checks, unit: { status: 'configured', command: 'first\nsecond' } } },
    { checks: { ...valid.checks, e2e: { status: 'unconfigured', command: 'hidden command' } } },
    { device: { preference: 'physical-first', serial: 'invalid serial' } },
    { memoryPath: join(project, 'MEMORY.md') }, { memoryPath: join(root, 'data', 'not-memory.txt') },
    { worktreeDirectory: project }, { worktreeDirectory: root },
    { memoryPath: join(root, 'worktrees', 'MEMORY.md') }, { worktreeDirectory: 'relative' },
  ]) assert.throws(() => validateProfile({ ...valid, ...mutation }), JSON.stringify(mutation));
  assert.throws(() => parseProfile('{invalid'), /Invalid existing/);
  assert.throws(() => parseProfile(JSON.stringify(valid).replace('"version":1', '"version":2,"version":1')), /Invalid existing/);
});

test('interactive collection confirms each command, supports explicit unconfigured and device serial', async t => {
  const { root, project } = fixture(t);
  const responses = ['feature base', 'develop', 'unknown', 'bash', './gradlew :app:assembleDebug', '-', '-', '-', 'adb -s emulator-5554 shell am start -n app/.Main', '-', 'emulator', 'emulator-5554', join(root, 'trees'), join(root, 'memory', 'MEMORY.md')];
  const prompts: string[] = [];
  const result = await askProfile(project, inspectProject(project), undefined, async question => {
    prompts.push(question);
    assert.ok(responses.length);
    return responses.shift()!;
  });
  assert.equal(responses.length, 0);
  assert.equal(result.baseBranch, 'develop');
  assert.equal(result.checks.build.status, 'configured');
  assert.deepEqual(result.checks.e2e, { status: 'unconfigured' });
  assert.equal(result.device.serial, 'emulator-5554');
  for (const name of checkNames) assert.ok(prompts.some(question => question.startsWith(`${name}:`)));
});

test('repeat setup preserves explicitly unconfigured checks and previous choices without silently enabling suggestions', async t => {
  const { root, project } = fixture(t);
  const previous = profile(root, project);
  previous.device.serial = 'existing-device';
  const shown: Record<string, string | undefined> = {};
  const result = await askProfile(project, inspectProject(project), previous, async (question, suggested) => { shown[question] = suggested; return ''; });
  assert.deepEqual(result, previous);
  assert.equal(shown['build: confirm command, or - to leave UNCONFIGURED'], '-');
});

test('AGENTS marked-section updates preserve unrelated bytes, BOM, and CRLF; repeat is idempotent', t => {
  const { root, project } = fixture(t);
  const settings = profile(root, project);
  const original = '\uFEFF# Existing rules\r\nDo not change this.\r\n';
  const updated = updateProjectInstructions(original, settings);
  assert.ok(updated.startsWith(original));
  assert.ok(!updated.replaceAll('\r\n', '').includes('\n'));
  assert.deepEqual(contextData(updated, 'project'), settings);
  assert.ok(updated.includes('not passed or waived'));
  assert.equal(updateProjectInstructions(updated, settings), updated);
  const withFooter = updated + '\r\n# Other instructions\r\n';
  assert.ok(updateProjectInstructions(withFooter, settings).endsWith('\r\n# Other instructions\r\n'));
});

test('confirmed commands containing harness markers survive setup, parsing, and repeat updates', t => {
  const { root, project } = fixture(t);
  const settings = profile(root, project);
  settings.shell = 'powershell';
  settings.checks.build = { status: 'configured', command: 'Write-Output "<!-- advanced-harness:project:start -->"' };
  validateProfile(settings);
  const original = '\uFEFF# Existing rules\r\nKeep these.\r\n';
  const files = prepareSetup(project, settings, original);
  const restored = validateProfile(contextData(files[0]!.updated, 'project'));
  assert.deepEqual(restored, settings);
  assert.equal(prepareSetup(project, restored, files[0]!.updated)[0]!.updated, files[0]!.updated);
  assert.equal(existsSync(join(project, 'AGENTS.md')), false); // Preparation never writes or executes the command.
});

test('ambiguous AGENTS markers abort instead of overwriting user instructions', t => {
  const { root, project } = fixture(t);
  for (const text of ['<!-- advanced-harness:project:start -->', '<!-- advanced-harness:project:end --><!-- advanced-harness:project:start -->', '<!-- advanced-harness:project:start --><!-- advanced-harness:project:end --><!-- advanced-harness:project:start --><!-- advanced-harness:project:end -->']) assert.throws(() => updateProjectInstructions(text, profile(root, project)), /Ambiguous/);
});

test('setup writes only selected files with exact backups; worktrees and memory are not created', t => {
  const { root, project } = fixture(t);
  const settings = profile(root, project);
  const original = '# Existing AGENTS rules\n';
  writeFileSync(join(project, 'AGENTS.md'), original);
  const files = prepareSetup(project, settings, original);
  const backups = saveSetup(files, join(root, 'backups'));
  assert.equal(readFileSync(backups[0]!, 'utf8'), original);
  assert.deepEqual(contextData(readFileSync(files[0]!.path, 'utf8'), 'project'), settings);
  assert.equal(existsSync(join(project, '.opencode')), false);
  assert.ok(readFileSync(join(project, 'AGENTS.md'), 'utf8').startsWith(original));
  assert.equal(existsSync(settings.worktreeDirectory), false);
  assert.equal(existsSync(settings.memoryPath), false);
  assert.equal(existsSync(join(project, '.gitignore')), false);
});

test('prepare and cancellation perform no writes; save preserves original instructions outside the section', t => {
  const { root, project } = fixture(t);
  const original = '# Original rules';
  writeFileSync(join(project, 'AGENTS.md'), original);
  const files = prepareSetup(project, profile(root, project), original);
  assert.equal(files.length, 1);
  assert.equal(existsSync(join(project, '.opencode')), false);
  saveSetup(files, join(root, 'backups'));
  assert.ok(readFileSync(join(project, 'AGENTS.md'), 'utf8').startsWith(original));
});

test('concurrent AGENTS modification aborts the entire write set before profile/backup creation', t => {
  const { root, project } = fixture(t);
  const files = prepareSetup(project, profile(root, project), undefined);
  writeFileSync(join(project, 'AGENTS.md'), '# Newly written by the user');
  assert.throws(() => saveSetup(files, join(root, 'backups')), /changed/);
  assert.equal(existsSync(join(project, '.opencode')), false);
  assert.equal(existsSync(join(root, 'backups')), false);
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), '# Newly written by the user');
});

test('existing embedded settings are backed up, invalid settings and mismatched roots are not replaced', t => {
  const { root, project } = fixture(t);
  const settings = profile(root, project);
  saveSetup(prepareSetup(project, settings, undefined), join(root, 'backups'));
  const path = join(project, 'AGENTS.md');
  const original = readFileSync(path, 'utf8');
  settings.baseBranch = 'develop';
  const backups = saveSetup(prepareSetup(project, settings, original), join(root, 'backups'));
  assert.equal(readFileSync(backups[0]!, 'utf8'), original);
  const invalid = updateContext(undefined, 'project', { unexpected: 'user work' }, []);
  writeFileSync(path, invalid);
  assert.throws(() => prepareSetup(project, settings, invalid), /Invalid/);
  assert.equal(readFileSync(path, 'utf8'), invalid);
  assert.throws(() => prepareSetup(root, settings, undefined), /does not match/);
});

test('setup refuses noninteractive input without creating profile or changing AGENTS', t => {
  const { project } = fixture(t);
  const script = fileURLToPath(new URL('../scripts/setup-native-project.ts', import.meta.url));
  assert.match(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }), /harness:setup/);
  assert.throws(() => execFileSync(process.execPath, [script, '--project', project], { input: 'setup\n', stdio: 'pipe' }), /interactive terminal/);
  assert.equal(existsSync(join(project, '.opencode')), false);
  assert.equal(existsSync(join(project, 'AGENTS.md')), false);
});

test('symlinked project configuration directory is refused without writing to its destination', t => {
  const { root, project } = fixture(t);
  const target = join(root, 'unrelated-config');
  mkdirSync(target);
  try { symlinkSync(target, join(project, '.opencode'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Symlink creation requires OS privilege'); return; } throw error; }
  const files = prepareSetup(project, profile(root, project), undefined, join(project, '.opencode', 'CONTEXT.md'));
  assert.throws(() => saveSetup(files, join(root, 'backups')), /symlinked/);
  assert.equal(existsSync(join(target, 'CONTEXT.md')), false);
  assert.equal(existsSync(join(root, 'backups')), false);
});
