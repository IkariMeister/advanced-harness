import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRoot } from './temp-directory.ts';
import { askProfile, askProjectShell, checkNames, confirmAndSaveSetup, emptyGlobalProjectDefaults, inspectProject, parseGlobalProjectDefaults, parseProfile, prepareSetup, readLocalProjectContext, readSetupPreflightPolicy, resolveProjectLocations, runSetupFlow, saveSetup, setupConfirmation, suggestedAdditionalChecks, suggestedCommands, updateProjectInstructions, validateGlobalProjectDefaults, validateProfile, type ProjectProfile } from '../src/project-setup.ts';
import { contextData, updateContext } from '../src/project-context.ts';
import { DEFAULT_PREFLIGHT_CONFIG } from '../src/preflight/policy.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = makeTempRoot('harness-project-setup-');
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
  assert.equal(result.hasGit, true);
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

test('full-preview confirmation trims save and legacy setup; every other answer cancels', () => {
  assert.equal(setupConfirmation(' save  '), 'save');
  assert.equal(setupConfirmation('setup'), 'save');
  for (const answer of ['', 'cancel', 'SAVE', 'unknown', 'save please']) assert.equal(setupConfirmation(answer), 'cancel');
});

test('shell selection accepts default/saved shell and retries invalid input', async () => {
  assert.equal(await askProjectShell(async () => '', 'bash'), 'bash');
  assert.equal(await askProjectShell(async () => '', 'cmd'), 'cmd');
  const replies = ['invalid', 'powershell'];
  const prompts: string[] = [];
  assert.equal(await askProjectShell(async question => { prompts.push(question); return replies.shift()!; }, 'bash'), 'powershell');
  assert.equal(prompts.length, 2);
});

