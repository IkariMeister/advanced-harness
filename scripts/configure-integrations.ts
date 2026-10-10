import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { chooseConfiguration, discoverConfigurations, findMarkdownConflicts, parseConfiguration, type Ask } from '../src/native-installer.ts';
import { expandPath, saveSetup, type SetupFile } from '../src/project-setup.ts';
import { configuredServers, updateConnectionConfig } from '../src/integration-setup.ts';
import { askGlobalIntegrations, askProjectIntegrations, checkSelectedIntegrations, emptyGlobalIntegrations, legacyIntegrationContext, optionalDiscoveryPrompt, parseGlobalIntegrations, selectedMcp, validateProjectIntegrations, type GlobalIntegrations, type ProjectIntegrations } from '../src/integration-context.ts';
import { contextData, contextPath, prepareContextFiles, readContext, updateContext } from '../src/project-context.ts';
import { DiagnosticError } from '../src/native-diagnostics.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run harness:integrations -- [--scope global|project] [--project <checkout>] [--context <project Markdown>] [--config <global opencode.json/jsonc>] [--check] [--opencode <CLI>] [--server <URL>]');
  console.log('Every integration is optional. Global scope manages reusable connections/defaults; project scope writes context only. New remote MCP entries stay disabled. Checks require separate read-only approval.');
} else {
  const options: Record<string, string> = {};
  let check = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--check' && !check) { check = true; continue; }
    const value = args[++index];
    if (!flag || !['--scope', '--project', '--context', '--config', '--opencode', '--server'].includes(flag) || !value || value.startsWith('--') || options[flag]) throw new Error('Unknown, duplicate, or incomplete option. Run --help.');
    options[flag] = value;
  }
  if (options['--scope'] && !['global', 'project'].includes(options['--scope'])) throw new Error('Scope must be global or project.');
  if (!check && (options['--opencode'] || options['--server'])) throw new Error('--opencode/--server apply only to checks.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run integration setup/check in an interactive terminal. No files or connections changed.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = async (question, suggested) => (await terminal.question(`${question}${suggested ? ` [${suggested}]` : ''}: `)).trim();
  try {
    let scope = options['--scope'] ?? (options['--project'] ? 'project' : undefined);
    while (!scope || !['global', 'project'].includes(scope)) scope = (await ask('Configuration scope: global or project', 'global')).trim() || 'global';
    if (scope === 'global' && (options['--context'] || (!check && options['--project']))) throw new Error('Global setup does not take project/context settings. Use project scope separately.');
    if (options['--config'] && (scope !== 'global' || check)) throw new Error('--config selects only a global setup target.');
    const global = resolve(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode'));
    const preferencesPath = join(global, 'harness.integrations.json');
    const originalPreferences = existsSync(preferencesPath) ? readFileSync(preferencesPath, 'utf8') : undefined;
    const defaults = originalPreferences === undefined ? emptyGlobalIntegrations() : parseGlobalIntegrations(originalPreferences);
    let root = process.cwd();
    if (scope === 'project' || (check && options['--project'])) root = expandPath(options['--project'] ?? ((await ask('Application Git checkout root', root)) || root));
    if (!lstatSync(root).isDirectory() || (scope === 'project' && !existsSync(join(root, '.git')))) throw new Error('Select an existing project Git checkout root.');
    let settings: GlobalIntegrations | ProjectIntegrations = defaults;
    let files: SetupFile[] = [];
    if (scope === 'global' && !check) {
      const target = options['--config'] ? expandPath(options['--config']) : chooseConfiguration(global);
      const same = process.platform === 'win32' ? dirname(target).toLowerCase() === global.toLowerCase() : dirname(target) === global;
      if (!same || !['opencode.json', 'opencode.jsonc'].includes(basename(target))) throw new Error('--config must select global opencode.json/jsonc.');
      const sources = discoverConfigurations(undefined, global);
      const original = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
      if (original !== undefined && !sources.some(source => source.path === target)) sources.push({ path: target, text: original, value: parseConfiguration(original, target) });
      const servers = configuredServers(sources);
      console.log('Global MCP aliases (no endpoints/settings/credentials printed):');
      Object.keys(servers).sort().forEach((name, index) => console.log(`  ${index + 1}. ${name} (${servers[name]!.disabled === true ? 'disabled' : 'runtime unverified'})`));
      console.log('Each integration may be none. New entries are disabled remote OAuth servers; no connections will be attempted. No repository/Jira project data belongs in global preferences.');
      const draft = await askGlobalIntegrations(servers, defaults, ask);
      settings = draft.settings;
      if ((draft.choices.length || settings.github?.backend === 'gh') && findMarkdownConflicts(sources, target, global).length) throw new Error('Resolve competing global named Markdown agent definitions before writing role permissions.');
      const updated = updateConnectionConfig(original ?? '{}\n', sources, draft.choices, settings.github?.backend === 'gh');
      if (updated !== (original ?? '{}\n')) files.push({ path: target, original, updated });
      files.push({ path: preferencesPath, original: originalPreferences, updated: JSON.stringify(settings, null, 2) + '\n' });
      for (const server of draft.choices) console.log(`${server.name}: ${server.create ? `new disabled endpoint ${server.create.url}` : 'reuse unchanged'}`);
      console.log('Selected MCP actions: External ASK; other seven harness roles DENY. gh/gh.exe shell ASK belongs to External when selected. Existing rules remain; appended rules win matches. None does not remove old connections/grants.');
    } else if (scope === 'project') {
      const target = contextPath(root, options['--context']);
      const original = readContext(target);
      const embedded = contextData(original, 'integrations');
      let previous = embedded === undefined ? undefined : validateProjectIntegrations(embedded);
      if (!check) {
        const legacy = join(root, '.opencode', 'harness.integrations.json');
        if (!previous && existsSync(legacy)) {
          console.log(`Legacy profile detected: ${legacy}. It will not be edited/deleted.`);
          if ((await ask('Type migrate to use legacy integration choices as context suggestions', 'no')) === 'migrate') previous = legacyIntegrationContext(readFileSync(legacy, 'utf8'));
        }
        const servers = configuredServers(discoverConfigurations(root, global));
        console.log('Available aliases (new connections must be configured globally first):');
        Object.keys(servers).sort().forEach((name, index) => console.log(`  ${index + 1}. ${name}`));
        settings = await askProjectIntegrations(servers, defaults, previous, ask);
        const updated = updateContext(original, 'integrations', settings, [
          'These embedded settings are the project context source; legacy .opencode/harness.integrations.json files are not loaded automatically.',
          'These are project selections and identifiers, not credentials or connection definitions. Reusable connections and permissions live in global OpenCode configuration.',
          'Each integration may be none. Ask about an absent integration only when a task needs it; never silently enable or substitute a service.',
          'Only External owns services/GitHub CLI. Status mappings and access are unverified; read-only checks, lifecycle writes, and publishing require appropriate conversational approval. Human merge remains separate.',
        ]);
        files = prepareContextFiles(root, target, original, updated);
      } else {
        if (!previous) throw new Error('No integration settings in the selected project context. Run project scope first; legacy files are not loaded automatically.');
        settings = previous;
      }
    }
    if (!check) {
      console.log(`\nReview ${scope} settings (no credentials):\n${JSON.stringify(settings, null, 2)}`);
      console.log('Files to write:');
      for (const file of files) console.log(`  ${file.path}${file.original === undefined ? ' (new)' : ' (backup first)'}`);
      if (scope === 'project') console.log('Only the selected marked context section (and AGENTS.md reference if needed) changes. No project OpenCode config/profile files are created.');
      console.log('No service calls, OAuth, credential changes, publishing, or legacy-file deletion. Keep backups private; preview Git status before publishing.');
      if ((await ask('Type integrations to save, or anything else to cancel', 'cancel')) !== 'integrations') console.log('Cancelled. No files or connections changed.');
      else {
        const backups = saveSetup(files, join(homedir(), 'Projects', 'advanced-harness-backups'));
        for (const backup of backups) if (backup) console.log(`Private backup: ${backup}`);
        console.log(`${scope} integration settings saved. New servers remain disabled. Approve connections separately; sign in via /mcps.`);
        console.log(optionalDiscoveryPrompt(settings));
      }
    } else {
      const selected = selectedMcp(settings);
      if (!selected.length && !settings.github) console.log('No integrations selected. No runtime checks or connections attempted; none is not a blocker.');
      else {
        console.log(`Checking ${scope} selections in location ${root}. MCP status checks may start OpenCode and enabled connections/local processes, including unrelated servers. gh selection runs version/auth status only, which may contact GitHub. Raw output/tokens are suppressed. No service tools, login, enabling, reload, or writes.`);
        if ((await ask('Type inspect to approve these read-only checks', 'cancel')) !== 'inspect') console.log('Cancelled. No checks performed.');
        else {
          try {
            const checks = await checkSelectedIntegrations({ directory: root, ...(options['--opencode'] ? { executable: options['--opencode'] } : {}), ...(options['--server'] ? { server: options['--server'] } : {}) }, settings);
            for (const row of checks) console.log(`${row.service}: ${row.name}: ${row.status}\n  ${row.message}`);
            console.log(optionalDiscoveryPrompt(settings));
            process.exitCode = checks.every(row => row.status === 'connected') ? 0 : 1;
          } catch (error) {
            if (error instanceof DiagnosticError) console.error(error.message);
            console.error('Verification inconclusive; no settings updated.'); process.exitCode = 2;
          }
        }
      }
    }
  } finally { terminal.close(); }
}
