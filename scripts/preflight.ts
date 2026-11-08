import { exitCodeFor, formatHuman, runPreflight } from '../src/preflight/runner.ts';

const usage = `Usage: npm run harness:preflight -- --worktree <path> [--base <ref>] [--json]
       npm run harness:preflight -- -h | --help

Reports pre-publish evidence for a task worktree. It never records approval.
  --worktree <path>  Task worktree to inspect (required)
  --base <ref>       Base ref; defaults to baseBranch in project context.
                     Required if the project context has no baseBranch.
  --json             Print the result contract as JSON
  -h, --help         Show this help message

Exit codes: 0 pass (or --help), 1 blocked, 2 inconclusive or usage error.`;

function fail(message: string): void {
  console.error(`${message}\n\n${usage}`);
  process.exitCode = 2;
}

async function main(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return; }
  const options: Record<string, string> = {};
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--json') { json = true; continue; }
    if (flag !== '--worktree' && flag !== '--base') return fail(`Unknown option: ${flag}`);
    if (options[flag] !== undefined) return fail(`Duplicate option: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) return fail(`Missing value for ${flag}`);
    options[flag] = value;
    index += 1;
  }
  if (!options['--worktree']) return fail('Missing required --worktree.');
  const result = await runPreflight({ worktree: options['--worktree'], base: options['--base'] });
  console.log(json ? JSON.stringify(result, null, 2) : formatHuman(result));
  process.exitCode = exitCodeFor(result);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`Unexpected preflight error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
