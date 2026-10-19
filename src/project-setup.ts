import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseConfiguration, saveInstallation, type Ask } from './native-installer.ts';
import { contextData, contextPath, prepareContextFiles, readContext, updateContext } from './project-context.ts';

export const checkNames = ['build', 'lint', 'unit', 'roborazzi', 'runtime', 'e2e'] as const;
export type CheckName = typeof checkNames[number];
export type ProjectCheck = { status: 'configured'; command: string } | { status: 'unconfigured' };
export type ProjectProfile = {
  version: 1;
  projectRoot: string;
  baseBranch: string;
  shell: 'powershell' | 'bash' | 'cmd';
  checks: Record<CheckName, ProjectCheck>;
  device: { preference: 'physical-first' | 'emulator' | 'ask'; serial?: string };
  worktreeDirectory: string;
  memoryPath: string;
};
export type Inspection = {
  hasGit: boolean;
  gradleFiles: string[];
  androidModules: string[];
  roborazzi: boolean;
  wrappers: { bash: boolean; windows: boolean };
  packageScripts?: Partial<Record<CheckName, string>> | undefined;
  agents: string | undefined;
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function validBranch(value: string): boolean {
  return !!value && value !== '@' && !/\s|[\x00-\x1f\x7f~^:?*\[\\]|\.\.|@\{|\/\/|^[-/]|\/$|\.$|\.lock(?:\/|$)|(?:^|\/)\./.test(value);
}

export function expandPath(path: string, home = homedir()): string {
  return resolve(path.replace(/^(?:~|\$HOME)(?=[/\\]|$)/, home));
}

function safeText(path: string): string {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024 * 1024) throw new Error('Expected a regular text file no larger than 1 MiB. No project files changed.');
  return readFileSync(path, 'utf8');
}

/** Bounded filesystem inspection only; Gradle scripts are never evaluated. */
export function inspectProject(directory: string): Inspection {
  const root = resolve(directory);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error('Select an existing repository directory.');
  const hasGit = existsSync(join(root, '.git'));
  const gradleFiles: string[] = [];
  const androidModules: string[] = [];
  let roborazzi = false;
  let visited = 0;
  const walk = (directory: string, depth: number) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++visited > 2000) throw new Error('Project inspection limit reached; select a smaller repository or reduce generated directories.');
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3 && !entry.name.startsWith('.') && !['build', 'node_modules', 'src', 'out', 'dist'].includes(entry.name)) walk(path, depth + 1);
      } else if (entry.isFile() && /^(build|settings)\.gradle(\.kts)?$/.test(entry.name)) {
        const text = safeText(path);
        gradleFiles.push(relative(root, path).replaceAll('\\', '/'));
        if (/com\.android\.(application|library)/.test(text) && entry.name.startsWith('build.')) androidModules.push(relative(root, directory).replaceAll('\\', '/'));
        if (/roborazzi/i.test(text)) roborazzi = true;
      }
    }
  };
  walk(root, 0);

  let packageScripts: Partial<Record<CheckName, string>> | undefined;
  const packageJsonPath = join(root, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(safeText(packageJsonPath));
      if (parsed && typeof parsed === 'object' && typeof parsed.scripts === 'object' && parsed.scripts !== null) {
        const scripts = parsed.scripts as Record<string, unknown>;
        packageScripts = {};
        if (typeof scripts.build === 'string') packageScripts.build = 'npm run build';
        if (typeof scripts.lint === 'string') packageScripts.lint = 'npm run lint';
        if (typeof scripts.test === 'string') packageScripts.unit = 'npm test';
        else if (typeof scripts.unit === 'string') packageScripts.unit = 'npm run unit';
        if (typeof scripts.e2e === 'string') packageScripts.e2e = 'npm run e2e';
      }
    } catch { /* ignore invalid or unreadable package.json for heuristic suggestions */ }
  }

  const agentsPath = join(root, 'AGENTS.md');
  return {
    hasGit,
    gradleFiles,
    androidModules,
    roborazzi,
    wrappers: { bash: existsSync(join(root, 'gradlew')), windows: existsSync(join(root, 'gradlew.bat')) },
    packageScripts,
    agents: existsSync(agentsPath) ? safeText(agentsPath) : undefined,
  };
}

