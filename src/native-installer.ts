import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, parse as pathParse, resolve } from 'node:path';
import { applyEdits, modify, parse, parseTree, type Node, type ParseError } from 'jsonc-parser';
import { reconcilePermissions, type PermissionRule, type ReconciliationResult, type AttributedRule } from './permission-reconciliation.ts';
import { compileOpenCodeRoles } from './opencode-role-compiler.ts';
import { loadRoleDefinitions } from './role-definitions.ts';
import { modelReference, nativeRoles, type NativeRole } from './native-role-types.ts';

export { modelReference, nativeRoles };
export type { NativeRole };
export type ConfigSource = { path: string; text: string; value: Record<string, unknown> };
export type NativeDefinition = { description: string; mode: string; model: string; permissions: unknown[]; system: string };
export type Ask = (question: string, suggested?: string) => Promise<string>;

export class RoleCapabilityCompilationError extends Error {
  readonly diagnostics: import('./capability-policy.ts').CapabilityDiagnostic[];
  constructor(diagnostics: import('./capability-policy.ts').CapabilityDiagnostic[]) {
    super(`OpenCode role capability compilation failed: ${diagnostics.map(item => `${item.code}${item.role ? ` (${item.role})` : ''}: ${item.message}`).join('; ')}`);
    this.name = 'RoleCapabilityCompilationError';
    this.diagnostics = diagnostics;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseConfiguration(text: string, path: string): Record<string, unknown> {
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  const errors: ParseError[] = [];
  const options = { allowTrailingComma: true, disallowComments: false };
  const value: unknown = parse(text, errors, options);
  if (errors.length || !object(value)) throw new Error(`Invalid JSON/JSONC object: ${path}. No changes made.`);
  const check = (node: Node): void => {
    if (node.type === 'object') {
      const seen = new Set<string>();
      for (const property of node.children ?? []) {
        const key = String(property.children?.[0]?.value);
        if (seen.has(key)) throw new Error(`Duplicate configuration key: ${path}. Resolve it before installing.`);
        seen.add(key);
      }
    }
    for (const child of node.children ?? []) check(child);
  };
  const tree = parseTree(text, [], options);
  if (tree) check(tree);
  if (value.agents !== undefined && !object(value.agents)) throw new Error(`Expected a V2 agents object: ${path}`);
  return value;
}

export function configurationFiles(directory: string): string[] {
  return ['opencode.json', 'opencode.jsonc'].map(name => join(directory, name)).filter(existsSync);
}

/** Filesystem sources in V2 order; this is not a running server's effective config. */
export function discoverConfigurations(project: string | undefined, globalDirectory: string): ConfigSource[] {
  const paths = configurationFiles(globalDirectory);
  if (project) {
    const ancestors: string[] = [];
    for (let directory = resolve(project); ; directory = dirname(directory)) {
      ancestors.unshift(directory);
      if (dirname(directory) === directory) break;
    }
    paths.push(...ancestors.flatMap(configurationFiles));
    paths.push(...ancestors.flatMap(directory => configurationFiles(join(directory, '.opencode'))));
  }
  return [...new Set(paths.map(path => resolve(path)))].map(path => {
    const text = readFileSync(path, 'utf8');
    return { path, text, value: parseConfiguration(text, path) };
  });
}

export function chooseConfiguration(directory: string): string {
  const files = configurationFiles(directory);
  if (files.length > 1) throw new Error(`Both opencode.json and opencode.jsonc exist in ${directory}; choose a target with --config.`);
  return files[0] ?? join(directory, 'opencode.jsonc');
}

export function projectConfiguration(project: string, sources: readonly ConfigSource[]): string {
  const local = join(resolve(project), '.opencode');
  if (configurationFiles(local).length) return chooseConfiguration(local);
  // Any discovered .opencode config overrides direct files, even an ancestor's.
  if (sources.some(source => basename(dirname(source.path)) === '.opencode')) return chooseConfiguration(local);
  return chooseConfiguration(resolve(project));
}

export function configuredModels(sources: readonly ConfigSource[]): string[] {
  const models = new Set<string>();
  const add = (value: unknown) => { const reference = modelReference(value); if (reference) models.add(reference); };
  for (const { value } of sources) {
    add(value.model);
    if (object(value.agents)) for (const agent of Object.values(value.agents)) if (object(agent)) add(agent.model);
    if (object(value.providers)) for (const [provider, definition] of Object.entries(value.providers)) {
      if (!object(definition) || !object(definition.models)) continue;
      for (const [id, model] of Object.entries(definition.models)) {
        if (object(model) && model.disabled === true) continue;
        add(`${provider}/${id}`);
        if (object(model) && Array.isArray(model.variants)) for (const variant of model.variants) {
          if (object(variant) && typeof variant.id === 'string') add(`${provider}/${id}#${variant.id}`);
        }
      }
    }
  }
  return [...models].sort();
}

export function suggestedModel(role: NativeRole, sources: readonly ConfigSource[], fallback: string): string {
  let current: string | undefined;
  let defaultModel: string | undefined;
  for (const { value } of sources) {
    defaultModel = modelReference(value.model) ?? defaultModel;
    const agent = object(value.agents) ? value.agents[role] : undefined;
    if (object(agent)) current = modelReference(agent.model) ?? current;
  }
  return current ?? defaultModel ?? fallback;
}

export function loadNativeDefinitions(directory: string): Record<NativeRole, NativeDefinition> {
  const result = compileOpenCodeRoles(loadRoleDefinitions(directory));
  if (!result.definitions) throw new RoleCapabilityCompilationError(result.diagnostics);
  return result.definitions;
}

/**
 * Numbered choices shown to the user. `live` is present only when the runtime catalog was read;
 * it holds `provider/model` and `provider/model#variant` entries for enabled models.
 */
export type ModelChoices = { choices: readonly string[]; live?: ReadonlySet<string> };

export async function askAssignments(definitions: Record<NativeRole, NativeDefinition>, sources: readonly ConfigSource[], ask: Ask, catalog: ModelChoices = { choices: configuredModels(sources) }, output: (message: string) => void = () => {}): Promise<Record<NativeRole, string>> {
  const { choices, live } = catalog;
  const assignments = {} as Record<NativeRole, string>;
  for (const role of nativeRoles) {
    const suggested = suggestedModel(role, sources, definitions[role].model);
    let assignment: string | undefined;
    while (!assignment) {
      let selected: string | undefined;
      while (!selected) {
        const answer = (await ask(`${role}: model ID or listed number (provider/model#variant)`, suggested)).trim();
        const candidate = /^\d+$/.test(answer) ? choices[Number(answer) - 1] : answer || suggested;
        selected = modelReference(candidate);
      }
      const [base = '', selectedVariant] = selected.split('#');
      let variant: string | undefined;
      while (variant === undefined) {
        const answer = (await ask(`${role}: reasoning variant (- for no variant)`, selectedVariant ?? '-')).trim() || selectedVariant || '-';
        if (answer === '-') variant = '';
        else if (/^[^\s/#]+$/.test(answer)) variant = answer;
      }
      const candidate = `${base}${variant ? `#${variant}` : ''}`;
      if (!live || live.has(candidate)) { assignment = candidate; continue; }
      // Never substitute: an off-catalog choice is kept only on an explicit answer, otherwise re-prompted.
      output(live.has(base) ? `Variant ${variant} of ${base} is absent from the live catalog.` : `${base} is absent or disabled in the live catalog.`);
      if ((await ask(`${role}: type keep to save ${candidate} anyway (Enter chooses again)`, 'no')).trim() === 'keep') assignment = candidate;
    }
    assignments[role] = assignment;
  }
  return assignments;
}

/** Abort on merging sources that could override the inline definitions. Never delete them. */
export function agentDirectories(sources: readonly ConfigSource[], target: string, globalDirectory: string, project?: string): string[] {
  const directories = new Set([resolve(globalDirectory)]);
  for (const path of [target, ...sources.map(source => source.path)]) {
    const directory = dirname(path);
    directories.add(basename(directory) === '.opencode' ? directory : join(directory, '.opencode'));
  }
  if (project) for (let directory = resolve(project); ; directory = dirname(directory)) {
    directories.add(join(directory, '.opencode'));
    if (dirname(directory) === directory) break;
  }
  return [...directories];
}

export function findMarkdownConflicts(sources: readonly ConfigSource[], target: string, globalDirectory: string, project?: string): string[] {
  const directories = agentDirectories(sources, target, globalDirectory, project);
  const paths = new Set<string>();
  for (const directory of directories) for (const layout of ['agent', 'agents']) for (const role of nativeRoles) {
    const path = join(directory, layout, `${role}.md`);
    if (existsSync(path)) paths.add(path);
  }
  return [...paths];
}

export interface NativeReconciliationOptions {
  managedFields?: Partial<Record<NativeRole, Partial<Pick<NativeDefinition, 'description' | 'mode' | 'system'>>>>;
  replaceFields?: Partial<Record<NativeRole, readonly ('description' | 'mode' | 'system')[]>>;
  permissions?: Partial<Record<NativeRole, { prior: readonly AttributedRule[]; previousOrder: readonly PermissionRule[]; removeObsolete?: readonly PermissionRule[] }>>;
  onPermissionPlan?: (role: NativeRole, plan: ReconciliationResult) => void;
}

export function updateNativeConfiguration(original: string, definitions: Record<NativeRole, NativeDefinition>, assignments: Record<NativeRole, string>, setDefault: boolean, setLeadModel = false, replaceModels: readonly NativeRole[] = [], reconciliation: NativeReconciliationOptions = {}): string {
  const value = parseConfiguration(original, 'selected configuration');
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
  let text = bom ? original.slice(1) : original;
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: original.includes('\r\n') ? '\r\n' : '\n' } };
  const set = (path: string[], content: unknown) => { text = applyEdits(text, modify(text, path, content, options)); };
  if (value.$schema === undefined) set(['$schema'], 'https://opencode.ai/config.json');
  for (const role of nativeRoles) {
    const model = modelReference(assignments[role]);
    if (!model) throw new Error(`Invalid model assignment for ${role}`);
    const existing = object(value.agents) ? value.agents[role] : undefined;
    if (existing !== undefined && !object(existing)) throw new Error(`Expected a V2 agent object for ${role}`);
    if (!object(existing) || existing.model === undefined || replaceModels.includes(role)) set(['agents', role, 'model'], model);
    for (const field of ['description', 'mode', 'system'] as const) {
      const current = object(existing) ? existing[field] : undefined;
      const managed = reconciliation.managedFields?.[role]?.[field];
      if (current === undefined || reconciliation.replaceFields?.[role]?.includes(field) || managed !== undefined && current === managed) set(['agents', role, field], definitions[role][field]);
    }
    if (object(existing) && existing.permissions !== undefined && !Array.isArray(existing.permissions)) throw new Error(`Expected a native permission array for ${role}`);
    const current = object(existing) && Array.isArray(existing.permissions) ? existing.permissions : [];
    const plan = reconcilePermissions({ existing: current as PermissionRule[], desired: (definitions[role].permissions as PermissionRule[]).map(rule => ({ rule, sources: [`native:${role}`] })), retiringSources: [`native:${role}`], ...reconciliation.permissions?.[role] });
    if (plan.preview.conflicts.length) throw new Error(`Permission reconciliation conflict for ${role}: ${plan.preview.conflicts.map(c => c.message).join(' ')}`);
    reconciliation.onPermissionPlan?.(role, plan);
    set(['agents', role, 'permissions'], plan.rules);
  }
  if (setDefault) set(['default_agent'], 'lead');
  if (setLeadModel) set(['model'], assignments.lead.split('#')[0]);
  parseConfiguration(text, 'updated configuration');
  return bom + text;
}

export function saveInstallation(target: string, expected: string | undefined, updated: string, backupParent: string, onBackup?: (path: string, contents: string) => void, onBackupDirectory?: (path: string) => void): string | undefined {
  const checkAncestors = (path: string, leaf: 'file' | 'directory' | 'either'): void => {
    const absolute = resolve(path), root = pathParse(absolute).root;
    let cursor = root;
    const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      cursor = join(cursor, parts[index]!);
      const stat = lstatSync(cursor, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isSymbolicLink()) throw new Error(`Symlink path component refused: ${cursor}`);
      const final = index === parts.length - 1;
      if (final && leaf === 'file' && !stat.isFile()) throw new Error(`Refusing non-regular configuration file: ${cursor}`);
      if (final && leaf === 'directory' && !stat.isDirectory()) throw new Error(`Expected directory: ${cursor}`);
      if (!final && !stat.isDirectory()) throw new Error(`Non-directory path ancestor refused: ${cursor}`);
    }
  };
  checkAncestors(target, 'file'); checkAncestors(backupParent, 'directory');
  const entry = lstatSync(target, { throwIfNoEntry: false });
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error('Refusing to replace a non-regular or symlink configuration file.');
  const identity = entry ? `${entry.dev}:${entry.ino}` : undefined;
  const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  if (current !== expected) throw new Error('Configuration changed while answering prompts. Rerun the installer; nothing was overwritten.');
  let backup: string | undefined;
  if (expected !== undefined) {
    const makeDirectories = (directory: string) => {
      const missing: string[] = []; let cursor = resolve(directory); const root = pathParse(cursor).root;
      while (cursor !== root && !lstatSync(cursor, { throwIfNoEntry: false })) { missing.push(cursor); cursor = dirname(cursor); }
      for (const path of missing.reverse()) {
        try { mkdirSync(path, { mode: 0o700 }); onBackupDirectory?.(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) throw error; }
      }
    };
    makeDirectories(backupParent);
    const directory = join(backupParent, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
    checkAncestors(backupParent, 'directory');
    makeDirectories(directory);
    checkAncestors(directory, 'directory');
    backup = join(directory, basename(target));
    const fd = openSync(backup, 'wx', 0o600);
    onBackup?.(backup, expected);
    try { writeFileSync(fd, expected, 'utf8'); } finally { closeSync(fd); }
  }
  mkdirSync(dirname(target), { recursive: true });
  checkAncestors(target, 'file');
  const temporary = `${target}.harness-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, updated, { flag: 'wx', mode: 0o600 });
    if (expected !== undefined) chmodSync(temporary, lstatSync(target).mode & 0o777);
    checkAncestors(target, 'file');
    if ((existsSync(target) ? readFileSync(target, 'utf8') : undefined) !== expected) throw new Error('Configuration changed before save. Nothing was overwritten.');
    const latest = lstatSync(target, { throwIfNoEntry: false });
    if ((latest ? `${latest.dev}:${latest.ino}` : undefined) !== identity) throw new Error('Configuration file identity changed before save. Nothing was overwritten.');
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return backup;
}
