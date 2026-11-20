import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020Import from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import {
  validateResult,
  validateRubric,
  validateRunManifest,
  validateScenario,
} from '../src/eval-contracts.ts';
import type { EvalResult, EvalRunManifest, EvalScenario } from '../src/eval-contracts.ts';
import {
  checkBoundScenarioVersion,
  compareRepeats,
  evaluateScenario,
  isolationEvidence,
  metricsFromJourneyRecord,
  normalizeForRepeatability,
} from '../src/eval-evaluate.ts';
import type {
  CompletedRunFacts,
  EvaluationFacts,
  EvidenceEntry,
  ObservedFinalStateCheck,
  ObservedViolationKind,
  ResultMetrics,
} from '../src/eval-evaluate.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..');

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf8'));
}

type AjvInstance = { compile: (schema: object) => ValidateFunction };
type AjvCtor = new (opts: {
  allErrors: boolean;
  strictSchema: boolean;
  strictTypes: boolean;
}) => AjvInstance;
const Ajv2020 =
  (Ajv2020Import as unknown as { default?: AjvCtor }).default ??
  (Ajv2020Import as unknown as AjvCtor);

const ajv = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false });
const validateResultSchema = ajv.compile(readJson('eval/schemas/result.schema.json') as object);
const validateRubricSchema = ajv.compile(readJson('eval/schemas/rubric.schema.json') as object);

function assertSchemaValid(
  validator: { (data: unknown): boolean; errors?: unknown },
  data: unknown,
  label: string,
): void {
  const ok = validator(data);
  assert.equal(
    ok,
    true,
    `${label} failed JSON Schema validation: ${JSON.stringify(validator.errors)}`,
  );
}

/** Every produced result must pass both the TypeScript validator and the JSON Schema. */
function assertProducedResultValid(result: EvalResult): void {
  validateResult(result, 'produced result');
  assertSchemaValid(validateResultSchema, result, `result ${result.scenarioId} ${result.outcome}`);
}

const baseScenario: EvalScenario = validateScenario(
  readJson('eval/examples/scenario.example.json'),
);

const negativeScenario: EvalScenario = {
  ...baseScenario,
  polarity: 'negative',
  expectedOutcome: { ...baseScenario.expectedOutcome, status: 'fail' },
};

const ZERO_METRICS: ResultMetrics = {
  handoffCount: 0,
  roleTransitions: [],
  skillsInvoked: [],
  humanInterventions: 0,
  permissionAmbiguities: 0,
  reviewDetectedDefects: 0,
  escapedDefects: 0,
};

function evidenceEntry(
  artifacts: string[] = ['loopback-transcript.json', 'git-status.txt'],
  durationMs = 18,
): EvidenceEntry {
  return {
    schemaVersion: 1,
    check: { name: 'edd-git-status', category: 'custom' },
    execution: { command: 'git status --porcelain', exitStatus: 0, durationMs, basis: 're-run' },
    artifacts,
  };
}

function passingChecks(scenario: EvalScenario): ObservedFinalStateCheck[] {
  return scenario.expectedOutcome.observableFinalState.map((assertion) => ({
    assertion,
    passed: true,
    observed: `${assertion}: held`,
  }));
}

function completedFacts(overrides: Partial<CompletedRunFacts> = {}): CompletedRunFacts {
  return {
    kind: 'completed',
    runId: 'edd-run-test-001',
    scenario: baseScenario,
    durationMs: 420,
    observedStatus: 'pass',
    finalStateChecks: passingChecks(baseScenario),
    violations: [],
    evidence: [evidenceEntry()],
    metrics: {
      ...ZERO_METRICS,
      handoffCount: 2,
      roleTransitions: ['lead->external', 'lead->planner'],
      humanInterventions: 1,
    },
    ...overrides,
  };
}

function run(facts: EvaluationFacts): EvalResult {
  const result = evaluateScenario(facts);
  assertProducedResultValid(result);
  return result;
}

