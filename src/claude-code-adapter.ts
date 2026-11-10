import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import type { HarnessVersionStamp } from './receipt-lineage.ts';
import { formatVersionStamp } from './harness-version.ts';
import { assertSafeFilesystemPath } from './installation-receipt.ts';
import { finishGitExclude, previewGitExclude } from './git-exclude.ts';
import {
  createSuccessorReceipt,
  discoverReceiptChain,
  finalizeSuccessor,
  recoverFailedSuccessor,
  revalidatePendingSuccessor,
  writePendingSuccessor,
  type ManagedFileEvidence,
} from './receipt-lineage.ts';
import { saveInstallation, type Ask } from './native-installer.ts';
import { nativeRoles, type NativeRole } from './native-role-types.ts';
import { discoverProcedureSkills, planProcedureDeployment, procedureManagedEvidence, applyProcedureFiles, preflightProcedureFiles, assertNoForeignManagedFileClaims, type ProcedureFilePlan } from './procedure-deployment.ts';
import { loadRoleDefinitions } from './role-definitions.ts';
import { loadWorkflowCommands, workflowCommandIds } from './workflow-commands.ts';
import {
  claudeAdvisories,
  claudeChildRoles,
  claudeDisclosures,
  claudeMarkers,
  claudeModelAliases,
  claudePresetModels,
  isClaudeModelValue,
  claudeSettingsAsk,
  claudeSettingsDeny,
  compileClaudeCommandFile,
  compileClaudeLeadBlock,
  compileClaudeSubagentFile,
  extractClaudeLeadBlock,
  mappingsFor,
  mergeClaudeMemory,
  mergeClaudeSettings,
  type ClaudeRoleMapping,
} from './claude-code-compiler.ts';

export interface ClaudeCodeInstallOptions {
  scope: 'project' | 'global';
  project?: string | undefined;
  home?: string | undefined;
  recoveryDirectory?: string | undefined;
  agentsDirectory?: string | undefined;
  commandsDirectory?: string | undefined;
  skillsDirectory?: string | undefined;
  harnessVersion?: HarnessVersionStamp | undefined;
  ask: Ask;
  output(message: string): void;
  error(message: string): void;
}

export interface ClaudeCodeDoctorOptions {
  project?: string | undefined;
  home?: string | undefined;
  agentsDirectory?: string | undefined;
  commandsDirectory?: string | undefined;
}

export interface ClaudeCodeDoctorResult {
  ok: boolean;
  issues: string[];
  notes: string[];
}

