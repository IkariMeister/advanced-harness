import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readAcceptanceCriteria } from '../src/preflight/criteria.ts';
import { exitCodeFor, formatHuman, runPreflight } from '../src/preflight/runner.ts';

const usage = `Usage: npm run harness:preflight -- --worktree <path> [--base <ref>] [--task <key>] [--criteria <file>] [--justify-no-tests "<text>"] [--json]
       npm run harness:preflight -- -h | --help

Reports pre-publish evidence for a task worktree. It never records approval.
  --worktree <path>            Task worktree to inspect (required)
  --base <ref>                 Base ref; defaults to baseBranch in project context.
                               Required if the project context has no baseBranch.
  --task <key>                 Optional task or issue key (e.g. 182, #182, BH-067)
                               to verify that HEAD matches the task branch.
  --criteria <file>            Acceptance criteria JSON: {"items":[{"text":"...","done":true}]}.
                               Pending items warn; a missing or invalid file is inconclusive.
  --justify-no-tests "<text>"  Justified bypass: turns a test-change block into a warning and
                               records the text in the output. It is not approval.
  --json                       Print the result contract as JSON
  -h, --help                   Show this help message

Exit codes: 0 pass (or --help), 1 blocked, 2 inconclusive or usage error.`;

export type CliExitCode = 0 | 1 | 2;

export type CliDeps = {
  runPreflight: typeof runPreflight;
  output(message: string): void;
  error(message: string): void;
};

const defaultDeps: CliDeps = {
  runPreflight,
  output: (message) => console.log(message),
  error: (message) => console.error(message),
};

/** Runs the preflight CLI and returns its exit code. Unexpected failures are reported and exit 2. */
export async function runCli(args: string[], deps: CliDeps = defaultDeps): Promise<CliExitCode> {
  const fail = (message: string): CliExitCode => {
    deps.error(`${message}\n\n${usage}`);
    return 2;
  };
  try {
    if (args.includes('--help') || args.includes('-h')) { deps.output(usage); return 0; }
    const options: Record<string, string> = {};
    const valueFlags = ['--worktree', '--base', '--task', '--criteria', '--justify-no-tests'];
    let json = false;
    for (let index = 0; index < args.length; index += 1) {
      const flag = args[index]!;
      if (flag === '--json') { json = true; continue; }
      if (flag === '--ack-gitlink') {
        return fail('--ack-gitlink was removed. Move acknowledgements into trusted .harness/preflight.json under gitlinkAcknowledgements; see docs/preflight.md.');
      }
      if (!valueFlags.includes(flag)) return fail(`Unknown option: ${flag}`);
      if (options[flag] !== undefined) return fail(`Duplicate option: ${flag}`);
      const value = args[index + 1];
      if (!value || value.startsWith('--')) return fail(`Missing value for ${flag}`);
      if (flag === '--justify-no-tests' && !value.trim()) return fail('--justify-no-tests requires a nonblank justification.');
      options[flag] = value;
      index += 1;
    }
    if (!options['--worktree']) return fail('Missing required --worktree.');
    const criteriaPath = options['--criteria'];
    const justification = options['--justify-no-tests'];
    const result = await deps.runPreflight({
      worktree: options['--worktree'],
      base: options['--base'],
      task: options['--task'],
      ...(criteriaPath === undefined ? {} : { criteria: readAcceptanceCriteria(resolve(criteriaPath)) }),
      ...(justification === undefined ? {} : { justifyNoTests: justification }),
    });
    deps.output(json ? JSON.stringify(result, null, 2) : formatHuman(result));
    return exitCodeFor(result);
  } catch (error) {
    deps.error(`Unexpected preflight error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

export type EntryDecision = 'run' | 'skip' | 'ambiguous';

const sameUrl = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * Decides whether this module is the process entry point. `isMain` is `import.meta.main` (Node 24.2+)
 * and is authoritative when true. Otherwise argv1 (or its realpath) must resolve to `moduleUrl` to run.
 * A different file whose basename matches this module is 'ambiguous' (the caller fails closed), so the
 * gate never exits 0 silently when it cannot tell whether it was executed. Anything else is 'skip'
 * (a plain import, e.g. from a test file).
 */
export function entryDecision(
  argv1: string | undefined,
  moduleUrl: string,
  isMain: boolean,
  realpath: (path: string) => string = realpathSync,
): EntryDecision {
  if (isMain) return 'run';
  if (!argv1) return 'skip';
  let real: string | undefined;
  try {
    real = realpath(argv1);
  } catch {
    real = undefined;
  }
  const candidates = [pathToFileURL(resolve(argv1)).href, real ? pathToFileURL(real).href : undefined];
  if (candidates.some((url) => url !== undefined && sameUrl(url, moduleUrl))) return 'run';
  const moduleName = basename(fileURLToPath(moduleUrl));
  const names = [basename(argv1), real ? basename(real) : undefined];
  return names.some((name) => name !== undefined && sameUrl(name, moduleName)) ? 'ambiguous' : 'skip';
}

// Run only when executed as the script (npm run harness:preflight), not when imported by tests.
const decision = entryDecision(process.argv[1], import.meta.url, (import.meta as { main?: boolean }).main === true);
if (decision === 'run') {
  process.exitCode = await runCli(process.argv.slice(2));
} else if (decision === 'ambiguous') {
  console.error(`Unexpected preflight error: could not confirm entry point (${process.argv[1]})`);
  process.exitCode = 2;
}