describe('evaluateScenario outcome paths (EDD outcome model)', () => {
  it('passes when the observed status and every final-state check match', () => {
    const result = run(completedFacts());
    assert.equal(result.outcome, 'pass');
    assert.deepEqual(result.observableStateChecks[0], {
      assertion: 'observed status pass matches expected pass',
      passed: true,
      observed: 'observed status pass',
    });
    assert.match(result.reason, /observed status pass, expected status pass/);
    assert.deepEqual(result.metrics.roleTransitions, ['lead->external', 'lead->planner']);
    assert.equal(result.metrics.handoffCount, 2);
    assert.equal(result.scenarioId, 'EDD-DEV-001');
    assert.equal(result.scenarioVersion, '1.0.0');
  });

  it('fails when a final-state check fails', () => {
    const checks = passingChecks(baseScenario);
    const first = checks[0];
    assert.ok(first);
    checks[0] = { ...first, passed: false, observed: 'worktree dirty' };
    const result = run(completedFacts({ finalStateChecks: checks }));
    assert.equal(result.outcome, 'fail');
    assert.equal(result.observableStateChecks[1]?.passed, false);
    assert.match(result.reason, /final-state check failed/);
  });

  for (const kind of [
    'unscripted-request',
    'expectation-mismatch',
    'unoffered-tool',
    'forbidden-action',
  ] satisfies ObservedViolationKind[]) {
    it(`fails on a ${kind} violation`, () => {
      const result = run(completedFacts({ violations: [{ kind, detail: 'synthetic detail' }] }));
      assert.equal(result.outcome, 'fail');
      assert.ok(result.observableStateChecks.some((c) => c.assertion === `no ${kind} violation` && !c.passed));
    });
  }

  it('passes a negative scenario whose deliberate violation was rejected', () => {
    const result = run(
      completedFacts({
        scenario: negativeScenario,
        observedStatus: 'fail',
        finalStateChecks: passingChecks(negativeScenario),
      }),
    );
    assert.equal(result.outcome, 'pass');
    assert.equal(result.observableStateChecks[0]?.passed, true);
    assert.match(result.reason, /expected status fail/);
  });

  it('fails a negative scenario whose deliberate violation was not rejected', () => {
    const result = run(
      completedFacts({
        scenario: negativeScenario,
        observedStatus: 'pass',
        finalStateChecks: passingChecks(negativeScenario),
      }),
    );
    assert.equal(result.outcome, 'fail');
    assert.equal(result.observableStateChecks[0]?.passed, false);
  });

  it('fails a synthetic violating state that contradicts the expected final state', () => {
    const checks = passingChecks(baseScenario).map((check) => ({
      ...check,
      passed: false,
      observed: '2 modified files in git diff --name-only',
    }));
    const result = run(completedFacts({ observedStatus: 'pass', finalStateChecks: checks }));
    assert.equal(result.outcome, 'fail');
  });

  it('is inconclusive when a required artifact is missing', () => {
    const result = run(completedFacts({ evidence: [evidenceEntry(['loopback-transcript.json'])] }));
    assert.equal(result.outcome, 'inconclusive');
    assert.match(result.reason, /required artifact\(s\) missing: git-status.txt/);
    assert.match(result.reason, /metrics not observed/);
    assert.deepEqual(result.metrics, ZERO_METRICS);
  });

  it('accepts a required artifact recorded under a run directory', () => {
    const result = run(
      completedFacts({
        evidence: [
          evidenceEntry([
            'runs/edd-run-test-001/loopback-transcript.json',
            'runs\\edd-run-test-001\\git-status.txt',
          ]),
        ],
      }),
    );
    assert.equal(result.outcome, 'pass');
  });

  it('is inconclusive when a declared final-state assertion has no observed check', () => {
    const result = run(completedFacts({ finalStateChecks: [] }));
    assert.equal(result.outcome, 'inconclusive');
    assert.match(result.reason, /cannot be machine-checked/);
    assert.equal(result.observableStateChecks[1]?.passed, false);
  });

  it('is inconclusive when the run reports inconclusive but the scenario expects pass', () => {
    const result = run(completedFacts({ observedStatus: 'inconclusive' }));
    assert.equal(result.outcome, 'inconclusive');
    assert.match(result.reason, /observed status inconclusive, expected status pass/);
    assert.deepEqual(result.metrics, ZERO_METRICS);
  });

  it('passes when expected and observed are both inconclusive and checks hold', () => {
    const inconclusiveScenario: EvalScenario = {
      ...baseScenario,
      expectedOutcome: { ...baseScenario.expectedOutcome, status: 'inconclusive' },
    };
    const result = evaluateScenario(
      completedFacts({
        scenario: inconclusiveScenario,
        observedStatus: 'inconclusive',
        finalStateChecks: passingChecks(inconclusiveScenario),
      }),
    );
    assert.equal(result.outcome, 'pass');
    assert.deepEqual(result.observableStateChecks[0], {
      assertion: 'observed status inconclusive matches expected inconclusive',
      passed: true,
      observed: 'observed status inconclusive',
    });
    assert.doesNotThrow(() => validateResult(result, 'inconclusive-expected pass result'));
    assertSchemaValid(validateResultSchema, result, 'inconclusive-expected pass result');
  });

  it('is inconclusive when a completed run has no evidence entries', () => {
    const result = run(completedFacts({ evidence: [] }));
    assert.equal(result.outcome, 'inconclusive');
    assert.match(result.reason, /no evidence entries/);
  });

  it('records a deliberately skipped scenario with zero metrics', () => {
    const result = run({
      kind: 'skipped',
      runId: 'edd-run-test-002',
      scenario: baseScenario,
      durationMs: 0,
      detail: 'not selected for deterministic mode',
    });
    assert.equal(result.outcome, 'skipped');
    assert.deepEqual(result.observableStateChecks, []);
    assert.deepEqual(result.evidence, []);
    assert.deepEqual(result.metrics, ZERO_METRICS);
    assert.match(result.reason, /deliberately not executed: not selected for deterministic mode/);
    assert.match(result.reason, /metrics not observed/);
  });

  it('records an infrastructure error when the fixture or binary fails', () => {
    const result = run({
      kind: 'infrastructure_error',
      runId: 'edd-run-test-003',
      scenario: baseScenario,
      durationMs: 5,
      detail: 'loopback fixture failed to bind 127.0.0.1',
    });
    assert.equal(result.outcome, 'infrastructure_error');
    assert.match(result.reason, /loopback fixture failed to bind/);
    assert.match(result.reason, /metrics not observed/);
  });

  it('records a stale binding (version mismatch) as an infrastructure error', () => {
    const mismatch = checkBoundScenarioVersion(baseScenario, '0.9.0');
    assert.ok(mismatch);
    assert.match(mismatch, /stale binding for EDD-DEV-001/);
    assert.equal(checkBoundScenarioVersion(baseScenario, '1.0.0'), undefined);

    const result = run({
      kind: 'infrastructure_error',
      runId: 'edd-run-test-004',
      scenario: baseScenario,
      durationMs: 1,
      detail: mismatch,
    });
    assert.equal(result.outcome, 'infrastructure_error');
  });

  it('records an unexpected network destination as an infrastructure error even when checks pass', () => {
    const result = run(
      completedFacts({
        isolation: { unexpectedDestinations: ['CONNECT example.invalid:443'], credentialHeaders: [] },
      }),
    );
    assert.equal(result.outcome, 'infrastructure_error');
    assert.match(result.reason, /isolation breached: unexpected network destination\(s\): CONNECT example.invalid:443/);
  });

  it('records a credential-shaped header as an infrastructure error', () => {
    const result = run(
      completedFacts({ isolation: { unexpectedDestinations: [], credentialHeaders: ['authorization'] } }),
    );
    assert.equal(result.outcome, 'infrastructure_error');
    assert.match(result.reason, /credential-shaped header\(s\): authorization/);
  });

  it('rejects observed final-state checks that the scenario does not declare', () => {
    assert.throws(
      () =>
        evaluateScenario(
          completedFacts({
            finalStateChecks: [{ assertion: 'not declared', passed: true, observed: 'x' }],
          }),
        ),
      /is not declared by the scenario/,
    );
  });

  it('rejects duplicate observed final-state checks', () => {
    const first = passingChecks(baseScenario)[0];
    assert.ok(first);
    assert.throws(
      () => evaluateScenario(completedFacts({ finalStateChecks: [first, first] })),
      /reported more than once/,
    );
  });
});

