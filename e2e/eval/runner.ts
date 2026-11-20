// Evaluation runner (U2, issue #226). Runs the development scenarios that have a deterministic binding through the agent
// E2E harness, and writes run manifests, per-repeat evaluation results, and a run summary. A scenario without a binding
// is skipped. A process starts only when HARNESS_E2E_OPENCODE names a ready OpenCode 2.3.0 binary and the network check
// passes (see planScenario).
//
// Layout: <out>/<runId>/summary.json, and <out>/<runId>/<scenarioId>/<repeat>/{run-manifest.json, result.json, artifacts/}.
// Exit status (exitStatusOf): 1 for any fail, inconclusive, or infrastructure_error result, any non-repeatable scenario,
// or zero executed scenarios. Skipped scenarios alone do not fail a run.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadScenarioCorpus,
  validateResult,
  validateRubric,
  validateRunManifest,
  type EvalRubric,
  type EvalResult,
  type EvalRunManifest,
  type EvalScenario,
  type ResultOutcome,
  type ScenarioSet,
} from '../../src/eval-contracts.ts';
import {
  checkBoundScenarioVersion,
  compareRepeats,
  evaluateScenario,
  isolationEvidence,
  metricsFromJourneyRecord,
  type EvaluationFacts,
  type EvidenceEntry,
  type FieldDifference,
  type ObservedViolation,
} from '../../src/eval-evaluate.ts';
import { defineJourney, ROLE_MODEL_MAP, runJourney, startJourneyFixture, type JourneyRun, type JourneyViolation } from '../support/journey.ts';
import type { LoopbackModel } from '../support/loopback-model.ts';
import {
  createOpenCodeSandbox,
  currentLoopbackCheck,
  enforcementOf,
  PROVIDER,
  resolveOpenCodeBinary,
  type BinaryResolution,
  type NetnsCheck,
  type OpenCodeSandbox,
} from '../support/opencode-sandbox.ts';
import { findBinding } from './bindings/index.ts';
import { jsonText, LOOPBACK_TRANSCRIPT, type BindingContext, type BindingJudgement, type ScenarioBinding } from './binding-support.ts';

const CORPUS_DIRECTORY = fileURLToPath(new URL('../../eval/corpus/', import.meta.url));
const RUBRIC_FILE = fileURLToPath(new URL('../../eval/rubrics/deterministic-v1.json', import.meta.url));
export const DEFAULT_REPEAT = 2;
export const NOT_CONFIGURED_REASON = 'OpenCode not configured';
export const UNBOUND_REASON = 'no deterministic binding; requires live mode';
const OPENCODE_VARIABLE = 'HARNESS_E2E_OPENCODE';
const NETNS_VARIABLE = 'HARNESS_E2E_NETNS';
const ARTIFACT_DIRECTORY = 'artifacts';
const MANIFEST_FILE = 'run-manifest.json';
const RESULT_FILE = 'result.json';
const SUMMARY_FILE = 'summary.json';
const EXECUTION_COMMAND = 'opencode run against the loopback model fixture (scripted journey)';

export type OpenCodeStatus =
  | { status: 'not-configured' }
  | { status: 'error'; reason: string }
  | { status: 'ready'; version: string };

export interface ScenarioSummary {
  scenarioId: string;
  scenarioVersion: string;
  bound: boolean;
  /** One outcome per repeat, in repeat order. */
  outcomes: ResultOutcome[];
  /** The first repeat's reason, for reading the run. */
  reason: string;
  repeatable: boolean;
  /** Differences between the first repeat and each later repeat, after normalization. Empty when repeatable. */
  differences: FieldDifference[];
}

export interface EvaluationSummary {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  set: ScenarioSet;
  /** True for the validation set: a holdout run, read as such. */
  holdout: boolean;
  repeat: number;
  openCode: OpenCodeStatus;
  enforcement: 'netns' | 'none';
  scenarios: ScenarioSummary[];
  /** Scenarios with at least one repeat that was not skipped. */
  executed: number;
  /** True when every scenario's repeats gave the same normalized result. */
  repeatable: boolean;
  exitCode: 0 | 1;
  /** Absolute run directory, <out>/<runId>. */
  directory: string;
}

export interface EvaluationOptions {
  set: ScenarioSet;
  /** Scenario IDs to run from the chosen set. Empty or absent: every scenario in the set. */
  scenarioIds?: readonly string[] | undefined;
  /** Runs per scenario. Defaults to DEFAULT_REPEAT. */
  repeat?: number | undefined;
  /** Absolute output directory. */
  outDirectory: string;
  /** Environment to read HARNESS_E2E_* from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => Date) | undefined;
  runId?: string | undefined;
  /** Test seams. Production uses the defaults: resolveOpenCodeBinary and currentLoopbackCheck. */
  resolveBinary?: ((env: NodeJS.ProcessEnv) => BinaryResolution) | undefined;
  checkNetwork?: ((flag: string | undefined) => NetnsCheck) | undefined;
  /** Test seam: binding lookup by scenario ID. Production uses the default findBinding. */
  bindingOf?: ((scenarioId: string) => ScenarioBinding | undefined) | undefined;
}

