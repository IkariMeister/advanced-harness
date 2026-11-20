import type {
  EvalResult,
  EvalRunManifest,
  EvalScenario,
  ExpectedOutcomeStatus,
  ResultOutcome,
} from './eval-contracts.ts';
import { validateResult } from './eval-contracts.ts';

/** Metrics recorded on an evaluation result. */
export type ResultMetrics = EvalResult['metrics'];
/** One check/execution evidence entry on an evaluation result. */
export type EvidenceEntry = EvalResult['evidence'][number];
/** One observable state check on an evaluation result. */
export type ObservableStateCheck = EvalResult['observableStateChecks'][number];

const NOT_OBSERVED = 'not observed';
const METRICS_NOT_OBSERVED = 'metrics not observed';

/** A final-state check reported by the runner, keyed by the scenario's assertion text. */
export interface ObservedFinalStateCheck {
  assertion: string;
  passed: boolean;
  observed: string;
}

export type ObservedViolationKind =
  | 'unscripted-request'
  | 'expectation-mismatch'
  | 'unoffered-tool'
  | 'forbidden-action';

/** A loopback violation or a forbidden action that happened during a completed run. */
export interface ObservedViolation {
  kind: ObservedViolationKind;
  detail: string;
}

/** Isolation facts observed during a run. Any entry is a breach. */
export interface IsolationFacts {
  unexpectedDestinations: readonly string[];
  credentialHeaders: readonly string[];
}

/**
 * The journey-record fields that metrics are mapped from. Read structurally, so this module
 * does not import from e2e/ and stays compatible with the journey record shape.
 */
export interface JourneyRecordMetricsInput {
  handoffCount: number;
  roleTransitions: ReadonlyArray<{ from: string; to: string }>;
  skillInvocations: ReadonlyArray<{ skillId: string | null; loaded: boolean }>;
}

interface RunFactsBase {
  runId: string;
  scenario: EvalScenario;
  durationMs: number;
}

/** A scenario deliberately not executed. */
export interface SkippedRunFacts extends RunFactsBase {
  kind: 'skipped';
  /** Why the run was not executed. */
  detail: string;
}

/** The runner, fixture, binary, sandbox, or binding failed. Not valid evidence. */
export interface InfrastructureFailureFacts extends RunFactsBase {
  kind: 'infrastructure_error';
  /** What failed. */
  detail: string;
  evidence?: readonly EvidenceEntry[];
}

/** A run that finished and produced observed facts. */
export interface CompletedRunFacts extends RunFactsBase {
  kind: 'completed';
  /** The status the run stopped with, in the vocabulary of expectedOutcome.status. */
  observedStatus: ExpectedOutcomeStatus;
  /** Checks for scenario assertions. Every entry must name a declared observableFinalState assertion. */
  finalStateChecks: readonly ObservedFinalStateCheck[];
  violations: readonly ObservedViolation[];
  evidence: readonly EvidenceEntry[];
  metrics: ResultMetrics;
  isolation?: IsolationFacts;
}

export type EvaluationFacts = SkippedRunFacts | InfrastructureFailureFacts | CompletedRunFacts;

/**
 * Builds a schema-valid evaluation result from observed facts (EDD outcome model).
 *
 * - pass: observed status equals the expected status and every observable final-state check holds.
 * - fail: observed behaviour contradicts the expectation (a check fails, a violation or forbidden
 *   action happened, or the observed status differs from the expected status).
 * - inconclusive: the run finished but evidence cannot decide (no evidence, a missing required
 *   artifact, a declared assertion with no check, or an observed inconclusive status).
 * - skipped: deliberately not executed.
 * - infrastructure_error: the runner failed, or isolation was breached.
 *
 * Metrics are zero with the reason "metrics not observed" for every outcome except pass and fail.
 * Throws when the facts break the contract (undeclared or duplicated final-state checks).
 */