describe('metrics mapping', () => {
  it('maps journey-record-shaped input to result metrics', () => {
    const metrics = metricsFromJourneyRecord({
      handoffCount: 3,
      roleTransitions: [
        { from: 'lead', to: 'external' },
        { from: 'external', to: 'lead' },
      ],
      skillInvocations: [
        { skillId: 'evidence-collection', loaded: true },
        { skillId: 'denied-skill', loaded: false },
        { skillId: null, loaded: true },
      ],
    });
    assert.deepEqual(metrics, {
      handoffCount: 3,
      roleTransitions: ['lead->external', 'external->lead'],
      skillsInvoked: ['evidence-collection'],
      humanInterventions: 0,
      permissionAmbiguities: 0,
      reviewDetectedDefects: 0,
      escapedDefects: 0,
    });
  });
});

describe('isolation evidence', () => {
  it('records the network record and enforcement value for a clean run', () => {
    const entry = isolationEvidence({
      breached: false,
      networkRecordArtifact: 'network-record.json',
      enforcement: 'netns',
      durationMs: 5,
    });
    assert.equal(entry.check.name, 'isolation');
    assert.equal(entry.check.category, 'custom');
    assert.equal(entry.execution.basis, 're-run');
    assert.equal(entry.execution.exitStatus, 0);
    assert.deepEqual(entry.artifacts, ['network-record.json', 'network.enforcement=netns']);

    const result = run(completedFacts({ evidence: [evidenceEntry(), entry] }));
    assert.equal(result.outcome, 'pass');
  });

  it('records a non-zero exit status when isolation was breached', () => {
    const entry = isolationEvidence({
      breached: true,
      networkRecordArtifact: 'network-record.json',
      enforcement: 'none',
      durationMs: 5,
    });
    assert.equal(entry.execution.exitStatus, 1);
    assert.deepEqual(entry.artifacts, ['network-record.json', 'network.enforcement=none']);
  });
});

