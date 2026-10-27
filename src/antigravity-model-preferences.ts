import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { assertSafeFilesystemPath } from './installation-receipt.ts';
import { contextData, contextPath, prepareContextFiles, readContext, updateContext } from './project-context.ts';
import { parseConfiguration, nativeRoles, type Ask, type NativeRole } from './native-installer.ts';
import type { ManagedFileEvidence } from './receipt-lineage.ts';
import type { SetupFile } from './project-setup.ts';

export type AntigravityModelPreferences = { version: 1; preferences: Record<NativeRole, string | null> };
export type ModelPreferenceWrite = { path: string; currentContent: string | undefined; content: string; kind: 'config' | 'instructions' };

export const ANTIGRAVITY_MODEL_LABELS = [
  'Claude Opus 5.5',
  'Claude Sonnet 5.5',
  'Gemini 4 Argon',
] as const;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const defaultPreferences = (): AntigravityModelPreferences => ({ version: 1, preferences: Object.fromEntries(nativeRoles.map(role => [role, null])) as Record<NativeRole, string | null> });

export function parseAntigravityModelPreferences(text: string, source: string): AntigravityModelPreferences {
  const value = parseConfiguration(text, source);
  if (!object(value) || Object.keys(value).sort().join(',') !== 'preferences,version' || value.version !== 1 || !object(value.preferences) || Object.keys(value.preferences).sort().join(',') !== [...nativeRoles].sort().join(',')) {
    throw new Error(`Invalid Antigravity model-preferences document: ${source}. No files changed.`);
  }
  const preferences = {} as Record<NativeRole, string | null>;
  for (const role of nativeRoles) {
    const preference = value.preferences[role];
    if (preference !== null && (typeof preference !== 'string' || !preference.trim() || preference.length > 200 || /[\x00-\x1f\x7f]/.test(preference))) {
      throw new Error(`Invalid desired model preference for ${role} in ${source}. No files changed.`);
    }
    preferences[role] = preference as string | null;
  }
  return { version: 1, preferences };
}

function parseModelPreferenceSection(text: string | undefined, source: string): AntigravityModelPreferences | undefined {
  if (!text) return undefined;
  const hasSection = text.includes('<!-- advanced-harness:model-preferences:start -->') || text.includes('<!-- advanced-harness:model-preferences:end -->');
  const value = contextData(text, 'model-preferences');
  if (hasSection && value === undefined) throw new Error(`Model-preferences section is malformed in ${source}. No files changed.`);
  if (value === undefined) return undefined;
  if (!object(value)) throw new Error(`Invalid Antigravity model-preferences section in ${source}. No files changed.`);
  return parseAntigravityModelPreferences(JSON.stringify(value), source);
}

function readGlobalPreferences(home: string): { path: string; text: string | undefined; preferences: AntigravityModelPreferences | undefined } {
  const path = assertSafeFilesystemPath(join(home, '.gemini', 'config', 'harness.model-preferences.json'), 'file');
  const text = readContext(path);
  return { path, text, preferences: text === undefined ? undefined : parseAntigravityModelPreferences(text, path) };
}

export async function promptAntigravityModelPreferences(
  defaults: AntigravityModelPreferences,
  ask: Ask,
  output: (message: string) => void,
  runtimeTiers: Record<NativeRole, string>,
): Promise<AntigravityModelPreferences> {
  output('Desired model preferences are human-readable intent only; they do not configure or verify actual models, IDs, access, or runtime assignment.');
  ANTIGRAVITY_MODEL_LABELS.forEach((label, index) => output(`  ${index + 1}. ${label} (user-observed UI label only)`));
  output('  4. Enter a custom label');
  output('  0. Unconfigured');
  output('Type 4 to enter any custom label. These examples are not discovered provider IDs or entitlement evidence.');
  const preferences = {} as Record<NativeRole, string | null>;
  for (const role of nativeRoles) {
    output(`${role}: existing Antigravity runtime tier ${runtimeTiers[role]} (unchanged).`);
    const existing = defaults.preferences[role];
    const matchingExample = existing === null ? -1 : ANTIGRAVITY_MODEL_LABELS.indexOf(existing as typeof ANTIGRAVITY_MODEL_LABELS[number]);
    const suggested = existing === null ? '0' : matchingExample >= 0 ? String(matchingExample + 1) : '4';
    while (true) {
      const raw = (await ask(`${role}: desired model preference (1-4, 0 unconfigured, or custom label)`, suggested)).trim();
      const value = raw || suggested;
      if (value === '0') { preferences[role] = null; break; }
      if (/^[1-3]$/.test(value)) { preferences[role] = ANTIGRAVITY_MODEL_LABELS[Number(value) - 1]!; break; }
      if (value === '4') {
        const custom = (await ask(`${role}: custom desired model label`, existing ?? '')).trim() || (existing ?? '');
        if (custom && custom.length <= 200 && !/[\x00-\x1f\x7f]/.test(custom)) { preferences[role] = custom; break; }
        output(`Invalid label for ${role}; use 1-200 printable characters.`);
        continue;
      }
      if (/^\d+$/.test(value)) {
        output(`Invalid choice for ${role}; choose 0-4.`);
        continue;
      }
      if (value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) {
        output(`Invalid label for ${role}; use 1-200 printable characters.`);
        continue;
      }
      preferences[role] = value;
      break;
    }
  }
  return { version: 1, preferences };
}

