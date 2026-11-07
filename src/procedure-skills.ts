import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseDocument, stringify as stringifyYaml } from 'yaml';
import { nativeRoles, type NativeRole } from './native-role-types.ts';
import { workflowCommandIds } from './workflow-commands.ts';

export interface ProcedureSkill {
  schemaVersion: 1;
  name: string;
  description: string;
  intendedRoles: NativeRole[];
  body: string;
  supportingFiles: Array<{ relativePath: string; content: Buffer }>;
}

export type ProcedureSkillHost = 'opencode' | 'claude-code' | 'antigravity' | 'codex';
export interface ProcedureSkillArtifact { host: ProcedureSkillHost; relativePath: string; content: string | Buffer }
const PREFIX = 'harness-procedure-';
const safeName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function emittedProcedureSkillName(name: string): string {
  const emitted = `${PREFIX}${name}`;
  if (!safeName.test(name) || name.length > 64 || emitted.length > 64) throw new Error(`Invalid or overlong procedure skill name: ${name}`);
  return emitted;
}

function validRelativePath(path: string): boolean {
  return !!path && !path.startsWith('/') && !path.startsWith('\\') && !/^[a-z]:/i.test(path) &&
    !path.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part));
}

export function loadProcedureSkill(directory: string): ProcedureSkill {
  const root = resolve(directory);
  if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw new Error('Procedure skill root must be a real directory, not a link.');
  const base = root.split(/[\\/]/).at(-1)!;
  if (!safeName.test(base) || base.length > 64 || base.startsWith(PREFIX)) throw new Error(`Invalid procedure skill directory name: ${base}`);
  const source = join(root, 'SKILL.md');
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new Error(`Canonical procedure skill entry must be a regular file, not a symbolic link or other entry: ${source}`);
  const text = readFileSync(source, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`Malformed procedure skill frontmatter: ${source}`);
  const doc = parseDocument(match[1]!);
  const header: unknown = doc.toJSON();
  if (doc.errors.length || !header || typeof header !== 'object' || Array.isArray(header)) throw new Error(`Malformed procedure skill frontmatter: ${source}`);
  const data = header as Record<string, unknown>;
  if (Object.keys(data).some(key => !['schemaVersion','name','description','intendedRoles'].includes(key))) throw new Error(`Unknown procedure skill field: ${source}`);
  if (data.schemaVersion !== 1) throw new Error(`Unsupported procedure skill schema version: ${source}`);
  if (data.name !== base) throw new Error(`Procedure skill name must match directory: ${source}`);
  const name = emittedProcedureSkillName(base);
  if (typeof data.description !== 'string' || !data.description.trim() || data.description.length > 1024) throw new Error(`Invalid procedure skill description: ${source}`);
  if (!Array.isArray(data.intendedRoles) || !data.intendedRoles.length || data.intendedRoles.some(role => typeof role !== 'string' || !nativeRoles.includes(role as NativeRole)) || new Set(data.intendedRoles).size !== data.intendedRoles.length) throw new Error(`Invalid procedure skill intendedRoles: ${source}`);
  const body = match[2]!;
  if (!body.trim()) throw new Error(`Procedure skill body must not be empty: ${source}`);
  const supportingFiles: ProcedureSkill['supportingFiles'] = [];
  const seen = new Set<string>(['skill.md']);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = relative(root, full).split(sep).join('/');
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`Procedure skill symlinks are not supported: ${rel}`);
      if (rel === 'SKILL.md') continue;
      if (!validRelativePath(rel)) throw new Error(`Unsafe procedure skill support path: ${rel}`);
      const key = rel.toLowerCase();
      if (seen.has(key)) throw new Error(`Case-insensitive procedure skill path collision: ${rel}`);
      seen.add(key);
      if (stat.isDirectory() && realpathSync(full) !== resolve(full)) throw new Error(`Procedure skill directory escapes root: ${rel}`);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) supportingFiles.push({ relativePath: rel, content: readFileSync(full) });
      else if (!stat.isFile()) throw new Error(`Non-regular procedure skill entry: ${rel}`);
    }
  };
  walk(root);
  const selectedRoles = new Set(data.intendedRoles as NativeRole[]);
  return { schemaVersion: 1, name, description: data.description, intendedRoles: nativeRoles.filter(role => selectedRoles.has(role)), body, supportingFiles };
}

