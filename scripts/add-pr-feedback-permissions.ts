import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Ask } from '../src/native-installer.ts';
import { feedbackPermissionsRecoveryDirectory, runPrFeedbackPermissionsFlow } from '../src/pr-feedback-permissions.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run harness:pr-feedback-permissions -- --config <global-opencode.json|jsonc> [--recovery-directory <directory>] [--apply]');
  console.log('Default mode is read-only preview. Apply only after separate conversational approval of the exact preview; the command asks for an exact confirmation phrase.');
} else {
  const options: Record<string, string> = {}; let apply = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--apply' && !apply) { apply = true; continue; }
    const value = args[++index];
    if (!flag || !['--config', '--recovery-directory'].includes(flag) || !value || value.startsWith('--') || options[flag]) throw new Error('Unknown, duplicate, or incomplete option. Run --help.');
    options[flag] = value;
  }
  if (!options['--config']) throw new Error('--config is required; select the exact global OpenCode configuration to preview.');
  const target = resolve(options['--config'].replace(/^(?:~|\$HOME)(?=[/\\]|$)/, homedir()));
  if (!['opencode.json', 'opencode.jsonc'].includes(target.split(/[\\/]/).at(-1)!)) throw new Error('--config must name opencode.json or opencode.jsonc.');
  const recoveryDirectory = resolve((options['--recovery-directory'] ?? feedbackPermissionsRecoveryDirectory()).replace(/^(?:~|\$HOME)(?=[/\\]|$)/, homedir()));
  if (apply && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('--apply requires an interactive terminal. No files changed.');
  const terminal = apply ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask: Ask | undefined = terminal ? async (question, suggested) => (await terminal.question(`${question}${suggested ? ` [${suggested}]` : ''}: `)).trim() : undefined;
  try {
    process.exitCode = await runPrFeedbackPermissionsFlow({ target, recoveryDirectory, apply }, {
      ...(ask ? { ask } : {}), output: message => console.log(message), error: message => console.error(message),
    });
  } finally { terminal?.close(); }
}
