import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadScenarioCorpus,
  validateCorpusCoverage,
  validateResult,
  validateRubric,
  validateRunManifest,
  validateScenario,
} from '../src/eval-contracts.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..');

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf8'));
}

describe('EDD v1 evaluation contracts', () => {
  it('ships valid JSON Schema files with schemaVersion const 1', () => {
    const schemaFiles = [
      'eval/schemas/scenario.schema.json',
      'eval/schemas/rubric.schema.json',
      'eval/schemas/run-manifest.schema.json',
      'eval/schemas/result.schema.json',
    ];
    for (const file of schemaFiles) {
      const schema = readJson(file) as Record<string, unknown>;
      assert.equal(schema.type, 'object', `${file} should be an object schema`);
      assert.equal(schema.additionalProperties, false, `${file} should forbid unknown properties`);
      const props = schema.properties as Record<string, Record<string, unknown>>;
      assert.equal(props.schemaVersion?.const, 1, `${file} schemaVersion must be const 1`);
    }
  });

  it('validates all four example files against the contracts', () => {
    const scenario = validateScenario(readJson('eval/examples/scenario.example.json'));
    const rubric = validateRubric(readJson('eval/examples/rubric.example.json'));
    const manifest = validateRunManifest(readJson('eval/examples/run-manifest.example.json'));
    const result = validateResult(readJson('eval/examples/result.example.json'));

    assert.equal(scenario.id, 'EDD-DEV-001');
    assert.equal(rubric.mode, 'deterministic');
    assert.equal(manifest.isolation.networkAllowed, false);
    assert.equal(result.outcome, 'pass');
  });

  it('loads the versioned scenario corpus with >= 20 scenarios and strict set separation', () => {
    const corpus = loadScenarioCorpus(join(REPO_ROOT, 'eval/corpus'));
    const summary = validateCorpusCoverage(corpus.all);

    assert.ok(summary.total >= 20, `Expected >= 20 scenarios, got ${summary.total}`);
    assert.equal(corpus.development.length, 14);
    assert.equal(corpus.validation.length, 10);

    const devSet = new Set(summary.developmentIds);
    for (const valId of summary.validationIds) {
      assert.equal(devSet.has(valId), false, `Validation ID ${valId} must not overlap development`);
    }

    for (const cat of ['approval', 'permissions', 'scope', 'tool-errors', 'recovery']) {
      const counts = summary.byCategory[cat];
      assert.ok(counts, `Missing category ${cat}`);
      assert.ok(counts.positive >= 1, `Missing positive case for ${cat}`);
      assert.ok(counts.negative >= 1, `Missing negative case for ${cat}`);
    }

    assert.ok(summary.targetSurfaceCounts.roles > 0);
    assert.ok(summary.targetSurfaceCounts.prompts > 0);
    assert.ok(summary.targetSurfaceCounts.skills > 0);
    assert.ok(summary.targetSurfaceCounts.workflows > 0);
    assert.ok(summary.targetSurfaceCounts.adapters > 0);

    const sanitizedIncidents = corpus.all.filter((s) => s.provenance.kind === 'sanitized-incident');
    assert.ok(sanitizedIncidents.length >= 1, 'Expected at least one sanitized-incident scenario');
  });

  it('rejects invalid scenarios, rubrics, manifests, and results', () => {
    const baseScenario = readJson('eval/examples/scenario.example.json') as Record<string, unknown>;

    assert.throws(
      () => validateScenario({ ...baseScenario, schemaVersion: 2 }),
      /schemaVersion must be 1/,
    );
    assert.throws(
      () => validateScenario({ ...baseScenario, extraField: true }),
      /not an allowed property/,
    );
    assert.throws(
      () => validateScenario({ ...baseScenario, set: 'validation' }),
      /must start with "EDD-VAL-"/,
    );
    assert.throws(
      () =>
        validateScenario({
          ...baseScenario,
          provenance: { kind: 'synthetic', sanitized: false, sourceSummary: 'unsanitized' },
        }),
      /sanitized must be true/,
    );

    const baseRubric = readJson('eval/examples/rubric.example.json') as Record<string, unknown>;
    assert.throws(
      () => validateRubric({ ...baseRubric, mode: 'live' }),
      /judge is required when mode is "live"/,
    );

    const baseManifest = readJson('eval/examples/run-manifest.example.json') as Record<
      string,
      unknown
    >;
    assert.throws(
      () =>
        validateRunManifest({
          ...baseManifest,
          isolation: { tempRepo: true, isolatedConfig: true, networkAllowed: true },
        }),
      /networkAllowed must be false in deterministic mode/,
    );

    const baseResult = readJson('eval/examples/result.example.json') as Record<string, unknown>;
    assert.throws(
      () => validateResult({ ...baseResult, outcome: 'unknown' }),
      /outcome must be one of/,
    );
  });

  it('rejects duplicate scenario IDs across development and validation directories', () => {
    const tmpRoot = join(tmpdir(), `edd-corpus-dup-${Date.now()}`);
    try {
      mkdirSync(join(tmpRoot, 'development'), { recursive: true });
      mkdirSync(join(tmpRoot, 'validation'), { recursive: true });

      const devScenario = readJson('eval/corpus/development/EDD-DEV-001.json') as Record<
        string,
        unknown
      >;
      writeFileSync(
        join(tmpRoot, 'development', 'EDD-DEV-001.json'),
        JSON.stringify(devScenario),
        'utf8',
      );
      writeFileSync(
        join(tmpRoot, 'validation', 'EDD-DEV-001.json'),
        JSON.stringify({ ...devScenario, set: 'validation' }),
        'utf8',
      );

      assert.throws(() => loadScenarioCorpus(tmpRoot), /must start with "EDD-VAL-"/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
