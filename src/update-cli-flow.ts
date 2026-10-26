import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agentDirectories,
  chooseConfiguration,
  discoverConfigurations,
  findMarkdownConflicts,
  loadNativeDefinitions,
  nativeRoles,
  parseConfiguration,
  projectConfiguration,
  saveInstallation,
  updateNativeConfiguration,
  type Ask
} from './native-installer.ts';
import { DiagnosticError, printReport, verifyRuntime } from './native-diagnostics.ts';
import { assertSafeFilesystemPath } from './installation-receipt.ts';
import {
  createSuccessorReceipt,
  discoverReceiptChain,
  finalizeSuccessor,
  receiptReconciliationOptions,
  recoverFailedSuccessor,
  revalidatePendingSuccessor,
  writePendingSuccessor
} from './receipt-lineage.ts';
import { checkRemoteHead, compareInstalledAndSource, readSourceVersion, type Runner } from './harness-version.ts';
import { planUpdate } from './update-planner.ts';
import type { ReconciliationResult } from './permission-reconciliation.ts';
import {
  applyOpenCodeCommandDeployment,
  buildOpenCodeCommandManagedEvidence,
  planOpenCodeCommandDeployment,
  preflightOpenCodeCommandDeployment,
  type WorkflowCommandId
} from './workflow-commands.ts';
import { formatClaudePermissionPreflight, preflightClaudePermissions } from './claude-permission-preflight.ts';
import { loadRoleDefinitions } from './role-definitions.ts';
import { parseHostSelection, askHostSelection, HOST_CAPABILITIES, getHostAdapter, type HostId } from './host-registry.ts';

export interface UpdateFlowOptions {
  scope?: string;
  project?: string;
  config?: string;
  opencode?: string;
  checkRemote?: boolean;
  host?: string;
}

export interface UpdateFlowDependencies {
  ask: Ask;
  output(message: string): void;
  error(message: string): void;
  cwd?: string;
  home?: string;
  xdgConfigHome?: string;
  recoveryDirectory?: string;
  agentsDirectory?: string;
  workflowCommandsDirectory?: string;
  applyWorkflowCommands?: typeof applyOpenCodeCommandDeployment;
  harnessRoot?: string;
  environment?: NodeJS.ProcessEnv;
  runCommand?: Runner;
  loadDefinitions?: typeof loadNativeDefinitions;
  updateConfiguration?: typeof updateNativeConfiguration;
  save?: typeof saveInstallation;
  writePending?: typeof writePendingSuccessor;
  finalize?: typeof finalizeSuccessor;
  verify?: typeof verifyRuntime;
  printReport?: typeof printReport;
}