export function suggestedCommands(inspection: Inspection, shell: ProjectProfile['shell']): Partial<Record<CheckName, string>> {
  const hasGradleWrapper = shell === 'bash' ? inspection.wrappers.bash : inspection.wrappers.windows;
  if (hasGradleWrapper && inspection.gradleFiles.length > 0) {
    const wrapper = shell === 'powershell' ? '.\\gradlew.bat' : shell === 'cmd' ? 'gradlew.bat' : './gradlew';
    const module = inspection.androidModules[0];
    const prefix = module ? `:${module.replaceAll('/', ':')}:` : '';
    return {
      build: `${wrapper} ${prefix}assembleDebug`,
      lint: `${wrapper} ${prefix}lintDebug`,
      unit: `${wrapper} ${prefix}testDebugUnitTest`,
      ...(inspection.roborazzi ? { roborazzi: `${wrapper} ${prefix}verifyRoborazziDebug` } : {}),
    };
  }
  if (inspection.packageScripts && Object.keys(inspection.packageScripts).length > 0) {
    return { ...inspection.packageScripts };
  }
  return {};
}

/** Full-preview confirmation accepts only the documented tokens; all else cancels. */
export function setupConfirmation(response: string): 'save' | 'cancel' {
  const answer = response.trim();
  return answer === 'save' || answer === 'setup' ? 'save' : 'cancel';
}

/** Production CLI decision flow, extracted so cancellation is regression-tested. */
export function confirmAndSaveSetup(response: string, files: readonly SetupFile[], backupParent: string): { status: 'cancelled' } | { status: 'saved'; backups: (string | undefined)[] } {
  if (setupConfirmation(response) !== 'save') return { status: 'cancelled' };
  return { status: 'saved', backups: saveSetup(files, backupParent) };
}

function inside(path: string, directory: string): boolean {
  const child = relative(resolve(directory), resolve(path));
  return child === '' || (!child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && child !== '..' && !isAbsolute(child));
}

export function validateProfile(value: unknown): ProjectProfile {
  if (!object(value) || !onlyKeys(value, ['version', 'projectRoot', 'baseBranch', 'shell', 'checks', 'device', 'worktreeDirectory', 'memoryPath']) || value.version !== 1 || typeof value.projectRoot !== 'string' || !isAbsolute(value.projectRoot) || typeof value.baseBranch !== 'string' || !validBranch(value.baseBranch) || !['powershell', 'bash', 'cmd'].includes(String(value.shell)) || !object(value.checks) || !onlyKeys(value.checks, checkNames) || !object(value.device) || !onlyKeys(value.device, ['preference', 'serial']) || !['physical-first', 'emulator', 'ask'].includes(String(value.device.preference))) throw new Error('Invalid or unsupported project profile metadata; unknown fields are not silently discarded.');
  for (const name of checkNames) {
    const check = value.checks[name];
    if (!object(check) || !onlyKeys(check, ['status', 'command']) || !['configured', 'unconfigured'].includes(String(check.status))) throw new Error(`Invalid ${name} check configuration.`);
    if (check.status === 'configured' && (typeof check.command !== 'string' || !check.command.trim() || /[\r\n\0]/.test(check.command))) throw new Error(`Invalid ${name} command; use a single shell command line.`);
    if (check.status === 'unconfigured' && Object.hasOwn(check, 'command')) throw new Error(`Unconfigured ${name} cannot contain a command.`);
  }
  if (value.device.serial !== undefined && (typeof value.device.serial !== 'string' || !/^[\w.:-]+$/.test(value.device.serial))) throw new Error('Invalid device serial.');
  for (const key of ['worktreeDirectory', 'memoryPath'] as const) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key]) || inside(value[key], value.projectRoot) || inside(value.projectRoot, key === 'memoryPath' ? dirname(value[key]) : value[key])) throw new Error('Worktree and shared-memory paths must be outside the application checkout and cannot contain it.');
  }
  if (basename(value.memoryPath as string) !== 'MEMORY.md') throw new Error('Shared memory path must end in MEMORY.md.');
  if (inside(value.memoryPath as string, value.worktreeDirectory as string)) throw new Error('Shared memory must not be inside the worktree directory.');
  return value as ProjectProfile;
}

export function parseProfile(text: string): ProjectProfile {
  try {
    parseConfiguration(text, 'project profile'); // Reject ambiguous duplicate keys before JSON.parse.
    return validateProfile(JSON.parse(text));
  } catch { throw new Error('Invalid existing project profile; resolve it before setup. No files changed.'); }
}

