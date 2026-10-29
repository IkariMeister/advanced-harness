import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { formatSharedMemory } from './shared-memory.ts';

/** Where future task worktrees and the shared Operator MEMORY.md live, outside the checkout. */
export type SharedLocations = { worktreeDirectory: string; memoryPath: string };
/** Context `paths` section used before full project settings exist. */
export type PathsSettings = { version: 1 } & SharedLocations;
export type LocationPlan = { directories: string[]; memoryFile?: string };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function inside(path: string, directory: string): boolean {
  const child = relative(resolve(directory), resolve(path));
  return child === '' || (!child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && child !== '..' && !isAbsolute(child));
}

export function projectId(root: string): string {
  const canonical = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
  return `${basename(root).replace(/[^a-zA-Z0-9_-]/g, '-') || 'project'}-${createHash('sha256').update(canonical).digest('hex').slice(0, 8)}`;
}

export function defaultLocations(root: string, parents: { worktreeParentDirectory?: string; memoryParentDirectory?: string } = {}, home = homedir()): SharedLocations {
  const id = projectId(root);
  return {
    worktreeDirectory: join(parents.worktreeParentDirectory ?? join(home, 'Projects', 'advanced-harness-worktrees'), id),
    memoryPath: join(parents.memoryParentDirectory ?? join(home, 'Projects', 'advanced-harness-data'), id, 'MEMORY.md'),
  };
}

export function validateLocations(projectRoot: string, value: Record<string, unknown>): void {
  for (const key of ['worktreeDirectory', 'memoryPath'] as const) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key]) || inside(value[key], projectRoot) || inside(projectRoot, key === 'memoryPath' ? dirname(value[key]) : value[key])) throw new Error('Worktree and shared-memory paths must be outside the application checkout and cannot contain it.');
  }
  if (basename(value.memoryPath as string) !== 'MEMORY.md') throw new Error('Shared memory path must end in MEMORY.md.');
  if (inside(value.memoryPath as string, value.worktreeDirectory as string)) throw new Error('Shared memory must not be inside the worktree directory.');
}

export function validatePathsSettings(projectRoot: string, value: unknown): PathsSettings {
  if (!object(value) || !Object.keys(value).every(key => ['version', 'worktreeDirectory', 'memoryPath'].includes(key)) || value.version !== 1) throw new Error('Invalid or unsupported shared paths settings; unknown fields are not silently discarded.');
  validateLocations(projectRoot, value);
  return value as PathsSettings;
}

export const pathsInstructions = [
  'Shared locations for this project, recorded before full project settings exist. Run harness:setup to confirm the remaining settings.',
  'worktreeDirectory is the parent for future task worktrees; memoryPath is the shared Operator MEMORY.md. Both are outside this checkout by design: read them from here, never search the workspace for MEMORY.md or create one inside it.',
];

/** Plans only missing locations; existing files are never overwritten. */
export function planSharedLocations(locations: SharedLocations): LocationPlan {
  const plan: LocationPlan = { directories: [] };
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