/** What the environment allows for this run. Computed once, before any scenario. */
export interface Availability {
  openCode: OpenCodeStatus;
  enforcement: 'netns' | 'none';
  binary?: string | undefined;
  version?: string | undefined;
  /** A reason every bound scenario fails with infrastructure_error (a binary error or a failed network check). */
  blocker?: string | undefined;
}

/** What one scenario does in this run. */
export type Plan =
  | { kind: 'skipped'; detail: string }
  | { kind: 'infrastructure_error'; detail: string }
  | { kind: 'run'; binding: ScenarioBinding; binary: string; version: string; enforcement: 'netns' | 'none' };

/**
 * Reads the environment once. Unset HARNESS_E2E_OPENCODE: not configured (every scenario is skipped). Otherwise the
 * binary is resolved (an error is a blocker), and HARNESS_E2E_NETNS is checked (a failed check is a blocker).
 */
export function availabilityOf(
  env: NodeJS.ProcessEnv,
  resolveBinary: (environment: NodeJS.ProcessEnv) => BinaryResolution,
  checkNetwork: (flag: string | undefined) => NetnsCheck,
): Availability {
  if (env[OPENCODE_VARIABLE] === undefined) return { openCode: { status: 'not-configured' }, enforcement: 'none' };
  const resolved = resolveBinary(env);
  if (resolved.status === 'skip') return { openCode: { status: 'not-configured' }, enforcement: 'none' };
  if (resolved.status === 'error') {
    return { openCode: { status: 'error', reason: resolved.reason }, enforcement: 'none', blocker: resolved.reason };
  }
  const network = checkNetwork(env[NETNS_VARIABLE]);
  const base: Availability = {
    openCode: { status: 'ready', version: resolved.version },
    enforcement: enforcementOf(network),
    binary: resolved.binary,
    version: resolved.version,
  };
  return network.status === 'failed' ? { ...base, blocker: network.reason } : base;
}

/**
 * The plan for one scenario, in this order: not configured (skip); unbound (skip); stale binding version
 * (infrastructure_error); a blocker (infrastructure_error); otherwise run. Pure: no process is started here.
 */
export function planScenario(
  scenario: Pick<EvalScenario, 'id' | 'version'>,
  binding: ScenarioBinding | undefined,
  availability: Availability,
): Plan {
  if (availability.openCode.status === 'not-configured') return { kind: 'skipped', detail: NOT_CONFIGURED_REASON };
  if (binding === undefined) return { kind: 'skipped', detail: UNBOUND_REASON };
  const stale = checkBoundScenarioVersion(scenario, binding.scenarioVersion);
  if (stale !== undefined) return { kind: 'infrastructure_error', detail: stale };
  if (availability.blocker !== undefined || availability.binary === undefined || availability.version === undefined) {
    return { kind: 'infrastructure_error', detail: availability.blocker ?? 'OpenCode is not ready' };
  }
  return { kind: 'run', binding, binary: availability.binary, version: availability.version, enforcement: availability.enforcement };
}

/** Exit status for a run's scenarios (see the file header). */
export function exitStatusOf(scenarios: readonly Pick<ScenarioSummary, 'outcomes' | 'repeatable'>[]): 0 | 1 {
  const executed = scenarios.some(scenario => scenario.outcomes.some(outcome => outcome !== 'skipped'));
  if (!executed) return 1;
  const blocked = scenarios.some(scenario => !scenario.repeatable || scenario.outcomes.some(outcome => outcome !== 'pass' && outcome !== 'skipped'));
  return blocked ? 1 : 0;
}

/** The selected scenarios: every scenario of the set, or the named ones. An unknown ID is an error. */
export function selectScenarios(pool: readonly EvalScenario[], set: ScenarioSet, ids: readonly string[]): EvalScenario[] {
  if (ids.length === 0) return [...pool];
  const wanted = [...new Set(ids)];
  const missing = wanted.filter(id => !pool.some(scenario => scenario.id === id));
  if (missing.length > 0) throw new Error(`No ${set} scenario has the ID ${missing.join(', ')}.`);
  return pool.filter(scenario => wanted.includes(scenario.id));
}

/** Maps a journey-run violation to an observed violation. Network and credential findings are forbidden actions. */
export function observedViolationsOf(violations: readonly JourneyViolation[]): ObservedViolation[] {
  return violations.map(violation => ({
    kind: violationKind(violation.expected),
    detail: `step ${violation.step === null ? 'none' : String(violation.step)}: expected ${violation.expected}; received ${violation.received}`,
  }));
}

