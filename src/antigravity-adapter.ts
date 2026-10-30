import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSafeFilesystemPath } from './installation-receipt.ts';
import {
  createSuccessorReceipt,
  discoverReceiptChain,
  finalizeSuccessor,
  recoverFailedSuccessor,
  revalidatePendingSuccessor,
  writePendingSuccessor,
  type HarnessVersionStamp,
  type ManagedFileEvidence,
} from './receipt-lineage.ts';
import { formatVersionStamp } from './harness-version.ts';
import { nativeRoles, saveInstallation, type Ask, type NativeRole } from './native-installer.ts';
import { loadRoleDefinitions } from './role-definitions.ts';
import {
  compileLeadOrchestrationRule,
  compileAntigravitySkill,
  mergeAntigravityHooksConfig,
  mergeAntigravityMcpConfig,
  getAntigravityMergeGuardMjsSource,
  AntigravityConfigMergeError,
} from './antigravity-compiler.ts';
import { loadWorkflowCommands, workflowCommandIds } from './workflow-commands.ts';
import { HOST_CAPABILITIES, HOST_MODEL_PRESETS, type HostRolePreset } from './host-registry.ts';
import { antigravityGlobalModelPreferencesPath, antigravityPreferenceEvidence, assertAntigravityPreferencePredecessorState, assertNoAntigravityPreferenceDeploymentOverlap, planAntigravityModelPreferenceWrites, preflightAntigravityPreferenceWrites } from './antigravity-model-preferences.ts';

export interface AntigravityAdapterInstallOptions {
  scope: 'project' | 'global';
  project?: string | undefined;
  home?: string | undefined;
  recoveryDirectory?: string | undefined;
  agentsDirectory?: string | undefined;
  commandsDirectory?: string | undefined;
  context?: string | undefined;
  harnessVersion?: HarnessVersionStamp | undefined;
  ask: Ask;
  output(message: string): void;
  error(message: string): void;
}

export interface AntigravityDoctorResult {
  ok: boolean;
  issues: string[];
  notes: string[];
}

