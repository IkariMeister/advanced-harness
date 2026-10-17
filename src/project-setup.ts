import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseConfiguration, saveInstallation, type Ask } from './native-installer.ts';
import { contextData, prepareContextFiles, updateContext } from './project-context.ts';

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
export type Inspection = { gradleFiles: string[]; androidModules: string[]; roborazzi: boolean; wrappers: { bash: boolean; windows: boolean }; agents: string | undefined };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function validBranch(value: string): boolean {
  return !!value && value !== '@' && !/\s|[\x00-\x1f\x7f~^:?*\[\\]|\.\.|@\{|\/\/|^[-/]|\/$|\.$|\.lock(?:\/|$)|(?:^|\/)\./.test(value);
}

export function expandPath(path: string): string {
  return resolve(path.replace(/^(?:~|\$HOME)(?=[/\\]|$)/, homedir()));
}

function safeText(path: string): string {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024 * 1024) throw new Error('Expected a regular text file no larger than 1 MiB. No project files changed.');
  return readFileSync(path, 'utf8');
}

/** Bounded filesystem inspection only; Gradle scripts are never evaluated. */
export function inspectProject(directory: string): Inspection {
  const root = resolve(directory);
  if (!lstatSync(root).isDirectory()) throw new Error('Select an existing repository directory.');
  if (!existsSync(join(root, '.git'))) throw new Error('Select a Git checkout/worktree root (with a .git entry).');
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
  if (!gradleFiles.some(path => /^(build|settings)\.gradle(\.kts)?$/.test(path))) throw new Error('No root Gradle build/settings file found. Select the Android Gradle checkout root.');
  const agentsPath = join(root, 'AGENTS.md');
  return { gradleFiles, androidModules, roborazzi, wrappers: { bash: existsSync(join(root, 'gradlew')), windows: existsSync(join(root, 'gradlew.bat')) }, agents: existsSync(agentsPath) ? safeText(agentsPath) : undefined };
}

export function suggestedCommands(inspection: Inspection, shell: ProjectProfile['shell']): Partial<Record<CheckName, string>> {
  if (!(shell === 'bash' ? inspection.wrappers.bash : inspection.wrappers.windows)) return {};
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

async function choose<T extends string>(ask: Ask, question: string, choices: readonly T[], suggested: T): Promise<T> {
  for (;;) {
    const answer = (await ask(question, suggested)).trim() || suggested;
    if (choices.includes(answer as T)) return answer as T;
  }
}

export async function askProjectShell(ask: Ask, suggested: ProjectProfile['shell']): Promise<ProjectProfile['shell']> {
  return choose(ask, 'Command shell: powershell, bash, or cmd', ['powershell', 'bash', 'cmd'], suggested);
}

export async function askProfile(root: string, inspection: Inspection, previous: ProjectProfile | undefined, ask: Ask, selectedShell?: ProjectProfile['shell']): Promise<ProjectProfile> {
  let baseBranch = '';
  while (!baseBranch) {
    const answer = (await ask('Base branch (confirm against the repository; not inferred)', previous?.baseBranch ?? 'main')).trim() || previous?.baseBranch || 'main';
    if (validBranch(answer)) baseBranch = answer;
  }
  const shell: ProjectProfile['shell'] = selectedShell ?? await choose(ask, 'Command shell: powershell, bash, or cmd', ['powershell', 'bash', 'cmd'], previous?.shell ?? (process.platform === 'win32' ? 'powershell' : 'bash'));
  const suggestions = suggestedCommands(inspection, shell);
  const checks = {} as Record<CheckName, ProjectCheck>;
  for (const name of checkNames) {
    const old = previous?.checks[name];
    const suggestion = old?.status === 'configured' ? old.command : old ? '-' : suggestions[name] ?? '-';
    let answer: string;
    do { answer = (await ask(`${name}: confirm command, or - to leave UNCONFIGURED`, suggestion)).trim() || suggestion; } while (/[\r\n\0]/.test(answer));
    checks[name] = answer === '-' ? { status: 'unconfigured' } : { status: 'configured', command: answer };
  }
  const preference = await choose(ask, 'Device preference: physical-first, emulator, or ask', ['physical-first', 'emulator', 'ask'], previous?.device.preference ?? 'physical-first');
  let serial = '';
  for (;;) {
    const answer = (await ask('Optional device serial (- to decide at runtime)', previous?.device.serial ?? '-')).trim() || previous?.device.serial || '-';
    if (answer === '-' || /^[\w.:-]+$/.test(answer)) { serial = answer === '-' ? '' : answer; break; }
  }
  const canonical = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
  const id = `${basename(root).replace(/[^a-zA-Z0-9_-]/g, '-') || 'android-project'}-${createHash('sha256').update(canonical).digest('hex').slice(0, 8)}`;
  const worktreeDirectory = expandPath((await ask('Parent directory for future worktrees (outside the checkout)', previous?.worktreeDirectory ?? join(homedir(), 'Projects', 'advanced-harness-worktrees', id))).trim() || previous?.worktreeDirectory || join(homedir(), 'Projects', 'advanced-harness-worktrees', id));
  const memoryPath = expandPath((await ask('Shared MEMORY.md path (outside checkout/worktrees)', previous?.memoryPath ?? join(homedir(), 'Projects', 'advanced-harness-data', id, 'MEMORY.md'))).trim() || previous?.memoryPath || join(homedir(), 'Projects', 'advanced-harness-data', id, 'MEMORY.md'));
  return validateProfile({ version: 1, projectRoot: resolve(root), baseBranch, shell, checks, device: { preference, ...(serial ? { serial } : {}) }, worktreeDirectory, memoryPath });
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
