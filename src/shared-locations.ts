import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { formatSharedMemory } from './shared-memory.ts';

/** Where future task worktrees and the shared Operator MEMORY.md live, outside the checkout. */
export type SharedLocations = { worktreeDirectory: string; memoryPath: string };
/** Context `paths` section used before full project settings exist. */
export type PathsSettings = { version: 1 } & SharedLocations;
export type LocationPlan = { projectRoot: string; locations: SharedLocations; directories: string[]; memoryFile?: string };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function inside(path: string, directory: string): boolean {
  const child = relative(resolve(directory), resolve(path));
  return child === '' || (!child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && child !== '..' && !isAbsolute(child));
}

/**
 * The checkout that identifies this project: a linked worktree maps to its main checkout through the
 * `.git` file and `commondir`, without running Git. Separate clones and submodules stay their own project.
 */
export function mainCheckoutRoot(root: string): string {
  const own = resolve(root);
  const dotGit = join(own, '.git');
  const entry = lstatSync(dotGit, { throwIfNoEntry: false });
  if (!entry?.isFile() || entry.size > 4096) return own;
  try {
    const gitDirectory = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(dotGit, 'utf8'))?.[1];
    if (!gitDirectory) return own;
    const linked = resolve(own, gitDirectory);
    const commonFile = join(linked, 'commondir');
    if (!lstatSync(commonFile, { throwIfNoEntry: false })?.isFile()) return own;
    const common = resolve(linked, readFileSync(commonFile, 'utf8').trim());
    if (!existsSync(common)) return own;
    return basename(common) === '.git' ? dirname(common) : common;
  } catch { return own; }
}

function canonicalPath(path: string): string {
  let physical: string;
  try { physical = physicalPath(path); } catch { physical = resolve(path); }
  return process.platform === 'win32' ? physical.toLowerCase() : physical;
}

function idFor(name: string, canonical: string): string {
  return `${name.replace(/[^a-zA-Z0-9_-]/g, '-') || 'project'}-${createHash('sha256').update(canonical).digest('hex').slice(0, 8)}`;
}

/** All worktrees of a repository share this ID; the main checkout's own ID does not change. */
export function projectId(root: string): string {
  const main = mainCheckoutRoot(root);
  let physical: string;
  try { physical = physicalPath(main); } catch { physical = main; }
  return idFor(basename(physical), process.platform === 'win32' ? physical.toLowerCase() : physical);
}

/** The ID this checkout path had before worktrees shared one, kept only to find existing data. */
export function legacyProjectId(root: string): string {
  return idFor(basename(root), process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root));
}

/** Whether two checkouts are worktrees of one repository. Separate clones are different projects. */
export function sameProject(left: string, right: string): boolean {
  return canonicalPath(mainCheckoutRoot(left)) === canonicalPath(mainCheckoutRoot(right));
}

type LocationParents = { worktreeParentDirectory?: string; memoryParentDirectory?: string };

function locationsFor(id: string, parents: LocationParents, home: string): SharedLocations {
  return {
    worktreeDirectory: join(parents.worktreeParentDirectory ?? join(home, 'Projects', 'advanced-harness-worktrees'), id),
    memoryPath: join(parents.memoryParentDirectory ?? join(home, 'Projects', 'advanced-harness-data'), id, 'MEMORY.md'),
  };
}

/** Computed defaults are suggestions for setup and update only; they never take effect on their own. */
export function defaultLocations(root: string, parents: LocationParents = {}, home = homedir()): SharedLocations {
  return locationsFor(projectId(root), parents, home);
}

/** Locations under this worktree's old path-derived ID, when a MEMORY.md still exists there. */
export function legacyWorktreeLocations(root: string, parents: LocationParents = {}, home = homedir()): SharedLocations | undefined {
  if (canonicalPath(mainCheckoutRoot(root)) === canonicalPath(root)) return undefined;
  const locations = locationsFor(legacyProjectId(root), parents, home);
  return existsSync(locations.memoryPath) ? locations : undefined;
}

/** `$HOME/...` is the portable form: it names the same place on every machine. */
export function isPortablePath(path: string): boolean {
  return /^\$HOME[/\\]/.test(path) && !path.split(/[/\\]/).includes('..');
}

export function expandStoredPath(path: string, home = homedir()): string {
  return isPortablePath(path) ? join(home, path.slice('$HOME/'.length)) : path;
}