function violationKind(expected: string): ObservedViolation['kind'] {
  if (expected.startsWith('no connection through') || expected.startsWith('no request carries')) return 'forbidden-action';
  if (expected.startsWith('a scripted step')) return 'unscripted-request';
  if (expected.startsWith('tool ')) return 'unoffered-tool';
  return 'expectation-mismatch';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function newRunId(createdAt: string): string {
  return `run-${createdAt.replace(/\D/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
}

function manifestFor(rubric: EvalRubric, runId: string, createdAt: string, scenarioIdentifier: string): EvalRunManifest {
  return validateRunManifest({
    schemaVersion: 1,
    runId,
    createdAt,
    mode: 'deterministic',
    host: 'opencode',
    roleSetup: 'eight-role',
    modelConfig: { provider: PROVIDER, fixtureLoopbackOnly: true, roleModels: { ...ROLE_MODEL_MAP } },
    rubricId: rubric.id,
    rubricVersion: rubric.version,
    isolation: { tempRepo: true, isolatedConfig: true, networkAllowed: false },
    scenarioIds: [scenarioIdentifier],
  });
}

/** A result for a scenario that did not run: skipped or infrastructure_error, with no metrics. */
function resultWithoutRun(scenario: EvalScenario, plan: Exclude<Plan, { kind: 'run' }>, runId: string): EvalResult {
  const base = { runId, scenario, durationMs: 0 };
  return plan.kind === 'skipped'
    ? evaluateScenario({ kind: 'skipped', ...base, detail: plan.detail })
    : evaluateScenario({ kind: 'infrastructure_error', ...base, detail: plan.detail });
}

/** Judges one finished run. A run that did not complete cleanly (timeout, idle timeout, non-zero exit) is inconclusive. */
function evaluateExecution(
  scenario: EvalScenario,
  binding: ScenarioBinding,
  runId: string,
  context: BindingContext,
  enforcement: 'netns' | 'none',
  artifactNames: readonly string[],
): EvalResult {
  const { run } = context;
  const completedCleanly = run.run.status === 'completed' && run.run.exitCode === 0;
  const judged: BindingJudgement = completedCleanly
    ? binding.judge(context)
    : { observedStatus: 'inconclusive', finalStateChecks: [], violations: [] };
  const breached = run.record.network.unexpectedDestinations.length > 0 || run.record.credentialHeaders.length > 0;
  const evidence: EvidenceEntry[] = [
    {
      schemaVersion: 1,
      check: { name: `${scenario.id} scripted journey`, category: 'e2e' },
      execution: {
        command: judged.note === undefined ? EXECUTION_COMMAND : `${EXECUTION_COMMAND}; ${judged.note}`,
        exitStatus: run.run.exitCode ?? 1,
        durationMs: run.run.durationMs,
        basis: 're-run',
      },
      artifacts: artifactNames.map(name => `${ARTIFACT_DIRECTORY}/${name}`),
    },
    isolationEvidence({
      breached,
      networkRecordArtifact: `${ARTIFACT_DIRECTORY}/${LOOPBACK_TRANSCRIPT}`,
      enforcement,
      durationMs: run.run.durationMs,
    }),
  ];
  const facts: EvaluationFacts = {
    kind: 'completed',
    runId,
    scenario,
    durationMs: run.run.durationMs,
    observedStatus: judged.observedStatus,
    finalStateChecks: judged.finalStateChecks,
    violations: completedCleanly ? [...observedViolationsOf(run.record.violations), ...judged.violations] : [],
    evidence,
    metrics: metricsFromJourneyRecord(run.record),
    isolation: {
      unexpectedDestinations: run.record.network.unexpectedDestinations,
      credentialHeaders: run.record.credentialHeaders,
    },
  };
  return evaluateScenario(facts);
}

interface Execution {
  result: EvalResult;
  /** Artifact file name to content, including the journey transcript. Empty when no run happened. */
  artifacts: ReadonlyMap<string, string>;
}

/**
 * Runs one bound scenario once. The fixture starts first (its base URL goes into the sandbox install commit), then the
 * sandbox, then the journey. Any failure after the sandbox starts is an infrastructure_error. Both are always cleaned up.
 */
async function executeBound(scenario: EvalScenario, plan: Extract<Plan, { kind: 'run' }>, runId: string): Promise<Execution> {
  const started = Date.now();
  const binding = plan.binding;
  const definition = defineJourney({ name: scenario.id.toLowerCase(), steps: binding.steps });
  let fixture: LoopbackModel | undefined;
  let sandbox: OpenCodeSandbox | undefined;
  try {
    fixture = await startJourneyFixture(definition);
    sandbox = createOpenCodeSandbox(definition.name, { baseURL: fixture.baseURL });
    const prepared = binding.prepare === undefined ? {} : binding.prepare(sandbox);
    const headBefore = sandbox.git(['rev-parse', 'HEAD']).trim();
    const run: JourneyRun = await runJourney(sandbox, fixture, definition, {
      binary: plan.binary,
      version: plan.version,
      message: binding.message,
      auto: true,
      enforcement: plan.enforcement,
    });
    const context: BindingContext = { sandbox, run, prepared, headBefore };
    const artifacts = new Map<string, string>([[LOOPBACK_TRANSCRIPT, run.serialized]]);
    for (const [name, produce] of Object.entries(binding.artifacts)) artifacts.set(name, produce(context));
    const result = evaluateExecution(scenario, binding, runId, context, plan.enforcement, [...artifacts.keys()]);
    return { result, artifacts };
  } catch (error) {
    return {
      result: evaluateScenario({ kind: 'infrastructure_error', runId, scenario, durationMs: Date.now() - started, detail: `runner failure: ${errorMessage(error)}` }),
      artifacts: new Map<string, string>(),
    };
  } finally {
    if (fixture !== undefined) await fixture.close();
    sandbox?.dispose();
  }
}

function writeRepeat(directory: string, manifest: EvalRunManifest, result: EvalResult, artifacts: ReadonlyMap<string, string>): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, MANIFEST_FILE), jsonText(validateRunManifest(manifest)));
  writeFileSync(join(directory, RESULT_FILE), jsonText(validateResult(result)));
  if (artifacts.size === 0) return;
  const artifactDirectory = join(directory, ARTIFACT_DIRECTORY);
  mkdirSync(artifactDirectory, { recursive: true });
  for (const [name, content] of artifacts) writeFileSync(join(artifactDirectory, name), content);
}

/**
 * Runs the selected scenarios and writes the run. Repeats run one after another. Throws only for a usage or corpus
 * error (a bad repeat count, a relative output directory, an unknown scenario ID); every scenario-level problem is
 * recorded as a result instead.
 */
export async function runEvaluation(options: EvaluationOptions): Promise<EvaluationSummary> {
  const env = options.env ?? process.env;
  const repeat = options.repeat ?? DEFAULT_REPEAT;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error(`Repeat count must be a positive integer: ${String(repeat)}.`);
  if (!isAbsolute(options.outDirectory)) throw new Error('The output directory must be an absolute path.');
  const corpus = loadScenarioCorpus(CORPUS_DIRECTORY);
  const pool = options.set === 'development' ? corpus.development : corpus.validation;
  const selected = selectScenarios(pool, options.set, options.scenarioIds ?? []);
  const rubric = validateRubric(JSON.parse(readFileSync(RUBRIC_FILE, 'utf8')), 'rubric');
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const runId = options.runId ?? newRunId(createdAt);
  const directory = join(options.outDirectory, runId);
  mkdirSync(directory, { recursive: true });
  const availability = availabilityOf(
    env,
    options.resolveBinary ?? ((environment: NodeJS.ProcessEnv): BinaryResolution => resolveOpenCodeBinary(environment)),
    options.checkNetwork ?? currentLoopbackCheck,
  );

  const scenarios: ScenarioSummary[] = [];
  const bindingOf = options.bindingOf ?? findBinding;
  for (const scenario of selected) {
    const binding = bindingOf(scenario.id);
    const plan = planScenario(scenario, binding, availability);
    const results: EvalResult[] = [];
    for (let number = 1; number <= repeat; number += 1) {
      const execution: Execution = plan.kind === 'run'
        ? await executeBound(scenario, plan, runId)
        : { result: resultWithoutRun(scenario, plan, runId), artifacts: new Map<string, string>() };
      writeRepeat(join(directory, scenario.id, String(number)), manifestFor(rubric, runId, createdAt, scenario.id), execution.result, execution.artifacts);
      results.push(execution.result);
    }
    const first = results[0]!;
    const comparisons = results.slice(1).map(other => compareRepeats(first, other));
    scenarios.push({
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      bound: binding !== undefined,
      outcomes: results.map(result => result.outcome),
      reason: first.reason,
      repeatable: comparisons.every(comparison => comparison.repeatable),
      differences: comparisons.flatMap(comparison => comparison.differences),
    });
  }

  const summary: EvaluationSummary = {
    schemaVersion: 1,
    runId,
    createdAt,
    set: options.set,
    holdout: options.set === 'validation',
    repeat,
    openCode: availability.openCode,
    enforcement: availability.enforcement,
    scenarios,
    executed: scenarios.filter(scenario => scenario.outcomes.some(outcome => outcome !== 'skipped')).length,
    repeatable: scenarios.every(scenario => scenario.repeatable),
    exitCode: exitStatusOf(scenarios),
    directory,
  };
  writeFileSync(join(directory, SUMMARY_FILE), jsonText(summary));
  return summary;
}