describe('repeatability', () => {
  it('treats repeats that differ only in run identity, timing, and run directory as equal', () => {
    const first = evaluateScenario(
      completedFacts({
        runId: 'run-a',
        durationMs: 420,
        evidence: [evidenceEntry(['runs/run-a/loopback-transcript.json', 'runs/run-a/git-status.txt'], 18)],
      }),
    );
    const second = evaluateScenario(
      completedFacts({
        runId: 'run-b',
        durationMs: 611,
        evidence: [
          evidenceEntry(
            ['C:\\temp\\run-b\\loopback-transcript.json', 'C:\\temp\\run-b\\git-status.txt'],
            22,
          ),
        ],
      }),
    );
    const comparison = compareRepeats(first, second);
    assert.equal(comparison.repeatable, true);
    assert.deepEqual(comparison.differences, []);
    assert.equal(first.outcome, 'pass');
    assert.equal(second.outcome, 'pass');
  });

  it('reports a field-level difference when the outcome differs between repeats', () => {
    const first = evaluateScenario(completedFacts({ runId: 'run-a' }));
    const second = evaluateScenario(completedFacts({ runId: 'run-b', observedStatus: 'fail' }));
    const comparison = compareRepeats(first, second);
    assert.equal(comparison.repeatable, false);
    const outcomeDiff = comparison.differences.find((d) => d.path === 'outcome');
    assert.deepEqual(outcomeDiff, { path: 'outcome', first: 'pass', second: 'fail' });
  });

  it('reports a changed artifact name as a difference', () => {
    const first = evaluateScenario(completedFacts({ runId: 'run-a' }));
    const second = evaluateScenario(
      completedFacts({
        runId: 'run-b',
        evidence: [evidenceEntry(['loopback-transcript.json', 'other-status.txt'])],
      }),
    );
    const comparison = compareRepeats(first, second);
    assert.equal(comparison.repeatable, false);
    assert.ok(comparison.differences.some((d) => d.path === 'evidence[0].artifacts[1]'));
  });

  it('normalizes the manifest runId and createdAt but not its scenario list', () => {
    const manifest: EvalRunManifest = validateRunManifest(
      readJson('eval/examples/run-manifest.example.json'),
    );
    const later: EvalRunManifest = {
      ...manifest,
      runId: 'another-run',
      createdAt: '2030-01-01T00:00:00Z',
    };
    assert.equal(compareRepeats(manifest, later).repeatable, true);
    assert.equal(
      compareRepeats(manifest, { ...later, scenarioIds: ['EDD-DEV-002'] }).repeatable,
      false,
    );
    assert.equal(normalizeForRepeatability(manifest).createdAt, undefined);
  });

  it('does not change its inputs or the outcomes of the repeats it compares', () => {
    const first = evaluateScenario(completedFacts({ runId: 'run-a' }));
    const second = evaluateScenario(completedFacts({ runId: 'run-b', observedStatus: 'fail' }));
    const before = structuredClone(first);
    compareRepeats(first, second);
    assert.deepEqual(first, before);
    assert.equal(first.outcome, 'pass');
    assert.equal(second.outcome, 'fail');
  });
});