export interface ClaudeCodeDeploymentItem {
  relativePath: string;
  absolutePath: string;
  content: string;
  currentContent: string | undefined;
  status: 'new' | 'current' | 'outdated' | 'customized';
  kind: 'rules' | 'commands' | 'config' | 'instructions';
  merged: boolean;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const readIfExists = (path: string): string | undefined => existsSync(path) ? readFileSync(path, 'utf8') : undefined;

/**
 * Where the harness files live. Project scope uses <project>/CLAUDE.md and <project>/.claude;
 * global scope uses the Claude Code user directory ~/.claude (read by the CLI and Desktop).
 */
export interface ClaudeTarget {
  scope: 'project' | 'global';
  /** Directory holding CLAUDE.md. */
  memoryDirectory: string;
  /** Directory holding agents/, commands/ and settings.json. */
  claudeDirectory: string;
  /** Display prefix for paths inside claudeDirectory. */
  label: string;
}

export function claudeTarget(scope: 'project' | 'global', root: string): ClaudeTarget {
  return scope === 'global'
    ? { scope, memoryDirectory: join(root, '.claude'), claudeDirectory: join(root, '.claude'), label: '~/.claude/' }
    : { scope, memoryDirectory: root, claudeDirectory: join(root, '.claude'), label: '.claude/' };
}

const asTarget = (target: string | ClaudeTarget) => typeof target === 'string' ? claudeTarget('project', target) : target;
const memoryLabel = (target: ClaudeTarget) => target.scope === 'global' ? '~/.claude/CLAUDE.md' : 'CLAUDE.md';

const defaultAgentsDirectory = () => fileURLToPath(new URL('../agents/', import.meta.url));
const defaultCommandsDirectory = () => fileURLToPath(new URL('../commands/', import.meta.url));

/** Valid models in installed role files; a missing or invalid value falls back to the preset. */
export function installedClaudeModels(target: string | ClaudeTarget): Record<NativeRole, string> {
  const { claudeDirectory } = asTarget(target);
  const models = claudePresetModels();
  for (const role of nativeRoles) {
    const text = readIfExists(join(claudeDirectory, 'agents', `${role}.md`));
    const model = text === undefined ? undefined : frontmatterOf(text)?.model;
    if (isClaudeModelValue(model)) models[role] = model;
  }
  return models;
}

/**
 * Asks for an explicit model per role. Enter keeps the shown default (installed, else preset).
 * Only syntax is checked: no catalog exists to establish availability or entitlement.
 */
export async function askClaudeModels(defaults: Record<NativeRole, string>, ask: Ask, output: (message: string) => void): Promise<Record<NativeRole, string>> {
  output('\nClaude Code role models. Claude Code exposes no model catalog to this harness: discovery is unsupported and availability is unverified.');
  claudeModelAliases.forEach((alias, index) => output(`  ${index + 1}. ${alias}${alias === 'inherit' ? ' (use the main session model)' : ''}`));
  output('Enter a listed number, an alias, or a full model ID (written as typed, not checked). Enter keeps the shown model.');
  const models = {} as Record<NativeRole, string>;
  for (const role of nativeRoles) {
    for (let attempt = 1; !models[role]; attempt++) {
      const answer = (await ask(`${role}: Claude Code model (number, alias, or full model ID)`, defaults[role])).trim() || defaults[role];
      const model = /^\d+$/.test(answer) ? claudeModelAliases[Number(answer) - 1] : answer;
      if (isClaudeModelValue(model)) {
        models[role] = model;
        if (!(claudeModelAliases as readonly string[]).includes(model)) output(`  ${role}: ${model} is not a documented alias; it is written as typed and its availability is unverified.`);
      } else if (attempt >= 3) {
        throw new Error(`Claude Code model for ${role} remained invalid after 3 attempts. No files were changed.`);
      } else {
        output(`Enter a listed number, an alias, or a model ID without spaces for ${role}; nothing is substituted.`);
      }
    }
  }
  return models;
}

export function planClaudeDeployment(
  targetOrProject: string | ClaudeTarget,
  agentsDirectory: string,
  commandsDirectory: string,
  priorManagedFiles: readonly ManagedFileEvidence[] = [],
  models: Record<NativeRole, string> = installedClaudeModels(targetOrProject)
): { files: ClaudeCodeDeploymentItem[]; mappings: Record<NativeRole, ClaudeRoleMapping>; settingsPath: string; models: Record<NativeRole, string>; skills: ProcedureFilePlan[] } {
  const target = asTarget(targetOrProject);
  const { claudeDirectory, label } = target;
  const roles = loadRoleDefinitions(agentsDirectory);
  const mappings = mappingsFor(roles);
  const commands = loadWorkflowCommands(commandsDirectory);

  const priorByPath = new Map<string, ManagedFileEvidence>();
  for (const evidence of priorManagedFiles) priorByPath.set(canonical(evidence.path), evidence);

  const raw: Array<Omit<ClaudeCodeDeploymentItem, 'currentContent' | 'status'>> = [];
  const memoryPath = join(target.memoryDirectory, 'CLAUDE.md');
  raw.push({
    relativePath: memoryLabel(target),
    absolutePath: memoryPath,
    content: mergeClaudeMemory(readIfExists(memoryPath), compileClaudeLeadBlock(mappings, models, target.scope), target.scope === 'project'),
    kind: 'instructions',
    merged: true,
  });
  for (const role of nativeRoles) {
    raw.push({
      relativePath: `${label}agents/${role}.md`,
      absolutePath: join(claudeDirectory, 'agents', `${role}.md`),
      content: compileClaudeSubagentFile(role, roles[role], mappings[role], models[role]),
      kind: 'rules',
      merged: false,
    });
  }
  for (const id of workflowCommandIds) {
    raw.push({
      relativePath: `${label}commands/${id}.md`,
      absolutePath: join(claudeDirectory, 'commands', `${id}.md`),
      content: compileClaudeCommandFile(commands[id]),
      kind: 'commands',
      merged: false,
    });
  }
  const settingsPath = join(claudeDirectory, 'settings.json');
  raw.push({
    relativePath: `${label}settings.json`,
    absolutePath: settingsPath,
    content: mergeClaudeSettings(readIfExists(settingsPath)),
    kind: 'config',
    merged: true,
  });

  const files = raw.map((item): ClaudeCodeDeploymentItem => {
    assertSafeFilesystemPath(item.absolutePath, 'file');
    const currentContent = readIfExists(item.absolutePath);
    let status: ClaudeCodeDeploymentItem['status'];
    if (currentContent === undefined) {
      status = 'new';
    } else if (currentContent === item.content) {
      status = 'current';
    } else if (item.kind === 'instructions') {
      // Only the managed block is compared. A hand-edited block that the harness did not write
      // (not equal to the prior receipt's block) requires explicit overwrite confirmation.
      const existingBlock = extractClaudeLeadBlock(currentContent);
      const compiledBlock = extractClaudeLeadBlock(item.content);
      const prior = priorByPath.get(canonical(item.absolutePath));
      const priorText = prior && !('absent' in prior.after) && typeof prior.after.content === 'string' ? prior.after.content : undefined;
      const priorBlock = priorText === undefined ? undefined : extractClaudeLeadBlock(priorText);
      status = existingBlock !== undefined && existingBlock !== compiledBlock && existingBlock !== priorBlock ? 'customized' : 'outdated';
    } else if (item.merged) {
      // The merge already preserved unrelated user content; only the managed part changes.
      status = 'outdated';
    } else {
      const prior = priorByPath.get(canonical(item.absolutePath));
      if (prior && !('absent' in prior.after)) {
        const matchesPriorContent = prior.after.content !== undefined && currentContent === prior.after.content;
        const matchesPriorDigest = prior.after.digest !== undefined && hash(currentContent) === prior.after.digest;
        status = matchesPriorContent || matchesPriorDigest ? 'outdated' : 'customized';
      } else {
        status = 'customized';
      }
    }
    return { ...item, currentContent, status };
  });
  const skills = planProcedureDeployment(discoverProcedureSkills(fileURLToPath(new URL('../skills/', import.meta.url)), 'claude-code'), target.scope === 'global' ? claudeDirectory : target.memoryDirectory, priorManagedFiles, target.scope === 'global');
  return { files, mappings, settingsPath, models, skills };
}

export async function installClaudeCode(options: ClaudeCodeInstallOptions): Promise<number> {
  const { scope, project, ask, output, error } = options;
  const home = options.home ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (scope === 'project' && !project) {
    error('Select a project directory for a project-scoped Claude Code install. No files were changed.');
    return 2;
  }
  if (scope === 'global' && !home) {
    error('Cannot locate the home directory for a global Claude Code install. No files were changed.');
    return 2;
  }
  const target = claudeTarget(scope, scope === 'global' ? home : project!);
  const agentsDir = options.agentsDirectory ?? defaultAgentsDirectory();
  const commandsDir = options.commandsDirectory ?? defaultCommandsDirectory();
  const backupParent = options.recoveryDirectory ?? process.env.ADVANCED_HARNESS_RECOVERY_DIR ?? join(home, 'Projects', 'advanced-harness-backups');

  output(`\nTarget Host: Claude Code\nScope: ${scope}\n${scope === 'global' ? `User directory: ${target.claudeDirectory}` : `Project: ${project}`}`);

  const snapshot = discoverReceiptChain(backupParent, join(target.claudeDirectory, 'settings.json'), 'claude-code');
  const priorManagedFiles = snapshot.head?.receipt.version === 2 && snapshot.head.receipt.managedFiles
    ? snapshot.head.receipt.managedFiles
    : [];

  let plan: ReturnType<typeof planClaudeDeployment>;
  try {
    // Plan once with the installed models so malformed targets stop before any model prompt.
    plan = planClaudeDeployment(target, agentsDir, commandsDir, priorManagedFiles);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  let models: Record<NativeRole, string>;
  try {
    models = await askClaudeModels(plan.models, ask, output);
  } catch (err) {
    error(err instanceof Error && err.message.endsWith('No files were changed.') ? err.message : 'Claude Code model prompt was closed or rejected. No files were changed.');
    return 2;
  }
  if (nativeRoles.some(role => models[role] !== plan.models[role])) {
    try {
      plan = planClaudeDeployment(target, agentsDir, commandsDir, priorManagedFiles, models);
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      return 2;
    }
  }
  output('\nModel assignments (availability unverified):');
  for (const role of nativeRoles) output(`  ${role}: ${models[role]}`);

  if (scope === 'project' && !existsSync(join(project!, 'AGENTS.md'))) {
    output('Warning: AGENTS.md was not found in this project. The @AGENTS.md reference in CLAUDE.md will add nothing until it exists.');
  }

  const selectedFilesToWrite: ClaudeCodeDeploymentItem[] = [];
  const selectedSkills = new Set<string>();
  output('\nFiles to deploy:');
  for (const f of plan.files) {
    const statusLabel = f.status === 'new'
      ? 'new'
      : f.status === 'current'
      ? 'current (up to date)'
      : f.status === 'outdated'
      ? 'update'
      : 'customized/unowned';
    output(`  ${f.relativePath} (${statusLabel})`);

    if (f.status === 'new' || f.status === 'outdated') {
      selectedFilesToWrite.push(f);
    } else if (f.status === 'customized') {
      const answer = (await ask(`Overwrite customized/unowned file ${f.relativePath}? (yes/no)`, 'no')).trim().toLowerCase();
      if (answer === 'yes' || answer === 'y') {
        selectedFilesToWrite.push(f);
      } else {
        output(`  Preserving customized file: ${f.relativePath}${f.kind === 'rules' ? '; the model entered for it was not applied' : ''}`);
      }
    }
  }
  output('\nReusable procedure skills:');
  for (const f of plan.skills) {
    output(`  ${f.path}: ${f.status}${f.status === 'customized' ? ' (preserved unless explicitly replaced)' : ''}`);
    if (f.status === 'new' || f.status === 'outdated') selectedSkills.add(canonical(f.path));
    else if (f.status === 'customized' && /^(yes|y)$/i.test((await ask(`Overwrite customized/unowned procedure skill ${f.path}? (yes/no)`, 'no')).trim())) selectedSkills.add(canonical(f.path));
  }

  const targetInitial = readIfExists(plan.settingsPath);
  const targetFinal = plan.files.find(f => f.absolutePath === plan.settingsPath)?.content ?? (targetInitial ?? '');
  const configChanged = targetFinal !== (targetInitial ?? '');
  // A user-level install has no project whose Git exclude could hold harness scratch state.
  const exclude = scope === 'project' ? previewGitExclude(project, 'claude-code', output) : undefined;
  const filesChanged = selectedFilesToWrite.length > 0 || configChanged || selectedSkills.size > 0;
  if (!filesChanged && exclude?.status !== 'change') {
    output('No selected file needs changes; no files, backups, or receipts were modified.');
    return 0;
  }

  output('Settings and CLAUDE.md are merged: unrelated content is preserved. Unsupported mappings are withheld, not approximated:');
  for (const line of claudeDisclosures(plan.mappings)) output(`  - ${line}`);
  const advisories = claudeAdvisories(plan.mappings);
  if (advisories.length) {
    output('Advisory on Claude Code (instruction only, not enforced):');
    for (const line of advisories) output(`  - ${line}`);
  }
  if (scope === 'global') {
    output('Global scope writes your Claude Code user settings (CLI and Desktop): Lead becomes the default agent in every');
    output("session unless a project's .claude/settings.json selects another, and the deny/ask rules apply everywhere.");
    output("~/.claude/CLAUDE.md cannot import a project AGENTS.md; Lead is told to read the current project's AGENTS.md instead.");
  }

  if (options.harnessVersion) output(`Harness version: ${formatVersionStamp(options.harnessVersion)}`);
  // Enter does not apply a default here: only an explicit yes writes files.
  const confirm = (await ask('Type yes to install the Claude Code harness configuration listed above (yes/no)', 'no')).trim().toLowerCase();
  if (confirm !== 'yes' && confirm !== 'y') {
    output('Installation canceled by user. No files written.');
    return 1;
  }
  if (!filesChanged) {
    output('Harness files already match; no files, backups, or receipts were modified.');
    finishGitExclude(exclude, output, error);
    return 0;
  }

  assertNoForeignManagedFileClaims(backupParent, 'claude-code', [...selectedSkills]);
  for (const f of plan.files) assertSafeFilesystemPath(f.absolutePath, 'file');
  const preflight = () => {
    for (const f of plan.files) {
      const currentOnDisk = readIfExists(f.absolutePath);
      if (currentOnDisk !== f.currentContent) {
        throw new Error(`Configuration or artifact changed while confirmation was open: ${f.relativePath}. Rerun the installer; nothing was overwritten.`);
      }
    }
  };
  preflight();
  preflightProcedureFiles(plan.skills.filter(file => selectedSkills.has(canonical(file.path))));

  const newManagedEvidence: ManagedFileEvidence[] = selectedFilesToWrite.map(f => ({
    path: f.absolutePath,
    kind: f.kind,
    before: f.currentContent === undefined
      ? { absent: true }
      : { content: f.currentContent, digest: hash(f.currentContent) },
    after: { content: f.content, digest: hash(f.content) },
  }));

  const combinedManagedFiles = structuredClone(priorManagedFiles);
  for (const ev of procedureManagedEvidence(plan.skills, selectedSkills)) {
    const existing = combinedManagedFiles.find(m => canonical(m.path) === canonical(ev.path));
    if (existing) existing.after = structuredClone(ev.after); else combinedManagedFiles.push(ev);
  }
  for (const ev of newManagedEvidence) {
    const existing = combinedManagedFiles.find(m => canonical(m.path) === canonical(ev.path));
    if (existing) {
      existing.after = structuredClone(ev.after);
    } else {
      combinedManagedFiles.push(ev);
    }
  }

  const successor = createSuccessorReceipt(
    snapshot,
    targetInitial,
    targetFinal,
    {},
    options.harnessVersion,
    { host: 'claude-code', managedFiles: combinedManagedFiles }
  );
  const pending = writePendingSuccessor(snapshot, successor);
  const receiptPath = pending.path;

  try {
    revalidatePendingSuccessor(pending);
    assertNoForeignManagedFileClaims(backupParent, 'claude-code', [...selectedSkills]);
    preflight();
    preflightProcedureFiles(plan.skills.filter(file => selectedSkills.has(canonical(file.path))));
    for (const f of selectedFilesToWrite) {
      saveInstallation(f.absolutePath, f.currentContent, f.content, backupParent);
    }
    if (selectedSkills.size) applyProcedureFiles(plan.skills, selectedSkills, backupParent, path => output(`Procedure skill backup: ${path}`));
  } catch (err) {
    const allUnchanged = plan.files.every(f => readIfExists(f.absolutePath) === f.currentContent || !selectedFilesToWrite.includes(f)) && plan.skills.every(file => {
      const now = existsSync(file.path) ? readFileSync(file.path) : undefined;
      return !selectedSkills.has(canonical(file.path)) || (now === undefined ? file.current === undefined : file.current !== undefined && now.equals(file.current));
    });
    if (allUnchanged && !(err instanceof Error && err.message.includes('Procedure skill deployment may be partial'))) {
      recoverFailedSuccessor(pending, targetInitial);
    } else {
      error(`Configuration or artifact writes may have partially succeeded; pending recovery evidence retained at ${receiptPath}.`);
    }
    throw err;
  }
  finalizeSuccessor(pending, targetFinal);
  finishGitExclude(exclude, output, error);

  output('\nClaude Code harness deployment complete (runtime not verified).');
  if (selectedSkills.size) output('Reusable procedure skills deployed.');
  output(`• ${memoryLabel(target)} Lead block and ${target.label}settings.json (agent: lead, gh pr merge denied) are configured.`);
  output(`• Subagents: ${claudeChildRoles.join(', ')} plus lead in ${target.label}agents.`);
  output(`• Workflow commands: ${workflowCommandIds.join(', ')} in ${target.label}commands.`);
  output('• MCP configuration: none written; no MCP alias maps exactly to a Claude Code identity.');
  output('Withheld or unsupported on Claude Code:');
  for (const line of claudeDisclosures(plan.mappings)) output(`  - ${line}`);
  if (advisories.length) {
    output('Advisory on Claude Code (instruction only, not enforced):');
    for (const line of advisories) output(`  - ${line}`);
  }
  output(`Verify in a NEW Claude Code session with /agents and by running npm run harness:doctor -- --host claude-code${scope === 'global' ? ' from a directory without a project-level install' : ''}.\n`);
  return 0;
}

function frontmatterOf(text: string): Record<string, unknown> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) return undefined;
  const document = parseDocument(match[1]!);
  if (document.errors.length) return undefined;
  const value: unknown = document.toJSON();
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function listOf(value: unknown): string[] {
  return typeof value === 'string' ? value.split(/,(?![^(]*\))/).map(item => item.trim()).filter(Boolean) : [];
}

export async function diagnoseClaudeCode(options: ClaudeCodeDoctorOptions): Promise<ClaudeCodeDoctorResult> {
  const issues: string[] = [];
  const notes: string[] = [];
  const project = options.project ? resolve(options.project) : undefined;
  const markers = ['CLAUDE.md', join('.claude', 'settings.json'), join('.claude', 'agents', 'lead.md')];
  // A plain CLAUDE.md or settings.json is common without the harness, so only harness-owned markers
  // (Lead agent file or Lead block) decide between a project and a global install.
  const hasHarnessMarker = (target: ClaudeTarget) => existsSync(join(target.claudeDirectory, 'agents', 'lead.md'))
    || (readIfExists(join(target.memoryDirectory, 'CLAUDE.md'))?.includes(claudeMarkers.start) ?? false);
  const projectHarness = project !== undefined && hasHarnessMarker(claudeTarget('project', project));
  const global = options.home ? claudeTarget('global', resolve(options.home)) : undefined;
  const globalInstalled = global !== undefined && hasHarnessMarker(global);
  // Without a global install, generic project files still get a detailed (incomplete) project report.
  const projectInstalled = projectHarness || (!globalInstalled && project !== undefined && markers.some(rel => existsSync(join(project, rel))));
  if (!projectInstalled && !globalInstalled) {
    issues.push(project
      ? 'Claude Code harness is not installed in this project (no CLAUDE.md, .claude/settings.json, or .claude/agents/lead.md) or in ~/.claude.'
      : 'Claude Code harness is not installed in ~/.claude (no agents/lead.md or Lead block in CLAUDE.md).');
    return { ok: false, issues, notes };
  }
  const target = projectInstalled ? claudeTarget('project', project!) : global!;
  if (target.scope === 'global') notes.push(`Inspecting the global Claude Code install in ${target.claudeDirectory}.`);
  const settingsLabel = `${target.label}settings.json`;

  let plan: ReturnType<typeof planClaudeDeployment>;
  try {
    plan = planClaudeDeployment(target, options.agentsDirectory ?? defaultAgentsDirectory(), options.commandsDirectory ?? defaultCommandsDirectory());
  } catch (err) {
    issues.push(`Cannot compile the expected Claude Code files: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, issues, notes };
  }

  for (const f of plan.files) {
    if (f.merged) continue;
    if (f.status === 'new') issues.push(`Missing ${f.relativePath}.`);
    else if (f.status !== 'current') issues.push(`${f.relativePath} is ${f.status === 'customized' ? 'customized or unowned' : 'outdated'}; rerun the installer or review the customization.`);
  }

  const memory = plan.files.find(f => f.kind === 'instructions')!;
  if (target.scope === 'global') {
    if (memory.status !== 'current') issues.push('~/.claude/CLAUDE.md Lead orchestration block is missing or outdated.');
    else notes.push('~/.claude/CLAUDE.md contains the Lead orchestration block.');
  } else if (memory.status !== 'current') issues.push('CLAUDE.md Lead orchestration block or @AGENTS.md reference is missing or outdated.');
  else notes.push('CLAUDE.md contains the Lead orchestration block and @AGENTS.md reference.');

  for (const role of nativeRoles) {
    const path = join(target.claudeDirectory, 'agents', `${role}.md`);
    if (!existsSync(path)) continue;
    const meta = frontmatterOf(readFileSync(path, 'utf8'));
    if (!meta) { issues.push(`${role}.md has invalid YAML frontmatter.`); continue; }
    if (meta.name !== role) issues.push(`${role}.md name must be "${role}".`);
    if (typeof meta.description !== 'string' || !meta.description.trim()) issues.push(`${role}.md is missing a description.`);
    if (!isClaudeModelValue(meta.model)) issues.push(`${role}.md model ${JSON.stringify(meta.model ?? null)} is missing or invalid; rerun the installer to choose one explicitly.`);
    const tools = listOf(meta.tools);
    const disallowed = listOf(meta.disallowedTools);
    if (!tools.length) issues.push(`${role}.md must declare a tools allowlist.`);
    const delegates = tools.filter(tool => tool.startsWith('Agent('));
    if (role === 'lead') {
      const names = delegates.flatMap(tool => tool.slice(6, -1).split(',').map(name => name.trim())).sort();
      if (JSON.stringify(names) !== JSON.stringify([...claudeChildRoles].sort())) issues.push('lead.md must delegate to exactly the seven child agents.');
    } else if (delegates.length || tools.includes('Agent')) {
      issues.push(`${role}.md must not be able to spawn subagents.`);
    }
    if (role !== 'lead' && !disallowed.includes('Agent')) issues.push(`${role}.md must disallow Agent.`);
  }

  const settingsPath = join(target.claudeDirectory, 'settings.json');
  if (existsSync(settingsPath)) {
    let settings: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
      settings = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
      issues.push(`${settingsLabel} is not valid JSON.`);
    }
    if (settings) {
      if (settings.agent !== 'lead') issues.push(`${settingsLabel} does not select lead as the default agent.`);
      const permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions as Record<string, unknown> : {};
      const deny = Array.isArray(permissions.deny) ? permissions.deny.map(String) : [];
      const ask = Array.isArray(permissions.ask) ? permissions.ask.map(String) : [];
      for (const rule of claudeSettingsDeny) if (!deny.includes(rule)) issues.push(`${settingsLabel} is missing deny rule ${rule}.`);
      for (const rule of claudeSettingsAsk) if (!ask.includes(rule)) issues.push(`${settingsLabel} is missing ask rule ${rule}.`);
      if (!issues.some(issue => issue.startsWith(settingsLabel))) notes.push(`${settingsLabel} selects lead, denies gh pr merge, sensitive-path Read/Edit, destructive Git, and git fetch --upload-pack/-u (ADR-005), and prompts for .env reads.`);
    }
  } else {
    issues.push(`${settingsLabel} is missing.`);
  }

  notes.push(...claudeDisclosures(plan.mappings).map(line => `Withheld or unsupported: ${line}`));
  notes.push(...claudeAdvisories(plan.mappings).map(line => `Advisory (not enforced): ${line}`));
  notes.push('Discovery is checked by file presence and frontmatter only; Claude Code runtime discovery, agent: lead, and Agent(...) delegation are not verified (no claude CLI or session was invoked).');
  notes.push(`Expected Lead marker: ${claudeMarkers.start} ... ${claudeMarkers.end}`);
  return { ok: issues.length === 0, issues, notes };
}