test('inspection supports non-Git and non-Gradle directories, and detects package.json scripts', t => {
  const { root } = fixture(t);
  // Non-existent directory throws
  assert.throws(() => inspectProject(join(root, 'non-existent')), /existing repository directory/);

  // Non-Git, non-Gradle directory
  const nonGit = join(root, 'plain-dir');
  mkdirSync(nonGit);
  const plainResult = inspectProject(nonGit);
  assert.equal(plainResult.hasGit, false);
  assert.deepEqual(plainResult.gradleFiles, []);
  assert.deepEqual(plainResult.androidModules, []);
  assert.equal(plainResult.roborazzi, false);
  assert.deepEqual(plainResult.wrappers, { bash: false, windows: false });
  assert.deepEqual(suggestedCommands(plainResult, 'bash'), {});

  // Git directory with package.json
  mkdirSync(join(nonGit, '.git'));
  writeFileSync(join(nonGit, 'package.json'), JSON.stringify({
    name: 'test-app',
    scripts: {
      build: 'tsc',
      lint: 'eslint .',
      test: 'node --test',
      e2e: 'playwright test'
    }
  }));
  const nodeResult = inspectProject(nonGit);
  assert.equal(nodeResult.hasGit, true);
  assert.deepEqual(nodeResult.packageScripts, {
    build: 'npm run build',
    lint: 'npm run lint',
    unit: 'npm test',
    e2e: 'npm run e2e'
  });
  assert.deepEqual(suggestedCommands(nodeResult, 'bash'), {
    build: 'npm run build',
    lint: 'npm run lint',
    unit: 'npm test',
    e2e: 'npm run e2e'
  });
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
  const responses = ['feature base', 'develop', 'unknown', 'bash', './gradlew :app:assembleDebug', '-', '-', '-', 'adb -s emulator-5554 shell am start -n app/.Main', '-', '', 'emulator', 'emulator-5554', join(root, 'trees'), join(root, 'memory', 'MEMORY.md')];
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

test('additional gates: Spotless/Detekt detection suggests root tasks, validation keeps them distinct from standard checks', t => {
  const { root, project } = fixture(t);
  writeFileSync(join(project, 'build.gradle.kts'), 'plugins { id("com.diffplug.spotless"); id("io.gitlab.arturbosch.detekt") }');
  const inspection = inspectProject(project);
  assert.deepEqual(inspection.gates?.sort(), ['detekt', 'spotless']);
  assert.deepEqual(suggestedAdditionalChecks(inspection, 'powershell').map(check => check.command).sort(), ['.\\gradlew.bat detekt', '.\\gradlew.bat spotlessCheck']);
  assert.deepEqual(suggestedAdditionalChecks({ ...inspection, wrappers: { bash: false, windows: true } }, 'bash'), []);
  assert.deepEqual(inspectProject(fixture(t).project).gates, []);

  const valid: ProjectProfile = { ...profile(root, project), additionalChecks: [{ name: 'spotless', command: './gradlew spotlessCheck' }, { name: 'detekt', command: './gradlew detekt' }] };
  assert.equal(validateProfile(valid), valid);
  for (const additionalChecks of [
    [], {}, [{ name: 'lint', command: './gradlew detekt' }], [{ name: 'Spotless', command: 'x' }], [{ name: 'with space', command: 'x' }],
    [{ name: 'detekt', command: 'x' }, { name: 'detekt', command: 'y' }], [{ name: 'detekt', command: '' }], [{ name: 'detekt', command: 'a\nb' }],
    [{ name: 'detekt', command: 'x', status: 'waived' }], [{ name: 'detekt' }],
  ]) assert.throws(() => validateProfile({ ...valid, additionalChecks }), JSON.stringify(additionalChecks));

  const updated = updateProjectInstructions(undefined, valid);
  assert.deepEqual(contextData(updated, 'project'), valid);
  assert.ok(updated.includes('they do not replace lint'));
  assert.equal(updateProjectInstructions(updated, valid), updated);
});

test('additional gates: first setup confirms detected gates, retries invalid names, and skips with -', async t => {
  const { root, project } = fixture(t);
  writeFileSync(join(project, 'build.gradle.kts'), 'plugins { id("com.diffplug.spotless"); id("io.gitlab.arturbosch.detekt") }');
  const inspection = inspectProject(project);
  const gates = (inspection.gates ?? []).length;
  const replies: Record<string, string[]> = {
    'spotless (additional gate, detected in Gradle files): confirm command, or - to leave out': [''],
    'detekt (additional gate, detected in Gradle files): confirm command, or - to leave out': ['-'],
    'Additional required project gate name (for example spotless or detekt), or Enter to finish': ['lint', 'Bad Name', 'spotless', 'ktlint', 'license', ''],
    'ktlint: command, or - to skip this gate': ['./gradlew ktlintCheck'],
    'license: command, or - to skip this gate': [''],
  };
  const prompts: string[] = [];
  const result = await askProfile(project, inspection, undefined, async (question, suggested) => {
    prompts.push(question);
    if (question.startsWith('Parent directory')) return join(root, 'trees');
    if (question.startsWith('Shared MEMORY.md')) return join(root, 'memory', 'MEMORY.md');
    return replies[question]?.shift() ?? suggested ?? '';
  }, 'bash');
  assert.equal(gates, 2);
  assert.deepEqual(result.additionalChecks, [{ name: 'spotless', command: './gradlew spotlessCheck' }, { name: 'ktlint', command: './gradlew ktlintCheck' }]);
  for (const queue of Object.values(replies)) assert.equal(queue.length, 0);
  // Standard checks are still asked before the additional gates; lint is not replaced.
  assert.ok(prompts.indexOf('lint: confirm command, or - to leave UNCONFIGURED') < prompts.findIndex(question => question.startsWith('spotless')));
  assert.equal(result.checks.lint.status, 'configured');
});

test('additional gates: repeat setup keeps confirmed gates, removes with -, and never re-enables a detected gate left out', async t => {
  const { root, project } = fixture(t);
  writeFileSync(join(project, 'build.gradle.kts'), 'plugins { id("com.diffplug.spotless"); id("io.gitlab.arturbosch.detekt") }');
  const previous: ProjectProfile = { ...profile(root, project), additionalChecks: [{ name: 'spotless', command: './gradlew spotlessCheck' }, { name: 'ktlint', command: './gradlew ktlintCheck' }] };
  const shown: Record<string, string | undefined> = {};
  const kept = await askProfile(project, inspectProject(project), previous, async (question, suggested) => { shown[question] = suggested; return ''; });
  assert.deepEqual(kept, previous);
  assert.equal(shown['detekt (additional gate, detected in Gradle files): confirm command, or - to leave out'], '-');
  assert.equal(shown['spotless (additional gate, detected in Gradle files): confirm command, or - to leave out'], undefined);
  const removed = await askProfile(project, inspectProject(project), previous, async question => question.startsWith('ktlint (additional gate)') || question.startsWith('spotless (additional gate)') ? '-' : '');
  assert.equal(Object.hasOwn(removed, 'additionalChecks'), false);
});

test('runSetupFlow previews additional gates and cancellation writes nothing', async t => {
  const { root, project } = fixture(t);
  const original = '# Existing rules\n';
  writeFileSync(join(project, 'AGENTS.md'), original);
  writeFileSync(join(project, 'build.gradle.kts'), 'plugins { id("io.gitlab.arturbosch.detekt") }');
  const home = join(root, 'home');
  mkdirSync(home);
  for (const confirmation of ['', 'save']) {
    const outputs: string[] = [];
    const code = await runSetupFlow({ project }, {
      ask: async (question, suggested) => {
        if (question.startsWith('Full preview')) return confirmation;
        if (question.startsWith('Parent directory')) return join(root, 'trees');
        if (question.startsWith('Shared MEMORY.md')) return join(root, 'memory', 'MEMORY.md');
        return suggested ?? '';
      },
      output: message => outputs.push(message),
      error: message => outputs.push(message),
      home,
      xdgConfigHome: join(root, 'xdg'),
      recoveryDirectory: join(root, `backups-${confirmation || 'blank'}`),
    });
    assert.equal(code, 0);
    assert.ok(outputs.includes('detekt (additional gate): ./gradlew detekt') || outputs.includes('detekt (additional gate): .\\gradlew.bat detekt'));
    if (!confirmation) {
      assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), original);
      assert.equal(existsSync(join(root, 'backups-blank')), false);
    } else {
      assert.deepEqual(validateProfile(contextData(readFileSync(join(project, 'AGENTS.md'), 'utf8'), 'project')).additionalChecks?.map(check => check.name), ['detekt']);
    }
  }
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

test('production confirmation flow cancels blank, cancel, and unknown responses without writes or backups, including alternate context', t => {
  const { root, project } = fixture(t);
  const context = join(project, 'docs', 'HARNESS.md');
  mkdirSync(join(project, 'docs'));
  const original = '# Original rules\n';
  writeFileSync(join(project, 'AGENTS.md'), '# Project guidance\n');
  writeFileSync(context, original);
  const files = prepareSetup(project, profile(root, project), readFileSync(context, 'utf8'), context);
  for (const response of ['', 'cancel', 'unknown']) {
    assert.deepEqual(confirmAndSaveSetup(response, files, join(root, `backups-${response || 'blank'}`)), { status: 'cancelled' });
    assert.equal(readFileSync(context, 'utf8'), original);
    assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), '# Project guidance\n');
    assert.equal(existsSync(join(root, `backups-${response || 'blank'}`)), false);
  }
});

