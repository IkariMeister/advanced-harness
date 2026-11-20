// Evaluation runner E2E (U3, issue #226). Opt-in and on demand: run `npm run eval:opencode:e2e`. It is kept out of
// `npm run e2e:opencode` and the agent-e2e CI job, for feedback-loop cost (the job's 20-minute timeout does not cover it).
// It needs a real OpenCode 2.3.0 binary in HARNESS_E2E_OPENCODE.
//
// Without the binary every test is SKIPPED (a skip is not a pass). With HARNESS_E2E_REQUIRE=1 a missing or wrong binary
// fails. A failing HARNESS_E2E_NETNS check fails the preflight test. The skip convention is the same as in
// e2e/opencode-journeys.e2e.ts.
//
// R1 and R3 read the development runs: EDD-DEV-010 at repeat 2, and EDD-DEV-004, EDD-DEV-008, and EDD-DEV-003 at repeat 1.
// R2 runs a test-only variant of EDD-DEV-003
// that is defined in this file. It is not product code and is not in the binding list. Nothing here is a required check.
// On Windows, EDD-DEV-008 cannot run (its stub scanner is POSIX), so its expected result there is infrastructure_error.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { loadScenarioCorpus, validateResult, validateRunManifest, type EvalResult, type EvalRunManifest } from '../../src/eval-contracts.ts';
import { runEvaluation, type EvaluationSummary } from './runner.ts';
import { shellStep, type ScenarioBinding } from './binding-support.ts';
import { binding as edd003 } from './bindings/EDD-DEV-003.ts';
import { finalText } from '../support/journey.ts';
import { currentLoopbackCheck, enforcementOf, resolveOpenCodeBinary } from '../support/opencode-sandbox.ts';

/** Five bound OpenCode runs (EDD-DEV-010 at repeat 2, the other three bound scenarios at repeat 1), plus fixture and sandbox time. Generous; not a pass criterion. */
const EVALUATION_TIMEOUT_MS = 1_500_000;
const VIOLATION_TIMEOUT_MS = 240_000;
const DEVELOPMENT_SET = 'development';
const CORPUS_DIRECTORY = fileURLToPath(new URL('../../eval/corpus/', import.meta.url));
const BOUND_SCENARIOS = ['EDD-DEV-004', 'EDD-DEV-010', 'EDD-DEV-008', 'EDD-DEV-003'] as const;
/** The POSIX-only binding (its stub scanner and shell cannot run on Windows). */
const PREFLIGHT_SCENARIO = 'EDD-DEV-008';
const VIOLATION_SCENARIO = 'EDD-DEV-003';
/** The only bound scenario that runs at repeat 2 (to show repeatability). The other bound scenarios run at repeat 1. */
const REPEATED_SCENARIO = 'EDD-DEV-010';
const REPEATED_REPEAT = 2;
const SINGLE_REPEAT = 1;
/** One runner call per repeat count. Each call covers its own scenario IDs, and R1 and R3 read both summaries. */
const DEVELOPMENT_PLAN: readonly { readonly repeat: number; readonly scenarioIds: readonly string[] }[] = [
  { repeat: REPEATED_REPEAT, scenarioIds: [REPEATED_SCENARIO] },
  { repeat: SINGLE_REPEAT, scenarioIds: BOUND_SCENARIOS.filter(scenarioId => scenarioId !== REPEATED_SCENARIO) },
];
/** The positive EDD-DEV-003 final-state check that the unapproved file breaks. */
const CANONICAL_CHECK = 'canonical checkout remains clean on updated main';
const UNAPPROVED_FILE = 'UNAPPROVED-E2E.md';
const TASK_BRANCH = 'issue/90102';
const WORKTREE_PATH = '../worktrees/issue-90102';
const RESULT_FILE = 'result.json';
const MANIFEST_FILE = 'run-manifest.json';
const ISOLATION_CHECK = 'isolation';
/** Outcomes that mean the run finished and was judged, so its isolation evidence exists. */
const EXECUTED_OUTCOMES: readonly string[] = ['pass', 'fail', 'inconclusive'];

const TITLE_R1 = 'R1 bound development scenarios match their corpus outcomes (EDD-DEV-010 at repeat 2; EDD-DEV-004, 008, 003 at repeat 1)';
const TITLE_R2 = 'R2 deliberate unapproved file fails the EDD-DEV-003 final-state check (test-only variant)';
const TITLE_R3 = 'R3 every executed result records networkAllowed false and the enforcement value';
const TITLES = [TITLE_R1, TITLE_R2, TITLE_R3];

// ---------------------------------------------------------------------------
// Test-only variant. A copy of the positive EDD-DEV-003 steps, plus one Operator shell step that writes an unapproved
// file into the scratch repository. The canonical-checkout check then sees a dirty checkout.
// ---------------------------------------------------------------------------

