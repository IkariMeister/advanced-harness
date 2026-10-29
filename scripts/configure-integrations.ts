import { createInterface } from 'node:readline/promises';
import type { Ask } from '../src/native-installer.ts';
import { runIntegrationFlow } from '../src/integration-cli-flow.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run harness:integrations -- [--host opencode] [--scope global|project] [--project <checkout>] [--context <project Markdown>] [--config <global opencode.json/jsonc>] [--check] [--opencode <CLI>] [--server <URL>]');
  console.log('Every integration is optional. Global scope manages reusable connections/defaults; project scope writes context only. New remote MCP entries stay disabled. Checks require separate read-only approval.');
} else {
  const options: Record<string, string> = {}; let check = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--check' && !check) { check = true; continue; }
    const value = args[++index];
    if (!flag || !['--scope', '--project', '--context', '--config', '--opencode', '--server', '--host'].includes(flag) || !value || value.startsWith('--') || options[flag]) throw new Error('Unknown, duplicate, or incomplete option. Run --help.');
    options[flag] = value;
  }
  if (options['--scope'] && !['global', 'project'].includes(options['--scope'])) throw new Error('Scope must be global or project.');
  if (!check && (options['--opencode'] || options['--server'])) throw new Error('--opencode/--server apply only to checks.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run integration setup/check in an interactive terminal. No files or connections changed.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = async (question, suggested) => (await terminal.question(`${question}${suggested ? ` [${suggested}]` : ''}: `)).trim();
  try {
    const host = options['--host'] ?? 'opencode';
    process.exitCode = await runIntegrationFlow({ ...(options['--scope'] ? { scope: options['--scope'] } : {}), ...(options['--project'] ? { project: options['--project'] } : {}), ...(options['--context'] ? { context: options['--context'] } : {}), ...(options['--config'] ? { config: options['--config'] } : {}), ...(options['--opencode'] ? { opencode: options['--opencode'] } : {}), ...(options['--server'] ? { server: options['--server'] } : {}), host, check }, { ask, output: message => console.log(message), error: message => console.error(message) });
  } finally { terminal.close(); }
}