export function emitProcedureSkill(skill: ProcedureSkill, host: ProcedureSkillHost): ProcedureSkillArtifact[] {
  const canonicalName = skill.name.replace(/^harness-procedure-/, '');
  const name = emittedProcedureSkillName(canonicalName);
  const prefix = host === 'opencode' ? '.opencode/skills' : host === 'claude-code' ? '.claude/skills' : '.agents/skills';
  const path = `${prefix}/${name}`;
  const guidance = `\n\nIntended roles (advisory only): ${skill.intendedRoles.join(', ')}. This metadata is descriptive guidance only; it grants no permissions, conveys no approval or decision authority, and is not enforced role discovery.`;
  const frontmatter = stringifyYaml({ name, description: skill.description }).trimEnd();
  const content = `---\n${frontmatter}\n---\n${skill.body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s*$/, '')}${guidance}\n`;
  const files = [{ relativePath: `${path}/SKILL.md`, content }, ...skill.supportingFiles.map(file => ({ relativePath: `${path}/${file.relativePath}`, content: file.content }))];
  const paths = new Set<string>();
  for (const file of files) {
    const normalized = file.relativePath.toLowerCase();
    if (!validRelativePath(file.relativePath) || paths.has(normalized)) throw new Error(`Invalid or duplicate procedure skill artifact path: ${file.relativePath}`);
    paths.add(normalized);
  }
  return files.map(file => ({ host, ...file }));
}

export function combineProcedureSkillArtifacts<T extends { host: string; relativePath: string; content: string | Buffer }>(groups: readonly (readonly T[])[]): T[] {
  const byPath = new Map<string, T>();
  for (const artifact of groups.flat().sort((a,b) => compare(a.relativePath, b.relativePath) || compare(a.host, b.host))) {
    if (!validRelativePath(artifact.relativePath)) throw new Error(`Unsafe procedure skill artifact path: ${artifact.relativePath}`);
    const key = artifact.relativePath.toLowerCase();
    const prior = byPath.get(key);
    if (prior) {
      if (prior.relativePath !== artifact.relativePath) throw new Error(`Case-insensitive artifact path collision: ${artifact.relativePath}`);
      const same = Buffer.isBuffer(prior.content) && Buffer.isBuffer(artifact.content) ? prior.content.equals(artifact.content) : prior.content === artifact.content;
      if (!same) throw new Error(`Conflicting shared artifact path: ${artifact.relativePath}`);
      continue;
    }
    for (const existing of byPath.keys()) if (existing.startsWith(`${key}/`) || key.startsWith(`${existing}/`)) throw new Error(`Artifact file/directory conflict: ${artifact.relativePath}`);
    byPath.set(key, artifact);
  }
  return [...byPath.values()].sort((a,b) => compare(a.relativePath, b.relativePath) || compare(a.host, b.host));
}

export function assertProcedureSkillNamespaceAvailable(): void {
  if (workflowCommandIds.some(id => id.startsWith(PREFIX))) throw new Error('Workflow command ID conflicts with procedure skill namespace.');
}

/** Load selected source folders and emit deterministic shared-host artifacts without side effects. */
export function compileProcedureSkills(sourceDirectories: readonly string[], hosts: readonly ProcedureSkillHost[]): ProcedureSkillArtifact[] {
  assertProcedureSkillNamespaceAvailable();
  const skills = sourceDirectories.map(directory => loadProcedureSkill(directory)).sort((a, b) => compare(a.name, b.name));
  if (new Set(skills.map(skill => skill.name)).size !== skills.length) throw new Error('Duplicate procedure skill source name.');
  const hostOrder: ProcedureSkillHost[] = ['opencode', 'claude-code', 'antigravity', 'codex'];
  const selectedHosts = [...new Set(hosts)].sort((a, b) => hostOrder.indexOf(a) - hostOrder.indexOf(b));
  return combineProcedureSkillArtifacts([skills.flatMap(skill => selectedHosts.flatMap(host => emitProcedureSkill(skill, host)))]);
}