export interface AntigravityDeploymentItem {
  relativePath: string;
  absolutePath: string;
  content: string;
  currentContent: string | undefined;
  status: 'new' | 'current' | 'outdated' | 'customized';
  kind: 'rules' | 'commands' | 'config' | 'instructions';
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function planAntigravityDeployment(
  scope: 'project' | 'global',
  projectRoot: string | undefined,
  home: string,
  agentsDir: string,
  commandsDir: string,
  priorManagedFiles?: readonly ManagedFileEvidence[]
): {
  targetConfig: string;
  filesToDeploy: AntigravityDeploymentItem[];
} {
  const roles = loadRoleDefinitions(agentsDir);
  const leadRule = compileLeadOrchestrationRule(roles);
  const commands = loadWorkflowCommands(commandsDir);

  const rawFiles: Array<{
    relativePath: string;
    absolutePath: string;
    content: string;
    kind: 'rules' | 'commands' | 'config' | 'instructions';
    isMergedConfig?: boolean;
  }> = [];

  let targetConfig: string;
  let guardScriptPath: string;

  const priorByPath = new Map<string, ManagedFileEvidence>();
  if (priorManagedFiles) {
    for (const f of priorManagedFiles) {
      const canonical = process.platform === 'win32' ? resolve(f.path).toLowerCase() : resolve(f.path);
      priorByPath.set(canonical, f);
    }
  }

  const getPriorContent = (path: string): string | undefined => {
    const canonical = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    const ev = priorByPath.get(canonical);
    if (ev && 'content' in ev.after && typeof ev.after.content === 'string') {
      return ev.after.content;
    }
    return undefined;
  };

  // Merge failures name the file they came from so installers can report it.
  const mergeAt = <T>(path: string, merge: () => T): T => {
    try {
      return merge();
    } catch (err) {
      if (err instanceof AntigravityConfigMergeError) err.path = path;
      throw err;
    }
  };

  if (scope === 'project') {
    if (!projectRoot) throw new Error('Project scope requires a valid project root directory.');
    targetConfig = join(projectRoot, '.agents', 'hooks.json');
    guardScriptPath = join(projectRoot, '.agents', 'scripts', 'antigravity-merge-guard.mjs');

    // 1. Lead rule
    rawFiles.push({
      relativePath: leadRule.path,
      absolutePath: join(projectRoot, leadRule.path),
      content: leadRule.content,
      kind: 'rules',
    });

    // 2. Workflow skills (all 6)
    for (const cmdId of workflowCommandIds) {
      const skill = compileAntigravitySkill(cmdId, commands[cmdId], 'project');
      rawFiles.push({
        relativePath: skill.relativePath,
        absolutePath: join(projectRoot, skill.relativePath),
        content: skill.content,
        kind: 'commands',
      });
    }

    // 3. Standalone merge guard script (.agents/scripts/antigravity-merge-guard.mjs)
    rawFiles.push({
      relativePath: '.agents/scripts/antigravity-merge-guard.mjs',
      absolutePath: guardScriptPath,
      content: getAntigravityMergeGuardMjsSource(),
      kind: 'config',
    });

    // 4. hooks.json with resolved absolute path to guard script
    const existingHooks = existsSync(targetConfig) ? readFileSync(targetConfig, 'utf8') : undefined;
    const hooksMerged = mergeAt(targetConfig, () => mergeAntigravityHooksConfig(existingHooks, guardScriptPath, getPriorContent(targetConfig)));
    rawFiles.push({
      relativePath: '.agents/hooks.json',
      absolutePath: targetConfig,
      content: JSON.stringify(hooksMerged, null, 2) + '\n',
      kind: 'config',
      isMergedConfig: true,
    });

    // 5. mcp_config.json
    const mcpTarget = join(projectRoot, '.agents', 'mcp_config.json');
    const existingMcp = existsSync(mcpTarget) ? readFileSync(mcpTarget, 'utf8') : undefined;
    const mcpMerged = mergeAt(mcpTarget, () => mergeAntigravityMcpConfig(existingMcp, {}, getPriorContent(mcpTarget)));
    rawFiles.push({
      relativePath: '.agents/mcp_config.json',
      absolutePath: mcpTarget,
      content: JSON.stringify(mcpMerged, null, 2) + '\n',
      kind: 'config',
      isMergedConfig: true,
    });
  } else {
    // Global scope: ~/.gemini/config/
    const baseDir = join(home, '.gemini', 'config');
    targetConfig = join(baseDir, 'hooks.json');
    guardScriptPath = join(baseDir, 'scripts', 'antigravity-merge-guard.mjs');

    // 1. Lead rule in global rules
    const leadRulePath = join(baseDir, 'rules', 'advanced-harness-lead.md');
    rawFiles.push({
      relativePath: 'rules/advanced-harness-lead.md',
      absolutePath: leadRulePath,
      content: leadRule.content,
      kind: 'rules',
    });

    // 2. Workflow skills (all 6) in global skills directory
    for (const cmdId of workflowCommandIds) {
      const skill = compileAntigravitySkill(cmdId, commands[cmdId], 'global');
      rawFiles.push({
        relativePath: skill.relativePath,
        absolutePath: join(baseDir, skill.relativePath),
        content: skill.content,
        kind: 'commands',
      });
    }

    // 3. Standalone merge guard script (scripts/antigravity-merge-guard.mjs)
    rawFiles.push({
      relativePath: 'scripts/antigravity-merge-guard.mjs',
      absolutePath: guardScriptPath,
      content: getAntigravityMergeGuardMjsSource(),
      kind: 'config',
    });

    // 4. hooks.json
    const existingHooks = existsSync(targetConfig) ? readFileSync(targetConfig, 'utf8') : undefined;
    const hooksMerged = mergeAt(targetConfig, () => mergeAntigravityHooksConfig(existingHooks, guardScriptPath, getPriorContent(targetConfig)));
    rawFiles.push({
      relativePath: 'hooks.json',
      absolutePath: targetConfig,
      content: JSON.stringify(hooksMerged, null, 2) + '\n',
      kind: 'config',
      isMergedConfig: true,
    });

    // 5. mcp_config.json
    const mcpTarget = join(baseDir, 'mcp_config.json');
    const existingMcp = existsSync(mcpTarget) ? readFileSync(mcpTarget, 'utf8') : undefined;
    const mcpMerged = mergeAt(mcpTarget, () => mergeAntigravityMcpConfig(existingMcp, {}, getPriorContent(mcpTarget)));
    rawFiles.push({
      relativePath: 'mcp_config.json',
      absolutePath: mcpTarget,
      content: JSON.stringify(mcpMerged, null, 2) + '\n',
      kind: 'config',
      isMergedConfig: true,
    });
  }

  const filesToDeploy: AntigravityDeploymentItem[] = rawFiles.map(f => {
    assertSafeFilesystemPath(f.absolutePath, 'file');
    const currentContent = existsSync(f.absolutePath) ? readFileSync(f.absolutePath, 'utf8') : undefined;
    let status: AntigravityDeploymentItem['status'];

    if (currentContent === undefined) {
      status = 'new';
    } else if (currentContent === f.content) {
      status = 'current';
    } else if (f.isMergedConfig) {
      // Merged config already resolved and preserved unrelated settings
      status = 'outdated';
    } else {
      const canonical = process.platform === 'win32' ? resolve(f.absolutePath).toLowerCase() : resolve(f.absolutePath);
      const prior = priorByPath.get(canonical);
      if (prior && !('absent' in prior.after)) {
        const matchesPriorContent = prior.after.content !== undefined && currentContent === prior.after.content;
        const matchesPriorDigest = prior.after.digest !== undefined && hash(currentContent) === prior.after.digest;
        if (matchesPriorContent || matchesPriorDigest) {
          status = 'outdated';
        } else {
          status = 'customized';
        }
      } else {
        // File exists on disk but was never managed by a prior receipt
        status = 'customized';
      }
    }

    return {
      relativePath: f.relativePath,
      absolutePath: f.absolutePath,
      content: f.content,
      currentContent,
      status,
      kind: f.kind,
    };
  });

  return { targetConfig, filesToDeploy };
}

/** One-line, actionable report for a merged config file that blocks planning. */
export function formatAntigravityConfigMergeError(err: AntigravityConfigMergeError, recoveryDirectory: string): string {
  const file = err.path ?? 'the Antigravity configuration';
  if (err.reason === 'malformed' || !err.entry) {
    const detail = err.message.replace(/\s+/g, ' ').trim().replace(/\.?$/, '.');
    return `Antigravity configuration problem in ${file}: ${detail} Fix the JSON or move the file aside, then re-run. No files were changed.`;
  }
  const entry = err.entry.kind === 'hook'
    ? { label: `"${err.entry.id}" hook`, removal: `remove the "${err.entry.id}" key` }
    : { label: `MCP server "${err.entry.id}"`, removal: `remove the "${err.entry.id}" entry from "mcpServers"` };
  return `Antigravity configuration conflict in ${file}: the ${entry.label} does not match what the harness installs or last installed. Restore it to the content recorded in the latest Antigravity install receipt under ${recoveryDirectory}, or ${entry.removal}, then re-run. No files were changed.`;
}

export function preflightAntigravityDeployment(files: readonly AntigravityDeploymentItem[]): void {
  for (const f of files) {
    assertSafeFilesystemPath(f.absolutePath, 'file');
    const currentOnDisk = existsSync(f.absolutePath) ? readFileSync(f.absolutePath, 'utf8') : undefined;
    if (currentOnDisk !== f.currentContent) {
      throw new Error(
        `Configuration or artifact changed while confirmation was open: ${f.relativePath}. Rerun the installer; nothing was overwritten.`
      );
    }
  }
}

export async function installAntigravity(options: AntigravityAdapterInstallOptions): Promise<number> {
  const { scope, project, ask, output, error } = options;
  const home = options.home ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
  const agentsDir = options.agentsDirectory ?? fileURLToPath(new URL('../agents/', import.meta.url));
  const commandsDir = options.commandsDirectory ?? fileURLToPath(new URL('../commands/', import.meta.url));
  const backupParent = options.recoveryDirectory ?? process.env.ADVANCED_HARNESS_RECOVERY_DIR ?? join(home, 'Projects', 'advanced-harness-backups');

  output(`\nTarget Host: Google Antigravity\nScope: ${scope}`);
  if (project) output(`Project: ${project}`);

  const initialTarget = scope === 'project'
    ? join(project ?? '', '.agents', 'hooks.json')
    : join(home, '.gemini', 'config', 'hooks.json');

  const snapshot = discoverReceiptChain(backupParent, initialTarget, 'antigravity');
  const priorManagedFiles = snapshot.head?.receipt.version === 2 && snapshot.head.receipt.managedFiles
    ? snapshot.head.receipt.managedFiles
    : [];

  const globalTarget = join(home, '.gemini', 'config', 'hooks.json');
  const globalSnapshot = scope === 'global' ? snapshot : discoverReceiptChain(backupParent, globalTarget, 'antigravity');
  const globalManagedFiles = globalSnapshot.head?.receipt.version === 2 && globalSnapshot.head.receipt.managedFiles
    ? globalSnapshot.head.receipt.managedFiles
    : [];
  const canonicalPath = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const globalPreferencesPath = canonicalPath(antigravityGlobalModelPreferencesPath(home));
  const predecessorStates = [
    ...priorManagedFiles.filter(file => file.kind === 'instructions'),
    ...globalManagedFiles.filter(file => canonicalPath(file.path) === globalPreferencesPath),
  ];
  // Check only the specific model-preference/context ownership footprint. Other
  // customized Antigravity artifacts retain their existing explicit-overwrite flow.
  assertAntigravityPreferencePredecessorState(predecessorStates);

  let plan: ReturnType<typeof planAntigravityDeployment>;
  try {
    plan = planAntigravityDeployment(scope, project, home, agentsDir, commandsDir, priorManagedFiles);
  } catch (err) {
    if (!(err instanceof AntigravityConfigMergeError)) throw err;
    error(formatAntigravityConfigMergeError(err, backupParent));
    return 1;
  }

  const selectedFilesToWrite: AntigravityDeploymentItem[] = [];

  output('\nFiles to deploy:');
  for (const f of plan.filesToDeploy) {
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
        output(`  Preserving customized file: ${f.relativePath}`);
      }
    }
  }

  const preferencePlan = await planAntigravityModelPreferenceWrites({
    scope,
    ...(project ? { project } : {}),
    home,
    ...(options.context ? { context: options.context } : {}),
    ask,
    output,
    runtimeTiers: Object.fromEntries(nativeRoles.map(role => [role, HOST_MODEL_PRESETS.antigravity[role].model])) as Record<NativeRole, string>,
  });
  assertNoAntigravityPreferenceDeploymentOverlap(preferencePlan.paths, plan.filesToDeploy);
  output('\nDesired model preference preview (labels only; no runtime assignment or access verification):');
  for (const role of nativeRoles) {
    output(`  ${role} (existing runtime tier ${HOST_MODEL_PRESETS.antigravity[role].model}, unchanged): ${preferencePlan.preferences.preferences[role] ?? 'unconfigured'}`);
  }
  output('Preference files to update:');
  if (preferencePlan.writes.length) preferencePlan.writes.forEach(file => output(`  ${file.path} (${file.currentContent === undefined ? 'new' : 'update'}${file.currentContent === undefined ? '' : `; private before-state backup under ${backupParent}`})`));
  else output('  None (preferences already match).');

  if (options.harnessVersion) output(`Harness version: ${formatVersionStamp(options.harnessVersion)}`);
  // Enter does not apply a default here: only an explicit yes writes files.
  output('');
  const confirm = (await ask('Type yes to install the Antigravity harness configuration listed above (yes/no)', 'no')).trim().toLowerCase();
  if (confirm !== 'yes' && confirm !== 'y') {
    output('Installation canceled by user. No files written.');
    return 1;
  }

  // Preflight all planned files against snapshot taken before confirmation
  preflightAntigravityDeployment(plan.filesToDeploy);
  preflightAntigravityPreferenceWrites(preferencePlan.writes);
  // Customized-artifact prompts and preference questions are asynchronous. A
  // predecessor context may have changed while either was open, including when
  // this plan produces no preference write. Recheck before no-op or receipt work.
  assertAntigravityPreferencePredecessorState(predecessorStates);

  const targetInitial = existsSync(plan.targetConfig) ? readFileSync(plan.targetConfig, 'utf8') : undefined;
  const targetFileInPlan = plan.filesToDeploy.find(f => f.absolutePath === plan.targetConfig);
  const targetFinal = targetFileInPlan?.content ?? (targetInitial ?? '');

  const newManagedEvidence: ManagedFileEvidence[] = [];
  for (const f of selectedFilesToWrite) {
    newManagedEvidence.push({
      path: f.absolutePath,
      kind: f.kind,
      before: f.currentContent === undefined
        ? { absent: true }
        : { content: f.currentContent, digest: hash(f.currentContent) },
      after: { content: f.content, digest: hash(f.content) },
    });
  }
  newManagedEvidence.push(...antigravityPreferenceEvidence(preferencePlan.writes));

  // Preserve earliest before baseline from prior managed files across upgrades/reinstalls
  const combinedManagedFiles = structuredClone(priorManagedFiles);
  for (const ev of newManagedEvidence) {
    const canonical = process.platform === 'win32' ? resolve(ev.path).toLowerCase() : resolve(ev.path);
    const existing = combinedManagedFiles.find(
      m => (process.platform === 'win32' ? resolve(m.path).toLowerCase() : resolve(m.path)) === canonical
    );
    if (existing) {
      existing.after = structuredClone(ev.after);
    } else {
      combinedManagedFiles.push(ev);
    }
  }

  const configChanged = targetFinal !== (targetInitial ?? '');
  const hasWrites = selectedFilesToWrite.length > 0 || preferencePlan.writes.length > 0;

  if (!hasWrites && !configChanged) {
    output('Configuration and artifacts already match; no files, backups, or receipts were modified.');
    return 0;
  }

  const successor = createSuccessorReceipt(
    snapshot,
    targetInitial,
    targetFinal,
    {},
    options.harnessVersion,
    { host: 'antigravity', managedFiles: combinedManagedFiles }
  );

  const pending = writePendingSuccessor(snapshot, successor);
  const receiptPath = pending.path;

  try {
    revalidatePendingSuccessor(pending);
    preflightAntigravityDeployment(plan.filesToDeploy);
    preflightAntigravityPreferenceWrites(preferencePlan.writes);

    for (const f of selectedFilesToWrite) {
      saveInstallation(f.absolutePath, f.currentContent, f.content, backupParent);
    }
    for (const file of preferencePlan.writes) {
      saveInstallation(file.path, file.currentContent, file.content, backupParent);
    }
  } catch (err) {
    const targetUnchanged = (existsSync(plan.targetConfig) ? readFileSync(plan.targetConfig, 'utf8') : undefined) === targetInitial;
    const allFilesUnchanged = selectedFilesToWrite.every(f => {
      const exists = existsSync(f.absolutePath);
      if (f.currentContent === undefined) return !exists;
      return exists && readFileSync(f.absolutePath, 'utf8') === f.currentContent;
    }) && preferencePlan.writes.every(f => (existsSync(f.path) ? readFileSync(f.path, 'utf8') : undefined) === f.currentContent);

    if (targetUnchanged && allFilesUnchanged) {
      recoverFailedSuccessor(pending, targetInitial);
    } else {
      error(`Configuration or artifact writes may have partially succeeded; pending recovery evidence retained at ${receiptPath}.`);
    }
    throw err;
  }

  finalizeSuccessor(pending, targetFinal);

  output('\nAntigravity harness deployment complete.');
  output('• Rules deployed for Lead orchestrator with subagent delegation contract.');
  output('• PreToolUse hook installed to block "gh pr merge".');
  output('• Workflow skills and MCP config generated.\n');
  output('• Per-role desired model labels saved as preferences only; effective models/access are not configured or verified.');

  return 0;
}