export function expandLocations(locations: SharedLocations, home = homedir()): SharedLocations {
  return { worktreeDirectory: expandStoredPath(locations.worktreeDirectory, home), memoryPath: expandStoredPath(locations.memoryPath, home) };
}

/** Paths under the home directory are stored portably; anything else stays absolute. */
export function toStoredPath(path: string, home = homedir()): string {
  const absolute = resolve(path);
  if (resolve(home) === absolute || !inside(absolute, home)) return absolute;
  return `$HOME/${relative(resolve(home), absolute).split(sep).join('/')}`;
}

/** Recognizes Windows absolute paths on every platform, so a committed one is reported as foreign, not as relative. */
export function isAbsoluteOnAnyPlatform(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}

/** Checks that do not depend on which checkout is asking. */
export function validateLocationShape(value: Record<string, unknown>, home = homedir()): void {
  for (const key of ['worktreeDirectory', 'memoryPath'] as const) {
    const path = value[key];
    if (typeof path !== 'string' || !(isPortablePath(path) || isAbsoluteOnAnyPlatform(path))) throw new Error('Worktree and shared-memory paths must be absolute or start with $HOME/.');
  }
  const { worktreeDirectory, memoryPath } = expandLocations(value as SharedLocations, home);
  if (basename(memoryPath) !== 'MEMORY.md') throw new Error('Shared memory path must end in MEMORY.md.');
  if (inside(memoryPath, worktreeDirectory)) throw new Error('Shared memory must not be inside the worktree directory.');
}

export function validateLocations(projectRoot: string, value: Record<string, unknown>, home = homedir()): void {
  validateLocationShape(value, home);
  const { worktreeDirectory, memoryPath } = expandLocations(value as SharedLocations, home);
  if (inside(worktreeDirectory, projectRoot) || inside(projectRoot, worktreeDirectory) || inside(memoryPath, projectRoot) || inside(projectRoot, dirname(memoryPath))) throw new Error('Worktree and shared-memory paths must be outside the application checkout and cannot contain it.');
}

export function validatePathsSettings(projectRoot: string, value: unknown, home = homedir()): PathsSettings {
  if (!object(value) || !Object.keys(value).every(key => ['version', 'worktreeDirectory', 'memoryPath'].includes(key)) || value.version !== 1) throw new Error('Invalid or unsupported shared paths settings; unknown fields are not silently discarded.');
  validateLocations(mainCheckoutRoot(projectRoot), value, home);
  return value as PathsSettings;
}

export const pathsInstructions = [
  'Shared locations for this project, recorded before full project settings exist. Run harness:setup to confirm the remaining settings.',
  'worktreeDirectory is the parent for future task worktrees; memoryPath is the shared Operator MEMORY.md. Both are outside this checkout by design: read them from here, never search the workspace for MEMORY.md or create one inside it.',
  '$HOME/ means the current user\'s home directory on this machine. Stop and ask if a location is missing or invalid, or is an absolute path that does not exist on this machine.',
];

export type LocationResolution =
  | { status: 'resolved'; source: 'project' | 'paths'; stored: SharedLocations; locations: SharedLocations; portable: boolean; plan: LocationPlan }
  | { status: 'missing'; reason: string }
  | { status: 'conflict' | 'invalid'; source?: 'project' | 'paths'; reason: string };

/**
 * The one resolution order: `project` section, then `paths` section, then stop and ask.
 * Computed defaults are deliberately absent, so nothing silently starts a new, empty MEMORY.md.
 */
export function resolveLocationSettings(root: string, settings: { project?: (SharedLocations & { projectRoot?: string }) | undefined; paths?: SharedLocations | undefined }, home = homedir()): LocationResolution {
  const { project, paths } = settings;
  const stored = project ?? paths;
  if (!stored) return { status: 'missing', reason: 'No shared locations are recorded in project context.' };
  const source = project ? 'project' : 'paths';
  const locations = expandLocations(stored, home);
  if (project && paths) {
    const other = expandLocations(paths, home);
    if (resolve(other.worktreeDirectory) !== resolve(locations.worktreeDirectory) || resolve(other.memoryPath) !== resolve(locations.memoryPath)) return { status: 'conflict', source, reason: 'The project and paths sections record different shared locations.' };
  }
  const absolute = [stored.worktreeDirectory, stored.memoryPath].filter(path => !isPortablePath(path));
  if (absolute.length) {
    if (project?.projectRoot !== undefined) {
      if (!sameProject(root, project.projectRoot)) return { status: 'conflict', source, reason: `Absolute shared locations were saved for ${project.projectRoot}, which is not this repository on this machine.` };
    } else if (absolute.some(path => !lstatSync(path, { throwIfNoEntry: false }))) {
      return { status: 'conflict', source, reason: 'An absolute shared location does not exist on this machine, so it may belong to another machine.' };
    }
  }
  try {
    return { status: 'resolved', source, stored: { worktreeDirectory: stored.worktreeDirectory, memoryPath: stored.memoryPath }, locations, portable: absolute.length === 0, plan: planSharedLocations(root, locations) };
  } catch (error) {
    return { status: 'invalid', source, reason: (error as Error).message };
  }
}