export type GlobalProjectDefaults = {
  version: 1;
  baseBranch: string;
  shell: 'powershell' | 'bash' | 'cmd';
  checks: Record<CheckName, ProjectCheck>;
  device: { preference: 'physical-first' | 'emulator' | 'ask'; serial?: string };
  worktreeParentDirectory: string;
  memoryParentDirectory: string;
};

export function emptyGlobalProjectDefaults(home = homedir()): GlobalProjectDefaults {
  return {
    version: 1,
    baseBranch: 'main',
    shell: process.platform === 'win32' ? 'powershell' : 'bash',
    checks: Object.fromEntries(checkNames.map(name => [name, { status: 'unconfigured' }])) as Record<CheckName, ProjectCheck>,
    device: { preference: 'physical-first' },
    worktreeParentDirectory: join(home, 'Projects', 'advanced-harness-worktrees'),
    memoryParentDirectory: join(home, 'Projects', 'advanced-harness-data'),
  };
}

export function validateGlobalProjectDefaults(value: unknown): GlobalProjectDefaults {
  if (!object(value) || !onlyKeys(value, ['version', 'baseBranch', 'shell', 'checks', 'device', 'worktreeParentDirectory', 'memoryParentDirectory']) || value.version !== 1 || typeof value.baseBranch !== 'string' || !validBranch(value.baseBranch) || !['powershell', 'bash', 'cmd'].includes(String(value.shell)) || !object(value.checks) || !onlyKeys(value.checks, checkNames) || !object(value.device) || !onlyKeys(value.device, ['preference', 'serial']) || !['physical-first', 'emulator', 'ask'].includes(String(value.device.preference))) throw new Error('Invalid or unsupported global project defaults; unknown fields are not silently discarded.');
  for (const name of checkNames) {
    const check = value.checks[name];
    if (!object(check) || !onlyKeys(check, ['status', 'command']) || !['configured', 'unconfigured'].includes(String(check.status))) throw new Error(`Invalid ${name} check configuration.`);
    if (check.status === 'configured' && (typeof check.command !== 'string' || !check.command.trim() || /[\r\n\0]/.test(check.command))) throw new Error(`Invalid ${name} command; use a single shell command line.`);
    if (check.status === 'unconfigured' && Object.hasOwn(check, 'command')) throw new Error(`Unconfigured ${name} cannot contain a command.`);
  }
  if (value.device.serial !== undefined && (typeof value.device.serial !== 'string' || !/^[\w.:-]+$/.test(value.device.serial))) throw new Error('Invalid device serial.');
  for (const key of ['worktreeParentDirectory', 'memoryParentDirectory'] as const) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key])) throw new Error(`Global ${key} must be an absolute path.`);
  }
  return value as GlobalProjectDefaults;
}

export function parseGlobalProjectDefaults(text: string): GlobalProjectDefaults {
  try {
    parseConfiguration(text, 'global project defaults');
    return validateGlobalProjectDefaults(JSON.parse(text));
  } catch { throw new Error('Invalid existing global project defaults; resolve it before setup. No files changed.'); }
}

async function choose<T extends string>(ask: Ask, question: string, choices: readonly T[], suggested: T): Promise<T> {
  for (;;) {
    const answer = (await ask(question, suggested)).trim() || suggested;
    if (choices.includes(answer as T)) return answer as T;
  }
}

export async function askProjectShell(ask: Ask, suggested: ProjectProfile['shell']): Promise<ProjectProfile['shell']> {
  return choose(ask, 'Command shell: powershell, bash, or cmd', ['powershell', 'bash', 'cmd'], suggested);
}

