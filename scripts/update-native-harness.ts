import { createInterface } from 'node:readline/promises';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import type { Ask } from '../src/native-installer.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run harness:update -- [--scope project|global] [--project <directory>] [--config <file>] [--opencode <CLI path>] [--check-remote]');
  console.log('Safe harness update workflow. Discovers newer versions, previews prompt & permission updates, preserves customizations, and records recovery receipts.');
} else {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--check-remote') {
      options['--check-remote'] = true;
      continue;
    }
    const value = args[index + 1];
    if (!flag || !['--scope', '--project', '--config', '--opencode'].includes(flag) || !value || value.startsWith('--') || options[flag]) {
      throw new Error('Unknown, duplicate, or incomplete option. Run --help.');
    }
    options[flag] = value;
    index++;
  }
  if (options['--scope'] && !['project', 'global'].includes(String(options['--scope']))) {
    throw new Error('--scope must be project or global');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run this update command in an interactive terminal. No configuration was changed.');
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = async (question, suggested) => (await terminal.question(`${question}${suggested ? ` [${suggested}]` : ''}: `)).trim();
  try {
    process.exitCode = await runUpdateFlow(
      {
        ...(options['--scope'] ? { scope: String(options['--scope']) } : {}),
        ...(options['--project'] ? { project: String(options['--project']) } : {}),
        ...(options['--config'] ? { config: String(options['--config']) } : {}),
        ...(options['--opencode'] ? { opencode: String(options['--opencode']) } : {}),
        ...(options['--check-remote'] ? { checkRemote: true } : {})
      },
      {
        ask,
        output: message => console.log(message),
        error: message => console.error(message)
      }
    );
  } finally {
    terminal.close();
  }
}
