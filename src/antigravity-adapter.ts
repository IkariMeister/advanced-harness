import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeFilesystemPath } from './installation-receipt.ts';
import { createSuccessorReceipt, discoverReceiptChain, finalizeSuccessor, writePendingSuccessor, type ManagedFileEvidence } from './receipt-lineage.ts';
import { saveInstallation, type Ask } from './native-installer.ts';
import { loadRoleDefinitions } from './role-definitions.ts';
import {
  compileLeadOrchestrationRule,
  compileAntigravitySkill,
  mergeAntigravityHooksConfig,
  mergeAntigravityMcpConfig,
  getAntigravityMergeGuardMjsSource,
} from './antigravity-compiler.ts';
import { loadWorkflowCommands, workflowCommandIds } from './workflow-commands.ts';
import { HOST_CAPABILITIES, HOST_MODEL_PRESETS, type HostRolePreset } from './host-registry.ts';

export interface AntigravityAdapterInstallOptions {
  scope: 'project' | 'global';
  project?: string | undefined;
  home?: string | undefined;
  recoveryDirectory?: string | undefined;
  agentsDirectory?: string | undefined;
  commandsDirectory?: string | undefined;
  ask: Ask;
  output(message: string): void;
  error(message: string): void;
}

export interface AntigravityDoctorResult {
  ok: boolean;
  issues: string[];
  notes: string[];
}

