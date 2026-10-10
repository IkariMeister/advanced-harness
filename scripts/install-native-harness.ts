import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { agentDirectories, askAssignments, chooseConfiguration, configuredModels, discoverConfigurations, findMarkdownConflicts, loadNativeDefinitions, nativeRoles, parseConfiguration, projectConfiguration, saveInstallation, updateNativeConfiguration, type Ask } from '../src/native-installer.ts';
import { DiagnosticError, printReport, verifyRuntime } from '../src/native-diagnostics.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run harness:install -- [--scope project|global] [--project <directory>] [--config <file>] [--opencode <CLI path>]');
  console.log('Interactive native-agent installer. Preserves unrelated JSON/JSONC settings; writes only after confirmation.');
} else {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !['--scope', '--project', '--config', '--opencode'].includes(flag) || !value || value.startsWith('--') || options[flag]) throw new Error('Unknown, duplicate, or incomplete option. Run --help.');
    options[flag] = value;
  }
  if (options['--scope'] && !['project', 'global'].includes(options['--scope'])) throw new Error('--scope must be project or global');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run this installer in an interactive terminal. No configuration was changed.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = async (question, suggested) => (await terminal.question(`${question}${suggested ? ` [${suggested}]` : ''}: `)).trim();
  try {
    let scope = options['--scope'];
    while (!scope || !['project', 'global'].includes(scope)) scope = (await ask('Install scope: project or global', 'project')) || 'project';
    if (scope === 'global' && options['--project']) throw new Error('--project cannot be combined with global scope.');
    const expand = (path: string) => path.replace(/^(?:~|\$HOME)(?=[/\\]|$)/, homedir());
    const project = scope === 'project' ? resolve(expand(options['--project'] ?? ((await ask('Project directory', process.cwd())) || process.cwd()))) : undefined;
    if (project && (!existsSync(project) || !statSync(project).isDirectory())) throw new Error('Project directory does not exist or is not a directory. Create/select it before installing.');
    const globalDirectory = resolve(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode'));
    const sources = discoverConfigurations(project, globalDirectory);
    const target = options['--config'] ? resolve(expand(options['--config'])) : project ? projectConfiguration(project, sources) : chooseConfiguration(globalDirectory);
    const allowedDirectories = project ? [project, join(project, '.opencode')] : [resolve(globalDirectory)];
    const sameDirectory = (directory: string) => process.platform === 'win32' ? directory.toLowerCase() === dirname(target).toLowerCase() : directory === dirname(target);
    if (!['opencode.json', 'opencode.jsonc'].includes(basename(target)) || !allowedDirectories.some(sameDirectory)) throw new Error('--config must select opencode.json/jsonc inside the chosen project (or its .opencode folder), or the global OpenCode directory.');
    const original = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    if (!sources.some(source => source.path === target) && original !== undefined) sources.push({ path: target, text: original, value: parseConfiguration(original, target) });
    const conflicts = findMarkdownConflicts(sources, target, globalDirectory, project);
    if (conflicts.length) throw new Error(`Existing named Markdown agents may override inline installation. Resolve intentionally, then rerun; no files were changed:\n${conflicts.join('\n')}`);
    const adapter = agentDirectories(sources, target, globalDirectory, project).some(directory => existsSync(join(directory, 'plugins', 'advanced-harness')));
    const configuredAdapter = sources.some(source => Array.isArray(source.value.plugins) && source.value.plugins.some(entry => {
      const name = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && 'package' in entry ? String(entry.package) : '';
      return /spike[/\\]opencode|advanced-harness-opencode-spike/i.test(name);
    }));
    if (adapter || configuredAdapter) throw new Error('Historical advanced-harness plugin detected. Disable/remove it intentionally before installing native agents; the installer will not delete it.');
    console.log(`\nScope: ${scope}\nTarget: ${target}`);
    console.log('Read configuration files (contents/credentials are not printed):');
    for (const source of sources) console.log(`  ${source.path}`);
    if (!sources.length) console.log('  None; a new configuration will be created.');
    if (process.env.OPENCODE_CONFIG_CONTENT || process.env.OPENCODE_CONFIG) console.log('Warning: environment config overrides may affect runtime behavior; they are not edited by this installer.');
    console.log('\nConfigured model IDs (not proof of account access):');
    const choices = configuredModels(sources);
    choices.forEach((model, index) => console.log(`  ${index + 1}. ${model}`));
    if (!choices.length) console.log('  None declared. Enter IDs verified in OpenCode /models.');
    console.log('Each role requires your choice. Enter a listed number or provider/model#variant; Enter accepts the shown suggestion.');
    console.log('Unknown account access/variants must be checked in /models. Spark previously failed with the tested ChatGPT account.');
    const definitions = loadNativeDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));
    const assignments = await askAssignments(definitions, sources, ask);
    const setDefault = /^(y|yes)$/i.test(await ask('Make Lead the default agent for new sessions?', 'no'));
    const setLeadModel = /^(y|yes)$/i.test(await ask('Also set the root default model to Lead? (otherwise preserve it)', 'no'));
    const updated = updateNativeConfiguration(original ?? '{}\n', definitions, assignments, setDefault, setLeadModel);
    console.log('\nAssignments:');
    for (const role of nativeRoles) console.log(`  ${role}: ${assignments[role]}`);
    const value = original === undefined ? {} : parseConfiguration(original, target);
    const existing = value.agents as Record<string, unknown> | undefined;
    const collisions = nativeRoles.filter(role => existing && Object.hasOwn(existing, role));
    if (collisions.length) console.log(`Existing roles updated: ${collisions.join(', ')}. Their model, mode, description, permissions, and system prompt will be replaced; other fields are preserved.`);
    console.log('Preserved hidden/disabled flags, ancestor definitions, and runtime overrides may affect discovery. Verify effective agents after installation.');
    console.log(`Default agent: ${setDefault ? 'set to lead' : 'preserved'}; root default model: ${setLeadModel ? assignments.lead.split('#')[0] : 'preserved'}.`);
    console.log('Providers, credentials, MCP servers, plugins, and unrelated agents/settings will not be changed.');
    console.log('Assignments are stored inline in agents; no plugin or separate approval host is installed.');
    const backupParent = join(homedir(), 'Projects', 'advanced-harness-backups');
    if (original !== undefined) console.log(`A private configuration backup will be created under ${backupParent}. It may contain existing secrets; keep it local.`);
    console.log('After writing, runtime verification may start the OpenCode service. It will not restart/reload it or send paid model requests.');
    if ((await ask('Type install to apply these changes', 'cancel')) !== 'install') console.log('Cancelled. No files were changed.');
    else {
      const backup = saveInstallation(target, original, updated, backupParent);
      console.log(`Configuration written (runtime not yet verified): ${target}`);
      if (backup) console.log(`Backup: ${backup}`);
      const directory = project ?? process.cwd();
      try {
        const intended = Object.fromEntries(nativeRoles.map(role => [role, { ...definitions[role], model: assignments[role] }]));
        const report = await verifyRuntime({ directory, ...(options['--opencode'] ? { executable: options['--opencode'] } : {}) }, intended);
        printReport(report);
        process.exitCode = report.ok ? 0 : 1;
      } catch (error) {
        if (error instanceof DiagnosticError) console.error(error.message);
        console.error('Configuration saved, but runtime verification is inconclusive. Run npm run harness:doctor; check CLI path/service. No rollback or model substitution was performed.');
        process.exitCode = 2;
      }
      console.log('Existing session models are unchanged; explicitly verify the assigned Lead model/variant in the new session.');
      console.log('Model access, MCP authentication, project commands, and approval behavior have NOT been runtime-validated.');
    }
  } finally { terminal.close(); }
}
