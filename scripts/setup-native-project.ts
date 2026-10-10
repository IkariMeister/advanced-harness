import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { askProfile, checkNames, expandPath, inspectProject, parseProfile, prepareSetup, saveSetup, validateProfile, type ProjectProfile } from '../src/project-setup.ts';
import { contextData, contextPath, readContext } from '../src/project-context.ts';
import type { Ask } from '../src/native-installer.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run harness:setup -- [--project <Git/Android checkout root>] [--context <project Markdown file>]');
  console.log('Interactive project configuration. Does not execute commands, create worktrees/memory, or change OpenCode models/MCP.');
} else {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!flag || !['--project', '--context'].includes(flag) || !value || value.startsWith('--') || options[flag]) throw new Error('Unknown or incomplete option. Run --help.');
    options[flag] = value;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run setup in an interactive terminal. No files changed.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = async (question, suggested) => (await terminal.question(`${question}${suggested ? ` [${suggested}]` : ''}: `)).trim();
  try {
    const root = expandPath(options['--project'] ?? ((await ask('Android Git checkout root', process.cwd())) || process.cwd()));
    const inspection = inspectProject(root);
    console.log(`Project: ${root}`);
    console.log(`Gradle files inspected: ${inspection.gradleFiles.join(', ')}`);
    console.log(`Android modules detected heuristically: ${inspection.androidModules.join(', ') || 'none (aliases/conventions may hide plugins)'}`);
    console.log('No Gradle/Git/device commands were executed. Suggestions are unverified; confirm tasks and shell explicitly.');
    if (inspection.agents !== undefined) console.log('Existing AGENTS.md found. Read its rules before confirming setup; content will be preserved outside the marked harness section.');
    console.log('Do not enter secrets in commands or paths. Use environment references instead. Missing checks remain unconfigured, never waived.');
    const target = contextPath(root, options['--context']);
    const original = readContext(target);
    const data = contextData(original, 'project');
    let previous: ProjectProfile | undefined = data === undefined ? undefined : validateProfile(data);
    const legacyPath = join(root, '.opencode', 'harness.project.json');
    if (!previous && existsSync(legacyPath)) {
      console.log(`Legacy settings detected: ${legacyPath}. This file will not be edited/deleted.`);
      if ((await ask('Type migrate to use legacy settings as suggestions in the context file', 'no')) === 'migrate') previous = parseProfile(readFileSync(legacyPath, 'utf8'));
    }
    const profile = await askProfile(root, inspection, previous, ask);
    const files = prepareSetup(root, profile, original, target);
    const updated = files[0]!.updated;
    console.log('\nReview project setup:');
    console.log(`Base branch: ${profile.baseBranch}; shell: ${profile.shell}`);
    for (const name of checkNames) { const check = profile.checks[name]; console.log(`${name}: ${check.status === 'configured' ? check.command : 'UNCONFIGURED (not waived)'}`); }
    console.log(`Device: ${profile.device.preference}; serial: ${profile.device.serial ?? 'choose at runtime'}`);
    console.log(`Worktree parent: ${profile.worktreeDirectory}\nShared memory: ${profile.memoryPath}`);
    console.log('Files to write:');
    for (const file of files) console.log(`  ${file.path}${file.original === undefined ? ' (new)' : ' (backup before updating)'}`);
    console.log('Proposed context section:');
    console.log(updated.slice(updated.indexOf('<!-- advanced-harness:project:start -->'), updated.indexOf('<!-- advanced-harness:project:end -->') + '<!-- advanced-harness:project:end -->'.length));
    console.log('Only context files are written; no separate project profile. Paths are machine-specific: review before committing. No models/MCP/ignore rules are changed. Legacy files remain untouched.');
    if ((await ask('Type setup to save, or anything else to cancel', 'cancel')) !== 'setup') console.log('Cancelled. No files or directories changed.');
    else {
      const backups = saveSetup(files, join(homedir(), 'Projects', 'advanced-harness-backups'));
      console.log(`Project settings saved in context: ${target}`);
      for (const backup of backups) if (backup) console.log(`Backup (keep private): ${backup}`);
      console.log('Setup choices saved, not runtime-validated. Run harness:doctor in this project, then approve command/device/integration validation with Lead.');
    }
  } finally { terminal.close(); }
}
