import { createInterface } from 'node:readline/promises';
import { runInstallerFlow } from '../src/installer-flow.ts';
import type { Ask } from '../src/native-installer.ts';
import { askHostSelection } from '../src/host-registry.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run harness:install -- [--host <opencode|claude-code|antigravity|codex|cursor|all>] [--scope project|global] [--project <directory>] [--config <file>] [--opencode <CLI path>]');
  console.log('Interactive native-agent installer. Preserves unrelated JSON/JSONC settings; writes only after confirmation.');
} else {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !['--scope', '--project', '--config', '--opencode', '--host'].includes(flag) || !value || value.startsWith('--') || options[flag]) throw new Error('Unknown, duplicate, or incomplete option. Run --help.');
    options[flag] = value;
  }
  if (options['--scope'] && !['project', 'global'].includes(options['--scope'])) throw new Error('--scope must be project or global');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run this installer in an interactive terminal. No configuration was changed.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = async (question, suggested) => (await terminal.question(`${question}${suggested ? ` [${suggested}]` : ''}: `)).trim();
  try {
    const host = options['--host'] ? options['--host'] : (await askHostSelection(ask, 'opencode')).join(',');
    process.exitCode = await runInstallerFlow({ ...(options['--scope'] ? { scope: options['--scope'] } : {}), ...(options['--project'] ? { project: options['--project'] } : {}), ...(options['--config'] ? { config: options['--config'] } : {}), ...(options['--opencode'] ? { opencode: options['--opencode'] } : {}), host }, { ask, output: message => console.log(message), error: message => console.error(message) });
  } finally { terminal.close(); }
}