export function evaluateScenario(facts: EvaluationFacts): EvalResult {
  switch (facts.kind) {
    case 'skipped':
      return finishWithoutMetrics(
        facts,
        'skipped',
        undefined,
        `deliberately not executed: ${facts.detail}`,
        [],
        [],
      );
    case 'infrastructure_error':
      return finishWithoutMetrics(
        facts,
        'infrastructure_error',
        undefined,
        facts.detail,
        [],
        [...(facts.evidence ?? [])],
      );
    case 'completed':
      return evaluateCompleted(facts);
  }
}

/** Maps a journey-record-shaped input to result metrics (metrics convention). Other counters are zero. */
export function metricsFromJourneyRecord(record: JourneyRecordMetricsInput): ResultMetrics {
  return {
    ...zeroMetrics(),
    handoffCount: record.handoffCount,
    roleTransitions: record.roleTransitions.map((t) => `${t.from}->${t.to}`),
    skillsInvoked: record.skillInvocations.flatMap((s) =>
      s.loaded && s.skillId !== null ? [s.skillId] : [],
    ),
  };
}

/**
 * Returns a stale-binding message when the scenario version differs from the version a binding
 * was made for, or undefined when they match. The caller records a mismatch as infrastructure_error.
 */
export function checkBoundScenarioVersion(
  scenario: Pick<EvalScenario, 'id' | 'version'>,
  boundVersion: string,
): string | undefined {
  if (scenario.version === boundVersion) return undefined;
  return `stale binding for ${scenario.id}: scenario version is ${scenario.version} but the binding was made for ${boundVersion}`;
}

export interface IsolationEvidenceInput {
  breached: boolean;
  networkRecordArtifact: string;
  enforcement: 'netns' | 'none';
  durationMs: number;
}

/** Builds the isolation evidence entry (isolation evidence): the network record and the enforcement value. */
export function isolationEvidence(input: IsolationEvidenceInput): EvidenceEntry {
  return {
    schemaVersion: 1,
    check: { name: 'isolation', category: 'custom' },
    execution: {
      command: 'network record check',
      exitStatus: input.breached ? 1 : 0,
      durationMs: input.durationMs,
      basis: 're-run',
    },
    artifacts: [input.networkRecordArtifact, `network.enforcement=${input.enforcement}`],
  };
}

/**
 * Removes what legitimately differs between repeats (repeatability normalization): runId, durationMs (top level and per
 * evidence execution), the run-directory prefix of artifact paths, and manifest createdAt.
 * Returns a new object; the input is not changed.
 */
export function normalizeForRepeatability(input: EvalResult | EvalRunManifest): Record<string, unknown> {
  if ('scenarioId' in input) return normalizeResult(input);
  const copy: Record<string, unknown> = { ...input };
  delete copy.runId;
  delete copy.createdAt;
  return copy;
}

export interface FieldDifference {
  path: string;
  first: unknown;
  second: unknown;
}

export interface RepeatabilityComparison {
  repeatable: boolean;
  differences: FieldDifference[];
}

/** Compares two repeats after normalization. Inputs are not changed and no outcome is altered. */
export function compareRepeats(
  first: EvalResult | EvalRunManifest,
  second: EvalResult | EvalRunManifest,
): RepeatabilityComparison {
  const differences: FieldDifference[] = [];
  diffValues(normalizeForRepeatability(first), normalizeForRepeatability(second), '', differences);
  return { repeatable: differences.length === 0, differences };
}

