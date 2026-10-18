import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { chooseConfiguration, discoverConfigurations, findMarkdownConflicts, nativeRoles, parseConfiguration, type Ask, type NativeRole } from './native-installer.ts';
import { createReceipt } from './installation-receipt.ts';
import { createSuccessorReceipt, discoverReceiptChain, finalizeSuccessor, receiptReconciliationOptions, recoverFailedSuccessor, revalidatePendingSuccessor, revalidateReceiptSnapshot, writePendingSuccessor, type ReceiptSnapshot, type V2Receipt } from './receipt-lineage.ts';
import type { ReconciliationResult } from './permission-reconciliation.ts';
import { saveSetup, type SetupFile } from './project-setup.ts';
import { configuredServers, updateConnectionConfig } from './integration-setup.ts';
import { askGlobalIntegrations, askProjectIntegrations, checkSelectedIntegrations, emptyGlobalIntegrations, legacyIntegrationContext, optionalDiscoveryPrompt, parseGlobalIntegrations, selectedMcp, validateProjectIntegrations, type GlobalIntegrations, type ProjectIntegrations } from './integration-context.ts';
import { contextData, contextPath, prepareContextFiles, readContext, updateContext } from './project-context.ts';
import { DiagnosticError } from './native-diagnostics.ts';

import { parseHostSelection, askHostSelection, type HostId } from './host-registry.ts';

