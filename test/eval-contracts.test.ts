import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Ajv2020Import from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
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

type AjvInstance = { compile: (schema: object) => ValidateFunction };
type AjvCtor = new (opts: {
  allErrors: boolean;
  strictSchema: boolean;
  strictTypes: boolean;
}) => AjvInstance;
const Ajv2020 =
  (Ajv2020Import as unknown as { default?: AjvCtor }).default ??
  (Ajv2020Import as unknown as AjvCtor);

// strictSchema catches unknown/misspelled keywords; strictTypes is false because
// conditional allOf/if/then branches refine properties whose types are declared at root.
const ajv = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false });
const validateScenarioSchema = ajv.compile(readJson('eval/schemas/scenario.schema.json') as object);
const validateRubricSchema = ajv.compile(readJson('eval/schemas/rubric.schema.json') as object);
const validateManifestSchema = ajv.compile(
  readJson('eval/schemas/run-manifest.schema.json') as object,
);
const validateResultSchema = ajv.compile(readJson('eval/schemas/result.schema.json') as object);

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

describe('EDD v1 evaluation contracts', () => {
  it('validates all four example files against both JSON Schemas and TypeScript validators', () => {
    const scenarioRaw = readJson('eval/examples/scenario.example.json');
    const rubricRaw = readJson('eval/examples/rubric.example.json');
    const manifestRaw = readJson('eval/examples/run-manifest.example.json');
    const resultRaw = readJson('eval/examples/result.example.json');

    assertSchemaValid(validateScenarioSchema, scenarioRaw, 'scenario.example.json');
    assertSchemaValid(validateRubricSchema, rubricRaw, 'rubric.example.json');
    assertSchemaValid(validateManifestSchema, manifestRaw, 'run-manifest.example.json');
    assertSchemaValid(validateResultSchema, resultRaw, 'result.example.json');

    const scenario = validateScenario(scenarioRaw);
    const rubric = validateRubric(rubricRaw);
    const manifest = validateRunManifest(manifestRaw);
    const result = validateResult(resultRaw);

    assert.equal(scenario.id, 'EDD-DEV-001');
    assert.equal(rubric.mode, 'deterministic');
    assert.equal(manifest.isolation.networkAllowed, false);
    assert.equal(result.outcome, 'pass');
  });

  it('validates the full scenario corpus against JSON Schema, separation, and coverage rules', () => {
    const corpus = loadScenarioCorpus(join(REPO_ROOT, 'eval/corpus'));
    for (const scenario of corpus.all) {
      assertSchemaValid(validateScenarioSchema, scenario, scenario.id);
    }

    const summary = validateCorpusCoverage(corpus.all);

    assert.ok(summary.total >= 20, `Expected >= 20 scenarios, got ${summary.total}`);
    assert.ok(corpus.development.length > 0, 'Development set must be non-empty');
    assert.ok(corpus.validation.length > 0, 'Validation set must be non-empty');

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

  it('enforces parity between JSON Schemas and TypeScript validators on invalid inputs', () => {
    const baseScenario = readJson('eval/examples/scenario.example.json') as Record<string, unknown>;
    const invalidScenarios: Array<{ label: string; data: unknown; pattern: RegExp }> = [
      { label: 'wrong schemaVersion', data: { ...baseScenario, schemaVersion: 2 }, pattern: /schemaVersion must be 1/ },
      { label: 'extra field', data: { ...baseScenario, extraField: true }, pattern: /not an allowed property/ },
      { label: 'whitespace title', data: { ...baseScenario, title: '   ' }, pattern: /non-empty string/ },
      { label: 'set/prefix mismatch', data: { ...baseScenario, set: 'validation' }, pattern: /must start with "EDD-VAL-"/ },
      {
        label: 'unsanitized provenance',
        data: {
          ...baseScenario,
          provenance: { kind: 'synthetic', sanitized: false, sourceSummary: 'unsanitized' },
        },
        pattern: /sanitized must be true/,
      },
    ];

    for (const { label, data, pattern } of invalidScenarios) {
      assert.equal(validateScenarioSchema(data), false, `Schema should reject: ${label}`);
      assert.throws(() => validateScenario(data), pattern, `Validator should reject: ${label}`);
    }

    const baseRubric = readJson('eval/examples/rubric.example.json') as Record<string, unknown>;
    const liveNoJudge = { ...baseRubric, mode: 'live' };
    assert.equal(validateRubricSchema(liveNoJudge), false);
    assert.throws(() => validateRubric(liveNoJudge), /judge is required when mode is "live"/);

    const existingCriteria = baseRubric.criteria as unknown[];
    const dupCriteriaRubric = { ...baseRubric, criteria: [existingCriteria[0], existingCriteria[0]] };
    assert.throws(() => validateRubric(dupCriteriaRubric), /duplicate id/);

    const baseManifest = readJson('eval/examples/run-manifest.example.json') as Record<string, unknown>;
    const badDetManifest = {
      ...baseManifest,
      isolation: { tempRepo: true, isolatedConfig: true, networkAllowed: true },
    };
    assert.equal(validateManifestSchema(badDetManifest), false);
    assert.throws(
      () => validateRunManifest(badDetManifest),
      /networkAllowed must be false in deterministic mode/,
    );

    const badCreatedAtCases = [
      'yesterday',
      '2026-11-15',
      '2026-11-15T14:00:00',
      '2026-11-15T14:00:00z',
    ];
    for (const createdAt of badCreatedAtCases) {
      const badManifest = { ...baseManifest, createdAt };
      assert.equal(validateManifestSchema(badManifest), false);
      assert.throws(
        () => validateRunManifest(badManifest),
        /createdAt must be a valid ISO 8601 timestamp/,
      );
    }

    // Shape-only schema accepts impossible calendar dates, while validateRunManifest rejects them
    const impossibleDateManifest = { ...baseManifest, createdAt: '2026-13-45T99:99:99Z' };
    assert.equal(validateManifestSchema(impossibleDateManifest), true);
    assert.throws(
      () => validateRunManifest(impossibleDateManifest),
      /createdAt must be a valid ISO 8601 timestamp/,
    );

    const fractionalOffsetManifest = {
      ...baseManifest,
      createdAt: '2026-11-15T14:00:00.123+01:00',
    };
    assertSchemaValid(validateManifestSchema, fractionalOffsetManifest, 'fractional offset manifest');
    assert.equal(
      validateRunManifest(fractionalOffsetManifest).createdAt,
      '2026-11-15T14:00:00.123+01:00',
    );
  });

  it('supports empty observations for non-observed outcomes and rejects pass with failed checks', () => {
    const baseResult = readJson('eval/examples/result.example.json') as Record<string, unknown>;

    for (const outcome of ['skipped', 'inconclusive', 'infrastructure_error'] as const) {
      const nonObserved = {
        ...baseResult,
        outcome,
        observableStateChecks: [],
        evidence: [],
      };
      assertSchemaValid(validateResultSchema, nonObserved, `result (${outcome})`);
      assert.equal(validateResult(nonObserved).outcome, outcome);
    }

    const passWithFailedCheck = {
      ...baseResult,
      outcome: 'pass',
      observableStateChecks: [{ assertion: 'clean tree', passed: false, observed: 'dirty' }],
    };
    assert.equal(validateResultSchema(passWithFailedCheck), false);
    assert.throws(
      () => validateResult(passWithFailedCheck),
      /cannot be "pass" when an observableStateCheck failed/,
    );

    const passWithEmptyEvidence = { ...baseResult, outcome: 'pass', evidence: [] };
    assert.equal(validateResultSchema(passWithEmptyEvidence), false);
    assert.throws(() => validateResult(passWithEmptyEvidence), /evidence must be a non-empty array/);
  });

  it('rejects malformed JSON, directory/set mismatch, filename/id mismatch, and cross-set overlap', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'edd-corpus-'));
    try {
      mkdirSync(join(tmpRoot, 'development'), { recursive: true });
      mkdirSync(join(tmpRoot, 'validation'), { recursive: true });

      const devScenario = readJson('eval/corpus/development/EDD-DEV-001.json') as Record<
        string,
        unknown
      >;
      const valScenario = readJson('eval/corpus/validation/EDD-VAL-001.json') as Record<
        string,
        unknown
      >;

      // 1. Filename / ID mismatch
      writeFileSync(
        join(tmpRoot, 'development', 'WRONG-NAME.json'),
        JSON.stringify(devScenario),
        'utf8',
      );
      assert.throws(() => loadScenarioCorpus(tmpRoot), /filename must match scenario\.id/);
      rmSync(join(tmpRoot, 'development', 'WRONG-NAME.json'));

      // 2. Directory / set mismatch
      writeFileSync(
        join(tmpRoot, 'development', 'EDD-VAL-001.json'),
        JSON.stringify(valScenario),
        'utf8',
      );
      assert.throws(() => loadScenarioCorpus(tmpRoot), /inside "development" directory/);
      rmSync(join(tmpRoot, 'development', 'EDD-VAL-001.json'));

      // 3. Malformed JSON names the file
      writeFileSync(join(tmpRoot, 'development', 'EDD-DEV-001.json'), '{not-json', 'utf8');
      assert.throws(() => loadScenarioCorpus(tmpRoot), /Failed to parse development\/EDD-DEV-001\.json/);
      rmSync(join(tmpRoot, 'development', 'EDD-DEV-001.json'));

      // 4. Cross-set title and userPrompt overlap rejected by validateCorpusCoverage
      const corpus = loadScenarioCorpus(join(REPO_ROOT, 'eval/corpus'));
      const firstDev = corpus.development[0]!;
      const overlappingTitleVal = {
        ...corpus.validation[0]!,
        title: firstDev.title,
      };
      assert.throws(
        () =>
          validateCorpusCoverage([
            ...corpus.development,
            overlappingTitleVal,
            ...corpus.validation.slice(1),
          ]),
        /duplicates development title/,
      );

      const overlappingPromptVal = {
        ...corpus.validation[0]!,
        stimulus: {
          ...corpus.validation[0]!.stimulus,
          userPrompt: firstDev.stimulus.userPrompt,
        },
      };
      assert.throws(
        () =>
          validateCorpusCoverage([
            ...corpus.development,
            overlappingPromptVal,
            ...corpus.validation.slice(1),
          ]),
        /duplicates development userPrompt/,
      );
      // 5. Active scenario listed in retired.json is rejected
      writeFileSync(
        join(tmpRoot, 'development', 'EDD-DEV-001.json'),
        JSON.stringify(devScenario),
        'utf8',
      );
      writeFileSync(
        join(tmpRoot, 'retired.json'),
        JSON.stringify({ schemaVersion: 1, retiredIds: ['EDD-DEV-001'] }),
        'utf8',
      );
      assert.throws(() => loadScenarioCorpus(tmpRoot), /listed in retired\.json/);

      // 6. Duplicate ID inside retired.json is rejected
      writeFileSync(
        join(tmpRoot, 'retired.json'),
        JSON.stringify({ schemaVersion: 1, retiredIds: ['EDD-DEV-999', 'EDD-DEV-999'] }),
        'utf8',
      );
      assert.throws(() => loadScenarioCorpus(tmpRoot), /duplicate ID "EDD-DEV-999"/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