test('production confirmation flow cancels default-context responses without writes or backups', t => {
  const { root, project } = fixture(t);
  const path = join(project, 'AGENTS.md');
  const original = '# Existing guidance\n';
  writeFileSync(path, original);
  const files = prepareSetup(project, profile(root, project), original);
  for (const response of ['', 'cancel', 'unknown']) {
    assert.deepEqual(confirmAndSaveSetup(response, files, join(root, `default-backups-${response || 'blank'}`)), { status: 'cancelled' });
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.equal(existsSync(join(root, `default-backups-${response || 'blank'}`)), false);
  }
});

test('production confirmation flow accepts save/setup and preserves save safeguards', t => {
  const { root, project } = fixture(t);
  const context = join(project, 'docs', 'HARNESS.md');
  mkdirSync(join(project, 'docs'));
  const original = '# Original rules\n';
  writeFileSync(context, original);
  const files = prepareSetup(project, profile(root, project), original, context);
  for (const [index, response] of ['save', 'setup'].entries()) {
    const target = join(project, 'docs', `HARNESS-${index}.md`);
    writeFileSync(target, original);
    const prepared = prepareSetup(project, profile(root, project), original, target);
    const result = confirmAndSaveSetup(response, prepared, join(root, `backups-${index}`));
    assert.equal(result.status, 'saved');
    assert.equal(readFileSync(result.backups[0]!, 'utf8'), original);
    assert.ok(readFileSync(target, 'utf8').startsWith(original));
  }
  writeFileSync(context, original);
  const concurrent = prepareSetup(project, profile(root, project), original, context);
  writeFileSync(context, '# Changed concurrently');
  assert.throws(() => confirmAndSaveSetup('save', concurrent, join(root, 'concurrent-backups')), /changed/);
  assert.equal(readFileSync(context, 'utf8'), '# Changed concurrently');
  assert.equal(existsSync(join(root, 'concurrent-backups')), false);
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

test('global defaults validation, parsing, and empty factory', () => {
  const defaults = emptyGlobalProjectDefaults('/test/home');
  assert.equal(defaults.version, 1);
  assert.equal(defaults.baseBranch, 'main');
  assert.equal(validateGlobalProjectDefaults(defaults), defaults);
  assert.deepEqual(parseGlobalProjectDefaults(JSON.stringify(defaults)), defaults);
  assert.throws(() => validateGlobalProjectDefaults({ ...defaults, version: 2 }), /Invalid/);
  assert.throws(() => validateGlobalProjectDefaults({ ...defaults, baseBranch: 'invalid branch..' }), /Invalid/);
  assert.throws(() => validateGlobalProjectDefaults({ ...defaults, worktreeParentDirectory: 'relative/path' }), /absolute/);
});

test('runSetupFlow in global scope configures and saves harness.project.json', async t => {
  const root = makeTempRoot('harness-global-setup-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const xdg = join(root, 'xdg');
  const home = join(root, 'home');
  mkdirSync(join(xdg, 'opencode'), { recursive: true });
  mkdirSync(home, { recursive: true });

  const outputs: string[] = [];
  const responses = [
    'global', // scope prompt
    'bash',   // shell
    'main',   // baseBranch
    'bash',   // selectedShell
    '-', '-', '-', '-', '-', '-', // 6 checks
    'physical-first', // device
    '-', // serial
    join(home, 'Projects', 'custom-worktrees'),
    join(home, 'Projects', 'custom-data'),
    'save', // confirm
  ];

  const code = await runSetupFlow(
    {},
    {
      ask: async () => responses.shift()!,
      output: msg => outputs.push(msg),
      error: msg => outputs.push(`ERROR: ${msg}`),
      home,
      xdgConfigHome: xdg,
      cwd: root,
    }
  );

  assert.equal(code, 0);
  const savedPath = join(xdg, 'advanced-harness', 'project-defaults.json');
  assert.equal(existsSync(savedPath), true);
  assert.equal(existsSync(join(xdg, 'opencode', 'harness.project.json')), false, 'nothing is written to the OpenCode path');
  const saved = parseGlobalProjectDefaults(readFileSync(savedPath, 'utf8'));
  assert.equal(saved.baseBranch, 'main');
  assert.equal(saved.shell, 'bash');
  assert.equal(saved.worktreeParentDirectory, join(home, 'Projects', 'custom-worktrees'));
  assert.equal(saved.memoryParentDirectory, join(home, 'Projects', 'custom-data'));
  assert.ok(outputs.some(msg => msg.includes('Global project defaults saved')));
});

test('runSetupFlow in project scope supports non-Git and non-Android directory, retrying missing path', async t => {
  const root = makeTempRoot('harness-project-flow-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const xdg = join(root, 'xdg');
  const home = join(root, 'home');
  mkdirSync(join(xdg, 'opencode'), { recursive: true });
  mkdirSync(home, { recursive: true });

  const projectDir = join(root, 'plain-project');
  mkdirSync(projectDir);
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'my-pkg', scripts: { build: 'tsc' } }));

  const outputs: string[] = [];
  const responses = [
    join(root, 'does-not-exist'), // non-existent dir first -> triggers retry
    projectDir,                   // valid dir
    'bash',                       // shell
    'main',                       // baseBranch
    'npm run build',              // build check (suggested from package.json)
    '-', '-', '-', '-',           // lint, unit, runtime, e2e (roborazzi skipped for non-Android!)
    '',                           // no additional gates
    join(home, 'worktrees'),
    join(home, 'data', 'MEMORY.md'),
    'save',
  ];

  const code = await runSetupFlow(
    { scope: 'project' },
    {
      // The policy prompt is answered by its text; this directory has no .git, so it is not asked at all.
      ask: async question => question.startsWith('Type policy') ? '' : responses.shift()!,
      output: msg => outputs.push(msg),
      error: msg => outputs.push(`ERROR: ${msg}`),
      home,
      xdgConfigHome: xdg,
      cwd: root,
    }
  );

  assert.equal(code, 0);
  assert.ok(outputs.some(msg => msg.includes('does not exist or is not a directory')));
  assert.ok(outputs.some(msg => msg.includes('No .git entry found')));
  assert.ok(outputs.some(msg => msg.includes('Node package scripts detected: build')));
  assert.equal(existsSync(join(projectDir, 'AGENTS.md')), true);
  const context = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8');
  assert.ok(context.includes('npm run build'));
});

test('CLI script parses --global and refuses invalid flag combinations', () => {
  const script = fileURLToPath(new URL('../scripts/setup-native-project.ts', import.meta.url));
  const helpOutput = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.match(helpOutput, /--global/);
  assert.match(helpOutput, /--scope/);

  // Unknown option
  assert.throws(() => execFileSync(process.execPath, [script, '--unknown-flag'], { encoding: 'utf8', stdio: 'pipe' }), /Unknown, duplicate, or incomplete option/);

  // Conflicting options: --global and --scope project
  assert.throws(() => execFileSync(process.execPath, [script, '--global', '--scope', 'project'], { encoding: 'utf8', stdio: 'pipe' }), /Conflicting options/);
});

test('readLocalProjectContext: parses valid project section, reports missing, resolves linked context, and throws on malformed schema', t => {
  const { root, project } = fixture(t);

  // 1. Missing context file
  const missing = readLocalProjectContext(join(root, 'nonexistent'));
  assert.equal(missing.status, 'missing');
  assert.match(missing.reason, /no project settings in AGENTS\.md/);

  // 2. Valid project section in AGENTS.md -> status: 'ok'
  const valid = profile(root, project);
  writeFileSync(join(project, 'AGENTS.md'), updateContext('', 'project', valid, []));
  const resultOk = readLocalProjectContext(project);
  assert.equal(resultOk.status, 'ok');
  assert.equal(resultOk.contextRel, 'AGENTS.md');
  assert.equal(resultOk.profile.baseBranch, 'main');
  assert.equal(resultOk.profile.worktreeDirectory, valid.worktreeDirectory);

  // 3. Linked context -> resolves linked file
  const linkedFile = join(project, 'custom-context.md');
  writeFileSync(linkedFile, updateContext('', 'project', valid, []));
  writeFileSync(join(project, 'AGENTS.md'), 'Read `custom-context.md` for Advanced Harness project settings before planning.\n');
  const resultLinked = readLocalProjectContext(project);
  assert.equal(resultLinked.status, 'ok');
  assert.equal(resultLinked.contextRel, 'custom-context.md');
  assert.equal(resultLinked.profile.baseBranch, 'main');

  // 4. Invalid schema -> throws on malformed project schema
  writeFileSync(join(project, 'AGENTS.md'), updateContext('', 'project', { version: 999 }, []));
  assert.throws(() => readLocalProjectContext(project), /Invalid or unsupported project profile metadata/);
});

test('resolveProjectLocations: handles paths-only fallback and reports conflict when project and paths differ', t => {
  const { root, project } = fixture(t);
  const wtDir = join(root, 'worktrees');
  const memDir = join(root, 'data');
  mkdirSync(wtDir, { recursive: true });
  mkdirSync(memDir, { recursive: true });
  const memFile = join(memDir, 'MEMORY.md');
  writeFileSync(memFile, '# Shared Memory\n');

  // 1. Paths-only fallback handling
  writeFileSync(
    join(project, 'AGENTS.md'),
    updateContext('', 'paths', {
      version: 1,
      worktreeDirectory: wtDir,
      memoryPath: memFile,
    }, []),
  );
  const pathsOnly = resolveProjectLocations(project);
  assert.equal(pathsOnly.status, 'resolved');
  assert.equal(pathsOnly.source, 'paths');
  assert.equal(pathsOnly.stored.worktreeDirectory, wtDir);

  // 2. Conflict case where project and paths sections exist with differing values
  const valid = profile(root, project);
  valid.worktreeDirectory = join(root, 'different-wt');
  mkdirSync(valid.worktreeDirectory, { recursive: true });
  const withBoth = updateContext(
    updateContext('', 'paths', {
      version: 1,
      worktreeDirectory: wtDir,
      memoryPath: memFile,
    }, []),
    'project',
    valid,
    [],
  );
  writeFileSync(join(project, 'AGENTS.md'), withBoth);
  const conflict = resolveProjectLocations(project);
  assert.equal(conflict.status, 'conflict');
  assert.match(conflict.reason, /project and paths sections record different shared locations/);
});

type SetupLog = { asked: { question: string; suggested?: string }[]; outputs: string[] };
type SetupRunOptions = { context?: string; policy?: string; confirm?: string };

/** Drives the production project-setup flow. Every prompt is answered by its text, never by its position. */
async function setupRun(root: string, project: string, options: SetupRunOptions = {}, log: SetupLog = { asked: [], outputs: [] }): Promise<number> {
  return runSetupFlow({ project, ...(options.context === undefined ? {} : { context: options.context }) }, {
    ask: async (question, suggested) => {
      log.asked.push({ question, ...(suggested === undefined ? {} : { suggested }) });
      if (question.startsWith('Type policy')) return options.policy ?? '';
      if (question.startsWith('Full preview')) return options.confirm ?? 'cancel';
      if (question.startsWith('Parent directory')) return join(root, 'trees');
      if (question.startsWith('Shared MEMORY.md')) return join(root, 'memory', 'MEMORY.md');
      return suggested ?? '';
    },
    output: line => log.outputs.push(line),
    error: line => log.outputs.push(`ERROR: ${line}`),
    home: join(root, 'home'),
    xdgConfigHome: join(root, 'xdg'),
    recoveryDirectory: join(root, 'backups'),
    cwd: root,
  });
}

const policyPrompts = (log: SetupLog) => log.asked.filter(item => item.question.startsWith('Type policy')).length;

test('preflight policy opt-in writes the default config on save and prints the commit guidance', async t => {
  const { root, project } = fixture(t);
  const log: SetupLog = { asked: [], outputs: [] };
  assert.equal(await setupRun(root, project, { policy: 'policy', confirm: 'save' }, log), 0);
  assert.equal(policyPrompts(log), 1, 'the policy prompt is asked once');
  assert.equal(readFileSync(join(project, '.harness', 'preflight.json'), 'utf8'), `${JSON.stringify(DEFAULT_PREFLIGHT_CONFIG, null, 2)}\n`);
  assert.ok(log.outputs.includes(`  ${join(project, '.harness', 'preflight.json')} (new)`), 'the policy file is listed under Files to write');
  assert.ok(log.outputs.some(line => line.startsWith('Preflight policy saved:') && line.includes('origin/HEAD')));
  assert.ok(log.outputs.some(line => line.includes('git add -f .harness/preflight.json')));
});

test('cancelling after the policy opt-in writes nothing and makes no backups', async t => {
  const { root, project } = fixture(t);
  const agents = '# Existing rules\n';
  writeFileSync(join(project, 'AGENTS.md'), agents);
  const log: SetupLog = { asked: [], outputs: [] };
  assert.equal(await setupRun(root, project, { policy: 'policy', confirm: 'cancel' }, log), 0);
  assert.ok(log.asked.some(item => item.question.startsWith('Full preview')), 'the confirmation was reached');
  assert.equal(existsSync(join(project, '.harness')), false, 'no policy directory or file');
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), agents, 'AGENTS.md is byte-identical');
  assert.equal(existsSync(join(root, 'backups')), false, 'no backups');
  assert.ok(log.outputs.some(line => line.startsWith('Cancelled. Nothing changed')));
});

