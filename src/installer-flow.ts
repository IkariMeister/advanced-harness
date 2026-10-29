import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentDirectories, askAssignments, chooseConfiguration, configuredModels, discoverConfigurations, findMarkdownConflicts, loadNativeDefinitions, modelReference, nativeRoles, parseConfiguration, projectConfiguration, saveInstallation, updateNativeConfiguration, type Ask } from './native-installer.ts';
import { DiagnosticError, printReport, verifyRuntime } from './native-diagnostics.ts';
import { assertSafeFilesystemPath } from './installation-receipt.ts';
import { createSuccessorReceipt, discoverReceiptChain, finalizeSuccessor, receiptReconciliationOptions, recoverFailedSuccessor, revalidatePendingSuccessor, writePendingSuccessor } from './receipt-lineage.ts';
import type { ReconciliationResult } from './permission-reconciliation.ts';
import { formatVersionStamp, readSourceVersion, toVersionStamp, type Runner } from './harness-version.ts';

import { parseHostSelection, askHostSelection, HOST_CAPABILITIES, getHostAdapter, type HostId } from './host-registry.ts';
import { loadWorkflowCommands, planCommandDeployment, filterCommandPlanForExecution, applyCommandDeployment, preflightCommandDeployment, type CommandDeploymentPlan, type CommandFilePlan } from './command-deployment.ts';

export interface InstallerFlowOptions { scope?: string; project?: string; config?: string; opencode?: string; host?: string; context?: string }
export interface InstallerFlowDependencies {
  ask: Ask;
  output(message: string): void;
  error(message: string): void;
  cwd?: string;
  home?: string;
  xdgConfigHome?: string;
  recoveryDirectory?: string;
  agentsDirectory?: string;
  commandsDirectory?: string;
  harnessRoot?: string;
  environment?: NodeJS.ProcessEnv;
  runCommand?: Runner;
  loadDefinitions?: typeof loadNativeDefinitions;
  updateConfiguration?: typeof updateNativeConfiguration;
  save?: typeof saveInstallation;
  applyCommands?: typeof applyCommandDeployment;
  writePending?: typeof writePendingSuccessor;
  finalize?: typeof finalizeSuccessor;
  verify?: typeof verifyRuntime;
  printReport?: typeof printReport;
}