/** Resolves the nearest existing ancestor through symlinks/junctions, then appends the missing tail. */
export function physicalPath(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  while (!lstatSync(current, { throwIfNoEntry: false })) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  let real: string;
  try { real = realpathSync.native(current); }
  catch { throw new Error(`Cannot resolve ${current} (for example a dangling link). No files changed.`); }
  return join(real, ...missing);
}

/**
 * Lexical checks can be bypassed by a linked ancestor, so compare where the paths really land.
 * A task worktree legitimately sits under the worktree parent, so containment is judged against the
 * main checkout; the current worktree must still not hold either location.
 */
export function validatePhysicalLocations(projectRoot: string, locations: SharedLocations): void {
  try {
    const worktreeDirectory = physicalPath(locations.worktreeDirectory);
    const memoryPath = physicalPath(locations.memoryPath);
    validateLocations(physicalPath(mainCheckoutRoot(projectRoot)), { worktreeDirectory, memoryPath });
    const own = physicalPath(projectRoot);
    if (inside(worktreeDirectory, own) || inside(memoryPath, own) || inside(own, dirname(memoryPath))) throw new Error('Worktree and shared-memory paths must be outside the application checkout and cannot contain it.');
  } catch (error) {
    throw new Error(`${(error as Error).message.replace(/\.$/, '')} once symlinks/junctions are resolved. No files changed.`);
  }
}

/** Plans only missing locations; existing files are never overwritten. */
export function planSharedLocations(projectRoot: string, locations: SharedLocations): LocationPlan {
  validatePhysicalLocations(projectRoot, locations);
  const plan: LocationPlan = { projectRoot, locations, directories: [] };
  const memoryDirectory = dirname(locations.memoryPath);
  for (const directory of [locations.worktreeDirectory, memoryDirectory]) {
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (!entry) { if (!plan.directories.includes(directory)) plan.directories.push(directory); }
    else if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Shared location ${directory} exists but is not a regular directory. No files changed.`);
  }
  const memory = lstatSync(locations.memoryPath, { throwIfNoEntry: false });
  if (!memory) plan.memoryFile = locations.memoryPath;
  else if (!memory.isFile() || memory.isSymbolicLink()) throw new Error(`Shared memory ${locations.memoryPath} exists but is not a regular file. No files changed.`);
  return plan;
}

export function describeLocationPlan(plan: LocationPlan): string[] {
  return [
    ...plan.directories.map(directory => `  ${directory} (new directory)`),
    ...(plan.memoryFile ? [`  ${plan.memoryFile} (new shared MEMORY.md, header only)`] : []),
  ];
}

export function emptyLocationPlan(plan: LocationPlan): boolean {
  return plan.directories.length === 0 && plan.memoryFile === undefined;
}

/** Creates planned locations; `wx` refuses to replace a MEMORY.md that appeared meanwhile. */
export function createSharedLocations(plan: LocationPlan): string[] {
  // Revalidate: an ancestor may have been replaced by a link since the preview.
  validatePhysicalLocations(plan.projectRoot, plan.locations);
  const created: string[] = [];
  for (const directory of plan.directories) {
    if (existsSync(directory)) continue;
    mkdirSync(directory, { recursive: true });
    created.push(directory);
  }
  if (plan.memoryFile) {
    try { writeFileSync(plan.memoryFile, formatSharedMemory([]), { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Shared memory ${plan.memoryFile} appeared during setup; it was left untouched.`);
      throw error;
    }
    created.push(plan.memoryFile);
  }
  return created;
}
