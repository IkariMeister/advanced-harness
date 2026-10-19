import { createInterface } from 'node:readline/promises';
import { runSetupFlow } from '../src/project-setup.ts';
import type { Ask } from '../src/native-installer.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run harness:setup -- [--global] [--scope <global|project>] [--project <Git/checkout root>] [--context <project Markdown file>]');
  console.log('Interactive project or global configuration. Does not execute commands, create worktrees/memory, or change OpenCode models/MCP.');
} else {
  const options: Record<string, string> = {};
  let global = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--global') {
      if (global) throw new Error('Duplicate option --global. Run --help.');
      global = true;
      continue;
    }
    const value = args[++index];
    if (!['--scope', '--project', '--context'].includes(flag) || !value || value.startsWith('--') || options[flag]) {
      throw new Error(`Unknown, duplicate, or incomplete option "${flag}". Run --help.`);
    }
    options[flag] = value;
  }
  if (options['--scope'] && !['global', 'project'].includes(options['--scope'])) {
    throw new Error('--scope must be global or project.');
  }
  if (global && options['--scope'] === 'project') {
    throw new Error('Conflicting options: --global cannot be combined with --scope project.');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run setup in an interactive terminal. No files changed.');
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = async (question, suggested) => (await terminal.question(`${question}${suggested ? ` [${suggested}]` : ''}: `)).trim();
  try {
    process.exitCode = await runSetupFlow(
      {
        scope: options['--scope'],
        project: options['--project'],
        context: options['--context'],
        global,
      },
      {
        ask,
        output: message => console.log(message),
        error: message => console.error(message),
      }
    );
  } finally {
    terminal.close();
  }
}

