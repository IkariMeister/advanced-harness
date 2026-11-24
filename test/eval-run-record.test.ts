import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv2020Import from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import {
  loadScenarioCorpus,
  validateResult,
  validateRunManifest,
} from '../src/eval-contracts.ts';
import { isValidIso8601Timestamp } from '../src/eval-validation-helpers.ts';
import {
  CAPABILITY_STATUSES,
  CORE_METRIC_NAMES,
  EXECUTION_KINDS,
  FORBIDDEN_FREE_TEXT_PATTERNS,
  JOURNEY_NETWORK_ENFORCEMENTS,
  JOURNEY_RECORD_OUTCOMES,
  JOURNEY_TEST_OUTCOMES,
  loadRunRecord,
  MAX_RUN_RECORD_BYTES,
  METHODOLOGY_MODES,
  MODEL_VERIFICATION_STATUSES,
  NETWORK_ENFORCEMENTS,
  NON_MEASURED_STATUSES,
  REPRESENTATIVE_TASK_CLASSES,
  RIGOR_LEVELS,
  RUN_RECORD_KINDS,
  validateRunRecord,
} from '../src/eval-run-record.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..');

function readText(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

function readJson(relPath: string): unknown {
  return JSON.parse(readText(relPath));
}

type AjvInstance = {
  addSchema: (schema: object) => AjvInstance;
  compile: (schema: object) => ValidateFunction;
};
type AjvCtor = new (opts: {
  allErrors: boolean;
  strictSchema: boolean;
  strictTypes: boolean;
}) => AjvInstance;
const Ajv2020 =
  (Ajv2020Import as unknown as { default?: AjvCtor }).default ??
  (Ajv2020Import as unknown as AjvCtor);

const ajv = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false })
  .addSchema(readJson('eval/schemas/run-manifest.schema.json') as object)
  .addSchema(readJson('eval/schemas/result.schema.json') as object);
const validateRunRecordSchema = ajv.compile(
  readJson('eval/schemas/run-record.schema.json') as object,
);

function assertSchemaValid(data: unknown, label: string): void {
  const ok = validateRunRecordSchema(data);
  assert.equal(
    ok,
    true,
    `${label} failed JSON Schema validation: ${JSON.stringify(validateRunRecordSchema.errors)}`,
  );
}

function collectJsonStrings(value: unknown, path = '$', out: Array<{ path: string; text: string }> = []): Array<{ path: string; text: string }> {
  if (typeof value === 'string') {
    out.push({ path, text: value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => collectJsonStrings(item, `${path}[${idx}]`, out));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      collectJsonStrings(val, `${path}.${key}`, out);
    }
  }
  return out;
}

function makeJourneyBaseline(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'CI Agent E2E',
    commit: '68219d552aede8ca347a6cca116be587e41418e5',
    opencodeVersion: '2.3.0',
    networkEnforcement: 'netns',
    ciRunId: '44850716927',
    artifactId: '14684054873',
    recordedAt: '2026-11-21T01:32:19Z',
    journeys: [
      {
        id: 'J1',
        journey: 'lead-reads-repository',
        testOutcome: 'pass',
        recordOutcome: 'pass',
        handoffCount: 0,
        roleTransitions: [],
        skillsInvoked: [],
        toolCallCount: 2,
        violationCount: 0,
      },
    ],
    ...overrides,
  };
}

/**
 * Coverage policy: exercise AJV schema + TS validator parity on committed artifacts and positive
 * live/candidate variants, verify enum drift against run-record.schema.json, test cross-field and
 * calendar invariants beyond JSON Schema, and derive corpus expectations dynamically from disk.
 */