export async function runUpdateFlow(options: UpdateFlowOptions, deps: UpdateFlowDependencies): Promise<number> {
  const { ask, output, error: errorOutput } = deps;
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? homedir();
  const env = deps.environment ?? process.env;
  const harnessRoot = deps.harnessRoot ?? resolve(fileURLToPath(new URL('..', import.meta.url)));

  const selectedHosts: HostId[] = options.host ? parseHostSelection(options.host) : ['opencode'];

  let scope = options.scope;
  while (!scope || !['project', 'global'].includes(scope)) {
    scope = (await ask('Update scope: project or global', 'project')) || 'project';
  }
  if (scope === 'global' && options.project) {
    throw new Error('--project cannot be combined with global scope.');
  }

  const expand = (path: string) => path.replace(/^(?:~|\$HOME)(?=[/\\]|$)/, home);
  const project = scope === 'project' ? resolve(cwd, expand(options.project ?? ((await ask('Project directory', cwd)) || cwd))) : undefined;
  if (project && (!existsSync(project) || !statSync(project).isDirectory())) {
    throw new Error('Project directory does not exist or is not a directory. Select a valid directory before updating.');
  }

  const supportedNativeHosts: HostId[] = ['opencode', 'antigravity'];
  const unsupportedHosts = selectedHosts.filter(host => !supportedNativeHosts.includes(host));

  if (unsupportedHosts.length > 0 || selectedHosts.length > 1) {
    for (const host of selectedHosts.filter(host => host !== 'opencode' && host !== 'antigravity')) {
      const issue = host === 'claude-code' ? '#43' : host === 'codex' ? '#45' : '#46';
      errorOutput(`Update blocked: ${HOST_CAPABILITIES[host].displayName} native deployment is not implemented; track integration in issue ${issue}. No host adapters or files were changed.`);
    }
    if (selectedHosts.length > 1 && unsupportedHosts.length === 0) {
      errorOutput('Multi-host simultaneous update is not supported. Update each host deliberately.');
    }
    if (selectedHosts.includes('claude-code')) {
      const definitions = loadRoleDefinitions(deps.agentsDirectory ?? join(harnessRoot, 'agents'));
      const report = preflightClaudePermissions(definitions);
      for (const line of formatClaudePermissionPreflight(report)) errorOutput(line);
    }
    return 2;
  }

  if (selectedHosts.includes('antigravity')) {
    const adapter = getHostAdapter('antigravity');
    if (!adapter || !adapter.update) throw new Error('Antigravity host adapter update is not available.');
    const result = await adapter.update({
      scope: scope as 'project' | 'global',
      project,
      home,
      recoveryDirectory: deps.recoveryDirectory ?? env.ADVANCED_HARNESS_RECOVERY_DIR,
      agentsDirectory: deps.agentsDirectory,
      commandsDirectory: deps.workflowCommandsDirectory,
      ask,
      output,
      error: errorOutput,
    });
    return typeof result === 'number' ? result : 0;
  }

  const globalDirectory = resolve(join(deps.xdgConfigHome ?? env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode'));
  const sources = discoverConfigurations(project, globalDirectory);
  const target = options.config ? resolve(cwd, expand(options.config)) : project ? projectConfiguration(project, sources) : chooseConfiguration(globalDirectory);

  const allowedDirectories = project ? [project, join(project, '.opencode')] : [resolve(globalDirectory)];
  const sameDirectory = (directory: string) => process.platform === 'win32' ? directory.toLowerCase() === dirname(target).toLowerCase() : directory === dirname(target);
  if (!['opencode.json', 'opencode.jsonc'].includes(basename(target)) || !allowedDirectories.some(sameDirectory)) {
    throw new Error('--config must select opencode.json/jsonc inside the chosen project (or its .opencode folder), or the global OpenCode directory.');
  }

  assertSafeFilesystemPath(target, 'file');
  if (!existsSync(target)) {
    throw new Error(`Target configuration file not found: ${target}. Run harness:install first.`);
  }

  const original = readFileSync(target, 'utf8');
  const backupParent = deps.recoveryDirectory ?? env.ADVANCED_HARNESS_RECOVERY_DIR ?? join(home, 'Projects', 'advanced-harness-backups');
  const history = discoverReceiptChain(backupParent, target, 'opencode');

  if (!sources.some(source => source.path === target)) {
    sources.push({ path: target, text: original, value: parseConfiguration(original, target) });
  }

  const conflicts = findMarkdownConflicts(sources, target, globalDirectory, project);
  if (conflicts.length) {
    throw new Error(`Existing named Markdown agents may override inline installation. Resolve intentionally, then rerun; no files were changed:\n${conflicts.join('\n')}`);
  }

  const sourceVersion = readSourceVersion(harnessRoot, deps.runCommand);
  const installedStamp = history.head?.receipt.version === 2 ? history.head.receipt.harnessVersion : undefined;
  const versionComparison = compareInstalledAndSource(installedStamp, sourceVersion);

  output('Harness Version Discovery:');
  output(`  Harness checkout: ${sourceVersion.version} (${sourceVersion.commit})${sourceVersion.dirty ? ' [dirty local changes]' : ''}`);
  if (installedStamp) {
    output(`  Installed version: ${installedStamp.version} (${installedStamp.commit})`);
  } else {
    output('  Installed version: unknown (legacy or unversioned receipt)');
  }
  output(`  Local status: ${versionComparison}`);

  let checkRemote = options.checkRemote;
  if (checkRemote === undefined) {
    const answer = await ask('Check remote repository for newer versions on origin/main? (read-only git ls-remote)', 'no');
    checkRemote = /^(y|yes)$/i.test(answer.trim());
  }

  if (checkRemote) {
    output('Checking remote origin/main...');
    const remote = checkRemoteHead(harnessRoot, deps.runCommand);
    output(`  Remote status: ${remote.status}${remote.remoteHead ? ` (origin/main: ${remote.remoteHead})` : ''}`);
    if (remote.status === 'remote-newer') {
      output('\nNOTICE: A newer version of the harness is available on origin/main.');
      output('The harness update workflow is report/preview-only and does not automatically modify your repository.');
      output('To update your harness checkout, run:');
      output('  git pull origin main');
      output('Then rerun npm run harness:update to preview and apply changes.\n');
    }
  }

  const definitions = (deps.loadDefinitions ?? loadNativeDefinitions)(
    deps.agentsDirectory ?? fileURLToPath(new URL('../agents/', import.meta.url))
  );

  const existingConfig = parseConfiguration(original, target);
  const plan = planUpdate(existingConfig, definitions, history);

  if (plan.migrationNotes.length) {
    output('\nMigration implications:');
    for (const note of plan.migrationNotes) {
      output(`  - ${note}`);
    }
  }

  output('\nRole Inspection & Update Preview:');
  const updatePrompts: typeof nativeRoles[number][] = [];

  for (const role of nativeRoles) {
    const r = plan.roles[role];
    output(`\n[${role}] status: ${r.status}`);
    if (r.preservedFields.model) {
      output(`  Model: ${r.preservedFields.model} (preserved)`);
    }
    if (r.preservedFields.customFields.length) {
      output(`  Custom fields preserved: ${r.preservedFields.customFields.join(', ')}`);
    }

    if (r.status === 'not-installed') {
      output(`  Role is missing from configuration. Will be added with template system prompt.`);
      updatePrompts.push(role);
    } else if (r.status === 'prompt-changed' || r.status === 'both-changed') {
      output('  System prompt differences (installed vs template):');
      if (r.diffLines) {
        for (const line of r.diffLines) {
          output(`    ${line}`);
        }
      }
      const answer = await ask(`Update ${role} system prompt to latest source template? (Enter/no keeps installed)`, 'no');
      if (/^(y|yes)$/i.test(answer.trim())) {
        updatePrompts.push(role);
      } else {
        output(`  Keeping installed ${role} system prompt.`);
      }
    } else if (r.status === 'description-changed') {
      output(`  Description updated from "${r.installedDescription}" to "${r.sourceDescription}".`);
    } else {
      output('  No template changes.');
    }

    const p = plan.plans[role];
    if (p && (p.preview.additions.length || p.preview.removals.length || p.preview.retainedObsolete.length || r.status === 'not-installed')) {
      output('  Permission reconciliation:');
      if (r.status === 'not-installed') {
        for (const rule of p.rules) output(`    + ${JSON.stringify(rule)}`);
      } else {
        for (const rule of p.preview.additions) output(`    + ${JSON.stringify(rule)}`);
      }
      for (const rule of p.preview.removals) output(`    - ${JSON.stringify(rule)}`);
      for (const rule of p.preview.retainedObsolete) output(`    = retained obsolete ${JSON.stringify(rule)}`);
    }
  }

  output('\nFinal permission rule order from the saved-configuration plan:');
  for (const role of nativeRoles) {
    const rules = plan.plans[role]?.rules;
    if (!rules) continue;
    output(`  [${role}]`);
    for (const rule of rules) output(`    ${JSON.stringify(rule)}`);
  }

  // Set up reconciliation options and update config
  const reconciliation = receiptReconciliationOptions(history);
  reconciliation.managedFields = {};
  reconciliation.replaceFields = {};
  for (const role of nativeRoles) {
    if (updatePrompts.includes(role)) {
      reconciliation.replaceFields[role] = ['system'];
    }
  }

  const reconciliationPlans: Partial<Record<typeof nativeRoles[number], ReconciliationResult>> = {};
  reconciliation.onPermissionPlan = (role, p) => {
    reconciliationPlans[role] = p;
  };

  const existingAgents = existingConfig.agents && typeof existingConfig.agents === 'object'
    ? existingConfig.agents as Record<string, Record<string, unknown>>
    : {};

  // Build assignments preserving installed models
  const assignments = Object.fromEntries(
    nativeRoles.map(role => [
      role,
      (existingAgents[role]?.model && typeof existingAgents[role]?.model === 'string'
        ? existingAgents[role]?.model
        : definitions[role].model) as string
    ])
  ) as Record<typeof nativeRoles[number], string>;

  const update = deps.updateConfiguration ?? updateNativeConfiguration;
  const updated = update(
    original,
    definitions,
    assignments,
    false,
    false,
    [],
    reconciliation
  );

  const existingManagedFiles = history.head?.receipt.version === 2 && history.head.receipt.managedFiles
    ? history.head.receipt.managedFiles
    : [];

  const commandSource = deps.workflowCommandsDirectory ?? join(harnessRoot, 'commands');
  const commandDirectory = join(project ?? globalDirectory, project ? '.opencode' : '', 'commands');
  const commandPlan = planOpenCodeCommandDeployment(commandSource, commandDirectory, existingManagedFiles);
  const commandSelections: WorkflowCommandId[] = [];
  output('\nWorkflow command update preview:');
  for (const item of commandPlan) {
    output(`  ${item.id}: ${item.status}${item.status === 'customized' ? ' (preserved unless explicitly replaced)' : ''}`);
    if (item.status === 'missing' || item.status === 'outdated') {
      commandSelections.push(item.id);
    } else if (
      item.status === 'customized' &&
      /^(y|yes)$/i.test(await ask(`Replace customized workflow command ${item.id}?`, 'no'))
    ) {
      commandSelections.push(item.id);
    }
  }

  output('\nSummary of Planned Updates:');
  output(`  Roles updating prompt: ${updatePrompts.length ? updatePrompts.join(', ') : 'none'}`);
  output(`  Configuration file: ${target}`);
  output(`  Private backup will be created under: ${backupParent}`);
  output(`  Recovery: If update fails or is rejected, restore via existing receipt restore chain.`);

  const confirm = await ask('Type update to apply these changes', 'cancel');
  if (confirm.trim() !== 'update') {
    output('Update cancelled. No files or receipts were modified.');
    return 0;
  }

  const harnessVersionStamp = {
    version: sourceVersion.version,
    commit: sourceVersion.commit,
    ...(sourceVersion.dirty ? { dirty: true } : {})
  };

  const combinedManagedFiles = buildOpenCodeCommandManagedEvidence(
    commandPlan,
    commandSelections,
    existingManagedFiles
  );

  const successor = createSuccessorReceipt(
    history,
    original,
    updated,
    reconciliationPlans,
    harnessVersionStamp,
    {
      host: 'opencode',
      ...(combinedManagedFiles.length ? { managedFiles: combinedManagedFiles } : {})
    }
  );

  const pending = (deps.writePending ?? writePendingSuccessor)(history, successor);
  const receiptPath = pending.path;
  let backup: string | undefined;

  const configChanged = updated !== original;
  const selectedCommandItems = commandPlan.filter(
    item => commandSelections.includes(item.id) && item.status !== 'current'
  );

  try {
    revalidatePendingSuccessor(pending);
    if (selectedCommandItems.length > 0) {
      preflightOpenCodeCommandDeployment(commandPlan, commandSelections);
    }
    if (configChanged) {
      backup = (deps.save ?? saveInstallation)(target, original, updated, backupParent);
    }
    if (selectedCommandItems.length > 0) {
      (deps.applyWorkflowCommands ?? applyOpenCodeCommandDeployment)(
        commandPlan,
        commandSelections,
        backupParent,
        (path, commandBackup) => {
          output(`Workflow command updated: ${path}`);
          if (commandBackup) output(`Workflow command backup: ${commandBackup}`);
        }
      );
    }
  } catch (err) {
    const configMatchesOriginal = (existsSync(target) ? readFileSync(target, 'utf8') : undefined) === original;
    const commandFilesUnchanged = selectedCommandItems.every(item => {
      const exists = existsSync(item.target);
      if (item.current === undefined) return !exists;
      return exists && readFileSync(item.target, 'utf8') === item.current;
    });

    if (configMatchesOriginal && commandFilesUnchanged) {
      recoverFailedSuccessor(pending, original);
    } else {
      errorOutput(
        `Configuration or command writes may have partially succeeded; pending recovery evidence retained at ${receiptPath}.`
      );
    }
    throw err;
  }

  const finalText = existsSync(target) ? readFileSync(target, 'utf8') : updated;
  try {
    (deps.finalize ?? finalizeSuccessor)(pending, updated);
  } catch (err) {
    errorOutput(`Configuration saved but receipt finalization failed; pending evidence retained at ${receiptPath}. Resolve recovery before further update or restore.`);
    throw err;
  }

  if (configChanged) {
    output(`\nConfiguration updated: ${target}`);
  }
  if (backup) {
    output(`Backup created: ${backup}`);
  }
  output(`Successor receipt finalized at: ${receiptPath}`);

  // Runtime diagnostic verification
  const directory = project ?? cwd;
  try {
    const saved = parseConfiguration(finalText, target);
    const savedAgents = saved.agents as Record<string, Record<string, unknown>>;
    const intended = Object.fromEntries(
      nativeRoles.map(role => {
        const actual = savedAgents[role]?.model;
        return [role, { ...definitions[role], model: typeof actual === 'string' ? actual : definitions[role].model }];
      })
    );
    const report = await (deps.verify ?? verifyRuntime)({ directory, ...(options.opencode ? { executable: options.opencode } : {}) }, intended);
    (deps.printReport ?? printReport)(report);
    if (!report.ok) return 1;
  } catch (err) {
    if (err instanceof DiagnosticError) errorOutput(err.message);
    errorOutput('Configuration saved, but runtime verification was inconclusive. Run npm run harness:doctor.');
    return 2;
  }

  output('Harness update complete.');
  return 0;
}