export function planAntigravityDeployment(
  scope: 'project' | 'global',
  projectRoot: string | undefined,
  home: string,
  agentsDir: string,
  commandsDir: string,
  priorManagedFiles?: readonly ManagedFileEvidence[]
): {
  targetConfig: string;
  filesToDeploy: Array<{ relativePath: string; absolutePath: string; content: string; kind: 'rules' | 'commands' | 'config' | 'instructions' }>;
} {
  const roles = loadRoleDefinitions(agentsDir);
  const leadRule = compileLeadOrchestrationRule(roles);
  const commands = loadWorkflowCommands(commandsDir);

  const filesToDeploy: Array<{ relativePath: string; absolutePath: string; content: string; kind: 'rules' | 'commands' | 'config' | 'instructions' }> = [];

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

  if (scope === 'project') {
    if (!projectRoot) throw new Error('Project scope requires a valid project root directory.');
    targetConfig = join(projectRoot, '.agents', 'hooks.json');
    guardScriptPath = join(projectRoot, '.agents', 'scripts', 'antigravity-merge-guard.mjs');

    // 1. Lead rule
    filesToDeploy.push({
      relativePath: leadRule.path,
      absolutePath: join(projectRoot, leadRule.path),
      content: leadRule.content,
      kind: 'rules',
    });

    // 2. Workflow skills (all 6)
    for (const cmdId of workflowCommandIds) {
      const skill = compileAntigravitySkill(cmdId, commands[cmdId], 'project');
      filesToDeploy.push({
        relativePath: skill.relativePath,
        absolutePath: join(projectRoot, skill.relativePath),
        content: skill.content,
        kind: 'commands',
      });
    }

    // 3. Standalone merge guard script (.agents/scripts/antigravity-merge-guard.mjs)
    filesToDeploy.push({
      relativePath: '.agents/scripts/antigravity-merge-guard.mjs',
      absolutePath: guardScriptPath,
      content: getAntigravityMergeGuardMjsSource(),
      kind: 'config',
    });

    // 4. hooks.json with resolved absolute path to guard script
    const existingHooks = existsSync(targetConfig) ? readFileSync(targetConfig, 'utf8') : undefined;
    const hooksMerged = mergeAntigravityHooksConfig(existingHooks, guardScriptPath, getPriorContent(targetConfig));
    filesToDeploy.push({
      relativePath: '.agents/hooks.json',
      absolutePath: targetConfig,
      content: JSON.stringify(hooksMerged, null, 2) + '\n',
      kind: 'config',
    });

    // 5. mcp_config.json
    const mcpTarget = join(projectRoot, '.agents', 'mcp_config.json');
    const existingMcp = existsSync(mcpTarget) ? readFileSync(mcpTarget, 'utf8') : undefined;
    const mcpMerged = mergeAntigravityMcpConfig(existingMcp, {}, getPriorContent(mcpTarget));
    filesToDeploy.push({
      relativePath: '.agents/mcp_config.json',
      absolutePath: mcpTarget,
      content: JSON.stringify(mcpMerged, null, 2) + '\n',
      kind: 'config',
    });
  } else {
    // Global scope: ~/.gemini/config/
    const baseDir = join(home, '.gemini', 'config');
    targetConfig = join(baseDir, 'hooks.json');
    guardScriptPath = join(baseDir, 'scripts', 'antigravity-merge-guard.mjs');

    // 1. Lead rule in global rules
    const leadRulePath = join(baseDir, 'rules', 'advanced-harness-lead.md');
    filesToDeploy.push({
      relativePath: 'rules/advanced-harness-lead.md',
      absolutePath: leadRulePath,
      content: leadRule.content,
      kind: 'rules',
    });

    // 2. Workflow skills (all 6) in global skills directory
    for (const cmdId of workflowCommandIds) {
      const skill = compileAntigravitySkill(cmdId, commands[cmdId], 'global');
      filesToDeploy.push({
        relativePath: skill.relativePath,
        absolutePath: join(baseDir, skill.relativePath),
        content: skill.content,
        kind: 'commands',
      });
    }

    // 3. Standalone merge guard script (scripts/antigravity-merge-guard.mjs)
    filesToDeploy.push({
      relativePath: 'scripts/antigravity-merge-guard.mjs',
      absolutePath: guardScriptPath,
      content: getAntigravityMergeGuardMjsSource(),
      kind: 'config',
    });

    // 4. hooks.json
    const existingHooks = existsSync(targetConfig) ? readFileSync(targetConfig, 'utf8') : undefined;
    const hooksMerged = mergeAntigravityHooksConfig(existingHooks, guardScriptPath, getPriorContent(targetConfig));
    filesToDeploy.push({
      relativePath: 'hooks.json',
      absolutePath: targetConfig,
      content: JSON.stringify(hooksMerged, null, 2) + '\n',
      kind: 'config',
    });

    // 5. mcp_config.json
    const mcpTarget = join(baseDir, 'mcp_config.json');
    const existingMcp = existsSync(mcpTarget) ? readFileSync(mcpTarget, 'utf8') : undefined;
    const mcpMerged = mergeAntigravityMcpConfig(existingMcp, {}, getPriorContent(mcpTarget));
    filesToDeploy.push({
      relativePath: 'mcp_config.json',
      absolutePath: mcpTarget,
      content: JSON.stringify(mcpMerged, null, 2) + '\n',
      kind: 'config',
    });
  }

  return { targetConfig, filesToDeploy };
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

  const plan = planAntigravityDeployment(scope, project, home, agentsDir, commandsDir, priorManagedFiles);

  output('\nFiles to deploy:');
  for (const f of plan.filesToDeploy) {
    const exists = existsSync(f.absolutePath);
    output(`  ${f.relativePath} (${exists ? 'update/preserve' : 'new'})`);
  }

  const confirm = (await ask('\nConfirm installation of Antigravity harness configuration? (yes/no)', 'yes')).trim().toLowerCase();
  if (confirm !== 'yes' && confirm !== 'y') {
    output('Installation canceled by user. No files written.');
    return 1;
  }

  // Preflight all paths safely
  for (const f of plan.filesToDeploy) {
    assertSafeFilesystemPath(f.absolutePath, 'file');
  }

  const targetInitial = existsSync(plan.targetConfig) ? readFileSync(plan.targetConfig, 'utf8') : undefined;

  const targetFileInPlan = plan.filesToDeploy.find(f => f.absolutePath === plan.targetConfig);
  const targetFinal = targetFileInPlan?.content ?? (targetInitial ?? '');

  const newManagedEvidence: ManagedFileEvidence[] = [];

  for (const f of plan.filesToDeploy) {
    const current = existsSync(f.absolutePath) ? readFileSync(f.absolutePath, 'utf8') : undefined;
    newManagedEvidence.push({
      path: f.absolutePath,
      kind: f.kind,
      before: current === undefined ? { absent: true } : { content: current },
      after: { content: f.content },
    });
  }

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

  const successor = createSuccessorReceipt(
    snapshot,
    targetInitial,
    targetFinal,
    {},
    undefined,
    { host: 'antigravity', managedFiles: combinedManagedFiles }
  );

  const pending = writePendingSuccessor(snapshot, successor);

  for (const f of plan.filesToDeploy) {
    const current = existsSync(f.absolutePath) ? readFileSync(f.absolutePath, 'utf8') : undefined;
    saveInstallation(f.absolutePath, current, f.content, backupParent);
  }

  finalizeSuccessor(pending, targetFinal);

  output('\nAntigravity harness deployment complete.');
  output('• Rules deployed for Lead orchestrator with subagent delegation contract.');
  output('• PreToolUse hook installed to block "gh pr merge".');
  output('• Workflow skills and MCP config generated.\n');

  return 0;
}

export async function diagnoseAntigravity(options: { project?: string | undefined; globalDirectory?: string | undefined; home?: string | undefined }): Promise<AntigravityDoctorResult> {
  const issues: string[] = [];
  const notes: string[] = [];
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
        if (parsed['gh-pr-merge-guard']?.PreToolUse) {
          notes.push(`${label} PreToolUse merge guard hook is configured.`);
          const hookList = parsed['gh-pr-merge-guard'].PreToolUse;
          let referencedScript: string | undefined;
          if (Array.isArray(hookList)) {
            for (const entry of hookList) {
              if (Array.isArray(entry.hooks)) {
                for (const h of entry.hooks) {
                  if (typeof h.command === 'string') {
                    const match = /node\s+"([^"]+)"|node\s+([^\s]+)/.exec(h.command);
                    if (match) referencedScript = match[1] ?? match[2];
                  }
                }
              }
            }
          }
          const actualScript = referencedScript ? resolve(isProject ? baseDir : baseDir, referencedScript) : scriptPath;
          if (!existsSync(actualScript)) {
            issues.push(`${label} merge-guard executable referenced in hooks.json does not exist: ${actualScript}`);
          }
        } else {
          issues.push(`${label} hooks.json missing gh-pr-merge-guard definition.`);
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
