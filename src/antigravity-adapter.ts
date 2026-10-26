import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeFilesystemPath } from './installation-receipt.ts';
import { createSuccessorReceipt, discoverReceiptChain, finalizeSuccessor, writePendingSuccessor, type ManagedFileEvidence } from './receipt-lineage.ts';
import { saveInstallation, type Ask } from './native-installer.ts';
import { loadRoleDefinitions } from './role-definitions.ts';
import { compileLeadOrchestrationRule, compileAntigravityHooks, compileAntigravityMcpConfig } from './antigravity-compiler.ts';
import { loadWorkflowCommands, compileWorkflowArtifacts, workflowCommandIds } from './workflow-commands.ts';
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
  commandsDir: string
): {
  targetConfig: string;
  filesToDeploy: Array<{ relativePath: string; absolutePath: string; content: string; kind: 'rules' | 'commands' | 'config' }>;
} {
  const roles = loadRoleDefinitions(agentsDir);
  const leadRule = compileLeadOrchestrationRule(roles);
  const hooksConfig = compileAntigravityHooks('scripts/antigravity-merge-guard.mjs');
  const mcpConfig = compileAntigravityMcpConfig();

  const filesToDeploy: Array<{ relativePath: string; absolutePath: string; content: string; kind: 'rules' | 'commands' | 'config' }> = [];

  let targetConfig: string;
  let baseDir: string;

  if (scope === 'project') {
    if (!projectRoot) throw new Error('Project scope requires a valid project root directory.');
    baseDir = projectRoot;
    targetConfig = join(projectRoot, '.agents', 'hooks.json');

    // 1. Lead rule
    filesToDeploy.push({
      relativePath: leadRule.path,
      absolutePath: join(projectRoot, leadRule.path),
      content: leadRule.content,
      kind: 'rules',
    });

    // 2. Workflow skills (all 6)
    for (const cmdId of workflowCommandIds) {
      const compiled = compileWorkflowArtifacts(commandsDir, ['antigravity'], {
        [cmdId]: cmdId === 'report-defect'
          ? { parent: 'issue-id', description: 'defect details' }
          : 'workflow instructions',
      });
      const art = compiled.artifacts.find(a => a.host === 'antigravity' && a.command === cmdId);
      if (art) {
        filesToDeploy.push({
          relativePath: art.relativePath,
          absolutePath: join(projectRoot, art.relativePath),
          content: art.content,
          kind: 'commands',
        });
      }
    }

    // 3. hooks.json
    filesToDeploy.push({
      relativePath: '.agents/hooks.json',
      absolutePath: join(projectRoot, '.agents', 'hooks.json'),
      content: JSON.stringify(hooksConfig, null, 2) + '\n',
      kind: 'config',
    });

    // 4. mcp_config.json
    filesToDeploy.push({
      relativePath: '.agents/mcp_config.json',
      absolutePath: join(projectRoot, '.agents', 'mcp_config.json'),
      content: JSON.stringify(mcpConfig, null, 2) + '\n',
      kind: 'config',
    });
  } else {
    // Global scope: ~/.gemini/config/
    baseDir = join(home, '.gemini', 'config');
    targetConfig = join(baseDir, 'hooks.json');

    // 1. Lead rule in global rules
    filesToDeploy.push({
      relativePath: 'rules/advanced-harness-lead.md',
      absolutePath: join(baseDir, 'rules', 'advanced-harness-lead.md'),
      content: leadRule.content,
      kind: 'rules',
    });

    // 2. hooks.json
    filesToDeploy.push({
      relativePath: 'hooks.json',
      absolutePath: join(baseDir, 'hooks.json'),
      content: JSON.stringify(hooksConfig, null, 2) + '\n',
      kind: 'config',
    });

    // 3. mcp_config.json
    filesToDeploy.push({
      relativePath: 'mcp_config.json',
      absolutePath: join(baseDir, 'mcp_config.json'),
      content: JSON.stringify(mcpConfig, null, 2) + '\n',
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

  const plan = planAntigravityDeployment(scope, project, home, agentsDir, commandsDir);

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

  const snapshot = discoverReceiptChain(backupParent, plan.targetConfig, 'antigravity');
  const targetInitial = existsSync(plan.targetConfig) ? readFileSync(plan.targetConfig, 'utf8') : undefined;

  const targetFileInPlan = plan.filesToDeploy.find(f => f.absolutePath === plan.targetConfig);
  const targetFinal = targetFileInPlan?.content ?? (targetInitial ?? '');

  const managedFiles: ManagedFileEvidence[] = [];

  for (const f of plan.filesToDeploy) {
    const current = existsSync(f.absolutePath) ? readFileSync(f.absolutePath, 'utf8') : undefined;
    managedFiles.push({
      path: f.absolutePath,
      kind: f.kind,
      before: current === undefined ? { absent: true } : { content: current },
      after: { content: f.content },
    });
  }

  const successor = createSuccessorReceipt(
    snapshot,
    targetInitial,
    targetFinal,
    {},
    undefined,
    { host: 'antigravity', managedFiles }
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

  let hookFound = false;

  // Check project-level
  if (project) {
    const hookPath = join(project, '.agents', 'hooks.json');
    if (existsSync(hookPath)) {
      hookFound = true;
      try {
        const text = readFileSync(hookPath, 'utf8');
        const parsed = JSON.parse(text);
        if (parsed['gh-pr-merge-guard']?.PreToolUse) {
          notes.push('Project PreToolUse merge guard hook is configured.');
        } else {
          issues.push('Project .agents/hooks.json missing gh-pr-merge-guard definition.');
        }
      } catch (err) {
        issues.push(`Malformed project .agents/hooks.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const leadRulePath = join(project, '.agents', 'rules', 'advanced-harness-lead.md');
    if (existsSync(leadRulePath)) {
      const size = readFileSync(leadRulePath).byteLength;
      if (size > 24000) {
        issues.push(`Lead rule exceeds 24KB limit (${size} bytes).`);
      } else {
        notes.push(`Project Lead orchestration rule is present (${size} bytes).`);
      }
    }

    const mcpPath = join(project, '.agents', 'mcp_config.json');
    if (existsSync(mcpPath)) {
      try {
        JSON.parse(readFileSync(mcpPath, 'utf8'));
        notes.push('Project mcp_config.json is valid JSON.');
      } catch (err) {
        issues.push(`Malformed project mcp_config.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Check global-level
  const globalHookPath = join(home, '.gemini', 'config', 'hooks.json');
  if (existsSync(globalHookPath)) {
    hookFound = true;
    try {
      const text = readFileSync(globalHookPath, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed['gh-pr-merge-guard']?.PreToolUse) {
        notes.push('Global PreToolUse merge guard hook is configured.');
      }
    } catch {
      // Ignored if project has it
    }
  }

  if (!hookFound) {
    notes.push('PreToolUse merge guard hook was not found in project or global locations.');
  }

  notes.push('Role/tool-group boundary enforcement is instruction-level in Antigravity rules.');
  notes.push('Interactive skill execution and hook enforcement are unverified until tested live in TUI.');

  return {
    ok: issues.length === 0,
    issues,
    notes,
  };
}
