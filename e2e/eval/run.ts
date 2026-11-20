// Command-line entry for the evaluation runner (U2, issue #226): npm run eval:opencode -- [options].
// The availability rules and exit statuses are in runner.ts and docs/evaluation.md (Runner).

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCENARIO_SETS, type ScenarioSet } from '../../src/eval-contracts.ts';
import { DEFAULT_REPEAT, runEvaluation, type EvaluationOptions, type EvaluationSummary } from './runner.ts';

export interface CliArguments {
  set: ScenarioSet;
  scenarioIds: string[];
  repeat: number;
  outDirectory: string;
}

export type ParsedCli = { kind: 'run'; cli: CliArguments } | { kind: 'help' } | { kind: 'error'; message: string };

export const LIVE_REJECTION = 'Live mode is rejected: this runner executes only deterministic scenario bindings, and live-mode evaluation is not implemented. No scenario was run.';
export const HOLDOUT_WARNING = 'Warning: the validation set is a holdout. Its scenarios have no deterministic binding, so every one is skipped. A holdout run is not evidence for the development set.';

const usage = `Usage: npm run eval:opencode -- [--set development|validation] [--scenario <id>]... [--repeat <n>] --out <dir>
       npm run eval:opencode -- -h | --help

Runs the development scenarios that have a deterministic binding through the agent E2E harness (OpenCode 2.3.0 and a
loopback model fixture) and writes results under <dir>/<runId>/.
  --set <name>      development (default) or validation. validation is a holdout: explicit, warned, and skipped.
  --scenario <id>   Run only this scenario (repeatable). It must belong to the chosen set.
  --repeat <n>      Runs per scenario (default ${DEFAULT_REPEAT}). A scenario passes only when its repeats match.
  --out <dir>       Output directory (required).
  --mode <name>     Only deterministic is accepted. live is rejected.
  -h, --help        Show this help message

Environment: HARNESS_E2E_OPENCODE (absolute path to OpenCode 2.3.0; unset skips every scenario),
HARNESS_E2E_NETNS=1 (require a loopback-only network namespace).
Exit codes: 0 every executed scenario passes and repeats; 1 a fail, inconclusive, or infrastructure_error result, a
non-repeatable result, or no scenario executed; 2 usage error.`;

const VALUE_FLAGS = ['--set', '--scenario', '--repeat', '--out', '--mode'];

/** Parses the command line. Pure: no file or process access. */
export function parseArguments(args: readonly string[]): ParsedCli {
  if (args.includes('--help') || args.includes('-h')) return { kind: 'help' };
  let set: ScenarioSet | undefined;
  let repeat: number | undefined;
  let outDirectory: string | undefined;
  let mode: string | undefined;
  const scenarioIds: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? '';
    if (!VALUE_FLAGS.includes(flag)) return { kind: 'error', message: `Unknown option: ${flag}` };
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) return { kind: 'error', message: `Missing value for ${flag}` };
    index += 1;
    if (flag === '--scenario') {
      scenarioIds.push(value);
      continue;
    }
    if (flag === '--set') {
      if (set !== undefined) return { kind: 'error', message: 'Duplicate option: --set' };
      if (!SCENARIO_SETS.includes(value as ScenarioSet)) return { kind: 'error', message: '--set must be development or validation.' };
      set = value as ScenarioSet;
    } else if (flag === '--repeat') {
      if (repeat !== undefined) return { kind: 'error', message: 'Duplicate option: --repeat' };
      if (!/^[0-9]+$/.test(value) || Number(value) < 1) return { kind: 'error', message: '--repeat must be a positive integer.' };
      repeat = Number(value);
    } else if (flag === '--out') {
      if (outDirectory !== undefined) return { kind: 'error', message: 'Duplicate option: --out' };
      if (value.trim() === '') return { kind: 'error', message: '--out requires a directory.' };
      outDirectory = resolve(value);
    } else {
      if (mode !== undefined) return { kind: 'error', message: 'Duplicate option: --mode' };
      if (value === 'live') return { kind: 'error', message: LIVE_REJECTION };
      if (value !== 'deterministic') return { kind: 'error', message: '--mode must be deterministic (the only supported mode).' };
      mode = value;
    }
  }
  if (outDirectory === undefined) return { kind: 'error', message: 'Missing required --out <dir>.' };
  return {
    kind: 'run',
    cli: { set: set ?? 'development', scenarioIds, repeat: repeat ?? DEFAULT_REPEAT, outDirectory },
  };
}

/** One line per scenario, with the first repeat's reason and any repeatability differences. */
export function formatSummary(summary: EvaluationSummary): string {
  const openCode = summary.openCode.status === 'ready'
    ? `ready (${summary.openCode.version})`
    : summary.openCode.status === 'error'
      ? `error: ${summary.openCode.reason}`
      : 'not configured (every scenario is skipped)';
  const lines = [
    `Evaluation run ${summary.runId} (set ${summary.set}, repeat ${summary.repeat}): ${summary.directory}`,
    `OpenCode: ${openCode}; network enforcement: ${summary.enforcement}`,
  ];
  for (const scenario of summary.scenarios) {
    const suffix = scenario.repeatable ? '' : ' (NOT repeatable)';
    lines.push(`${scenario.scenarioId} ${scenario.scenarioVersion}: ${scenario.outcomes.join(', ')}${suffix}`);
    lines.push(`  ${scenario.reason}`);
    for (const difference of scenario.differences) lines.push(`  difference at ${difference.path}`);
  }
  lines.push(`Executed ${summary.executed} of ${summary.scenarios.length} scenario(s); repeatable: ${summary.repeatable ? 'yes' : 'no'}; exit status ${summary.exitCode}.`);
  return lines.join('\n');
}

export interface CliDeps {
  run(options: EvaluationOptions): Promise<EvaluationSummary>;
  output(message: string): void;
  error(message: string): void;
}

const defaultDeps: CliDeps = {
  run: runEvaluation,
  output: message => console.log(message),
  error: message => console.error(message),
};

/** Runs the command and returns its exit status: 0, 1 (a run failure), or 2 (a usage error). */
export async function runCli(args: readonly string[], deps: CliDeps = defaultDeps): Promise<0 | 1 | 2> {
  const parsed = parseArguments(args);
  if (parsed.kind === 'help') {
    deps.output(usage);
    return 0;
  }
  if (parsed.kind === 'error') {
    deps.error(`${parsed.message}\n\n${usage}`);
    return 2;
  }
  if (parsed.cli.set === 'validation') deps.error(HOLDOUT_WARNING);
  try {
    const summary = await deps.run({
      set: parsed.cli.set,
      scenarioIds: parsed.cli.scenarioIds,
      repeat: parsed.cli.repeat,
      outDirectory: parsed.cli.outDirectory,
    });
    deps.output(formatSummary(summary));
    return summary.exitCode;
  } catch (error) {
    deps.error(`Evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;
  const entry = pathToFileURL(resolve(argv1)).href;
  return process.platform === 'win32' ? entry.toLowerCase() === moduleUrl.toLowerCase() : entry === moduleUrl;
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