function evaluateCompleted(facts: CompletedRunFacts): EvalResult {
  const expected = facts.scenario.expectedOutcome.status;
  const observed = facts.observedStatus;
  const declared = facts.scenario.expectedOutcome.observableFinalState;

  if (facts.isolation !== undefined) {
    const breach = isolationBreach(facts.isolation);
    if (breach !== undefined) {
      return finishWithoutMetrics(facts, 'infrastructure_error', observed, breach, [], [...facts.evidence]);
    }
  }

  const byAssertion = indexFinalStateChecks(declared, facts.finalStateChecks);
  const checks: ObservableStateCheck[] = [expectedStatusCheck(expected, observed)];
  const missing: string[] = [];
  const failed: string[] = [];
  for (const assertion of declared) {
    const check = byAssertion.get(assertion);
    if (check === undefined) {
      missing.push(assertion);
      checks.push({ assertion, passed: false, observed: NOT_OBSERVED });
      continue;
    }
    if (!check.passed) failed.push(assertion);
    checks.push({ assertion, passed: check.passed, observed: textOrNotObserved(check.observed) });
  }
  for (const violation of facts.violations) {
    checks.push({
      assertion: `no ${violation.kind} violation`,
      passed: false,
      observed: textOrNotObserved(violation.detail),
    });
  }

  const statusClauseText = statusClause(observed, expected);
  const decided = (outcome: 'pass' | 'fail', why: string): EvalResult =>
    build(facts, outcome, `${statusClauseText}: ${why}.`, checks, [...facts.evidence], facts.metrics);
  const undecided = (why: string): EvalResult =>
    finishWithoutMetrics(facts, 'inconclusive', observed, why, checks, [...facts.evidence]);

  // A decided pass or fail needs evidence entries and at least one check (result schema).
  if (facts.evidence.length === 0) return undecided('no evidence entries were recorded');
  if (facts.violations.length > 0) {
    return decided('fail', `${facts.violations.length} violation(s) observed (${describeViolations(facts.violations)})`);
  }
  if (failed.length > 0) return decided('fail', `final-state check failed: ${failed.join('; ')}`);
  if (observed !== expected) {
    if (observed === 'inconclusive') {
      return undecided(`the run reported inconclusive, expected ${expected}`);
    }
    return decided('fail', `observed behaviour contradicts the expected status ${expected}`);
  }
  const missingArtifacts = requiredArtifactsMissing(
    facts.scenario.evidence.requiredArtifacts,
    facts.evidence,
  );
  if (missingArtifacts.length > 0) {
    return undecided(`required artifact(s) missing: ${missingArtifacts.join(', ')}`);
  }
  if (missing.length > 0) {
    return undecided(`final-state assertion(s) cannot be machine-checked: ${missing.join('; ')}`);
  }
  return decided('pass', `all ${declared.length} observable final-state check(s) held`);
}

function finishWithoutMetrics(
  base: RunFactsBase,
  outcome: Extract<ResultOutcome, 'skipped' | 'infrastructure_error' | 'inconclusive'>,
  observed: ExpectedOutcomeStatus | undefined,
  detail: string,
  checks: ObservableStateCheck[],
  evidence: EvidenceEntry[],
): EvalResult {
  requireText(detail, 'detail');
  const reason = `${statusClause(observed, base.scenario.expectedOutcome.status)}: ${detail}; ${METRICS_NOT_OBSERVED}.`;
  return build(base, outcome, reason, checks, evidence, zeroMetrics());
}

function build(
  base: RunFactsBase,
  outcome: ResultOutcome,
  reason: string,
  observableStateChecks: ObservableStateCheck[],
  evidence: EvidenceEntry[],
  metrics: ResultMetrics,
): EvalResult {
  return validateResult({
    schemaVersion: 1,
    runId: base.runId,
    scenarioId: base.scenario.id,
    scenarioVersion: base.scenario.version,
    outcome,
    reason,
    durationMs: base.durationMs,
    observableStateChecks,
    evidence,
    metrics,
  });
}

function statusClause(observed: ExpectedOutcomeStatus | undefined, expected: ExpectedOutcomeStatus): string {
  return `observed status ${observed ?? NOT_OBSERVED}, expected status ${expected}`;
}