export async function runInstallerFlow(options: InstallerFlowOptions, deps: InstallerFlowDependencies): Promise<number> {
  const { ask } = deps;
  const output = deps.output;
  const errorOutput = deps.error;
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? homedir();
  const env = deps.environment ?? process.env;

  const selectedHosts: HostId[] = options.host ? parseHostSelection(options.host) : ['opencode'];

  let scope = options.scope;
  while (!scope || !['project', 'global'].includes(scope)) scope = (await ask('Install scope: project or global', 'project')) || 'project';
  if (scope === 'global' && options.project) throw new Error('--project cannot be combined with global scope.');
  const expand = (path: string) => path.replace(/^(?:~|\$HOME)(?=[/\\]|$)/, home);
  const project = scope === 'project' ? resolve(cwd, expand(options.project ?? ((await ask('Project directory', cwd)) || cwd))) : undefined;
  if (project && (!existsSync(project) || !statSync(project).isDirectory())) throw new Error('Project directory does not exist or is not a directory. Create/select it before installing.');

  // Hosts that require native adapter delegation or are blocked
  const supportedNativeHosts: HostId[] = ['opencode', 'antigravity', 'claude-code'];
  const unsupportedHosts = selectedHosts.filter(host => !supportedNativeHosts.includes(host));

  if (unsupportedHosts.length > 0 || selectedHosts.length > 1) {
    for (const host of unsupportedHosts) {
      const issue = host === 'codex' ? '#45' : '#46';
      errorOutput(`Installation blocked: ${HOST_CAPABILITIES[host].displayName} native deployment is not implemented; track integration in issue ${issue}. No host adapters or files were changed.`);
    }
    if (selectedHosts.length > 1 && unsupportedHosts.length === 0) {
      errorOutput('Multi-host simultaneous installation is not supported. Install each host deliberately.');
    }
    return 2;
  }

  if (options.context && !selectedHosts.includes('antigravity')) throw new Error('--context for model preferences is supported only with --host antigravity.');
  if (options.context && scope !== 'project') throw new Error('--context can be used only with project scope.');

  const harnessRoot = deps.harnessRoot ?? resolve(fileURLToPath(new URL('..', import.meta.url)));
  const stamp = toVersionStamp(readSourceVersion(harnessRoot, deps.runCommand));

  if (selectedHosts.includes('claude-code')) {
    const adapter = getHostAdapter('claude-code');
    if (!adapter) throw new Error('Claude Code host adapter is not registered.');
    const result = await adapter.install({
      scope: scope as 'project' | 'global',
      project,
      home,
      recoveryDirectory: deps.recoveryDirectory ?? env.ADVANCED_HARNESS_RECOVERY_DIR,
      agentsDirectory: deps.agentsDirectory,
      commandsDirectory: deps.commandsDirectory,
      harnessVersion: stamp,
      ask,
      output,
      error: errorOutput,
    });
    return typeof result === 'number' ? result : 0;
  }

  if (selectedHosts.includes('antigravity')) {
    const adapter = getHostAdapter('antigravity');
    if (!adapter) throw new Error('Antigravity host adapter is not registered.');
    const result = await adapter.install({
      scope: scope as 'project' | 'global',
      project,
      home,
      recoveryDirectory: deps.recoveryDirectory ?? env.ADVANCED_HARNESS_RECOVERY_DIR,
      agentsDirectory: deps.agentsDirectory,
      commandsDirectory: deps.commandsDirectory,
      context: options.context,
      harnessVersion: stamp,
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
  if (!['opencode.json', 'opencode.jsonc'].includes(basename(target)) || !allowedDirectories.some(sameDirectory)) throw new Error('--config must select opencode.json/jsonc inside the chosen project (or its .opencode folder), or the global OpenCode directory.');
  assertSafeFilesystemPath(target, 'file');
  const original = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  const backupParent = deps.recoveryDirectory ?? env.ADVANCED_HARNESS_RECOVERY_DIR ?? join(home, 'Projects', 'advanced-harness-backups');
  const history = discoverReceiptChain(backupParent, target, 'opencode');
  if (!sources.some(source => source.path === target) && original !== undefined) sources.push({ path: target, text: original, value: parseConfiguration(original, target) });
  const conflicts = findMarkdownConflicts(sources, target, globalDirectory, project);
  if (conflicts.length) throw new Error(`Existing named Markdown agents may override inline installation. Resolve intentionally, then rerun; no files were changed:\n${conflicts.join('\n')}`);
  const adapter = agentDirectories(sources, target, globalDirectory, project).some(directory => existsSync(join(directory, 'plugins', 'advanced-harness')));
  const configuredAdapter = sources.some(source => Array.isArray(source.value.plugins) && source.value.plugins.some(entry => {
    const name = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && 'package' in entry ? String(entry.package) : '';
    return /spike[/\\]opencode|advanced-harness-opencode-spike/i.test(name);
  }));
  if (adapter || configuredAdapter) throw new Error('Historical advanced-harness plugin detected. Disable/remove it intentionally before installing native agents; the installer will not delete it.');
  output(`\nScope: ${scope}\nTarget: ${target}`);
  output('Read configuration files (contents/credentials are not printed):');
  for (const source of sources) output(`  ${source.path}`);
  if (!sources.length) output('  None; a new configuration will be created.');
  if (env.OPENCODE_CONFIG_CONTENT || env.OPENCODE_CONFIG) output('Warning: environment config overrides may affect runtime behavior; they are not edited by this installer.');
  output('\nConfigured model IDs (not proof of account access):');
  const choices = configuredModels(sources);
  choices.forEach((model, index) => output(`  ${index + 1}. ${model}`));
  if (!choices.length) output('  None declared. Enter IDs verified in OpenCode /models.');
  output('Each role requires your choice. Enter a listed number or provider/model#variant; Enter accepts the shown suggestion.');
  output('Unknown account access/variants must be checked in /models. Spark previously failed with the tested ChatGPT account.');
  const definitions = (deps.loadDefinitions ?? loadNativeDefinitions)(deps.agentsDirectory ?? fileURLToPath(new URL('../agents/', import.meta.url)));
  const assignments = await askAssignments(definitions, sources, ask);
  const existingConfig = original === undefined ? {} : parseConfiguration(original, target);
  const existingAgents = existingConfig.agents && typeof existingConfig.agents === 'object' ? existingConfig.agents as Record<string, Record<string, unknown>> : {};
  const replaceModels = [] as typeof nativeRoles[number][];
  for (const role of nativeRoles) if (existingAgents[role]?.model !== undefined && /^(y|yes)$/i.test(await ask(`Replace existing ${role} model?`, 'no'))) replaceModels.push(role);
  const setDefault = /^(y|yes)$/i.test(await ask('Make Lead the default agent for new sessions?', 'no'));
  const setLeadModel = /^(y|yes)$/i.test(await ask('Also set the root default model to Lead? (otherwise preserve it)', 'no'));
  const reconciliation = receiptReconciliationOptions(history);
  reconciliation.replaceFields = {};
  for (const role of nativeRoles) for (const field of ['description', 'mode', 'system'] as const) {
    const current = existingAgents[role]?.[field];
    if (current !== undefined && current !== reconciliation.managedFields?.[role]?.[field] && /^(y|yes)$/i.test(await ask(`Replace customized/unattributed ${role} ${field} with the template?`, 'no'))) reconciliation.replaceFields[role] = [...(reconciliation.replaceFields[role] ?? []), field];
  }
  const plans: Partial<Record<typeof nativeRoles[number], ReconciliationResult>> = {};
  reconciliation.onPermissionPlan = (role, plan) => { plans[role] = plan; };
  const update = deps.updateConfiguration ?? updateNativeConfiguration;
  let updated = update(original ?? '{}\n', definitions, assignments, setDefault, setLeadModel, replaceModels, reconciliation);
  for (const role of nativeRoles) for (const obsolete of plans[role]?.preview.retainedObsolete ?? []) if (/^(y|yes)$/i.test(await ask(`Remove obsolete owned ${role} permission ${JSON.stringify(obsolete.rule)}?`, 'no'))) {
    const state = reconciliation.permissions![role]!;
    state.removeObsolete = [...(state.removeObsolete ?? []), obsolete.rule];
  }
  updated = update(original ?? '{}\n', definitions, assignments, setDefault, setLeadModel, replaceModels, reconciliation);

  // Workflow slash commands prompt and planning
  const commandsTargetDir = project ? join(project, '.opencode', 'commands') : join(globalDirectory, 'commands');
  const commandsSourceDir = deps.commandsDirectory ?? fileURLToPath(new URL('../.opencode/commands/', import.meta.url));
  const deployCommandsAnswer = (await ask('Install workflow slash commands (/start-issue, /review-pr, etc.)?', 'yes')).trim();
  const shouldDeployCommands = deployCommandsAnswer === '' || /^(y|yes)$/i.test(deployCommandsAnswer);

  const existingManagedFiles = history.head?.receipt.version === 2 && history.head.receipt.managedFiles ? history.head.receipt.managedFiles : [];

  let commandFilesToWrite: CommandFilePlan[] = [];
  let commandEvidence: ReturnType<typeof filterCommandPlanForExecution>['managedEvidence'] = [];
  let commandPlan: CommandDeploymentPlan | undefined;

  if (shouldDeployCommands) {
    const loadedCommands = loadWorkflowCommands(commandsSourceDir);
    commandPlan = planCommandDeployment(loadedCommands, commandsTargetDir, existingManagedFiles);
    let overwriteDiffers = false;
    if (commandPlan.hasDiffers) {
      const differingCount = commandPlan.files.filter(f => f.status === 'differs').length;
      const overwriteAnswer = (await ask(`Overwrite ${differingCount} customized/differing command file(s)?`, 'no')).trim();
      overwriteDiffers = /^(y|yes)$/i.test(overwriteAnswer);
    }
    const filtered = filterCommandPlanForExecution(commandPlan, overwriteDiffers);
    commandFilesToWrite = filtered.filesToWrite;
    commandEvidence = filtered.managedEvidence;
  }

  // Merge newly managed files with previous managed files, preserving original `before` baseline
  const combinedManagedFiles = structuredClone(existingManagedFiles);
  for (const ev of commandEvidence) {
    const existing = combinedManagedFiles.find(m => m.path === ev.path);
    if (existing) {
      // Preserve earliest before baseline across upgrades; update only latest after state
      existing.after = structuredClone(ev.after);
    } else {
      combinedManagedFiles.push(ev);
    }
  }

  const provenanceChanged = history.head?.receipt.version === 2 && nativeRoles.some(role => JSON.stringify(plans[role]?.provenance ?? []) !== JSON.stringify(history.head!.receipt.version === 2 ? history.head!.receipt.permissions.find(p => p.path[1] === role)?.owned ?? [] : []));
  const configChanged = updated !== (original ?? '{}\n');
  const commandsChanged = commandFilesToWrite.length > 0;
  const needsReceipt = configChanged || provenanceChanged || commandsChanged;
  const receipt = needsReceipt ? createSuccessorReceipt(history, original, updated, plans, stamp, { host: 'opencode', ...(combinedManagedFiles.length ? { managedFiles: combinedManagedFiles } : {}) }) : undefined;
  output('\nAssignments:');
  for (const role of nativeRoles) {
    const saved = parseConfiguration(updated, target).agents as Record<string, Record<string, unknown>>;
    output(`  ${role}: ${modelReference(saved[role]?.model) ?? '(invalid saved model)'}`);
    output(`  Permission preview: ${JSON.stringify(plans[role]?.preview)}`);
  }
  const value = original === undefined ? {} : parseConfiguration(original, target);
  const existing = value.agents as Record<string, unknown> | undefined;
  const collisions = nativeRoles.filter(role => existing && Object.hasOwn(existing, role));
  if (collisions.length) output(`Existing roles updated: ${collisions.join(', ')}. Models/custom fields are preserved unless individually selected; unchanged attributable fields are refreshed. Permissions are reconciled as previewed.`);
  output('Preserved hidden/disabled flags, ancestor definitions, and runtime overrides may affect discovery. Verify effective agents after installation.');
  output(`Default agent: ${setDefault ? 'set to lead' : 'preserved'}; root default model: ${setLeadModel ? assignments.lead.split('#')[0] : 'preserved'}.`);
  if (shouldDeployCommands && commandPlan) {
    output(`Workflow commands target: ${commandsTargetDir}`);
    for (const f of commandPlan.files) {
      const willWrite = commandFilesToWrite.some(w => w.filename === f.filename);
      output(`  ${f.filename}: ${f.status}${f.status === 'outdated' ? ' (update)' : willWrite && f.status === 'differs' ? ' (overwrite)' : (!willWrite && f.status === 'differs' ? ' (preserved)' : '')}`);
    }
  } else {
    output('Workflow commands: skipped.');
  }
  output('Providers, credentials, MCP servers, plugins, and unrelated agents/settings will not be changed.');
  output('Assignments are stored inline in agents; no plugin or separate approval host is installed.');
  if (original !== undefined && configChanged) output(`A private configuration backup will be created under ${backupParent}. It may contain existing secrets; keep it local.`);
  output('After writing, runtime verification may start the OpenCode service. It will not restart/reload it or send paid model requests.');
  output(`Harness version: ${formatVersionStamp(stamp)}`);
  if (await ask('Type install to apply these changes', 'cancel') !== 'install') { output('Cancelled. No files were changed.'); return 0; }
  if (!receipt && !configChanged && !commandsChanged) { output('Configuration and workflow commands already match; no configuration, backup, or receipt writes are needed.'); return 0; }
  const pending = (deps.writePending ?? writePendingSuccessor)(history, receipt!);
  const receiptPath = pending.path;
  let backup: string | undefined;
  try {
    revalidatePendingSuccessor(pending);
    if (commandFilesToWrite.length > 0) {
      preflightCommandDeployment(commandFilesToWrite, commandsTargetDir);
    }
    if (configChanged) {
      backup = (deps.save ?? saveInstallation)(target, original, updated, backupParent);
    }
    if (commandFilesToWrite.length > 0) {
      (deps.applyCommands ?? applyCommandDeployment)(commandFilesToWrite, commandsTargetDir);
    }
  }
  catch (err) {
    // Check if any command files or config actually changed
    const configMatchesOriginal = (existsSync(target) ? readFileSync(target, 'utf8') : undefined) === original;
    const commandFilesUnchanged = commandFilesToWrite.every(f => {
      const exists = existsSync(f.targetPath);
      if (f.status === 'new') return !exists;
      if (f.status === 'differs' || f.status === 'outdated') return exists && readFileSync(f.targetPath, 'utf8') === f.currentContent;
      return true;
    });

    if (configMatchesOriginal && commandFilesUnchanged) {
      recoverFailedSuccessor(pending, original);
    } else {
      errorOutput(`Configuration or command writes may have partially succeeded; pending recovery evidence retained at ${receiptPath}.`);
    }
    throw err;
  }
  const finalText = existsSync(target) ? readFileSync(target, 'utf8') : updated;
  try { (deps.finalize ?? finalizeSuccessor)(pending, updated); }
  catch (err) { errorOutput(`Configuration saved but receipt finalization failed; pending evidence retained at ${receiptPath}. Resolve recovery before any further update or restore.`); throw err; }
  if (configChanged) output(`Configuration written (runtime not yet verified): ${target}`);
  if (commandFilesToWrite.length > 0) output(`Workflow commands deployed: ${commandsTargetDir}`);
  if (backup) output(`Backup: ${backup}`);
  output(`Private uninstall receipt retained at ${receiptPath}`);
  const directory = project ?? cwd;
  try {
    const saved = parseConfiguration(finalText, target);
    const savedAgents = saved.agents as Record<string, Record<string, unknown>>;
    const intended = Object.fromEntries(nativeRoles.map(role => {
      const actual = modelReference(savedAgents[role]?.model);
      if (!actual) throw new Error(`Saved model assignment for ${role} is invalid.`);
      return [role, { ...definitions[role], model: actual }];
    }));
    const report = await (deps.verify ?? verifyRuntime)({ directory, ...(options.opencode ? { executable: options.opencode } : {}) }, intended);
    (deps.printReport ?? printReport)(report);
    if (!report.ok) return 1;
  } catch (err) {
    if (err instanceof DiagnosticError) errorOutput(err.message);
    errorOutput('Configuration saved, but runtime verification is inconclusive. Run npm run harness:doctor; check CLI path/service. No rollback or model substitution was performed.');
    return 2;
  }
  output('Existing session models are unchanged; explicitly verify the assigned Lead model/variant in the new session.');
  output('Model access, MCP authentication, project commands, and approval behavior have NOT been runtime-validated.');
  return 0;
}