export async function askGlobalProfile(previous: GlobalProjectDefaults | undefined, ask: Ask, home = homedir(), selectedShell?: ProjectProfile['shell']): Promise<GlobalProjectDefaults> {
  let baseBranch = '';
  while (!baseBranch) {
    const answer = (await ask('Default base branch', previous?.baseBranch ?? 'main')).trim() || previous?.baseBranch || 'main';
    if (validBranch(answer)) baseBranch = answer;
  }
  const shell: ProjectProfile['shell'] = selectedShell ?? await choose(ask, 'Default command shell: powershell, bash, or cmd', ['powershell', 'bash', 'cmd'], previous?.shell ?? (process.platform === 'win32' ? 'powershell' : 'bash'));
  const checks = {} as Record<CheckName, ProjectCheck>;
  for (const name of checkNames) {
    const old = previous?.checks[name];
    const suggestion = old?.status === 'configured' ? old.command : '-';
    let answer: string;
    do { answer = (await ask(`Default ${name} command, or - to leave UNCONFIGURED`, suggestion)).trim() || suggestion; } while (/[\r\n\0]/.test(answer));
    checks[name] = answer === '-' ? { status: 'unconfigured' } : { status: 'configured', command: answer };
  }
  const preference = await choose(ask, 'Default device preference: physical-first, emulator, or ask', ['physical-first', 'emulator', 'ask'], previous?.device.preference ?? 'physical-first');
  let serial = '';
  for (;;) {
    const answer = (await ask('Optional default device serial (- to decide at runtime)', previous?.device.serial ?? '-')).trim() || previous?.device.serial || '-';
    if (answer === '-' || /^[\w.:-]+$/.test(answer)) { serial = answer === '-' ? '' : answer; break; }
  }
  const worktreeParentDirectory = expandPath((await ask('Default parent directory for future worktrees', previous?.worktreeParentDirectory ?? join(home, 'Projects', 'advanced-harness-worktrees'))).trim() || previous?.worktreeParentDirectory || join(home, 'Projects', 'advanced-harness-worktrees'), home);
  const memoryParentDirectory = expandPath((await ask('Default parent directory for shared memory', previous?.memoryParentDirectory ?? join(home, 'Projects', 'advanced-harness-data'))).trim() || previous?.memoryParentDirectory || join(home, 'Projects', 'advanced-harness-data'), home);
  return validateGlobalProjectDefaults({ version: 1, baseBranch, shell, checks, device: { preference, ...(serial ? { serial } : {}) }, worktreeParentDirectory, memoryParentDirectory });
}

export async function askProfile(
  root: string,
  inspection: Inspection,
  previous: ProjectProfile | undefined,
  ask: Ask,
  selectedShell?: ProjectProfile['shell'],
  globalDefaults?: GlobalProjectDefaults,
  home = homedir()
): Promise<ProjectProfile> {
  const isAndroid = inspection.gradleFiles.length > 0 || inspection.androidModules.length > 0 || inspection.roborazzi || previous?.checks.roborazzi.status === 'configured' || previous?.device.serial !== undefined;
  let baseBranch = '';
  while (!baseBranch) {
    const answer = (await ask('Base branch (confirm against the repository; not inferred)', previous?.baseBranch ?? globalDefaults?.baseBranch ?? 'main')).trim() || previous?.baseBranch || globalDefaults?.baseBranch || 'main';
    if (validBranch(answer)) baseBranch = answer;
  }
  const defaultShell = previous?.shell ?? globalDefaults?.shell ?? (process.platform === 'win32' ? 'powershell' : 'bash');
  const shell: ProjectProfile['shell'] = selectedShell ?? await choose(ask, 'Command shell: powershell, bash, or cmd', ['powershell', 'bash', 'cmd'], defaultShell);
  const suggestions = suggestedCommands(inspection, shell);
  const checks = {} as Record<CheckName, ProjectCheck>;
  for (const name of checkNames) {
    if (name === 'roborazzi' && !isAndroid) {
      checks.roborazzi = { status: 'unconfigured' };
      continue;
    }
    const old = previous?.checks[name];
    const suggestion = old?.status === 'configured'
      ? old.command
      : old
      ? '-'
      : suggestions[name] ?? (globalDefaults?.checks[name]?.status === 'configured' ? globalDefaults.checks[name].command : '-');
    let answer: string;
    do { answer = (await ask(`${name}: confirm command, or - to leave UNCONFIGURED`, suggestion)).trim() || suggestion; } while (/[\r\n\0]/.test(answer));
    checks[name] = answer === '-' ? { status: 'unconfigured' } : { status: 'configured', command: answer };
  }
  let device: ProjectProfile['device'];
  if (isAndroid) {
    const preference = await choose(ask, 'Device preference: physical-first, emulator, or ask', ['physical-first', 'emulator', 'ask'], previous?.device.preference ?? globalDefaults?.device.preference ?? 'physical-first');
    let serial = '';
    for (;;) {
      const answer = (await ask('Optional device serial (- to decide at runtime)', previous?.device.serial ?? globalDefaults?.device.serial ?? '-')).trim() || previous?.device.serial || globalDefaults?.device.serial || '-';
      if (answer === '-' || /^[\w.:-]+$/.test(answer)) { serial = answer === '-' ? '' : answer; break; }
    }
    device = { preference, ...(serial ? { serial } : {}) };
  } else {
    device = previous?.device ?? globalDefaults?.device ?? { preference: 'ask' };
  }
  const canonical = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
  const id = `${basename(root).replace(/[^a-zA-Z0-9_-]/g, '-') || 'project'}-${createHash('sha256').update(canonical).digest('hex').slice(0, 8)}`;
  const defaultWorktreeParent = globalDefaults?.worktreeParentDirectory ?? join(home, 'Projects', 'advanced-harness-worktrees');
  const defaultMemoryParent = globalDefaults?.memoryParentDirectory ?? join(home, 'Projects', 'advanced-harness-data');
  const worktreeDirectory = expandPath((await ask('Parent directory for future worktrees (outside the checkout)', previous?.worktreeDirectory ?? join(defaultWorktreeParent, id))).trim() || previous?.worktreeDirectory || join(defaultWorktreeParent, id), home);
  const memoryPath = expandPath((await ask('Shared MEMORY.md path (outside checkout/worktrees)', previous?.memoryPath ?? join(defaultMemoryParent, id, 'MEMORY.md'))).trim() || previous?.memoryPath || join(defaultMemoryParent, id, 'MEMORY.md'), home);
  return validateProfile({ version: 1, projectRoot: resolve(root), baseBranch, shell, checks, device, worktreeDirectory, memoryPath });
}