describe('deterministic rubric file (eval/rubrics/deterministic-v1.json)', () => {
  it('validates against the TypeScript validator and the rubric JSON Schema in deterministic mode', () => {
    const raw = readJson('eval/rubrics/deterministic-v1.json');
    assertSchemaValid(validateRubricSchema, raw, 'deterministic-v1.json');
    const rubric = validateRubric(raw, 'deterministic-v1.json');
    assert.equal(rubric.mode, 'deterministic');
    assert.equal(rubric.judge, undefined);
    assert.ok(rubric.criteria.some((c) => c.metric === 'outcome-match' && c.required));
  });
});

describe('every produced result is valid', () => {
  it('passes validateResult and the result JSON Schema for every outcome path', () => {
    const scenarioFacts: EvaluationFacts[] = [
      completedFacts(),
      completedFacts({ observedStatus: 'fail', scenario: negativeScenario, finalStateChecks: passingChecks(negativeScenario) }),
      completedFacts({ violations: [{ kind: 'forbidden-action', detail: 'push attempted' }] }),
      completedFacts({ evidence: [] }),
      completedFacts({ evidence: [evidenceEntry(['loopback-transcript.json'])] }),
      completedFacts({ observedStatus: 'inconclusive' }),
      {
        kind: 'skipped',
        runId: 'run-s',
        scenario: baseScenario,
        durationMs: 0,
        detail: 'not selected',
      },
      {
        kind: 'infrastructure_error',
        runId: 'run-i',
        scenario: baseScenario,
        durationMs: 2,
        detail: 'sandbox failed',
      },
    ];
    const outcomes = new Set<string>();
    for (const facts of scenarioFacts) {
      const result = run(facts);
      outcomes.add(result.outcome);
    }
    assert.deepEqual([...outcomes].sort(), [
      'fail',
      'inconclusive',
      'infrastructure_error',
      'pass',
      'skipped',
    ]);
  });
});
