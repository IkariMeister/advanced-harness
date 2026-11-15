import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const EVAL_SCHEMA_VERSION = 1 as const;

export const SCENARIO_SETS = ['development', 'validation'] as const;
export type ScenarioSet = (typeof SCENARIO_SETS)[number];

export const SCENARIO_POLARITIES = ['positive', 'negative'] as const;
export type ScenarioPolarity = (typeof SCENARIO_POLARITIES)[number];

export const SCENARIO_CATEGORIES = [
  'approval',
  'permissions',
  'scope',
  'tool-errors',
  'recovery',
  'incident',
] as const;
export type ScenarioCategory = (typeof SCENARIO_CATEGORIES)[number];

export const CORE_COVERAGE_CATEGORIES = [
  'approval',
  'permissions',
  'scope',
  'tool-errors',
  'recovery',
] as const;

export const SCENARIO_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ScenarioSeverity = (typeof SCENARIO_SEVERITIES)[number];

export const EVAL_ROLES = [
  'lead',
  'operator',
  'external',
  'researcher',
  'planner',
  'implementer',
  'reviewer',
  'qa',
  'engineer',
  'operations',
] as const;
export type EvalRole = (typeof EVAL_ROLES)[number];

export const EVAL_HOSTS = ['opencode', 'claude-code', 'antigravity', 'codex', 'cursor'] as const;
export type EvalHost = (typeof EVAL_HOSTS)[number];

export const PRECONDITION_HOSTS = [...EVAL_HOSTS, 'any'] as const;
export type PreconditionHost = (typeof PRECONDITION_HOSTS)[number];

export const ROLE_SETUPS = ['eight-role', 'engineer-pilot', 'operations-pilot'] as const;
export type RoleSetup = (typeof ROLE_SETUPS)[number];

export const PRECONDITION_ROLE_SETUPS = [...ROLE_SETUPS, 'any'] as const;
export type PreconditionRoleSetup = (typeof PRECONDITION_ROLE_SETUPS)[number];

export const EXPECTED_OUTCOME_STATUSES = ['pass', 'fail', 'inconclusive'] as const;
export type ExpectedOutcomeStatus = (typeof EXPECTED_OUTCOME_STATUSES)[number];

export const RESULT_OUTCOMES = [
  'pass',
  'fail',
  'skipped',
  'inconclusive',
  'infrastructure_error',
] as const;
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];

export const EVAL_MODES = ['deterministic', 'live'] as const;
export type EvalMode = (typeof EVAL_MODES)[number];

export const RUBRIC_METRICS = [
  'outcome-match',
  'observable-state',
  'permission-compliance',
  'handoff-count',
  'role-transitions',
  'skill-invocation',
  'evidence-quality',
  'requirement-coverage',
  'rework-plan-drift',
  'human-interventions',
] as const;
export type RubricMetric = (typeof RUBRIC_METRICS)[number];

export const EVIDENCE_CATEGORIES = [
  'unit-tests',
  'static-analysis',
  'build',
  'e2e',
  'custom',
] as const;
export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];

export const EVIDENCE_BASES = ['re-run', 'judged from evidence only'] as const;
export type EvidenceBasis = (typeof EVIDENCE_BASES)[number];

export interface EvalScenario {
  schemaVersion: 1;
  id: string;
  version: string;
  set: ScenarioSet;
  title: string;
  description: string;
  polarity: ScenarioPolarity;
  category: ScenarioCategory;
  severity: ScenarioSeverity;
  targets: {
    roles: EvalRole[];
    prompts: string[];
    skills: string[];
    workflows: string[];
    adapters: EvalHost[];
  };
  preconditions: {
    repoState: string;
    host: PreconditionHost;
    roleSetup: PreconditionRoleSetup;
    constraints: string[];
  };
  stimulus: {
    userPrompt: string;
    events: string[];
  };
  expectedOutcome: {
    status: ExpectedOutcomeStatus;
    assertions: string[];
    requiredSkills?: string[];
    expectedRoleTransitions?: string[];
    observableFinalState: string[];
  };
  evidence: {
    format: 'evidence-collection-v1';
    requiredArtifacts: string[];
  };
  provenance: {
    kind: 'synthetic' | 'sanitized-incident';
    sanitized: boolean;
    sourceSummary: string;
  };
}

export interface EvalRubricCriterion {
  id: string;
  description: string;
  metric: RubricMetric;
  weight: number;
  required: boolean;
}

