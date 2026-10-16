import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverConfigurations, chooseConfiguration, projectConfiguration, type ConfigSource } from '../src/native-installer.ts';
import { deployPrompts, planPromptDeployment } from '../src/prompt-deployment.ts';
import { loadNativeDefinitions } from '../src/native-installer.ts';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run harness:deploy-prompts -- [--scope project|global] [--project <directory>] [--config <file>]');
  console.log('Safe prompt deployment. Refreshes native agent descriptions and system prompts from agents/*.md');
  console.log('Strictly preserves installed models, reasoning variants, permissions, and custom settings.');
  process.exit(0);
}

const options: Record<string, string> = {};
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!flag || !['--scope', '--project', '--config'].includes(flag) || !value || value.startsWith('--') || options[flag]) {
    throw new Error('Unknown, duplicate, or incomplete option. Run --help.');
  }
  options[flag] = value;
}

if (options['--scope'] && !['project', 'global'].includes(options['--scope'])) {
  throw new Error('--scope must be project or global');
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error('Run prompt deployment in an interactive terminal. No configuration was changed.');
}

const terminal = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string, def?: string) => (await terminal.question(`${q}${def ? ` [${def}]` : ''}: `)).trim();

try {
  let scope = options['--scope'];
  while (!scope || !['project', 'global'].includes(scope)) {
    scope = (await ask('Deploy scope: project or global', 'project')) || 'project';
  }

  const cwd = process.cwd();
  const home = homedir();
  const expand = (path: string) => path.replace(/^(?:~|\$HOME)(?=[/\\]|$)/, home);
  const project = scope === 'project' ? resolve(cwd, expand(options['--project'] ?? ((await ask('Project directory', cwd)) || cwd))) : undefined;

  const globalDirectory = resolve(join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode'));
  const sources = discoverConfigurations(project, globalDirectory);
  const target = options['--config'] ? resolve(cwd, expand(options['--config'])) : project ? projectConfiguration(project, sources) : chooseConfiguration(globalDirectory);

  if (!existsSync(target)) {
    throw new Error(`Target configuration not found: ${target}`);
  }

  const definitions = loadNativeDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));
  const original = readFileSync(target, 'utf8');
  const plan = planPromptDeployment(original, definitions, target);

  console.log(`\nTarget: ${target}`);
  if (!plan.hasChanges) {
    console.log('All installed roles already match the latest source prompt templates.');
    console.log('No prompt changes needed; no files were modified.');
    process.exit(0);
  }

  console.log('Roles to be updated with reviewed source templates:');
  for (const r of plan.roles) {
    if (r.descriptionChanged || r.systemChanged) {
      const parts = [
        r.descriptionChanged ? 'description' : null,
        r.systemChanged ? 'system' : null
      ].filter(Boolean);
      console.log(`  - ${r.role}: ${parts.join(', ')}`);
    } else {
      console.log(`  - ${r.role}: unchanged`);
    }
  }

  console.log('\nSafety invariants:');
  console.log('  - Configured models and reasoning variants will NOT be changed.');
  console.log('  - Configured permission rules and ordering will NOT be changed.');
  console.log('  - Pre-save backup and cumulative recovery receipt will be written.');

  const answer = await ask('Type deploy to confirm prompt deployment', 'cancel');
  if (answer !== 'deploy') {
    console.log('Cancelled. No configuration files were changed.');
    process.exit(0);
  }

  const backupParent = process.env.ADVANCED_HARNESS_RECOVERY_DIR ?? join(home, 'Projects', 'advanced-harness-backups');
  const result = deployPrompts(target, backupParent, {
    definitionsDirectory: fileURLToPath(new URL('../agents/', import.meta.url))
  });

  if (result.updated) {
    console.log(`\nPrompts successfully deployed to: ${target}`);
    if (result.backup) console.log(`Backup: ${result.backup}`);
    if (result.receiptPath) console.log(`Receipt: ${result.receiptPath}`);
    console.log('\nStart a new OpenCode session to activate the updated prompts.');
  } else {
    console.log('No changes were made.');
  }
} finally {
  terminal.close();
}