export function updateProjectInstructions(original: string | undefined, profile: ProjectProfile): string {
  validateProfile(profile);
  const previous = contextData(original, 'project');
  if (previous !== undefined) validateProfile(previous);
  return updateContext(original, 'project', profile, [
    'These embedded settings are the project context source; legacy .opencode/harness.project.json files are not loaded automatically.',
    'Use the settings below before planning. Commands are confirmed choices, not verified results or authorization to execute them.',
    'Run commands in the active application worktree root. Ask on instruction conflicts, missing prerequisites, or unconfigured checks; missing checks are not passed or waived.',
    'Operator owns local Git/worktrees and shared MEMORY.md. Task bootstrap prepares the worktree and initializes shared memory without blocking on other worktrees. Shared memory stays outside application worktrees.',
    'Screenshots/video/logcat evidence remain optional unless explicitly required. Implementation and publishing require separate conversational approvals.',
  ]);
}

export type SetupFile = { path: string; original: string | undefined; updated: string };
export function prepareSetup(root: string, profile: ProjectProfile, original: string | undefined, target = join(root, 'AGENTS.md')): SetupFile[] {
  validateProfile(profile);
  if (resolve(root) !== resolve(profile.projectRoot)) throw new Error('Profile checkout does not match the selected project.');
  return prepareContextFiles(root, target, original, updateProjectInstructions(original, profile));
}

export function saveSetup(files: readonly SetupFile[], backupParent: string): (string | undefined)[] {
  // Preflight the whole set before the first write. Each write rechecks too.
  for (const file of files) {
    const entry = lstatSync(file.path, { throwIfNoEntry: false });
    if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error('Refusing non-regular project setup targets.');
    // Do not write through a symlinked .opencode directory or ancestor.
    for (let directory = dirname(file.path); ; directory = dirname(directory)) {
      const parent = lstatSync(directory, { throwIfNoEntry: false });
      if (parent?.isSymbolicLink()) throw new Error('Refusing setup through symlinked directories.');
      if (dirname(directory) === directory) break;
    }
    const current = entry ? readFileSync(file.path, 'utf8') : undefined;
    if (current !== file.original) throw new Error('Project files changed during setup. Rerun; nothing was overwritten.');
  }
  const backups: (string | undefined)[] = [];
  for (const file of files) {
    try { backups.push(saveInstallation(file.path, file.original, file.updated, backupParent)); }
    catch { throw new Error(`Setup save failed after ${backups.length} file(s). Inspect saved files and backups before rerunning; no automatic rollback was attempted. Backups: ${backups.filter(Boolean).join(', ') || 'none for completed writes'}`); }
  }
  return backups;
}