test('Enter and every answer other than policy skip the policy file', async t => {
  for (const answer of ['', 'yes', 'Policy please', 'p']) {
    const { root, project } = fixture(t);
    const log: SetupLog = { asked: [], outputs: [] };
    assert.equal(await setupRun(root, project, { policy: answer, confirm: 'save' }, log), 0);
    assert.equal(policyPrompts(log), 1, `asked once for "${answer}"`);
    assert.equal(existsSync(join(project, '.harness')), false, `answer "${answer}" writes no policy`);
  }
});

test('a valid existing policy file is kept byte-for-byte without a prompt', async t => {
  const { root, project } = fixture(t);
  mkdirSync(join(project, '.harness'));
  const existing = '{"checks":{"path-policy":{"enabled":true,"severity":"warn"}}}\n';
  writeFileSync(join(project, '.harness', 'preflight.json'), existing);
  const log: SetupLog = { asked: [], outputs: [] };
  assert.equal(await setupRun(root, project, { policy: 'policy', confirm: 'save' }, log), 0);
  assert.equal(policyPrompts(log), 0, 'no policy prompt');
  assert.ok(log.outputs.includes('Existing preflight policy kept unchanged.'));
  assert.equal(readFileSync(join(project, '.harness', 'preflight.json'), 'utf8'), existing);
});

