import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse as parsePath, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { fileURLToPath } from 'node:url';
import { loadProcedureSkill, type ProcedureSkill } from './procedure-skills.ts';
import { nativeRoles } from './native-role-types.ts';
import type { HostId } from './host-registry.ts';

export interface ProcedureSkillCheck { host: HostId; status: string; issues: string[]; notes: string[] }
const guidance = 'Intended roles (advisory only):';

function sourceDirectories(directory: string): string[] {
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Canonical skills root must not be a symbolic link.');
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(directory, entry.name)).sort();
}

type RootScope = 'project' | 'global';
type SkillRoot = { scope: RootScope; path: string };

function installedRoots(host: HostId, project: string | undefined, home: string, global: string, scope?: RootScope): SkillRoot[] {
  const projectRoot = project ? ({ opencode: '.opencode/skills', 'claude-code': '.claude/skills', antigravity: '.agents/skills', codex: undefined, cursor: '.cursor/skills' } as const)[host] : undefined;
  const globalRoot = ({ opencode: join(global, 'skills'), 'claude-code': join(home, '.claude', 'skills'), antigravity: join(home, '.gemini', 'config', 'skills'), codex: join(home, '.agents', 'skills'), cursor: join(home, '.cursor', 'skills') } as const)[host];
  return [
    ...(scope !== 'global' && projectRoot && project ? [{ scope: 'project' as const, path: join(project, projectRoot) }] : []),
    ...(scope !== 'project' ? [{ scope: 'global' as const, path: globalRoot }] : []),
  ];
}

function harnessFootprint(host: HostId, project: string | undefined, home: string, global: string, scope: RootScope): boolean {
  if (host === 'opencode') {
    const candidates = scope === 'global'
      ? [join(global, 'opencode.json'), join(global, 'opencode.jsonc')]
      : project ? [join(project, '.opencode', 'opencode.json'), join(project, '.opencode', 'opencode.jsonc'), join(project, 'opencode.json'), join(project, 'opencode.jsonc')] : [];
    return candidates.some(path => {
      if (!existsSync(path)) return false;
      const text = readFileSync(path, 'utf8');
      return /"lead"\s*:/.test(text) && /"implementer"\s*:/.test(text);
    });
  }
  if (host === 'claude-code') {
    const roots = scope === 'project' ? (project ? [join(project, '.claude', 'agents')] : []) : [join(home, '.claude', 'agents')];
    return roots.some(root => existsSync(root) && nativeRoles.some(role => existsSync(join(root, `${role}.md`))));
  }
  const leadRule = scope === 'project'
    ? project ? join(project, '.agents', 'rules', 'advanced-harness-lead.md') : undefined
    : join(home, '.gemini', 'config', 'rules', 'advanced-harness-lead.md');
  return !!leadRule && existsSync(leadRule);
}

/** Reject symbolic-link components before following any expected installed path. */
function assertNoLinkedAncestors(path: string): void {
  const absolute = resolve(path);
  const parsed = parsePath(absolute);
  const relative = absolute.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  let current = parsed.root;
  for (const component of relative) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('symbolic link');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`Unsafe symbolic-link ancestor in procedure skill path: ${current}`);
    }
  }
}