export interface EvalRubric {
  schemaVersion: 1;
  id: string;
  version: string;
  mode: EvalMode;
  judge?: {
    modelId: string;
    rubricVersion: string;
    calibratedWithHumanExamples: boolean;
  };
  criteria: EvalRubricCriterion[];
}

export interface EvalRunManifest {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  mode: EvalMode;
  host: EvalHost;
  roleSetup: RoleSetup;
  modelConfig: {
    provider: string;
    fixtureLoopbackOnly: boolean;
    roleModels?: Record<string, string>;
  };
  rubricId: string;
  rubricVersion: string;
  isolation: {
    tempRepo: boolean;
    isolatedConfig: boolean;
    networkAllowed: boolean;
  };
  scenarioIds: string[];
}

export interface EvalResult {
  schemaVersion: 1;
  runId: string;
  scenarioId: string;
  scenarioVersion: string;
  outcome: ResultOutcome;
  reason: string;
  durationMs: number;
  observableStateChecks: Array<{
    assertion: string;
    passed: boolean;
    observed: string;
  }>;
  evidence: Array<{
    schemaVersion: 1;
    check: {
      name: string;
      category: EvidenceCategory;
    };
    execution: {
      command: string;
      exitStatus: number;
      durationMs: number;
      basis: EvidenceBasis;
    };
    artifacts: string[];
  }>;
  metrics: {
    handoffCount: number;
    roleTransitions: string[];
    skillsInvoked: string[];
    humanInterventions: number;
    permissionAmbiguities: number;
    reviewDetectedDefects: number;
    escapedDefects: number;
    tokenCostUsd?: number;
  };
}

export interface ScenarioCorpusSummary {
  total: number;
  developmentIds: string[];
  validationIds: string[];
  byCategory: Record<string, { positive: number; negative: number }>;
  targetSurfaceCounts: {
    roles: number;
    prompts: number;
    skills: number;
    workflows: number;
    adapters: number;
  };
}

const SCENARIO_ID_RE = /^EDD-(DEV|VAL)-[0-9]{3,}$/;
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value;
}

function assertAllowedKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in obj)) {
      throw new Error(`${path}.${key} is required.`);
    }
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`${path}.${key} is not an allowed property.`);
    }
  }
}

function assertSchemaVersion(obj: Record<string, unknown>, path: string): 1 {
  if (obj.schemaVersion !== EVAL_SCHEMA_VERSION) {
    throw new Error(`${path}.schemaVersion must be ${EVAL_SCHEMA_VERSION}.`);
  }
  return 1;
}

function assertNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
}

function assertSemver(value: unknown, path: string): string {
  const s = assertNonEmptyString(value, path);
  if (!SEMVER_RE.test(s)) {
    throw new Error(`${path} must be a semantic version (MAJOR.MINOR.PATCH).`);
  }
  return s;
}

function assertScenarioId(value: unknown, path: string): string {
  const s = assertNonEmptyString(value, path);
  if (!SCENARIO_ID_RE.test(s)) {
    throw new Error(`${path} must match EDD-(DEV|VAL)-NNN.`);
  }
  return s;
}

function assertBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean.`);
  }
  return value;
}

function assertNonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative finite number.`);
  }
  return value;
}

function assertInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${path} must be an integer.`);
  }
  return value;
}

function assertNonNegativeInteger(value: unknown, path: string): number {
  const n = assertInteger(value, path);
  if (n < 0) {
    throw new Error(`${path} must be a non-negative integer.`);
  }
  return n;
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  const s = assertNonEmptyString(value, path);
  if (!allowed.includes(s as T)) {
    throw new Error(`${path} must be one of: ${allowed.join(', ')}.`);
  }
  return s as T;
}

function assertStringArray(
  value: unknown,
  path: string,
  options: { minItems?: number } = {},
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  if (options.minItems !== undefined && value.length < options.minItems) {
    throw new Error(`${path} must contain at least ${options.minItems} item(s).`);
  }
  return value.map((item, idx) => assertNonEmptyString(item, `${path}[${idx}]`));
}

function assertEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value.map((item, idx) => assertEnum(item, allowed, `${path}[${idx}]`));
}

/** Validates an EDD v1 scenario object against schemaVersion 1 rules. */
export function validateScenario(input: unknown, path = 'scenario'): EvalScenario {
  const obj = assertObject(input, path);
  assertAllowedKeys(
    obj,
    [
      'schemaVersion',
      'id',
      'version',
      'set',
      'title',
      'description',
      'polarity',
      'category',
      'severity',
      'targets',
      'preconditions',
      'stimulus',
      'expectedOutcome',
      'evidence',
      'provenance',
    ],
    [],
    path,
  );

  const schemaVersion = assertSchemaVersion(obj, path);
  const id = assertScenarioId(obj.id, `${path}.id`);
  const version = assertSemver(obj.version, `${path}.version`);
  const set = assertEnum(obj.set, SCENARIO_SETS, `${path}.set`);

  const expectedPrefix = set === 'development' ? 'EDD-DEV-' : 'EDD-VAL-';
  if (!id.startsWith(expectedPrefix)) {
    throw new Error(`${path}.id "${id}" must start with "${expectedPrefix}" for set "${set}".`);
  }

  const title = assertNonEmptyString(obj.title, `${path}.title`);
  const description = assertNonEmptyString(obj.description, `${path}.description`);
  const polarity = assertEnum(obj.polarity, SCENARIO_POLARITIES, `${path}.polarity`);
  const category = assertEnum(obj.category, SCENARIO_CATEGORIES, `${path}.category`);
  const severity = assertEnum(obj.severity, SCENARIO_SEVERITIES, `${path}.severity`);

  const targetsObj = assertObject(obj.targets, `${path}.targets`);
  assertAllowedKeys(
    targetsObj,
    ['roles', 'prompts', 'skills', 'workflows', 'adapters'],
    [],
    `${path}.targets`,
  );
  const targets = {
    roles: assertEnumArray(targetsObj.roles, EVAL_ROLES, `${path}.targets.roles`),
    prompts: assertStringArray(targetsObj.prompts, `${path}.targets.prompts`),
    skills: assertStringArray(targetsObj.skills, `${path}.targets.skills`),
    workflows: assertStringArray(targetsObj.workflows, `${path}.targets.workflows`),
    adapters: assertEnumArray(targetsObj.adapters, EVAL_HOSTS, `${path}.targets.adapters`),
  };

  const preObj = assertObject(obj.preconditions, `${path}.preconditions`);
  assertAllowedKeys(
    preObj,
    ['repoState', 'host', 'roleSetup', 'constraints'],
    [],
    `${path}.preconditions`,
  );
  const preconditions = {
    repoState: assertNonEmptyString(preObj.repoState, `${path}.preconditions.repoState`),
    host: assertEnum(preObj.host, PRECONDITION_HOSTS, `${path}.preconditions.host`),
    roleSetup: assertEnum(
      preObj.roleSetup,
      PRECONDITION_ROLE_SETUPS,
      `${path}.preconditions.roleSetup`,
    ),
    constraints: assertStringArray(preObj.constraints, `${path}.preconditions.constraints`, {
      minItems: 1,
    }),
  };

  const stimObj = assertObject(obj.stimulus, `${path}.stimulus`);
  assertAllowedKeys(stimObj, ['userPrompt', 'events'], [], `${path}.stimulus`);
  const stimulus = {
    userPrompt: assertNonEmptyString(stimObj.userPrompt, `${path}.stimulus.userPrompt`),
    events: assertStringArray(stimObj.events, `${path}.stimulus.events`, { minItems: 1 }),
  };

  const expObj = assertObject(obj.expectedOutcome, `${path}.expectedOutcome`);
  assertAllowedKeys(
    expObj,
    ['status', 'assertions', 'observableFinalState'],
    ['requiredSkills', 'expectedRoleTransitions'],
    `${path}.expectedOutcome`,
  );
  const expectedOutcome: EvalScenario['expectedOutcome'] = {
    status: assertEnum(expObj.status, EXPECTED_OUTCOME_STATUSES, `${path}.expectedOutcome.status`),
    assertions: assertStringArray(expObj.assertions, `${path}.expectedOutcome.assertions`, {
      minItems: 1,
    }),
    observableFinalState: assertStringArray(
      expObj.observableFinalState,
      `${path}.expectedOutcome.observableFinalState`,
      { minItems: 1 },
    ),
  };
  if (expObj.requiredSkills !== undefined) {
    expectedOutcome.requiredSkills = assertStringArray(
      expObj.requiredSkills,
      `${path}.expectedOutcome.requiredSkills`,
    );
  }
  if (expObj.expectedRoleTransitions !== undefined) {
    expectedOutcome.expectedRoleTransitions = assertStringArray(
      expObj.expectedRoleTransitions,
      `${path}.expectedOutcome.expectedRoleTransitions`,
    );
  }

  const evObj = assertObject(obj.evidence, `${path}.evidence`);
  assertAllowedKeys(evObj, ['format', 'requiredArtifacts'], [], `${path}.evidence`);
  if (evObj.format !== 'evidence-collection-v1') {
    throw new Error(`${path}.evidence.format must be "evidence-collection-v1".`);
  }
  const evidence = {
    format: 'evidence-collection-v1' as const,
    requiredArtifacts: assertStringArray(
      evObj.requiredArtifacts,
      `${path}.evidence.requiredArtifacts`,
      { minItems: 1 },
    ),
  };

  const provObj = assertObject(obj.provenance, `${path}.provenance`);
  assertAllowedKeys(provObj, ['kind', 'sanitized', 'sourceSummary'], [], `${path}.provenance`);
  const kind = assertEnum(
    provObj.kind,
    ['synthetic', 'sanitized-incident'] as const,
    `${path}.provenance.kind`,
  );
  const sanitized = assertBoolean(provObj.sanitized, `${path}.provenance.sanitized`);
  if (!sanitized) {
    throw new Error(`${path}.provenance.sanitized must be true for versioned corpus scenarios.`);
  }
  const sourceSummary = assertNonEmptyString(
    provObj.sourceSummary,
    `${path}.provenance.sourceSummary`,
  );

  return {
    schemaVersion,
    id,
    version,
    set,
    title,
    description,
    polarity,
    category,
    severity,
    targets,
    preconditions,
    stimulus,
    expectedOutcome,
    evidence,
    provenance: { kind, sanitized, sourceSummary },
  };
}

/** Validates an EDD v1 rubric object against schemaVersion 1 rules. */
export function validateRubric(input: unknown, path = 'rubric'): EvalRubric {
  const obj = assertObject(input, path);
  assertAllowedKeys(obj, ['schemaVersion', 'id', 'version', 'mode', 'criteria'], ['judge'], path);

  const schemaVersion = assertSchemaVersion(obj, path);
  const id = assertNonEmptyString(obj.id, `${path}.id`);
  const version = assertSemver(obj.version, `${path}.version`);
  const mode = assertEnum(obj.mode, EVAL_MODES, `${path}.mode`);

  if (!Array.isArray(obj.criteria) || obj.criteria.length === 0) {
    throw new Error(`${path}.criteria must be a non-empty array.`);
  }
  const criteria: EvalRubricCriterion[] = obj.criteria.map((raw, idx) => {
    const cPath = `${path}.criteria[${idx}]`;
    const c = assertObject(raw, cPath);
    assertAllowedKeys(c, ['id', 'description', 'metric', 'weight', 'required'], [], cPath);
    return {
      id: assertNonEmptyString(c.id, `${cPath}.id`),
      description: assertNonEmptyString(c.description, `${cPath}.description`),
      metric: assertEnum(c.metric, RUBRIC_METRICS, `${cPath}.metric`),
      weight: assertNonNegativeNumber(c.weight, `${cPath}.weight`),
      required: assertBoolean(c.required, `${cPath}.required`),
    };
  });

  const result: EvalRubric = { schemaVersion, id, version, mode, criteria };
  if (obj.judge !== undefined) {
    const jObj = assertObject(obj.judge, `${path}.judge`);
    assertAllowedKeys(
      jObj,
      ['modelId', 'rubricVersion', 'calibratedWithHumanExamples'],
      [],
      `${path}.judge`,
    );
    result.judge = {
      modelId: assertNonEmptyString(jObj.modelId, `${path}.judge.modelId`),
      rubricVersion: assertNonEmptyString(jObj.rubricVersion, `${path}.judge.rubricVersion`),
      calibratedWithHumanExamples: assertBoolean(
        jObj.calibratedWithHumanExamples,
        `${path}.judge.calibratedWithHumanExamples`,
      ),
    };
  } else if (mode === 'live') {
    throw new Error(`${path}.judge is required when mode is "live".`);
  }

  return result;
}

/** Validates an EDD v1 run manifest object against schemaVersion 1 rules. */
export function validateRunManifest(input: unknown, path = 'runManifest'): EvalRunManifest {
  const obj = assertObject(input, path);
  assertAllowedKeys(
    obj,
    [
      'schemaVersion',
      'runId',
      'createdAt',
      'mode',
      'host',
      'roleSetup',
      'modelConfig',
      'rubricId',
      'rubricVersion',
      'isolation',
      'scenarioIds',
    ],
    [],
    path,
  );

  const schemaVersion = assertSchemaVersion(obj, path);
  const runId = assertNonEmptyString(obj.runId, `${path}.runId`);
  const createdAt = assertNonEmptyString(obj.createdAt, `${path}.createdAt`);
  const mode = assertEnum(obj.mode, EVAL_MODES, `${path}.mode`);
  const host = assertEnum(obj.host, EVAL_HOSTS, `${path}.host`);
  const roleSetup = assertEnum(obj.roleSetup, ROLE_SETUPS, `${path}.roleSetup`);
  const rubricId = assertNonEmptyString(obj.rubricId, `${path}.rubricId`);
  const rubricVersion = assertSemver(obj.rubricVersion, `${path}.rubricVersion`);

  const mcObj = assertObject(obj.modelConfig, `${path}.modelConfig`);
  assertAllowedKeys(
    mcObj,
    ['provider', 'fixtureLoopbackOnly'],
    ['roleModels'],
    `${path}.modelConfig`,
  );
  const modelConfig: EvalRunManifest['modelConfig'] = {
    provider: assertNonEmptyString(mcObj.provider, `${path}.modelConfig.provider`),
    fixtureLoopbackOnly: assertBoolean(
      mcObj.fixtureLoopbackOnly,
      `${path}.modelConfig.fixtureLoopbackOnly`,
    ),
  };
  if (mcObj.roleModels !== undefined) {
    const rmObj = assertObject(mcObj.roleModels, `${path}.modelConfig.roleModels`);
    const roleModels: Record<string, string> = {};
    for (const [k, v] of Object.entries(rmObj)) {
      roleModels[k] = assertNonEmptyString(v, `${path}.modelConfig.roleModels.${k}`);
    }
    modelConfig.roleModels = roleModels;
  }

  const isoObj = assertObject(obj.isolation, `${path}.isolation`);
  assertAllowedKeys(
    isoObj,
    ['tempRepo', 'isolatedConfig', 'networkAllowed'],
    [],
    `${path}.isolation`,
  );
  const isolation = {
    tempRepo: assertBoolean(isoObj.tempRepo, `${path}.isolation.tempRepo`),
    isolatedConfig: assertBoolean(isoObj.isolatedConfig, `${path}.isolation.isolatedConfig`),
    networkAllowed: assertBoolean(isoObj.networkAllowed, `${path}.isolation.networkAllowed`),
  };

  if (mode === 'deterministic') {
    if (!modelConfig.fixtureLoopbackOnly) {
      throw new Error(`${path}.modelConfig.fixtureLoopbackOnly must be true in deterministic mode.`);
    }
    if (isolation.networkAllowed) {
      throw new Error(`${path}.isolation.networkAllowed must be false in deterministic mode.`);
    }
  }

  if (!Array.isArray(obj.scenarioIds) || obj.scenarioIds.length === 0) {
    throw new Error(`${path}.scenarioIds must be a non-empty array.`);
  }
  const scenarioIds = obj.scenarioIds.map((id, idx) =>
    assertScenarioId(id, `${path}.scenarioIds[${idx}]`),
  );

  return {
    schemaVersion,
    runId,
    createdAt,
    mode,
    host,
    roleSetup,
    modelConfig,
    rubricId,
    rubricVersion,
    isolation,
    scenarioIds,
  };
}

/** Validates an EDD v1 evaluation result object against schemaVersion 1 rules. */
export function validateResult(input: unknown, path = 'result'): EvalResult {
  const obj = assertObject(input, path);
  assertAllowedKeys(
    obj,
    [
      'schemaVersion',
      'runId',
      'scenarioId',
      'scenarioVersion',
      'outcome',
      'reason',
      'durationMs',
      'observableStateChecks',
      'evidence',
      'metrics',
    ],
    [],
    path,
  );

  const schemaVersion = assertSchemaVersion(obj, path);
  const runId = assertNonEmptyString(obj.runId, `${path}.runId`);
  const scenarioId = assertScenarioId(obj.scenarioId, `${path}.scenarioId`);
  const scenarioVersion = assertSemver(obj.scenarioVersion, `${path}.scenarioVersion`);
  const outcome = assertEnum(obj.outcome, RESULT_OUTCOMES, `${path}.outcome`);
  const reason = assertNonEmptyString(obj.reason, `${path}.reason`);
  const durationMs = assertNonNegativeNumber(obj.durationMs, `${path}.durationMs`);

  if (!Array.isArray(obj.observableStateChecks) || obj.observableStateChecks.length === 0) {
    throw new Error(`${path}.observableStateChecks must be a non-empty array.`);
  }
  const observableStateChecks = obj.observableStateChecks.map((raw, idx) => {
    const cPath = `${path}.observableStateChecks[${idx}]`;
    const c = assertObject(raw, cPath);
    assertAllowedKeys(c, ['assertion', 'passed', 'observed'], [], cPath);
    return {
      assertion: assertNonEmptyString(c.assertion, `${cPath}.assertion`),
      passed: assertBoolean(c.passed, `${cPath}.passed`),
      observed: assertNonEmptyString(c.observed, `${cPath}.observed`),
    };
  });

  if (!Array.isArray(obj.evidence) || obj.evidence.length === 0) {
    throw new Error(`${path}.evidence must be a non-empty array.`);
  }
  const evidence = obj.evidence.map((raw, idx) => {
    const ePath = `${path}.evidence[${idx}]`;
    const e = assertObject(raw, ePath);
    assertAllowedKeys(e, ['schemaVersion', 'check', 'execution', 'artifacts'], [], ePath);
    const evSchemaVersion = assertSchemaVersion(e, ePath);
    const chk = assertObject(e.check, `${ePath}.check`);
    assertAllowedKeys(chk, ['name', 'category'], [], `${ePath}.check`);
    const exec = assertObject(e.execution, `${ePath}.execution`);
    assertAllowedKeys(
      exec,
      ['command', 'exitStatus', 'durationMs', 'basis'],
      [],
      `${ePath}.execution`,
    );
    return {
      schemaVersion: evSchemaVersion,
      check: {
        name: assertNonEmptyString(chk.name, `${ePath}.check.name`),
        category: assertEnum(chk.category, EVIDENCE_CATEGORIES, `${ePath}.check.category`),
      },
      execution: {
        command: assertNonEmptyString(exec.command, `${ePath}.execution.command`),
        exitStatus: assertInteger(exec.exitStatus, `${ePath}.execution.exitStatus`),
        durationMs: assertNonNegativeNumber(exec.durationMs, `${ePath}.execution.durationMs`),
        basis: assertEnum(exec.basis, EVIDENCE_BASES, `${ePath}.execution.basis`),
      },
      artifacts: assertStringArray(e.artifacts, `${ePath}.artifacts`),
    };
  });

  const mObj = assertObject(obj.metrics, `${path}.metrics`);
  assertAllowedKeys(
    mObj,
    [
      'handoffCount',
      'roleTransitions',
      'skillsInvoked',
      'humanInterventions',
      'permissionAmbiguities',
      'reviewDetectedDefects',
      'escapedDefects',
    ],
    ['tokenCostUsd'],
    `${path}.metrics`,
  );
  const metrics: EvalResult['metrics'] = {
    handoffCount: assertNonNegativeInteger(mObj.handoffCount, `${path}.metrics.handoffCount`),
    roleTransitions: assertStringArray(mObj.roleTransitions, `${path}.metrics.roleTransitions`),
    skillsInvoked: assertStringArray(mObj.skillsInvoked, `${path}.metrics.skillsInvoked`),
    humanInterventions: assertNonNegativeInteger(
      mObj.humanInterventions,
      `${path}.metrics.humanInterventions`,
    ),
    permissionAmbiguities: assertNonNegativeInteger(
      mObj.permissionAmbiguities,
      `${path}.metrics.permissionAmbiguities`,
    ),
    reviewDetectedDefects: assertNonNegativeInteger(
      mObj.reviewDetectedDefects,
      `${path}.metrics.reviewDetectedDefects`,
    ),
    escapedDefects: assertNonNegativeInteger(
      mObj.escapedDefects,
      `${path}.metrics.escapedDefects`,
    ),
  };
  if (mObj.tokenCostUsd !== undefined) {
    metrics.tokenCostUsd = assertNonNegativeNumber(
      mObj.tokenCostUsd,
      `${path}.metrics.tokenCostUsd`,
    );
  }

  return {
    schemaVersion,
    runId,
    scenarioId,
    scenarioVersion,
    outcome,
    reason,
    durationMs,
    observableStateChecks,
    evidence,
    metrics,
  };
}

function readSetScenarios(corpusRoot: string, set: ScenarioSet): EvalScenario[] {
  const dir = join(corpusRoot, set);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((file) => {
    const fullPath = join(dir, file);
    const parsed: unknown = JSON.parse(readFileSync(fullPath, 'utf8'));
    const scenario = validateScenario(parsed, `${set}/${file}`);
    if (scenario.set !== set) {
      throw new Error(`${set}/${file} has set "${scenario.set}" inside "${set}" directory.`);
    }
    return scenario;
  });
}

/** Loads and validates both development and validation scenario sets from disk. */
export function loadScenarioCorpus(corpusRoot: string): {
  development: EvalScenario[];
  validation: EvalScenario[];
  all: EvalScenario[];
} {
  const development = readSetScenarios(corpusRoot, 'development');
  const validation = readSetScenarios(corpusRoot, 'validation');
  const all = [...development, ...validation];

  const seen = new Set<string>();
  for (const scenario of all) {
    if (seen.has(scenario.id)) {
      throw new Error(`Duplicate scenario ID "${scenario.id}" in corpus.`);
    }
    seen.add(scenario.id);
  }

  return { development, validation, all };
}

/** Verifies corpus size, set separation, polarity coverage, and target surface coverage. */
export function validateCorpusCoverage(scenarios: readonly EvalScenario[]): ScenarioCorpusSummary {
  if (scenarios.length < 20) {
    throw new Error(`Scenario corpus must contain at least 20 scenarios; found ${scenarios.length}.`);
  }

  const developmentIds: string[] = [];
  const validationIds: string[] = [];
  const byCategory: Record<string, { positive: number; negative: number }> = {};
  const targetSurfaceCounts = {
    roles: 0,
    prompts: 0,
    skills: 0,
    workflows: 0,
    adapters: 0,
  };

  for (const scenario of scenarios) {
    if (scenario.set === 'development') {
      if (!scenario.id.startsWith('EDD-DEV-')) {
        throw new Error(`Development scenario "${scenario.id}" must use EDD-DEV- prefix.`);
      }
      developmentIds.push(scenario.id);
    } else {
      if (!scenario.id.startsWith('EDD-VAL-')) {
        throw new Error(`Validation scenario "${scenario.id}" must use EDD-VAL- prefix.`);
      }
      validationIds.push(scenario.id);
    }

    const counts = byCategory[scenario.category] ?? { positive: 0, negative: 0 };
    counts[scenario.polarity] += 1;
    byCategory[scenario.category] = counts;

    if (scenario.targets.roles.length > 0) targetSurfaceCounts.roles += 1;
    if (scenario.targets.prompts.length > 0) targetSurfaceCounts.prompts += 1;
    if (scenario.targets.skills.length > 0) targetSurfaceCounts.skills += 1;
    if (scenario.targets.workflows.length > 0) targetSurfaceCounts.workflows += 1;
    if (scenario.targets.adapters.length > 0) targetSurfaceCounts.adapters += 1;
  }

  if (developmentIds.length === 0 || validationIds.length === 0) {
    throw new Error('Both development and validation sets must be non-empty.');
  }

  const devSet = new Set(developmentIds);
  for (const id of validationIds) {
    if (devSet.has(id)) {
      throw new Error(`Scenario ID "${id}" appears in both development and validation sets.`);
    }
  }

  for (const category of CORE_COVERAGE_CATEGORIES) {
    const counts = byCategory[category];
    if (!counts || counts.positive === 0 || counts.negative === 0) {
      throw new Error(
        `Category "${category}" must include at least one positive and one negative scenario.`,
      );
    }
  }

  for (const [surface, count] of Object.entries(targetSurfaceCounts)) {
    if (count === 0) {
      throw new Error(`Corpus must cover target surface "${surface}" in at least one scenario.`);
    }
  }

  return {
    total: scenarios.length,
    developmentIds,
    validationIds,
    byCategory,
    targetSurfaceCounts,
  };
}