test('an existing policy that replaces the built-in forbidden globs is kept with a warning; add mode is not warned', async t => {
  const cases: [unknown, boolean][] = [
    [{ forbiddenPathGlobs: ['**/*.bin'] }, true],
    [{ forbiddenPathGlobs: { mode: 'replace', globs: [] } }, true],
    [{ forbiddenPathGlobs: { mode: 'add', globs: ['**/*.bin'] } }, false],
  ];
  for (const [config, warns] of cases) {
    const { root, project } = fixture(t);
    mkdirSync(join(project, '.harness'));
    writeFileSync(join(project, '.harness', 'preflight.json'), JSON.stringify(config));
    const log: SetupLog = { asked: [], outputs: [] };
    assert.equal(await setupRun(root, project, { policy: 'policy', confirm: 'save' }, log), 0);
    assert.equal(log.outputs.some(line => line.startsWith('Warning: .harness/preflight.json replaces the built-in forbidden path globs')), warns, JSON.stringify(config));
    assert.equal(policyPrompts(log), 0);
  }
});

test('an invalid existing policy stops setup before any prompt, with no writes or backups', async t => {
  const { root, project } = fixture(t);
  mkdirSync(join(project, '.harness'));
  const invalid = '{"checks":{"secret-scan":{"enabled":false}}}';
  writeFileSync(join(project, '.harness', 'preflight.json'), invalid);
  const log: SetupLog = { asked: [], outputs: [] };
  await assert.rejects(setupRun(root, project, { policy: 'policy', confirm: 'save' }, log), /fixed check.*No files changed\./);
  assert.equal(log.asked.length, 0, 'no prompt is shown');
  assert.equal(readFileSync(join(project, '.harness', 'preflight.json'), 'utf8'), invalid);
  assert.equal(existsSync(join(project, 'AGENTS.md')), false);
  assert.equal(existsSync(join(root, 'backups')), false);
});