export async function diagnoseAntigravity(options: { project?: string | undefined; globalDirectory?: string | undefined; home?: string | undefined; platform?: NodeJS.Platform | undefined }): Promise<AntigravityDoctorResult> {
  const issues: string[] = [];
  const notes: string[] = [];
  const platform = options.platform ?? process.platform;
  const home = options.home ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
  const project = options.project ? resolve(options.project) : undefined;
  const globalDir = options.globalDirectory ?? join(home, '.gemini', 'config');

  let projectInstalled = false;
  let globalInstalled = false;

  const validateScopeArtifacts = (baseDir: string, isProject: boolean, label: string) => {
    const scopePrefix = isProject ? '.agents' : '';
    const rulesDir = isProject ? join(baseDir, '.agents', 'rules') : join(baseDir, 'rules');
    const skillsDir = isProject ? join(baseDir, '.agents', 'skills') : join(baseDir, 'skills');
    const hookPath = isProject ? join(baseDir, '.agents', 'hooks.json') : join(baseDir, 'hooks.json');
    const mcpPath = isProject ? join(baseDir, '.agents', 'mcp_config.json') : join(baseDir, 'mcp_config.json');
    const scriptPath = isProject ? join(baseDir, '.agents', 'scripts', 'antigravity-merge-guard.mjs') : join(baseDir, 'scripts', 'antigravity-merge-guard.mjs');

    // 1. Lead Rule
    const leadRulePath = join(rulesDir, 'advanced-harness-lead.md');
    if (!existsSync(leadRulePath)) {
      issues.push(`${label} Lead orchestration rule missing: ${leadRulePath}`);
    } else {
      const size = readFileSync(leadRulePath).byteLength;
      if (size === 0) {
        issues.push(`${label} Lead orchestration rule is empty.`);
      } else if (size > 24000) {
        issues.push(`${label} Lead rule exceeds 24KB limit (${size} bytes).`);
      } else {
        notes.push(`${label} Lead orchestration rule is present (${size} bytes).`);
      }
    }

    // 2. All 6 Workflow Skills
    for (const cmdId of workflowCommandIds) {
      const skillFile = join(skillsDir, cmdId, 'SKILL.md');
      if (!existsSync(skillFile)) {
        issues.push(`${label} workflow skill "${cmdId}" missing: ${skillFile}`);
      } else {
        const content = readFileSync(skillFile, 'utf8');
        const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
        if (!match) {
          issues.push(`${label} workflow skill "${cmdId}" missing YAML frontmatter.`);
        } else {
          const frontmatter = match[1]!;
          if (!new RegExp(`^name:\\s*${cmdId}\\b`, 'm').test(frontmatter)) {
            issues.push(`${label} workflow skill "${cmdId}" frontmatter missing name: ${cmdId}.`);
          }
          if (!/^description:\s*.+/m.test(frontmatter)) {
            issues.push(`${label} workflow skill "${cmdId}" frontmatter missing valid description.`);
          }
        }
        if (content.includes('workflow instructions') || content.includes('issue-id') || content.includes('defect details')) {
          issues.push(`${label} workflow skill "${cmdId}" contains placeholder arguments instead of reusable invocation instructions.`);
        }
      }
    }

    // 3. hooks.json
    if (!existsSync(hookPath)) {
      issues.push(`${label} hooks.json missing: ${hookPath}`);
    } else {
      try {
        const text = readFileSync(hookPath, 'utf8');
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          issues.push(`Malformed ${label} hooks.json: root value must be a JSON object.`);
        } else if (!parsed['gh-pr-merge-guard'] || typeof parsed['gh-pr-merge-guard'] !== 'object' || Array.isArray(parsed['gh-pr-merge-guard'])) {
          issues.push(`${label} hooks.json missing valid gh-pr-merge-guard definition.`);
        } else {
          const guard = parsed['gh-pr-merge-guard'] as Record<string, unknown>;
          if (guard.enabled !== undefined && guard.enabled !== true) {
            issues.push(`${label} hooks.json gh-pr-merge-guard is disabled.`);
          }

          const hookList = guard.PreToolUse;
          let referencedScript: string | undefined;
          let referencedQuoted = false;

          if (Array.isArray(hookList) && hookList.length > 0) {
            for (const entry of hookList) {
              if (entry && typeof entry === 'object' && entry.matcher === 'run_command' && Array.isArray(entry.hooks) && entry.hooks.length > 0) {
                for (const h of entry.hooks) {
                  if (h && typeof h === 'object' && (h.type === undefined || h.type === 'command') && typeof h.command === 'string') {
                    const match = /^\s*node(?:\.exe)?\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))\s*$/i.exec(h.command);
                    const candidate = match ? (match[1] ?? match[2] ?? match[3]) : undefined;
                    if (candidate && candidate.toLowerCase().endsWith('antigravity-merge-guard.mjs')) {
                      referencedScript = candidate;
                      referencedQuoted = match?.[3] === undefined;
                      break;
                    }
                  }
                }
              }
              if (referencedScript) break;
            }
          }

          if (!referencedScript) {
            issues.push(`${label} hooks.json gh-pr-merge-guard PreToolUse is missing an enabled run_command handler for antigravity-merge-guard.mjs.`);
          } else {
            const actualScript = resolve(dirname(hookPath), referencedScript);
            if (!existsSync(actualScript)) {
              issues.push(`${label} merge-guard executable referenced in hooks.json does not exist: ${actualScript}`);
            } else if (referencedQuoted && platform === 'win32') {
              issues.push(`${label} hooks.json quotes the merge-guard path; Antigravity on Windows passes the quotes to Node and every run_command fails. Run harness:update to rewrite it.`);
            } else {
              notes.push(`${label} PreToolUse merge guard hook is configured.`);
            }
          }
        }
      } catch (err) {
        issues.push(`Malformed ${label} hooks.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 4. mcp_config.json
    if (!existsSync(mcpPath)) {
      issues.push(`${label} mcp_config.json missing: ${mcpPath}`);
    } else {
      try {
        const parsed = JSON.parse(readFileSync(mcpPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed.mcpServers && typeof parsed.mcpServers !== 'object')) {
          issues.push(`${label} mcp_config.json has invalid structure.`);
        } else {
          notes.push(`${label} mcp_config.json is valid JSON.`);
        }
      } catch (err) {
        issues.push(`Malformed ${label} mcp_config.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  // Determine footprints
  if (project) {
    if (
      existsSync(join(project, '.agents')) ||
      existsSync(join(project, '.agents', 'hooks.json')) ||
      existsSync(join(project, '.agents', 'mcp_config.json'))
    ) {
      projectInstalled = true;
    }
  }

  if (
    existsSync(join(globalDir, 'hooks.json')) ||
    existsSync(join(globalDir, 'mcp_config.json')) ||
    existsSync(join(globalDir, 'rules', 'advanced-harness-lead.md'))
  ) {
    globalInstalled = true;
  }

  if (!projectInstalled && !globalInstalled) {
    issues.push('Antigravity harness is not installed in the inspected project or global scope.');
  } else {
    if (project && projectInstalled) {
      validateScopeArtifacts(project, true, 'Project');
    }
    if (globalInstalled) {
      validateScopeArtifacts(globalDir, false, 'Global');
    }
  }

  notes.push('Role/tool-group boundary enforcement is instruction-level in Antigravity rules.');
  notes.push('PreToolUse hook guards direct run_command calls; subshells, aliases, or separate processes are not sandboxed.');
  notes.push('Interactive skill execution and hook enforcement are unverified until tested live in TUI.');

  return {
    ok: issues.length === 0,
    issues,
    notes,
  };
}