export interface SetupFlowOptions {
  scope?: string | undefined;
  project?: string | undefined;
  context?: string | undefined;
  global?: boolean | undefined;
}

export interface SetupFlowDependencies {
  ask: Ask;
  output(message: string): void;
  error(message: string): void;
  cwd?: string;
  home?: string;
  xdgConfigHome?: string;
  recoveryDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  save?: typeof saveSetup;
}

export async function runSetupFlow(options: SetupFlowOptions, deps: SetupFlowDependencies): Promise<number> {
  const { ask } = deps;
  const output = deps.output;
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? homedir();
  const env = deps.environment ?? process.env;
  const save = deps.save ?? saveSetup;
  const backupParent = deps.recoveryDirectory ?? env.ADVANCED_HARNESS_RECOVERY_DIR ?? join(home, 'Projects', 'advanced-harness-backups');

  let scope = options.scope ?? (options.global ? 'global' : options.project || options.context ? 'project' : undefined);
  while (!scope || !['global', 'project'].includes(scope)) {
    scope = (await ask('Setup scope: global or project', 'global')).trim() || 'global';
  }

  if (scope === 'global' && (options.project || options.context)) {
    throw new Error('Global setup does not take project/context settings. Use project scope separately.');
  }

  const globalDir = resolve(join(deps.xdgConfigHome ?? env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode'));
  const globalDefaultsPath = join(globalDir, 'harness.project.json');

  if (scope === 'global') {
    const originalDefaults = existsSync(globalDefaultsPath) ? readFileSync(globalDefaultsPath, 'utf8') : undefined;
    let previous: GlobalProjectDefaults | undefined;
    if (originalDefaults !== undefined) {
      try { previous = parseGlobalProjectDefaults(originalDefaults); }
      catch { output('Warning: Existing global project defaults file contains invalid data and will not be loaded as suggestions.'); }
    }
    const shell = await askProjectShell(ask, previous?.shell ?? (process.platform === 'win32' ? 'powershell' : 'bash'));
    const profile = await askGlobalProfile(previous, ask, home, shell);
    const updated = JSON.stringify(profile, null, 2) + '\n';
    const file: SetupFile = { path: globalDefaultsPath, original: originalDefaults, updated };

    output('\nReview global project defaults (no credentials):');
    output(updated);
    output('Files to write:');
    output(`  ${file.path}${file.original === undefined ? ' (new)' : ' (backup before updating)'}`);

    const confirm = await ask('Full preview: type save (or legacy setup) to save; Enter or anything else cancels', 'cancel');
    const result = confirmAndSaveSetup(confirm, [file], backupParent);
    if (result.status === 'cancelled') {
      output('Cancelled. Nothing changed: no files written and no backups created.');
      return 0;
    }
    for (const backup of result.backups) if (backup) output(`Backup (keep private): ${backup}`);
    output(`Global project defaults saved: ${globalDefaultsPath}`);
    return 0;
  }

  // Project scope
  let root = '';
  if (options.project) {
    root = expandPath(options.project, home);
    if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error('Select an existing repository directory.');
  } else {
    for (;;) {
      const answer = (await ask('Project directory', cwd)).trim() || cwd;
      const candidate = expandPath(answer, home);
      if (existsSync(candidate) && lstatSync(candidate).isDirectory()) {
        root = candidate;
        break;
      }
      output(`Directory "${candidate}" does not exist or is not a directory. Enter an existing directory.`);
    }
  }

  const inspection = inspectProject(root);
  if (!inspection.hasGit) {
    output(`Note: No .git entry found in ${root}; proceeding with non-Git directory setup.`);
  }

  output(`Project: ${root}`);
  if (inspection.gradleFiles.length > 0) {
    output(`Gradle files inspected: ${inspection.gradleFiles.join(', ')}`);
    output(`Android modules detected heuristically: ${inspection.androidModules.join(', ') || 'none detected'}`);
    output('Text-only discovery may miss modules hidden by aliases or convention plugins, deeper directories, or scan limits; detected module list is incomplete evidence, not a Gradle evaluation.');
    output('No Gradle/Git/device commands were executed. Suggestions are unverified; confirm tasks and shell explicitly.');
  } else if (inspection.packageScripts && Object.keys(inspection.packageScripts).length > 0) {
    output(`Node package scripts detected: ${Object.keys(inspection.packageScripts).join(', ')}`);
  }

  if (inspection.agents !== undefined) output('Existing AGENTS.md found. Read its rules before confirming setup; content will be preserved outside the marked harness section.');
  output('Do not enter secrets in commands or paths. Use environment references instead. Missing checks remain unconfigured, never waived.');

  const target = contextPath(root, options.context);
  const original = readContext(target);
  const data = contextData(original, 'project');
  let previous: ProjectProfile | undefined = data === undefined ? undefined : validateProfile(data);
  const legacyPath = join(root, '.opencode', 'harness.project.json');
  if (!previous && existsSync(legacyPath)) {
    output(`Legacy settings detected: ${legacyPath}. This file will not be edited/deleted.`);
    if ((await ask('Type migrate to use legacy settings as suggestions in the context file', 'no')) === 'migrate') previous = parseProfile(readFileSync(legacyPath, 'utf8'));
  }

  // Read global defaults if available
  let globalDefaults: GlobalProjectDefaults | undefined;
  if (existsSync(globalDefaultsPath)) {
    try { globalDefaults = parseGlobalProjectDefaults(readFileSync(globalDefaultsPath, 'utf8')); }
    catch { /* ignore malformed global defaults */ }
  }

  const defaultShell = previous?.shell ?? globalDefaults?.shell ?? (process.platform === 'win32' ? 'powershell' : 'bash');
  const shell = await askProjectShell(ask, defaultShell);
  const wrapperExists = shell === 'bash' ? inspection.wrappers.bash : inspection.wrappers.windows;
  const wrapperName = shell === 'bash' ? './gradlew' : shell === 'powershell' ? '.\\gradlew.bat' : 'gradlew.bat';

  if (inspection.gradleFiles.length > 0) {
    output(`Selected shell: ${shell}; expected wrapper syntax: ${wrapperName}. Shell selection controls suggested syntax only; it does not verify the actual shell, wrapper execution/readiness, or convert saved commands.`);
    if (!wrapperExists) output(`No wrapper for ${shell} (${wrapperName}) was found, so automatic suggestions are omitted. A wrapper for another shell does not provide the selected shell's syntax; enter the correct command manually or '-' to leave unconfigured.`);
    else output('Enter the correct command manually if the suggestion does not match your project, or enter - to leave it unconfigured. Existing/manual commands are not converted or validated.');
  } else {
    output(`Selected shell: ${shell}. Enter the correct command manually or - to leave unconfigured.`);
  }

  const profile = await askProfile(root, inspection, previous, ask, shell, globalDefaults, home);
  if (profile.shell !== shell) throw new Error('Collected shell differs from the selected shell. No files changed.');
  const files = prepareSetup(root, profile, original, target);
  const updated = files[0]!.updated;

  output('\nReview project setup:');
  output(`Base branch: ${profile.baseBranch}; shell: ${profile.shell}`);
  for (const name of checkNames) {
    const check = profile.checks[name];
    output(`${name}: ${check.status === 'configured' ? check.command : 'UNCONFIGURED (not waived)'}`);
  }
  output(`Device: ${profile.device.preference}; serial: ${profile.device.serial ?? 'choose at runtime'}`);
  output(`Worktree parent: ${profile.worktreeDirectory}\nShared memory: ${profile.memoryPath}`);
  output('Files to write:');
  for (const file of files) output(`  ${file.path}${file.original === undefined ? ' (new)' : ' (backup before updating)'}`);
  output('Proposed context section:');
  output(updated.slice(updated.indexOf('<!-- advanced-harness:project:start -->'), updated.indexOf('<!-- advanced-harness:project:end -->') + '<!-- advanced-harness:project:end -->'.length));
  output('Only context files are written; no separate project profile. Paths are machine-specific: review before committing. No models/MCP/ignore rules are changed. Legacy files remain untouched.');

  const confirm = await ask('Full preview: type save (or legacy setup) to save; Enter or anything else cancels', 'cancel');
  const result = confirmAndSaveSetup(confirm, files, backupParent);
  if (result.status === 'cancelled') {
    output('Cancelled. Nothing changed: no files written and no backups created.');
    return 0;
  }
  output(`Project settings saved in context: ${target}`);
  for (const backup of result.backups) if (backup) output(`Backup (keep private): ${backup}`);
  output('Setup choices saved, not runtime-validated. Run harness:doctor in this project, then approve command/device/integration validation with Lead.');
  return 0;
}