describe('EDD v1 / BH-051 run records and eight-role deterministic baseline', () => {
  it('validates the JSON run-record template against JSON Schema, TS validator, and #225 contracts', () => {
    const templatePath = join(REPO_ROOT, 'eval/templates/run-record.template.json');
    const raw = JSON.parse(readFileSync(templatePath, 'utf8'));

    assertSchemaValid(raw, 'run-record.template.json');
    const record = loadRunRecord(templatePath);

    assert.equal(record.recordKind, 'template');
    validateRunManifest(record.runManifest, 'template.runManifest');
    for (const result of record.results) {
      validateResult(result, `template.results[${result.scenarioId}]`);
    }
    assert.deepEqual(record.metricObservation.observed, []);
  });

  it('validates the Markdown run-record template and its required protocol sections', () => {
    const markdown = readText('eval/templates/run-record.template.md');
    for (const heading of [
      '## 1. Run Identification & Attribution',
      '## 2. Host, Role Setup & Model Configuration',
      '## 3. BH-048 Host Permission Prerequisites',
      '## 4. Representative Task Classification & Criteria',
      '## 5. Outcomes & BH-051 Metrics',
      '## 6. Checks, Evidence & Artifacts',
      '## 7. Limitations, Waivers & Comparison Notes',
    ]) {
      assert.ok(markdown.includes(heading), `Template Markdown missing heading "${heading}"`);
    }
  });

  it('validates the committed eight-role OpenCode deterministic baseline and its recorded counts', () => {
    const baselinePath = join(
      REPO_ROOT,
      'eval/baselines/eight-role-opencode-deterministic.json',
    );
    const raw = JSON.parse(readFileSync(baselinePath, 'utf8'));

    assertSchemaValid(raw, 'eight-role-opencode-deterministic.json');
    const baseline = loadRunRecord(baselinePath);

    assert.equal(baseline.recordKind, 'baseline');
    assert.equal(baseline.runManifest.roleSetup, 'eight-role');
    assert.equal(baseline.runManifest.mode, 'deterministic');
    assert.equal(baseline.hostEnvironment.host, 'opencode');
    assert.equal(baseline.hostEnvironment.networkEnforcement, 'netns');
    assert.equal(baseline.hostEnvironment.hermetic, true);
    assert.equal(baseline.repeatability.repeatCount, 2);
    assert.equal(baseline.repeatability.executedScenarios, 4);
    assert.equal(baseline.repeatability.allRepeatable, true);

    const corpus = loadScenarioCorpus(join(REPO_ROOT, 'eval/corpus'));
    const expectedIds = corpus.development.map((s) => s.id).sort();
    assert.deepEqual([...baseline.runManifest.scenarioIds].sort(), expectedIds);
    for (const scenario of corpus.development) {
      const result = baseline.results.find((r) => r.scenarioId === scenario.id);
      assert.ok(result, `Baseline missing development scenario ${scenario.id}`);
      assert.equal(result.scenarioVersion, scenario.version);
    }

    const expectedBoundHandoffs: Record<string, number> = {
      'EDD-DEV-003': 3,
      'EDD-DEV-004': 1,
      'EDD-DEV-008': 1,
      'EDD-DEV-010': 2,
    };
    for (const [scenarioId, expectedHandoffs] of Object.entries(expectedBoundHandoffs)) {
      const result = baseline.results.find((r) => r.scenarioId === scenarioId);
      assert.ok(result, `Missing bound scenario ${scenarioId}`);
      assert.equal(result.outcome, 'pass', `${scenarioId} should have passed`);
      assert.equal(result.metrics.handoffCount, expectedHandoffs, `${scenarioId} handoffCount`);
    }

    assert.deepEqual(
      [...baseline.metricObservation.notObserved].sort(),
      [
        'escapedDefects',
        'humanInterventions',
        'permissionAmbiguities',
        'reviewDetectedDefects',
        'tokenCostUsd',
      ].sort(),
    );

    assert.ok(baseline.journeyBaseline, 'Baseline must include #62 journeyBaseline');
    assert.equal(baseline.journeyBaseline.networkEnforcement, 'netns');
    assert.deepEqual(
      baseline.journeyBaseline.journeys.map((j) => [j.id, j.handoffCount]),
      [
        ['J1', 0],
        ['J2', 1],
        ['J3', 1],
        ['J3a', 1],
        ['J4a', 0],
        ['J4b', 0],
      ],
    );
  });

  it('keeps committed template and baseline JSON free of machine-local paths and credentials', () => {
    for (const relPath of [
      'eval/templates/run-record.template.json',
      'eval/baselines/eight-role-opencode-deterministic.json',
    ]) {
      const parsed = readJson(relPath);
      for (const { path, text } of collectJsonStrings(parsed)) {
        for (const { label, pattern } of FORBIDDEN_FREE_TEXT_PATTERNS) {
          assert.equal(
            pattern.test(text),
            false,
            `${relPath} (${path}) must not contain ${label}`,
          );
        }
      }
    }
  });

  it('enforces FORBIDDEN_FREE_TEXT_PATTERNS across all string fields while allowing benign prose', () => {
    const base = structuredClone(readJson('eval/templates/run-record.template.json')) as Record<
      string,
      unknown
    >;

    const samplesByLabel = new Map<string, string>([
      ['machine-local Unix path', 'path:[/var/log/run.txt]'],
      ['file URI', 'see file://localhost/tmp/out.json'],
      ['machine-local Windows or UNC path', 'copy from D:\\work\\repo or \\\\server\\share\\file'],
      ['GitHub token', ['ghs', 'abcdefghijklmnopqrstuvwxyz123456'].join('_')],
      ['GitHub fine-grained PAT', ['github', 'pat', 'abcdefghijklmnopqrstuvwxyz123456'].join('_')],
      ['Bearer authorization header', ['Bearer', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'].join(' ')],
      ['Authorization header', ['Authorization:', 'Basic', 'dXNlcjpwYXNz'].join(' ')],
      ['API secret key', ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')],
      ['AWS access key', ['AKIA', 'IOSFODNN7EXAMPLE'].join('')],
      ['Slack token', ['xoxb', '123456789012', 'abcdefghij'].join('-')],
      ['Google API key', ['AIza', 'SyDaGmWKa4JsXZ', '1234567890abcdefghij'].join('')],
    ]);

    for (const { label } of FORBIDDEN_FREE_TEXT_PATTERNS) {
      const sample = samplesByLabel.get(label);
      assert.ok(sample, `Missing negative sample for FORBIDDEN_FREE_TEXT_PATTERNS label "${label}"`);
      const doc = structuredClone(base);
      (doc.hostEnvironment as Record<string, unknown>).notes = sample;
      assert.throws(
        () => validateRunRecord(doc),
        new RegExp(`must not contain a ${label}`),
        `Should reject ${label}`,
      );
    }

    // Previously unguarded fields: results[].reason and runManifest.runId
    const reasonLeak = structuredClone(base);
    (reasonLeak.results as Array<Record<string, unknown>>)[0]!.reason = 'read ~/secret/key';
    assert.throws(() => validateRunRecord(reasonLeak), /must not contain a machine-local Unix path/);

    const manifestLeak = structuredClone(base);
    (manifestLeak.runManifest as Record<string, unknown>).runId = 'run-opt:[/opt/runner/id]';
    assert.throws(() => validateRunRecord(manifestLeak), /must not contain a machine-local Unix path/);

    // Benign hyphenated prose must pass
    const benign = structuredClone(base);
    (benign.hostEnvironment as Record<string, unknown>).notes =
      'Evaluated task-force workflow with risk-based checks.';
    assert.doesNotThrow(() => validateRunRecord(benign));
  });

  it('validates ISO 8601 timestamps directly including calendar and offset edge cases', () => {
    assert.equal(isValidIso8601Timestamp('2024-02-29T23:59:59Z'), true);
    assert.equal(isValidIso8601Timestamp('2026-11-21T01:32:19+23:59'), true);
    assert.equal(isValidIso8601Timestamp('2026-11-21T01:32:19-23:59'), true);
    assert.equal(isValidIso8601Timestamp('2025-02-29T00:00:00Z'), false);
    assert.equal(isValidIso8601Timestamp('2026-11-21T24:00:00Z'), false);
    assert.equal(isValidIso8601Timestamp('2026-11-21T01:32:19+24:00'), false);
    assert.equal(isValidIso8601Timestamp('2026-11-21T01:32:19+00:60'), false);
    assert.equal(isValidIso8601Timestamp('2026-11-21T01:32:19+99:99'), false);
  });

  it('keeps TypeScript enum constants aligned with run-record.schema.json', () => {
    const schema = readJson('eval/schemas/run-record.schema.json') as {
      properties: Record<
        string,
        {
          enum?: string[];
          properties?: Record<
            string,
            {
              enum?: string[];
              items?: {
                enum?: string[];
                properties?: Record<string, { enum?: string[] }>;
              };
            }
          >;
        }
      >;
      $defs: Record<string, { enum?: string[]; properties?: Record<string, { enum?: string[] }> }>;
    };
    const journeyProps = schema.properties.journeyBaseline?.properties?.journeys?.items?.properties;
    const pairs: Array<[string, readonly string[], readonly string[] | undefined]> = [
      ['RUN_RECORD_KINDS', RUN_RECORD_KINDS, schema.properties.recordKind?.enum],
      ['EXECUTION_KINDS', EXECUTION_KINDS, schema.properties.runner?.properties?.executionKind?.enum],
      ['NETWORK_ENFORCEMENTS', NETWORK_ENFORCEMENTS, schema.properties.hostEnvironment?.properties?.networkEnforcement?.enum],
      ['MODEL_VERIFICATION_STATUSES', MODEL_VERIFICATION_STATUSES, schema.properties.modelVerification?.properties?.status?.enum],
      ['CAPABILITY_STATUSES', CAPABILITY_STATUSES, schema.$defs.capabilityStatus?.enum],
      ['REPRESENTATIVE_TASK_CLASSES', REPRESENTATIVE_TASK_CLASSES, schema.properties.taskClassification?.properties?.taskClasses?.items?.enum],
      ['METHODOLOGY_MODES', METHODOLOGY_MODES, schema.properties.taskClassification?.properties?.methodologyMode?.enum],
      ['RIGOR_LEVELS', RIGOR_LEVELS, schema.properties.taskClassification?.properties?.rigor?.enum],
      ['CORE_METRIC_NAMES', CORE_METRIC_NAMES, schema.$defs.coreMetricName?.enum],
      ['NON_MEASURED_STATUSES', NON_MEASURED_STATUSES, schema.$defs.notMeasuredMetric?.properties?.status?.enum],
      ['JOURNEY_TEST_OUTCOMES', JOURNEY_TEST_OUTCOMES, journeyProps?.testOutcome?.enum],
      ['JOURNEY_RECORD_OUTCOMES', JOURNEY_RECORD_OUTCOMES, journeyProps?.recordOutcome?.enum],
      ['JOURNEY_NETWORK_ENFORCEMENTS', JOURNEY_NETWORK_ENFORCEMENTS, schema.properties.journeyBaseline?.properties?.networkEnforcement?.enum],
    ];
    for (const [name, tsValues, schemaValues] of pairs) {
      assert.ok(schemaValues, `Schema enum missing for ${name}`);
      assert.deepEqual([...tsValues].sort(), [...schemaValues].sort(), `${name} drifted from schema`);
    }
  });

  it('validates positive candidate, live, measured supplementaryMetrics, waivers, and journeyBaseline records', () => {
    const candidate = structuredClone(readJson('eval/templates/run-record.template.json')) as Record<
      string,
      unknown
    >;
    candidate.recordId = 'candidate-live-0001';
    candidate.recordKind = 'candidate';
    candidate.baselineRef = 'eight-role-opencode-deterministic-2026-11-21';
    candidate.runner = {
      executedBy: 'antigravity',
      executionKind: 'agent-assisted',
      authorizedBy: 'ikarimeister',
      ciRunRef: 'https://github.com/IkariMeister/advanced-harness/actions/runs/44850716927',
    };
    candidate.modelVerification = {
      status: 'verified',
      evidence: 'Provider API response headers recorded per-role model IDs.',
      observedRoleModels: {
        lead: 'anthropic/claude-sonnet-4',
        implementer: 'openai/gpt-5',
      },
    };
    const manifest = candidate.runManifest as Record<string, unknown>;
    manifest.mode = 'live';
    manifest.roleSetup = 'engineer-pilot';
    manifest.modelConfig = {
      provider: 'anthropic',
      fixtureLoopbackOnly: false,
      roleModels: {
        lead: 'anthropic/claude-sonnet-4',
        implementer: 'openai/gpt-5',
      },
    };
    const rep = candidate.repeatability as Record<string, unknown>;
    rep.executedScenarios = 1;
    (rep.scenarioSummaries as Array<Record<string, unknown>>)[0]!.outcomes = ['pass'];
    (rep.scenarioSummaries as Array<Record<string, unknown>>)[0]!.bound = true;
    const results = candidate.results as Array<Record<string, unknown>>;
    results[0]!.outcome = 'pass';
    results[0]!.reason = 'Live scenario completed all checks.';
    results[0]!.durationMs = 1200;
    results[0]!.observableStateChecks = [{ assertion: 'tests pass', passed: true, observed: 'ok' }];
    results[0]!.evidence = [
      {
        schemaVersion: 1,
        check: { name: 'npm test', category: 'unit-tests' },
        execution: { command: 'npm test', exitStatus: 0, durationMs: 1200, basis: 're-run' },
        artifacts: ['test-results/unit.txt'],
      },
    ];
    (results[0]!.metrics as Record<string, unknown>).handoffCount = 2;
    (results[0]!.metrics as Record<string, unknown>).tokenCostUsd = 0.04;
    candidate.metricObservation = {
      observed: ['handoffCount', 'tokenCostUsd', 'durationMs'],
      notObserved: [
        'roleTransitions',
        'skillsInvoked',
        'humanInterventions',
        'permissionAmbiguities',
        'reviewDetectedDefects',
        'escapedDefects',
      ],
    };
    candidate.supplementaryMetrics = {
      requirementCoverage: { status: 'measured', met: 2, total: 2, note: 'All criteria met.' },
      reworkCycles: { status: 'measured', count: 1 },
      planDriftCount: { status: 'measured', count: 0 },
      contextReconstructionCount: { status: 'measured', count: 0 },
      evidenceQuality: {
        status: 'measured',
        summary: 'All checks re-run after final edit.',
        checksReRun: 1,
        checksJudgedFromEvidence: 0,
        missingArtifacts: 0,
      },
      tokenUsage: {
        status: 'measured',
        inputTokens: 1000,
        outputTokens: 500,
        cachedTokens: 200,
        estimatedCostUsd: 0.04,
        pricingBasis: 'published-api-rates',
      },
      plannedApprovalGates: { status: 'measured', count: 1 },
    };
    candidate.waivers = [
      {
        scope: 'ui-visual',
        reason: 'CLI-only scenario has no visual UI surface.',
        approvedBy: 'ikarimeister',
        reference: '#126',
      },
    ];
    candidate.journeyBaseline = makeJourneyBaseline({
      journeys: [
        {
          id: 'J1',
          journey: 'lead-reads-repository',
          testOutcome: 'pass',
          recordOutcome: 'pass',
          handoffCount: 0,
          roleTransitions: [],
          skillsInvoked: [],
          toolCallCount: 2,
          violationCount: 0,
          repeatsByteIdentical: true,
          notes: 'Deterministic baseline journey.',
        },
      ],
    });

    assertSchemaValid(candidate, 'positive candidate live record');
    const validated = validateRunRecord(candidate, 'positive candidate live record');
    assert.equal(validated.recordKind, 'candidate');
    assert.equal(validated.waivers.length, 1);
    assert.equal(validated.journeyBaseline?.journeys[0]?.id, 'J1');
  });

  it('enforces schema and TypeScript validator parity across invalid run records', () => {
    const base = structuredClone(readJson('eval/templates/run-record.template.json')) as Record<
      string,
      unknown
    >;

    const schemaAndTsInvalid: Array<{ label: string; mutate: (doc: Record<string, unknown>) => void; pattern: RegExp }> = [
      {
        label: 'wrong schemaVersion',
        mutate: (doc) => {
          doc.schemaVersion = 2;
        },
        pattern: /schemaVersion must be 1/,
      },
      {
        label: 'extra top-level property',
        mutate: (doc) => {
          doc.extraField = true;
        },
        pattern: /not an allowed property/,
      },
      {
        label: 'invalid commit SHA',
        mutate: (doc) => {
          (doc.repository as Record<string, unknown>).commit = 'NOT-A-SHA';
        },
        pattern: /commit SHA/,
      },
      {
        label: 'candidate without baselineRef',
        mutate: (doc) => {
          doc.recordKind = 'candidate';
        },
        pattern: /baselineRef is required/,
      },
      {
        label: 'agent-assisted without authorizedBy',
        mutate: (doc) => {
          doc.runner = { executedBy: 'agent', executionKind: 'agent-assisted' };
        },
        pattern: /authorizedBy is required/,
      },
      {
        label: 'unverified model with observedRoleModels',
        mutate: (doc) => {
          doc.modelVerification = {
            status: 'unverified',
            evidence: 'Only labels configured.',
            observedRoleModels: { lead: 'some-model' },
          };
        },
        pattern: /observedRoleModels is forbidden/,
      },
      {
        label: 'invalid embedded runManifest',
        mutate: (doc) => {
          (doc.runManifest as Record<string, unknown>).createdAt = 'invalid-date';
        },
        pattern: /createdAt must be a valid ISO 8601 timestamp/,
      },
      {
        label: 'invalid embedded result',
        mutate: (doc) => {
          const results = doc.results as Array<Record<string, unknown>>;
          results[0]!.outcome = 'pass';
          results[0]!.observableStateChecks = [];
        },
        pattern: /observableStateChecks must be a non-empty array/,
      },
    ];

    for (const { label, mutate, pattern } of schemaAndTsInvalid) {
      const candidate = structuredClone(base);
      mutate(candidate);
      assert.equal(validateRunRecordSchema(candidate), false, `Schema should reject: ${label}`);
      assert.throws(() => validateRunRecord(candidate), pattern, `TS validator should reject: ${label}`);
    }

    const tsInvariantCases: Array<{ label: string; mutate: (doc: Record<string, unknown>) => void; pattern: RegExp }> = [
      {
        label: 'hostEnvironment.host mismatch against runManifest.host',
        mutate: (doc) => {
          (doc.hostEnvironment as Record<string, unknown>).host = 'codex';
        },
        pattern: /must match runManifest\.host/,
      },
      {
        label: 'deterministic mode without loopback-fixture verification',
        mutate: (doc) => {
          doc.modelVerification = { status: 'unverified', evidence: 'Missing fixture verification.' };
        },
        pattern: /must be "loopback-fixture"/,
      },
      {
        label: 'live mode with loopback-fixture verification',
        mutate: (doc) => {
          (doc.runManifest as Record<string, unknown>).mode = 'live';
        },
        pattern: /cannot be "loopback-fixture"/,
      },
      {
        label: 'overlapping metricObservation observed and notObserved',
        mutate: (doc) => {
          const results = doc.results as Array<Record<string, unknown>>;
          results[0]!.outcome = 'pass';
          results[0]!.observableStateChecks = [{ assertion: 'ok', passed: true, observed: 'ok' }];
          results[0]!.evidence = [
            {
              schemaVersion: 1,
              check: { name: 'check', category: 'custom' },
              execution: { command: 'true', exitStatus: 0, durationMs: 1, basis: 're-run' },
              artifacts: ['a.txt'],
            },
          ];
          const rep = doc.repeatability as Record<string, unknown>;
          rep.executedScenarios = 1;
          (rep.scenarioSummaries as Array<Record<string, unknown>>)[0]!.outcomes = ['pass'];
          doc.metricObservation = { observed: ['handoffCount'], notObserved: ['handoffCount'] };
        },
        pattern: /cannot appear in both observed and notObserved/,
      },
      {
        label: 'repeat count mismatch in scenarioSummaries outcomes',
        mutate: (doc) => {
          const rep = doc.repeatability as Record<string, unknown>;
          rep.repeatCount = 2;
        },
        pattern: /outcomes length \(1\) must match repeatability\.repeatCount \(2\)/,
      },
      {
        label: 'executedScenarios count mismatch',
        mutate: (doc) => {
          const rep = doc.repeatability as Record<string, unknown>;
          rep.executedScenarios = 1;
        },
        pattern: /executedScenarios \(1\) must match non-skipped summary count \(0\)/,
      },
      {
        label: 'requirementCoverage met > total',
        mutate: (doc) => {
          const sm = doc.supplementaryMetrics as Record<string, unknown>;
          sm.requirementCoverage = { status: 'measured', met: 3, total: 2 };
        },
        pattern: /met \(3\) cannot exceed .*total \(2\)/,
      },
      {
        label: 'claiming observed metrics when all results are non-observed',
        mutate: (doc) => {
          doc.metricObservation = {
            observed: ['handoffCount'],
            notObserved: CORE_METRIC_NAMES.filter((name) => name !== 'handoffCount'),
          };
        },
        pattern: /observed must be empty when no result has outcome "pass" or "fail"/,
      },
      {
        label: 'claiming measured supplementaryMetrics when all results are non-observed',
        mutate: (doc) => {
          const sm = doc.supplementaryMetrics as Record<string, unknown>;
          sm.reworkCycles = { status: 'measured', count: 0 };
        },
        pattern: /supplementaryMetrics cannot report "measured"/,
      },
      {
        label: 'non-decided result with non-zero metrics',
        mutate: (doc) => {
          const results = doc.results as Array<Record<string, unknown>>;
          (results[0]!.metrics as Record<string, unknown>).handoffCount = 1;
        },
        pattern: /non-decided outcome "skipped" and must record zero\/empty metrics/,
      },
      {
        label: 'incomplete metricObservation partition',
        mutate: (doc) => {
          doc.metricObservation = { observed: [], notObserved: ['handoffCount'] };
        },
        pattern: /must partition all core metrics; missing:/,
      },
      {
        label: 'non-placeholder value on a notObserved metric',
        mutate: (doc) => {
          const results = doc.results as Array<Record<string, unknown>>;
          results[0]!.outcome = 'pass';
          results[0]!.observableStateChecks = [{ assertion: 'ok', passed: true, observed: 'ok' }];
          results[0]!.evidence = [
            {
              schemaVersion: 1,
              check: { name: 'check', category: 'custom' },
              execution: { command: 'true', exitStatus: 0, durationMs: 1, basis: 're-run' },
              artifacts: ['a.txt'],
            },
          ];
          results[0]!.durationMs = 42;
          const rep = doc.repeatability as Record<string, unknown>;
          rep.executedScenarios = 1;
          (rep.scenarioSummaries as Array<Record<string, unknown>>)[0]!.outcomes = ['pass'];
        },
        pattern: /non-placeholder value for "durationMs"/,
      },
      {
        label: 'free-text machine-local path leakage',
        mutate: (doc) => {
          (doc.hostEnvironment as Record<string, unknown>).notes = 'Captured in /home/dev/repo.';
        },
        pattern: /must not contain a machine-local Unix path/,
      },
      {
        label: 'free-text credential leakage',
        mutate: (doc) => {
          const syntheticToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');
          doc.limitations = [`Token ${syntheticToken} leaked`];
        },
        pattern: /must not contain a GitHub token/,
      },
      {
        label: 'observedRoleModels undeclared role key',
        mutate: (doc) => {
          const mv = doc.modelVerification as Record<string, unknown>;
          (mv.observedRoleModels as Record<string, unknown>).unknownRole = 'loopback/mock';
        },
        pattern: /is not declared in runManifest\.modelConfig\.roleModels/,
      },
      {
        label: 'observedRoleModels prototype-pollution key via JSON.parse',
        mutate: (doc) => {
          const mv = doc.modelVerification as Record<string, unknown>;
          mv.observedRoleModels = JSON.parse('{"__proto__":"loopback/mock"}');
        },
        pattern: /contains forbidden key "__proto__"/,
      },
      {
        label: 'journeyBaseline duplicate journey ids',
        mutate: (doc) => {
          doc.journeyBaseline = makeJourneyBaseline({
            journeys: [
              {
                id: 'J1',
                journey: 'a',
                testOutcome: 'pass',
                recordOutcome: 'pass',
                handoffCount: 0,
                roleTransitions: [],
                skillsInvoked: [],
                toolCallCount: 1,
                violationCount: 0,
              },
              {
                id: 'J1',
                journey: 'b',
                testOutcome: 'pass',
                recordOutcome: 'pass',
                handoffCount: 0,
                roleTransitions: [],
                skillsInvoked: [],
                toolCallCount: 1,
                violationCount: 0,
              },
            ],
          });
        },
        pattern: /journeys contains duplicate id "J1"/,
      },
      {
        label: 'journeyBaseline pass with non-zero violationCount',
        mutate: (doc) => {
          doc.journeyBaseline = makeJourneyBaseline({
            journeys: [
              {
                id: 'J1',
                journey: 'a',
                testOutcome: 'pass',
                recordOutcome: 'pass',
                handoffCount: 0,
                roleTransitions: [],
                skillsInvoked: [],
                toolCallCount: 1,
                violationCount: 1,
              },
            ],
          });
        },
        pattern: /recordOutcome "pass" and must have violationCount 0/,
      },
      {
        label: 'journeyBaseline invalid calendar date in recordedAt',
        mutate: (doc) => {
          doc.journeyBaseline = makeJourneyBaseline({
            recordedAt: '2026-02-30T00:00:00Z',
          });
        },
        pattern: /recordedAt must be a valid ISO 8601 timestamp/,
      },
      {
        label: 'journeyBaseline handoffCount zero with non-empty roleTransitions',
        mutate: (doc) => {
          doc.journeyBaseline = makeJourneyBaseline({
            journeys: [
              {
                id: 'J1',
                journey: 'a',
                testOutcome: 'pass',
                recordOutcome: 'pass',
                handoffCount: 0,
                roleTransitions: ['lead->operator'],
                skillsInvoked: [],
                toolCallCount: 1,
                violationCount: 0,
              },
            ],
          });
        },
        pattern: /must both be zero or both be non-zero/,
      },
    ];

    for (const { label, mutate, pattern } of tsInvariantCases) {
      const candidate = structuredClone(base);
      mutate(candidate);
      assert.throws(
        () => validateRunRecord(candidate),
        pattern,
        `TS invariant validator should reject: ${label}`,
      );
    }

    const tmpDir = mkdtempSync(join(tmpdir(), 'edd-run-record-'));
    try {
      const missingPath = join(tmpDir, 'does-not-exist.json');
      assert.throws(() => loadRunRecord(missingPath), /Unable to read run record/);

      const badJsonPath = join(tmpDir, 'broken-record.json');
      writeFileSync(badJsonPath, '{broken', 'utf8');
      assert.throws(
        () => loadRunRecord(badJsonPath),
        new RegExp(`Invalid JSON in run record ${badJsonPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      );

      const oversizedPath = join(tmpDir, 'oversized-record.json');
      writeFileSync(oversizedPath, '{}', 'utf8');
      truncateSync(oversizedPath, MAX_RUN_RECORD_BYTES + 1);
      assert.throws(
        () => loadRunRecord(oversizedPath),
        /exceeds maximum allowed/,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