test('an alternate --context still writes the root policy file, not one beside the context file', async t => {
  const { root, project } = fixture(t);
  mkdirSync(join(project, 'docs'));
  writeFileSync(join(project, 'docs', 'HARNESS.md'), '# Harness\n');
  const log: SetupLog = { asked: [], outputs: [] };
  assert.equal(await setupRun(root, project, { context: 'docs/HARNESS.md', policy: 'policy', confirm: 'save' }, log), 0);
  assert.equal(existsSync(join(project, '.harness', 'preflight.json')), true);
  assert.equal(existsSync(join(project, 'docs', '.harness')), false);
});

test('cancelling with an alternate --context and the policy answer writes nothing, makes no backups, and creates no .harness', async t => {
  const { root, project } = fixture(t);
  mkdirSync(join(project, 'docs'));
  const context = join(project, 'docs', 'HARNESS.md');
  writeFileSync(context, '# Harness\n');
  const log: SetupLog = { asked: [], outputs: [] };
  assert.equal(await setupRun(root, project, { context: 'docs/HARNESS.md', policy: 'policy', confirm: 'cancel' }, log), 0);
  assert.equal(policyPrompts(log), 1, 'the policy prompt is asked once');
  assert.ok(log.asked.some(item => item.question.startsWith('Full preview')), 'the confirmation was reached');
  assert.equal(readFileSync(context, 'utf8'), '# Harness\n', 'the context file is unchanged');
  assert.equal(existsSync(join(project, 'AGENTS.md')), false, 'nothing is created at the root');
  assert.equal(existsSync(join(project, '.harness')), false, 'no policy directory or file');
  assert.equal(existsSync(join(root, 'backups')), false, 'no backups');
  assert.ok(log.outputs.some(line => line.startsWith('Cancelled. Nothing changed')));
});