function expectedStatusCheck(
  expected: ExpectedOutcomeStatus,
  observed: ExpectedOutcomeStatus,
): ObservableStateCheck {
  return {
    assertion: `observed status ${observed} matches expected ${expected}`,
    passed: observed === expected,
    observed: `observed status ${observed}`,
  };
}

function indexFinalStateChecks(
  declared: readonly string[],
  observed: readonly ObservedFinalStateCheck[],
): Map<string, ObservedFinalStateCheck> {
  const declaredSet = new Set(declared);
  const index = new Map<string, ObservedFinalStateCheck>();
  for (const check of observed) {
    if (!declaredSet.has(check.assertion)) {
      throw new Error(`Observed final-state check "${check.assertion}" is not declared by the scenario.`);
    }
    if (index.has(check.assertion)) {
      throw new Error(`Observed final-state check "${check.assertion}" was reported more than once.`);
    }
    index.set(check.assertion, check);
  }
  return index;
}

function requiredArtifactsMissing(required: readonly string[], evidence: readonly EvidenceEntry[]): string[] {
  const observedPaths = evidence.flatMap((entry) => entry.artifacts.map(toPosixPath));
  return required.filter((name) => {
    const wanted = toPosixPath(name);
    return !observedPaths.some((path) => path === wanted || path.endsWith(`/${wanted}`));
  });
}

function isolationBreach(isolation: IsolationFacts): string | undefined {
  const parts: string[] = [];
  if (isolation.unexpectedDestinations.length > 0) {
    parts.push(`unexpected network destination(s): ${isolation.unexpectedDestinations.join(', ')}`);
  }
  if (isolation.credentialHeaders.length > 0) {
    parts.push(`credential-shaped header(s): ${isolation.credentialHeaders.join(', ')}`);
  }
  return parts.length > 0 ? `isolation breached: ${parts.join('; ')}` : undefined;
}

function describeViolations(violations: readonly ObservedViolation[]): string {
  return violations.map((v) => `${v.kind}: ${v.detail}`).join('; ');
}

function zeroMetrics(): ResultMetrics {
  return {
    handoffCount: 0,
    roleTransitions: [],
    skillsInvoked: [],
    humanInterventions: 0,
    permissionAmbiguities: 0,
    reviewDetectedDefects: 0,
    escapedDefects: 0,
  };
}

function requireText(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function textOrNotObserved(value: string): string {
  return value.trim().length === 0 ? NOT_OBSERVED : value;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function stripRunDirectory(path: string, runId: string): string {
  const segments = path.split(/[\\/]/);
  const index = segments.lastIndexOf(runId);
  return (index === -1 ? segments : segments.slice(index + 1)).join('/');
}

function normalizeResult(result: EvalResult): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...result };
  delete copy.runId;
  delete copy.durationMs;
  copy.evidence = result.evidence.map((entry) => {
    const execution: Record<string, unknown> = { ...entry.execution };
    delete execution.durationMs;
    return {
      ...entry,
      execution,
      artifacts: entry.artifacts.map((path) => stripRunDirectory(path, result.runId)),
    };
  });
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diffValues(first: unknown, second: unknown, path: string, out: FieldDifference[]): void {
  if (Array.isArray(first) && Array.isArray(second)) {
    if (first.length !== second.length) {
      out.push({ path: `${path}.length`, first: first.length, second: second.length });
    }
    const shared = Math.min(first.length, second.length);
    for (let i = 0; i < shared; i += 1) {
      diffValues(first[i], second[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (isRecord(first) && isRecord(second)) {
    const keys = [...new Set([...Object.keys(first), ...Object.keys(second)])].sort();
    for (const key of keys) {
      const childPath = path === '' ? key : `${path}.${key}`;
      if (!(key in first) || !(key in second)) {
        out.push({ path: childPath, first: first[key], second: second[key] });
      } else {
        diffValues(first[key], second[key], childPath, out);
      }
    }
    return;
  }
  if (!Object.is(first, second)) {
    out.push({ path, first, second });
  }
}