/** Read-only structural checks for canonical source and expected native skill artifacts. */
export function diagnoseProcedureSkills(options: { host: HostId; project?: string; home?: string; globalDirectory?: string; scope?: 'global' | 'project'; skillsDirectory?: string }): ProcedureSkillCheck {
  const home = options.home ?? homedir();
  const project = options.scope === 'global' ? undefined : options.project;
  const global = options.globalDirectory ?? resolve(join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode'));
  const issues: string[] = [];
  const notes: string[] = [];
  const canonicalRoot = options.skillsDirectory ?? fileURLToPath(new URL('../skills/', import.meta.url));
  const skills: ProcedureSkill[] = [];
  try {
    const directories = sourceDirectories(canonicalRoot);
    if (!directories.length) throw new Error('No canonical procedure skills found.');
    for (const dir of directories) skills.push(loadProcedureSkill(dir));
  } catch {
    issues.push('Canonical procedure skill is missing or malformed (frontmatter/schema/role guidance source check failed).');
  }
  if (options.host === 'codex' || options.host === 'cursor') {
    notes.push(`${options.host} native procedure-skill deployment is unsupported; canonical validation is static only.`);
    return { host: options.host, status: 'unsupported', issues, notes };
  }
  const roots = installedRoots(options.host, project, home, global, options.scope);
  let inspected = false;
  for (const candidate of roots) {
    const root = candidate.path;
    try { assertNoLinkedAncestors(root); }
    catch {
      issues.push(`Installed ${candidate.scope} procedure skills path has a symbolic-link ancestor.`);
      inspected = true;
      continue;
    }
    // A third-party-only skills directory is not an installation footprint, but
    // expected artifacts are inspected wherever they exist, independently per scope.
    const unsafeExpectedPaths = new Set<string>();
    let hasExpectedArtifact = false;
    for (const skill of skills) {
      const path = join(root, skill.name);
      try {
        assertNoLinkedAncestors(path);
        if (existsSync(path)) hasExpectedArtifact = true;
      } catch {
        unsafeExpectedPaths.add(path);
      }
    }
    const footprint = harnessFootprint(options.host, project, home, global, candidate.scope);
    if (!footprint && !hasExpectedArtifact && !unsafeExpectedPaths.size) continue;
    inspected = true;
    if (existsSync(root) && !lstatSync(root).isDirectory()) {
      issues.push(`Installed ${candidate.scope} procedure skills root is not a directory.`);
      continue;
    }
    for (const skill of skills) {
      const name = skill.name;
      const entry = join(root, name);
      if (unsafeExpectedPaths.has(entry)) {
        issues.push(`Installed ${candidate.scope} procedure skill ${name} has a symbolic-link ancestor.`);
        continue;
      }
      try { assertNoLinkedAncestors(entry); }
      catch {
        issues.push(`Installed ${candidate.scope} procedure skill ${name} has a symbolic-link ancestor.`);
        continue;
      }
      if (!existsSync(entry)) {
        if (footprint) issues.push(`Expected installed ${candidate.scope} procedure skill is missing: ${name}.`);
        continue;
      }
      try {
        assertNoLinkedAncestors(join(entry, 'SKILL.md'));
        if (!lstatSync(entry).isDirectory() || !lstatSync(join(entry, 'SKILL.md')).isFile()) throw new Error('unsafe link or non-regular artifact');
        const text = readFileSync(join(entry, 'SKILL.md'), 'utf8');
        const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
        if (!match) throw new Error('frontmatter');
        const document = parseDocument(match[1]!);
        const data: unknown = document.toJSON();
        if (document.errors.length || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('frontmatter');
        const header = data as Record<string, unknown>;
        if (header.name !== name) issues.push(`Installed procedure skill ${name} has an unexpected name.`);
        if (typeof header.description !== 'string' || !header.description.trim()) issues.push(`Installed procedure skill ${name} has invalid description frontmatter.`);
        if (header.name === name && header.description !== skill.description) issues.push(`Installed procedure skill ${name} description differs from canonical metadata.`);
        const expectedGuidance = `${guidance} ${skill.intendedRoles.join(', ')}.`;
        if (!match[2]!.includes(expectedGuidance) || !match[2]!.includes('advisory only')) issues.push(`Installed procedure skill ${name} is missing intended-role advisory guidance.`);
      } catch {
        issues.push(`Installed procedure skill ${name} has malformed or unsafe SKILL.md frontmatter/artifact.`);
      }
    }
  }
  if (!inspected) {
    notes.push('No native procedure-skill installation footprint detected; missing installed skills are not checked.');
    return { host: options.host, status: 'not-installed', issues, notes };
  }
  notes.push(`Procedure skill validation is static and advisory; it does not verify runtime discovery, invocation, permissions, or enforcement (${options.host}).`);
  return { host: options.host, status: 'installed', issues, notes };
}