test('a .harness regular file or an oversized policy file stops setup before any prompt', async t => {
  const { root, project } = fixture(t);
  writeFileSync(join(project, '.harness'), 'not a directory');
  assert.throws(() => readSetupPreflightPolicy(project), /\.harness must be a real directory/);
  rmSync(join(project, '.harness'));

  mkdirSync(join(project, '.harness'));
  writeFileSync(join(project, '.harness', 'preflight.json'), Buffer.alloc(1024 * 1024 + 1, 0x20));
  assert.throws(() => readSetupPreflightPolicy(project), /\.harness\/preflight\.json must be a regular text file no larger than 1 MiB/);
  const log: SetupLog = { asked: [], outputs: [] };
  await assert.rejects(setupRun(root, project, { policy: 'policy', confirm: 'save' }, log), /No files changed\./);
  assert.equal(log.asked.length, 0, 'no prompt is shown');
});

test('a symlinked .harness directory is refused', t => {
  const { root, project } = fixture(t);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'preflight.json'), '{}');
  try { symlinkSync(outside, join(project, '.harness'), 'junction'); }
  catch { t.skip('directory symlinks are unavailable on this machine'); return; }
  assert.throws(() => readSetupPreflightPolicy(project), /\.harness must be a real directory/);
});

test('a symlinked policy file is refused', t => {
  const { root, project } = fixture(t);
  const outside = join(root, 'outside.json');
  writeFileSync(outside, '{}');
  mkdirSync(join(project, '.harness'));
  try { symlinkSync(outside, join(project, '.harness', 'preflight.json'), 'file'); }
  catch { t.skip('file symlinks are unavailable on this machine'); return; }
  assert.throws(() => readSetupPreflightPolicy(project), /\.harness\/preflight\.json must be a regular text file/);
});

test('a duplicate key in an existing policy stops setup before any prompt, naming the file', async t => {
  const { root, project } = fixture(t);
  mkdirSync(join(project, '.harness'));
  writeFileSync(join(project, '.harness', 'preflight.json'), '{"forbiddenPathGlobs":[],"forbiddenPathGlobs":[]}');
  const log: SetupLog = { asked: [], outputs: [] };
  await assert.rejects(setupRun(root, project, { policy: 'policy', confirm: 'save' }, log), /Invalid \.harness\/preflight\.json: duplicate key "forbiddenPathGlobs".*No files changed\./);
  assert.equal(log.asked.length, 0, 'no prompt is shown');
  assert.equal(existsSync(join(root, 'backups')), false);
});

test('a directory without .git gets a note and no policy prompt', async t => {
  const { root } = fixture(t);
  const plain = join(root, 'plain');
  mkdirSync(plain);
  const log: SetupLog = { asked: [], outputs: [] };
  assert.equal(await setupRun(root, plain, { policy: 'policy', confirm: 'save' }, log), 0);
  assert.equal(policyPrompts(log), 0);
  assert.ok(log.outputs.some(line => line.includes('is read at the repository top level')));
  assert.equal(existsSync(join(plain, '.harness')), false);
});

test('a valid project section in a linked context file is the source of suggestions, is saved back there, and AGENTS.md stays byte-identical', async t => {
  const { root, project } = fixture(t);
  mkdirSync(join(project, 'docs'));
  const linked = join(project, 'docs', 'HARNESS.md');
  // Non-default values: the defaults are base branch "main", shell by platform, device "physical-first", and no build command.
  const seeded: ProjectProfile = {
    ...profile(root, project),
    baseBranch: 'release',
    shell: 'cmd',
    checks: { ...profile(root, project).checks, build: { status: 'configured', command: 'gradlew.bat :app:assembleSeedDebug' } },
    device: { preference: 'emulator', serial: 'emulator-5554' },
  };
  writeFileSync(linked, updateContext('# Harness\n', 'project', seeded, []));
  writeFileSync(join(project, 'AGENTS.md'), 'Read `docs/HARNESS.md` for Advanced Harness project settings before planning.\n');
  const agents = readFileSync(join(project, 'AGENTS.md'), 'utf8');
  const log: SetupLog = { asked: [], outputs: [] };
  // No --context: the linked file is found through AGENTS.md. Every prompt takes its suggestion (Enter), except the
  // full-preview confirmation, which must be typed as `save` to write anything.
  const code = await runSetupFlow({ project }, {
    ask: async (question, suggested) => {
      log.asked.push({ question, ...(suggested === undefined ? {} : { suggested }) });
      if (question.startsWith('Full preview')) return 'save';
      return suggested ?? '';
    },
    output: line => log.outputs.push(line),
    error: line => log.outputs.push(`ERROR: ${line}`),
    home: join(root, 'home'),
    xdgConfigHome: join(root, 'xdg'),
    recoveryDirectory: join(root, 'backups'),
    cwd: root,
  });
  assert.equal(code, 0);

  const suggestedFor = (prefix: string) => log.asked.find(item => item.question.startsWith(prefix))?.suggested;
  assert.equal(suggestedFor('Base branch'), 'release', 'the seeded base branch is suggested');
  assert.equal(suggestedFor('Command shell'), 'cmd', 'the seeded shell is suggested');
  assert.equal(suggestedFor('build: confirm command'), 'gradlew.bat :app:assembleSeedDebug', 'the seeded build command is suggested');
  assert.equal(suggestedFor('Device preference'), 'emulator', 'the seeded device preference is suggested');
  assert.equal(suggestedFor('Optional device serial'), 'emulator-5554', 'the seeded device serial is suggested');

  const saved = validateProfile(contextData(readFileSync(linked, 'utf8'), 'project'));
  assert.equal(saved.baseBranch, 'release', 'the saved linked file keeps the base branch');
  assert.equal(saved.shell, 'cmd', 'the saved linked file keeps the shell');
  assert.deepEqual(saved.checks.build, { status: 'configured', command: 'gradlew.bat :app:assembleSeedDebug' }, 'the saved linked file keeps the build command');
  assert.deepEqual(saved.device, { preference: 'emulator', serial: 'emulator-5554' }, 'the saved linked file keeps the device settings');
  assert.equal(saved.worktreeDirectory, seeded.worktreeDirectory);
  assert.equal(saved.memoryPath, seeded.memoryPath);

  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), agents, 'AGENTS.md is byte-identical, so the link is preserved');
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8').includes('advanced-harness:project:start'), false, 'no project section was written into AGENTS.md');
  assert.ok(log.outputs.includes(`Context file: ${linked} (linked from AGENTS.md; the link is kept as written)`));
  assert.ok(log.outputs.includes(`Project settings saved in context: ${linked}`));
});