const VIOLATING_BINDING: ScenarioBinding = {
  ...edd003,
  steps: {
    ...edd003.steps,
    operator: [
      shellStep('git status --porcelain'),
      finalText('E3 operator inspection final'),
      shellStep(`git worktree add -b ${TASK_BRANCH} ${WORKTREE_PATH} origin/main`),
      shellStep(`echo unapproved > ${UNAPPROVED_FILE}`),
      finalText('E3 operator worktree final'),
    ],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let temporaryRoot: string | undefined;

/** One temporary root for every run in this file, removed when the file's tests finish. */
function rootDirectory(): string {
  temporaryRoot ??= mkdtempSync(join(tmpdir(), 'advanced-harness-eval-e2e-'));
  return temporaryRoot;
}

after(() => {
  if (temporaryRoot !== undefined) rmSync(temporaryRoot, { recursive: true, force: true });
});

/** Memoises a task so that two tests can share one runner run. The task runs at most once. */
function once<T>(task: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= task();
    return pending;
  };
}

/** The corpus status for a development scenario (the expected outcome, not a hard-coded value). */
function expectedStatusOf(scenarioId: string): string {
  const scenario = loadScenarioCorpus(CORPUS_DIRECTORY).development.find(candidate => candidate.id === scenarioId);
  assert.ok(scenario, `${scenarioId} must be in the development corpus`);
  return scenario.expectedOutcome.status;
}

function repeatDirectory(summary: EvaluationSummary, scenarioId: string, repeat: number): string {
  return join(summary.directory, scenarioId, String(repeat));
}

function readResult(summary: EvaluationSummary, scenarioId: string, repeat: number): EvalResult {
  return validateResult(JSON.parse(readFileSync(join(repeatDirectory(summary, scenarioId, repeat), RESULT_FILE), 'utf8')));
}

function readManifest(summary: EvaluationSummary, scenarioId: string, repeat: number): EvalRunManifest {
  return validateRunManifest(JSON.parse(readFileSync(join(repeatDirectory(summary, scenarioId, repeat), MANIFEST_FILE), 'utf8')));
}

// ---------------------------------------------------------------------------
// Runs (memoised, so R1 and R3 share one development run, and R2 and R3 share one violation run)
// ---------------------------------------------------------------------------

interface DevelopmentRun {
  readonly repeat: number;
  readonly scenarioIds: readonly string[];
  readonly summary: EvaluationSummary;
}

/** The development runs, one runner call per plan entry, run one after another. Memoised like the violation run. */
const developmentRuns = once(async (): Promise<DevelopmentRun[]> => {
  const runs: DevelopmentRun[] = [];
  for (const plan of DEVELOPMENT_PLAN) {
    const summary = await runEvaluation({
      set: DEVELOPMENT_SET,
      scenarioIds: [...plan.scenarioIds],
      repeat: plan.repeat,
      outDirectory: join(rootDirectory(), `development-repeat-${plan.repeat}`),
    });
    runs.push({ repeat: plan.repeat, scenarioIds: plan.scenarioIds, summary });
  }
  return runs;
});

const violationRun = once(() => runEvaluation({
  set: DEVELOPMENT_SET,
  scenarioIds: [VIOLATION_SCENARIO],
  repeat: 1,
  outDirectory: join(rootDirectory(), 'violation'),
  bindingOf: scenarioId => (scenarioId === VIOLATION_SCENARIO ? VIOLATING_BINDING : undefined),
}));

// ---------------------------------------------------------------------------
// Registration. Skip, error, or run; never a silent pass.
// ---------------------------------------------------------------------------

const netnsCheck = currentLoopbackCheck(process.env.HARNESS_E2E_NETNS);
const resolution = resolveOpenCodeBinary(process.env);
const preflightFailures = [
  netnsCheck.status === 'failed' ? netnsCheck.reason : undefined,
].filter((reason): reason is string => reason !== undefined);

if (preflightFailures.length > 0) {
  // A failing preflight means no runner test passes.
  test('Evaluation runner E2E preflight check', () => {
    assert.fail(preflightFailures.join(' '));
  });
} else if (resolution.status === 'skip') {
  for (const title of TITLES) test(title, { skip: resolution.reason }, () => undefined);
} else if (resolution.status === 'error') {
  test('Evaluation runner E2E preflight check', () => {
    assert.fail(resolution.reason);
  });
} else {
  test(TITLE_R1, { timeout: EVALUATION_TIMEOUT_MS }, async () => {
    for (const run of await developmentRuns()) {
      const { summary } = run;
      assert.equal(summary.openCode.status, 'ready', `the runner must find OpenCode ready; received ${JSON.stringify(summary.openCode)}`);
      assert.equal(summary.repeat, run.repeat, `the repeat count must be ${run.repeat}; received ${summary.repeat}`);
      assert.deepEqual(
        summary.scenarios.map(scenario => scenario.scenarioId).sort(),
        [...run.scenarioIds].sort(),
        `the run at repeat ${run.repeat} must cover exactly ${run.scenarioIds.join(', ')}`,
      );
      assert.equal(summary.repeatable, true, `summary.repeatable must be true; differences: ${JSON.stringify(summary.scenarios.map(scenario => [scenario.scenarioId, scenario.differences]))}`);
      for (const scenarioId of run.scenarioIds) {
        const scenario = summary.scenarios.find(candidate => candidate.scenarioId === scenarioId);
        assert.ok(scenario, `${scenarioId} must be in the run summary`);
        assert.equal(scenario.bound, true, `${scenarioId} must be bound`);
        assert.equal(scenario.repeatable, true, `${scenarioId} must be repeatable`);
        const expected = expectedStatusOf(scenarioId);
        // A pass means the observed status equals the corpus status and every final-state check held.
        const expectedOutcome = scenarioId === PREFLIGHT_SCENARIO && process.platform === 'win32' ? 'infrastructure_error' : 'pass';
        assert.deepEqual(scenario.outcomes, Array.from({ length: run.repeat }, () => expectedOutcome), `${scenarioId}: outcomes must be ${expectedOutcome} at every repeat; received ${JSON.stringify(scenario.outcomes)}`);
        for (let repeat = 1; repeat <= run.repeat; repeat += 1) {
          const result = readResult(summary, scenarioId, repeat);
          assert.equal(result.outcome, expectedOutcome, `${scenarioId} repeat ${repeat}: outcome must be ${expectedOutcome}; reason: ${result.reason}`);
          if (expectedOutcome === 'pass') {
            const statusAssertion = `observed status ${expected} matches expected ${expected}`;
            assert.ok(
              result.observableStateChecks.some(check => check.assertion === statusAssertion && check.passed),
              `${scenarioId} repeat ${repeat}: the check "${statusAssertion}" must be present and passed; reason: ${result.reason}`,
            );
          } else {
            // Windows: the binding fails in prepare, so the reason names the POSIX requirement.
            assert.ok(result.reason.includes('POSIX'), `${scenarioId} repeat ${repeat}: the infrastructure reason must name the POSIX requirement; received ${result.reason}`);
          }
        }
      }
    }
  });

  test(TITLE_R2, { timeout: VIOLATION_TIMEOUT_MS }, async () => {
    const summary = await violationRun();
    const scenario = summary.scenarios.find(candidate => candidate.scenarioId === VIOLATION_SCENARIO);
    assert.ok(scenario, `${VIOLATION_SCENARIO} must be in the violation run summary`);
    assert.deepEqual(scenario.outcomes, ['fail'], `the violation run must fail; received ${JSON.stringify(scenario.outcomes)}`);
    const result = readResult(summary, VIOLATION_SCENARIO, 1);
    assert.equal(result.outcome, 'fail', `the result must be fail; reason: ${result.reason}`);
    assert.ok(
      result.reason.includes(`final-state check failed: ${CANONICAL_CHECK}`),
      `the reason must name the failing final-state check "${CANONICAL_CHECK}"; received ${result.reason}`,
    );
    const check = result.observableStateChecks.find(candidate => candidate.assertion === CANONICAL_CHECK);
    assert.ok(check, `the result must carry the check "${CANONICAL_CHECK}"`);
    assert.equal(check.passed, false, `the check "${CANONICAL_CHECK}" must not pass; observed: ${check.observed}`);
    assert.ok(check.observed.includes('dirty'), `the check must observe the dirty checkout left by the unapproved file; observed: ${check.observed}`);
  });

  test(TITLE_R3, { timeout: EVALUATION_TIMEOUT_MS }, async () => {
    const runs = [...(await developmentRuns()).map(run => run.summary), await violationRun()];
    const expectedEnforcement = enforcementOf(netnsCheck);
    let checked = 0;
    for (const summary of runs) {
      assert.equal(summary.enforcement, expectedEnforcement, `the run enforcement must be ${expectedEnforcement}; received ${summary.enforcement}`);
      for (const scenario of summary.scenarios) {
        for (let repeat = 1; repeat <= scenario.outcomes.length; repeat += 1) {
          const result = readResult(summary, scenario.scenarioId, repeat);
          if (!EXECUTED_OUTCOMES.includes(result.outcome)) continue;
          const isolation = result.evidence.filter(entry => entry.check.name === ISOLATION_CHECK);
          assert.equal(isolation.length, 1, `${scenario.scenarioId} repeat ${repeat}: exactly one isolation evidence entry is required; received ${isolation.length}`);
          const entry = isolation[0];
          assert.ok(entry, `${scenario.scenarioId} repeat ${repeat}: the isolation entry must exist`);
          assert.ok(
            entry.artifacts.includes(`network.enforcement=${expectedEnforcement}`),
            `${scenario.scenarioId} repeat ${repeat}: the isolation evidence must record network.enforcement=${expectedEnforcement}; received ${JSON.stringify(entry.artifacts)}`,
          );
          // networkAllowed is recorded in the run manifest beside the result, not in the isolation evidence entry.
          const manifest = readManifest(summary, scenario.scenarioId, repeat);
          assert.equal(manifest.isolation.networkAllowed, false, `${scenario.scenarioId} repeat ${repeat}: the run manifest must record networkAllowed false`);
          checked += 1;
        }
      }
    }
    assert.ok(checked > 0, 'at least one executed result must be checked');
  });
}
