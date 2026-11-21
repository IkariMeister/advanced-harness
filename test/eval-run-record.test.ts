import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv2020Import from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import {
  loadScenarioCorpus,
  validateResult,
  validateRunManifest,
} from '../src/eval-contracts.ts';
import {
  loadRunRecord,
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
    const forbidden = ['/mnt/', '/home/', 'C:\\Users', 'C:/Users', '/tmp/', 'gho_', 'sk-', 'Bearer ', 'Authorization:'];
    for (const relPath of [
      'eval/templates/run-record.template.json',
      'eval/baselines/eight-role-opencode-deterministic.json',
    ]) {
      const content = readText(relPath);
      for (const token of forbidden) {
        assert.equal(content.includes(token), false, `${relPath} must not contain "${token}"`);
      }
    }
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
          doc.metricObservation = { observed: ['handoffCount'], notObserved: [] };
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
      const badJsonPath = join(tmpDir, 'broken-record.json');
      writeFileSync(badJsonPath, '{broken', 'utf8');
      assert.throws(
        () => loadRunRecord(badJsonPath),
        new RegExp(badJsonPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