export async function planAntigravityModelPreferenceWrites(options: {
  scope: 'project' | 'global';
  project?: string;
  home: string;
  context?: string;
  ask: Ask;
  output: (message: string) => void;
  runtimeTiers: Record<NativeRole, string>;
}): Promise<{ preferences: AntigravityModelPreferences; paths: string[]; writes: ModelPreferenceWrite[] }> {
  const global = readGlobalPreferences(options.home);
  if (options.scope === 'global') {
    const defaults = global.preferences ?? defaultPreferences();
    const preferences = await promptAntigravityModelPreferences(defaults, options.ask, options.output, options.runtimeTiers);
    const content = JSON.stringify(preferences, null, 2) + '\n';
    return {
      preferences,
      paths: [global.path],
      writes: content === global.text ? [] : [{ path: global.path, currentContent: global.text, content, kind: 'config' }],
    };
  }

  if (!options.project) throw new Error('Project scope requires a project directory for Antigravity model preferences.');
  const target = assertSafeFilesystemPath(contextPath(options.project, options.context ?? 'AGENTS.md'), 'file');
  const current = readContext(target);
  const existingPreferences = parseModelPreferenceSection(current, target);
  const defaults = existingPreferences ?? global.preferences ?? defaultPreferences();
  options.output(`Project preferences are saved in ${relative(options.project, target).replaceAll('\\', '/')}; global defaults are suggestions only and will not be changed.`);
  const preferences = await promptAntigravityModelPreferences(defaults, options.ask, options.output, options.runtimeTiers);
  const updated = updateContext(current, 'model-preferences', preferences, [
    'The following per-role model labels express desired preference only; they are not enforced runtime assignments or evidence of model access.',
    'Do not infer provider IDs, entitlement, discovery, or actual-model selection from these labels.',
  ]);
  const files: SetupFile[] = prepareContextFiles(options.project, target, current, updated);
  return {
    preferences,
    paths: files.map(file => file.path),
    writes: files.filter(file => file.updated !== file.original).map(file => ({
      path: file.path,
      currentContent: file.original,
      content: file.updated,
      kind: 'instructions' as const,
    })),
  };
}

export function antigravityPreferenceEvidence(writes: readonly ModelPreferenceWrite[]): ManagedFileEvidence[] {
  return writes.map(write => ({
    path: write.path,
    kind: write.kind,
    before: write.currentContent === undefined ? { absent: true } : { content: write.currentContent },
    after: { content: write.content },
  }));
}

export function preflightAntigravityPreferenceWrites(writes: readonly ModelPreferenceWrite[]): void {
  for (const write of writes) {
    assertSafeFilesystemPath(write.path, 'file');
    const current = existsSync(write.path) ? readFileSync(write.path, 'utf8') : undefined;
    if (current !== write.currentContent) throw new Error(`Model preference file changed while confirmation was open: ${write.path}. Rerun the installer; nothing was overwritten.`);
  }
}

export function assertNoAntigravityPreferenceDeploymentOverlap(
  preferencePaths: readonly string[],
  deploymentFiles: readonly { absolutePath: string; relativePath: string }[],
): void {
  const canonical = (path: string) => {
    const resolved = resolve(path);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const separator = process.platform === 'win32' ? '\\' : '/';
  const overlaps = (left: string, right: string) => left === right || left.startsWith(right + separator) || right.startsWith(left + separator);
  for (const path of preferencePaths) {
    const preferencePath = canonical(path);
    for (const artifact of deploymentFiles) {
      if (overlaps(preferencePath, canonical(artifact.absolutePath))) {
        throw new Error(`Selected model-preference context overlaps Antigravity deployment artifact "${artifact.relativePath}". Choose a different in-project Markdown file; no files were written.`);
      }
    }
  }
}