test('cancelling a linked context writes nothing and makes no backups', async t => {
  const { root, project } = fixture(t);
  mkdirSync(join(project, 'docs'));
  const linked = join(project, 'docs', 'HARNESS.md');
  writeFileSync(linked, '# Harness\n');
  writeFileSync(join(project, 'AGENTS.md'), 'Read `docs/HARNESS.md` for Advanced Harness project settings before planning.\n');
  const agents = readFileSync(join(project, 'AGENTS.md'), 'utf8');
  assert.equal(await setupRun(root, project, { confirm: 'cancel' }), 0);
  assert.equal(readFileSync(linked, 'utf8'), '# Harness\n');
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), agents);
  assert.equal(existsSync(join(root, 'backups')), false);
});

test('an invalid linked context stops before any prompt, with no writes, backups, or changes', async t => {
  const { root, project } = fixture(t);
  mkdirSync(join(project, 'docs'));
  const linked = join(project, 'docs', 'HARNESS.md');
  const invalid = updateContext('# Harness\n', 'project', { version: 999 }, []);
  writeFileSync(linked, invalid);
  writeFileSync(join(project, 'AGENTS.md'), 'Read `docs/HARNESS.md` for Advanced Harness project settings before planning.\n');
  const agents = readFileSync(join(project, 'AGENTS.md'), 'utf8');
  const log: SetupLog = { asked: [], outputs: [] };
  await assert.rejects(setupRun(root, project, { policy: 'policy', confirm: 'save' }, log), /Project context could not be read: .*No files changed\./);
  assert.equal(log.asked.length, 0, 'no prompt is shown');
  assert.equal(readFileSync(linked, 'utf8'), invalid);
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), agents);
  assert.equal(existsSync(join(root, 'backups')), false);
});

test('a link that escapes the project stops before any prompt with no writes', async t => {
  const { root, project } = fixture(t);
  writeFileSync(join(project, 'AGENTS.md'), 'Read `../outside.md` for Advanced Harness project settings before planning.\n');
  const agents = readFileSync(join(project, 'AGENTS.md'), 'utf8');
  const log: SetupLog = { asked: [], outputs: [] };
  await assert.rejects(setupRun(root, project, { confirm: 'save' }, log), /Project context could not be read: .*inside the project\. No files changed\./);
  assert.equal(log.asked.length, 0, 'no prompt is shown');
  assert.equal(existsSync(join(root, 'outside.md')), false);
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), agents);
  assert.equal(existsSync(join(root, 'backups')), false);
});

test('a dangling link is created by setup, marked new in the preview, and kept as written in AGENTS.md', async t => {
  const { root, project } = fixture(t);
  const link = 'Read `docs/HARNESS.md` for Advanced Harness project settings before planning.\n';
  writeFileSync(join(project, 'AGENTS.md'), link);
  const log: SetupLog = { asked: [], outputs: [] };
  assert.equal(await setupRun(root, project, { confirm: 'save' }, log), 0);
  const linked = join(project, 'docs', 'HARNESS.md');
  assert.ok(log.outputs.includes(`  ${linked} (new)`), 'the linked file is previewed as new');
  assert.ok(log.outputs.includes(`Context file: ${linked} (linked from AGENTS.md; the link is kept as written)`));
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), link, 'the link is kept as written');
  assert.notEqual(contextData(readFileSync(linked, 'utf8'), 'project'), undefined, 'setup created the linked file');
});