export interface IntegrationFlowOptions { scope?: string; project?: string; context?: string; config?: string; check?: boolean; opencode?: string; server?: string; host?: string | undefined }
export interface IntegrationFlowDependencies {
  ask: Ask; output(message: string): void; error(message: string): void;
  cwd?: string; home?: string; xdgConfigHome?: string; recoveryDirectory?: string; environment?: NodeJS.ProcessEnv;
  save?: typeof saveSetup; writePending?: typeof writePendingSuccessor; finalize?: typeof finalizeSuccessor;
  check?: typeof checkSelectedIntegrations;
}
export async function runIntegrationFlow(options: IntegrationFlowOptions, deps: IntegrationFlowDependencies): Promise<number> {
  const { ask } = deps; const output = deps.output; const errorOutput = deps.error;
  const cwd = deps.cwd ?? process.cwd(); const home = deps.home ?? homedir(); const env = deps.environment ?? process.env;
  let scope = options.scope ?? (options.project ? 'project' : undefined); const check = options.check ?? false;
  while (!scope || !['global', 'project'].includes(scope)) scope = (await ask('Configuration scope: global or project', 'global')).trim() || 'global';
  if (scope === 'global' && (options.context || (!check && options.project))) throw new Error('Global setup does not take project/context settings. Use project scope separately.');
  if (options.config && (scope !== 'global' || check)) throw new Error('--config selects only a global setup target.');
  const host: HostId = options.host ? parseHostSelection(options.host)[0]! : 'opencode';
  const global = resolve(join(deps.xdgConfigHome ?? env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode'));
  const preferencesPath = join(global, 'harness.integrations.json');
  const originalPreferences = existsSync(preferencesPath) ? readFileSync(preferencesPath, 'utf8') : undefined;
  const defaults = originalPreferences === undefined ? emptyGlobalIntegrations() : parseGlobalIntegrations(originalPreferences);
  let root = cwd;
  if (scope === 'project' || (check && options.project)) {
    const selectedRoot = options.project ?? ((await ask('Application Git checkout root', root)) || root);
    root = resolve(cwd, selectedRoot.replace(/^(?:~|\$HOME)(?=[/\\]|$)/, home));
  }
  if (!lstatSync(root).isDirectory() || (scope === 'project' && !existsSync(join(root, '.git')))) throw new Error('Select an existing project Git checkout root.');
  let settings: GlobalIntegrations | ProjectIntegrations = defaults;
  let files: SetupFile[] = []; let history: ReceiptSnapshot | undefined;
  let receiptWrite: { receipt: V2Receipt; file: SetupFile } | undefined;
  const recoveryDirectory = deps.recoveryDirectory ?? env.ADVANCED_HARNESS_RECOVERY_DIR ?? join(home, 'Projects', 'advanced-harness-backups');
  if (scope === 'global' && !check) {
    const target = options.config ? resolve(cwd, options.config.replace(/^(?:~|\$HOME)(?=[/\\]|$)/, home)) : chooseConfiguration(global);
    const same = process.platform === 'win32' ? dirname(target).toLowerCase() === global.toLowerCase() : dirname(target) === global;
    if (!same || !['opencode.json', 'opencode.jsonc'].includes(basename(target))) throw new Error('--config must select global opencode.json/jsonc.');
    const sources = discoverConfigurations(undefined, global); const original = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    if (original !== undefined && !sources.some(source => source.path === target)) sources.push({ path: target, text: original, value: parseConfiguration(original, target) });
    const servers = configuredServers(sources); output('Global MCP aliases (no endpoints/settings/credentials printed):');
    Object.keys(servers).sort().forEach((name, index) => output(`  ${index + 1}. ${name} (${servers[name]!.disabled === true ? 'disabled' : 'runtime unverified'})`));
    output('Each integration may be none. New entries are disabled remote OAuth servers; no connections will be attempted. No repository/Jira project data belongs in global preferences.');
    const draft = await askGlobalIntegrations(servers, defaults, ask); settings = draft.settings;
    if ((draft.choices.length || settings.github?.backend === 'gh') && findMarkdownConflicts(sources, target, global).length) throw new Error('Resolve competing global named Markdown agent definitions before writing role permissions.');
    const active = draft.choices.length > 0 || settings.github?.backend === 'gh'; history = active ? discoverReceiptChain(recoveryDirectory, target, host) : undefined;
    const reconciliation = history ? receiptReconciliationOptions(history) : {};
    const plans: Partial<Record<NativeRole, ReconciliationResult>> = {}; reconciliation.onPermissionPlan = (role, plan) => { plans[role] = plan; };
    let updated = updateConnectionConfig(original ?? '{}\n', sources, draft.choices, settings.github?.backend === 'gh', reconciliation);
    for (const role of nativeRoles) for (const obsolete of plans[role]?.preview.retainedObsolete ?? []) if (/^(y|yes)$/i.test(await ask(`Remove obsolete owned ${role} permission ${JSON.stringify(obsolete.rule)}?`, 'no'))) {
      const state = reconciliation.permissions![role]!; state.removeObsolete = [...(state.removeObsolete ?? []), obsolete.rule];
    }
    if (active) updated = updateConnectionConfig(original ?? '{}\n', sources, draft.choices, settings.github?.backend === 'gh', reconciliation);
    for (const role of nativeRoles) if (plans[role]) output(`${role} permission preview: ${JSON.stringify(plans[role]!.preview)}`);
    const predecessor = history?.head?.receipt;
    const provenanceChanged = predecessor?.version === 2 && nativeRoles.some(role => plans[role] && JSON.stringify(plans[role]!.provenance) !== JSON.stringify(predecessor.permissions.find(p => p.path[1] === role)?.owned ?? []));
    if (history && (createReceipt(target, original, updated).changes.length || provenanceChanged)) receiptWrite = { receipt: createSuccessorReceipt(history, original, updated, plans, undefined, { host }), file: { path: target, original, updated } };
    if (updated !== (original ?? '{}\n')) files.push({ path: target, original, updated });
    const updatedPreferences = JSON.stringify(settings, null, 2) + '\n';
    if (updatedPreferences !== originalPreferences) files.push({ path: preferencesPath, original: originalPreferences, updated: updatedPreferences });
    for (const server of draft.choices) output(`${server.name}: ${server.create ? `new disabled endpoint ${server.create.url}` : 'reuse unchanged'}`);
    output('Selected MCP actions: External ASK; other seven harness roles DENY. Permission additions/removals and final order are shown above. Unknown restrictions are preserved or cause a no-write conflict. None does not remove old connections/grants.');
  } else if (scope === 'project') {
    const target = contextPath(root, options.context); const original = readContext(target); const embedded = contextData(original, 'integrations');
    let previous = embedded === undefined ? undefined : validateProjectIntegrations(embedded);
    if (!check) {
      const legacy = join(root, '.opencode', 'harness.integrations.json');
      if (!previous && existsSync(legacy)) { output(`Legacy profile detected: ${legacy}. It will not be edited/deleted.`); if ((await ask('Type migrate to use legacy integration choices as context suggestions', 'no')) === 'migrate') previous = legacyIntegrationContext(readFileSync(legacy, 'utf8')); }
      const servers = configuredServers(discoverConfigurations(root, global)); output('Available aliases (new connections must be configured globally first):');
      Object.keys(servers).sort().forEach((name, index) => output(`  ${index + 1}. ${name}`));
      settings = await askProjectIntegrations(servers, defaults, previous, ask);
      const updated = updateContext(original, 'integrations', settings, [
        'These embedded settings are the project context source; legacy .opencode/harness.integrations.json files are not loaded automatically.',
        'These are project selections and identifiers, not credentials or connection definitions. Reusable connections and permissions live in global OpenCode configuration.',
        'Each integration may be none. Ask about an absent integration only when a task needs it; never silently enable or substitute a service.',
        'Only External owns services/GitHub CLI. Status mappings and access are unverified; read-only checks, lifecycle writes, and publishing require appropriate conversational approval. Human merge remains separate.',
      ]); files = prepareContextFiles(root, target, original, updated);
    } else { if (!previous) throw new Error('No integration settings in the selected project context. Run project scope first; legacy files are not loaded automatically.'); settings = previous; }
  }
  if (!check) {
    output(`\nReview ${scope} settings (no credentials):\n${JSON.stringify(settings, null, 2)}`); output('Files to write:');
    for (const file of files) output(`  ${file.path}${file.original === undefined ? ' (new)' : ' (backup first)'}`);
    if (scope === 'project') output('Only the selected marked context section (and AGENTS.md reference if needed) changes. No project OpenCode config/profile files are created.');
    output('No service calls, OAuth, credential changes, publishing, or legacy-file deletion. Keep backups private; preview Git status before publishing.');
    if ((await ask('Type integrations to save, or anything else to cancel', 'cancel')) !== 'integrations') { output('Cancelled. No files or connections changed.'); return 0; }
    if (history) revalidateReceiptSnapshot(history);
    const pending = receiptWrite && history ? (deps.writePending ?? writePendingSuccessor)(history, receiptWrite.receipt) : undefined;
    let backups: ReturnType<typeof saveSetup>;
    try { if (pending) revalidatePendingSuccessor(pending); backups = (deps.save ?? saveSetup)(files, recoveryDirectory); }
    catch (err) {
      if (pending && receiptWrite && recoverFailedSuccessor(pending, receiptWrite.file.original) !== 'cleared') errorOutput(`Integration save may be partial; pending recovery evidence retained at ${pending.path}.`);
      throw err;
    }
    if (pending && receiptWrite) {
      try { (deps.finalize ?? finalizeSuccessor)(pending, receiptWrite.file.updated); }
      catch (err) { errorOutput(`Settings saved but receipt finalization failed; pending evidence retained at ${pending.path}.`); throw err; }
      output(`Private cumulative permission receipt: ${pending.path}`);
    }
    for (const backup of backups) if (backup) output(`Private backup: ${backup}`);
    output(`${scope} integration settings saved. New servers remain disabled. Approve connections separately; sign in via /mcps.`); output(optionalDiscoveryPrompt(settings));
    return 0;
  } else {
    const selected = selectedMcp(settings);
    if (!selected.length && !settings.github) output('No integrations selected. No runtime checks or connections attempted; none is not a blocker.');
    else {
      output(`Checking ${scope} selections in location ${root}. MCP status checks may start OpenCode and enabled connections/local processes, including unrelated servers. gh selection runs version/auth status only, which may contact GitHub. Raw output/tokens are suppressed. No service tools, login, enabling, reload, or writes.`);
      if ((await ask('Type inspect to approve these read-only checks', 'cancel')) !== 'inspect') { output('Cancelled. No checks performed.'); return 0; }
      try { const rows = await (deps.check ?? checkSelectedIntegrations)({ directory: root, ...(options.opencode ? { executable: options.opencode } : {}), ...(options.server ? { server: options.server } : {}) }, settings); for (const row of rows) output(`${row.service}: ${row.name}: ${row.status}\n  ${row.message}`); output(optionalDiscoveryPrompt(settings)); return rows.every(row => row.status === 'connected') ? 0 : 1; }
      catch (err) { if (err instanceof DiagnosticError) errorOutput(err.message); errorOutput('Verification inconclusive; no settings updated.'); return 2; }
    }
    return 0;
  }
}
