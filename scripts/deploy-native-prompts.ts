import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { runPromptDeploymentFlow } from '../src/prompt-deployment-flow.ts';
import { parsePromptDeploymentArgs } from '../src/prompt-deployment-cli.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run harness:deploy-prompts -- [--scope project|global] [--project <directory>] [--config <file>]');
  console.log('Safe prompt deployment. Refreshes native agent descriptions and system prompts from agents/*.md');
  console.log('Strictly preserves installed models, reasoning variants, permissions, and custom settings.');
  process.exit(0);
}
const options = parsePromptDeploymentArgs(args);
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run prompt deployment in an interactive terminal. No configuration was changed.');
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string, def?: string) => (await terminal.question(`${q}${def ? ` [${def}]` : ''}: `)).trim();
const output = (message: string) => console.log(message);
try {
  await runPromptDeploymentFlow(options, { ask, output, definitionsDirectory: fileURLToPath(new URL('../agents/', import.meta.url)) });
} finally { terminal.close(); }
