import { readFileSync, statSync } from 'node:fs';
import {
  EVAL_HOSTS,
  EVAL_SCHEMA_VERSION,
  RESULT_OUTCOMES,
  validateResult,
  validateRunManifest,
  type EvalHost,
  type EvalResult,
  type EvalRunManifest,
  type ResultOutcome,
} from './eval-contracts.ts';
import {
  assertAllowedKeys,
  assertBoolean,
  assertEnum,
  assertIntegerMin,
  assertNonEmptyString,
  assertNonNegativeNumber,
  assertObject,
  assertRegexString,
  assertStringArray,
  assertUniqueEnumArray,
  isValidIso8601Timestamp,
  SCENARIO_ID_RE,
  SEMVER_RE,
} from './eval-validation-helpers.ts';

export const RUN_RECORD_KINDS = ['baseline', 'candidate', 'template'] as const;
export type RunRecordKind = (typeof RUN_RECORD_KINDS)[number];

export const EXECUTION_KINDS = ['human-interactive', 'agent-assisted', 'ci-automated'] as const;
export type ExecutionKind = (typeof EXECUTION_KINDS)[number];

export const NETWORK_ENFORCEMENTS = ['netns', 'none', 'not-applicable'] as const;
export type NetworkEnforcement = (typeof NETWORK_ENFORCEMENTS)[number];

export const MODEL_VERIFICATION_STATUSES = ['loopback-fixture', 'verified', 'unverified'] as const;
export type ModelVerificationStatus = (typeof MODEL_VERIFICATION_STATUSES)[number];

export const REPRESENTATIVE_TASK_CLASSES = [
  'routine-implementation',
  'research-then-implementation',
  'architecture',
  'qa-visual',
  'local-external-operations',
] as const;
export type RepresentativeTaskClass = (typeof REPRESENTATIVE_TASK_CLASSES)[number];

export const METHODOLOGY_MODES = ['RDD', 'SDD', 'ODD', 'HYBRID', 'unspecified'] as const;
export type MethodologyModeSelection = (typeof METHODOLOGY_MODES)[number];

export const RIGOR_LEVELS = ['minimal', 'standard', 'strict', 'unspecified'] as const;
export type RigorLevelSelection = (typeof RIGOR_LEVELS)[number];

export const CAPABILITY_STATUSES = ['enforced', 'advisory', 'unsupported', 'unverified'] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const CORE_METRIC_NAMES = [
  'handoffCount',
  'roleTransitions',
  'skillsInvoked',
  'humanInterventions',
  'permissionAmbiguities',
  'reviewDetectedDefects',
  'escapedDefects',
  'tokenCostUsd',
  'durationMs',
] as const;
export type CoreMetricName = (typeof CORE_METRIC_NAMES)[number];

export const NON_MEASURED_STATUSES = ['not-observed', 'unknown'] as const;
export type NonMeasuredStatus = (typeof NON_MEASURED_STATUSES)[number];

export const JOURNEY_TEST_OUTCOMES = ['pass', 'fail', 'todo'] as const;
export type JourneyTestOutcome = (typeof JOURNEY_TEST_OUTCOMES)[number];

export const JOURNEY_RECORD_OUTCOMES = ['pass', 'fail'] as const;
export type JourneyRecordOutcome = (typeof JOURNEY_RECORD_OUTCOMES)[number];

export const JOURNEY_NETWORK_ENFORCEMENTS = ['netns', 'none'] as const;
export type JourneyNetworkEnforcement = (typeof JOURNEY_NETWORK_ENFORCEMENTS)[number];

export interface NotMeasuredMetric {
  status: NonMeasuredStatus;
  note: string;
}

export type CountMetric =
  | NotMeasuredMetric
  | {
      status: 'measured';
      count: number;
      note?: string;
    };

export type RequirementCoverageMetric =
  | NotMeasuredMetric
  | {
      status: 'measured';
      met: number;
      total: number;
      note?: string;
    };

export type EvidenceQualityMetric =
  | NotMeasuredMetric
  | {
      status: 'measured';
      summary: string;
      checksReRun: number;
      checksJudgedFromEvidence: number;
      missingArtifacts: number;
      note?: string;
    };

export type TokenUsageMetric =
  | NotMeasuredMetric
  | {
      status: 'measured';
      inputTokens: number;
      outputTokens: number;
      cachedTokens?: number;
      estimatedCostUsd?: number;
      pricingBasis?: string;
      note?: string;
    };

export interface ScenarioRepeatSummary {
  scenarioId: string;
  scenarioVersion: string;
  bound: boolean;
  outcomes: ResultOutcome[];
  repeatable: boolean;
  differenceCount: number;
  repeatDurationsMs?: number[];
}

export interface JourneyBaselineEntry {
  id: string;
  journey: string;
  testOutcome: JourneyTestOutcome;
  recordOutcome: JourneyRecordOutcome;
  handoffCount: number;
  roleTransitions: string[];
  skillsInvoked: Array<{ skillId: string; loaded: boolean }>;
  toolCallCount: number;
  violationCount: number;
  repeatsByteIdentical?: boolean;
  notes?: string;
}

export interface EvalRunRecord {
  schemaVersion: 1;
  recordId: string;
  protocolVersion: string;
  recordKind: RunRecordKind;
  baselineRef?: string;
  repository: {
    commit: string;
    harnessVersion: string;
    dirty: boolean;
  };
  runner: {
    executedBy: string;
    executionKind: ExecutionKind;
    authorizedBy?: string;
    ciRunRef?: string;
  };
  hostEnvironment: {
    host: EvalHost;
    hostVersion: string;
    os: string;
    networkEnforcement: NetworkEnforcement;
    hermetic: boolean;
    notes?: string;
  };
  modelVerification: {
    status: ModelVerificationStatus;
    evidence: string;
    observedRoleModels?: Record<string, string>;
  };
  hostCapabilityPrerequisites?: {
    matrixSource: string;
    sameRoleApprovalTransition: CapabilityStatus;
    localRemoteIsolation: CapabilityStatus;
    perRoleCommands: CapabilityStatus;
    skillsMcpExposure: CapabilityStatus;
    actualModelRouting: CapabilityStatus;
  };
  taskClassification: {
    taskClasses: RepresentativeTaskClass[];
    taskCriteria: string[];
    methodologyMode?: MethodologyModeSelection;
    rigor?: RigorLevelSelection;
  };
  runManifest: EvalRunManifest;
  repeatability: {
    repeatCount: number;
    allRepeatable: boolean;
    executedScenarios: number;
    totalScenarios: number;
    scenarioSummaries: ScenarioRepeatSummary[];
  };
  results: EvalResult[];
  metricObservation: {
    observed: CoreMetricName[];
    notObserved: CoreMetricName[];
  };
  supplementaryMetrics: {
    requirementCoverage: RequirementCoverageMetric;
    reworkCycles: CountMetric;
    planDriftCount: CountMetric;
    contextReconstructionCount: CountMetric;
    evidenceQuality: EvidenceQualityMetric;
    tokenUsage: TokenUsageMetric;
    plannedApprovalGates: CountMetric;
  };
  journeyBaseline?: {
    source: string;
    commit: string;
    opencodeVersion: string;
    networkEnforcement: JourneyNetworkEnforcement;
    ciRunId: string;
    artifactId: string;
    recordedAt: string;
    journeys: JourneyBaselineEntry[];
  };
  limitations: string[];
  waivers: Array<{
    scope: string;
    reason: string;
    approvedBy: string;
    reference?: string;
  }>;
}

const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const MAX_RUN_RECORD_BYTES = 10 * 1024 * 1024;
const FORBIDDEN_PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FORBIDDEN_FREE_TEXT_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'machine-local Unix path', pattern: /(?:^|[\s"'`(=])\/(?:mnt|home|Users|tmp)\// },
  { label: 'file URI', pattern: /file:\/\//i },
  { label: 'machine-local Windows path', pattern: /[A-Za-z]:(?:\\|\/)Users(?:\\|\/)/i },
  { label: 'GitHub token', pattern: /\b(?:ghp|gho)_[A-Za-z0-9]{20,}\b/ },
  { label: 'GitHub fine-grained PAT', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { label: 'Bearer authorization header', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/ },
  { label: 'Authorization header', pattern: /\bAuthorization:\s*\S+/i },
  { label: 'API secret key', pattern: /\bsk-[A-Za-z0-9]{16,}\b/ },
];

function assertSafeFreeText(value: unknown, path: string): string {
  const s = assertNonEmptyString(value, path);
  for (const { label, pattern } of FORBIDDEN_FREE_TEXT_PATTERNS) {
    if (pattern.test(s)) {
      throw new Error(`${path} must not contain a ${label}.`);
    }
  }
  return s;
}

function assertSafeFreeTextArray(value: unknown, path: string, minItems = 0): string[] {
  const items = assertStringArray(value, path, { minItems });
  return items.map((item, idx) => assertSafeFreeText(item, `${path}[${idx}]`));
}

function validateNotMeasuredMetric(obj: Record<string, unknown>, path: string): NotMeasuredMetric {
  assertAllowedKeys(obj, ['status', 'note'], [], path);
  return {
    status: assertEnum(obj.status, NON_MEASURED_STATUSES, `${path}.status`),
    note: assertSafeFreeText(obj.note, `${path}.note`),
  };
}

function validateCountMetric(input: unknown, path: string): CountMetric {
  const obj = assertObject(input, path);
  if (obj.status !== 'measured') return validateNotMeasuredMetric(obj, path);
  assertAllowedKeys(obj, ['status', 'count'], ['note'], path);
  const out: CountMetric = {
    status: 'measured',
    count: assertIntegerMin(obj.count, 0, `${path}.count`),
  };
  if (obj.note !== undefined) out.note = assertSafeFreeText(obj.note, `${path}.note`);
  return out;
}

function validateRequirementCoverage(input: unknown, path: string): RequirementCoverageMetric {
  const obj = assertObject(input, path);
  if (obj.status !== 'measured') return validateNotMeasuredMetric(obj, path);
  assertAllowedKeys(obj, ['status', 'met', 'total'], ['note'], path);
  const met = assertIntegerMin(obj.met, 0, `${path}.met`);
  const total = assertIntegerMin(obj.total, 1, `${path}.total`);
  if (met > total) {
    throw new Error(`${path}.met (${met}) cannot exceed ${path}.total (${total}).`);
  }
  const out: RequirementCoverageMetric = { status: 'measured', met, total };
  if (obj.note !== undefined) out.note = assertSafeFreeText(obj.note, `${path}.note`);
  return out;
}

function validateEvidenceQuality(input: unknown, path: string): EvidenceQualityMetric {
  const obj = assertObject(input, path);
  if (obj.status !== 'measured') return validateNotMeasuredMetric(obj, path);
  assertAllowedKeys(
    obj,
    ['status', 'summary', 'checksReRun', 'checksJudgedFromEvidence', 'missingArtifacts'],
    ['note'],
    path,
  );
  const out: EvidenceQualityMetric = {
    status: 'measured',
    summary: assertSafeFreeText(obj.summary, `${path}.summary`),
    checksReRun: assertIntegerMin(obj.checksReRun, 0, `${path}.checksReRun`),
    checksJudgedFromEvidence: assertIntegerMin(
      obj.checksJudgedFromEvidence,
      0,
      `${path}.checksJudgedFromEvidence`,
    ),
    missingArtifacts: assertIntegerMin(obj.missingArtifacts, 0, `${path}.missingArtifacts`),
  };
  if (obj.note !== undefined) out.note = assertSafeFreeText(obj.note, `${path}.note`);
  return out;
}

function validateTokenUsage(input: unknown, path: string): TokenUsageMetric {
  const obj = assertObject(input, path);
  if (obj.status !== 'measured') return validateNotMeasuredMetric(obj, path);
  assertAllowedKeys(
    obj,
    ['status', 'inputTokens', 'outputTokens'],
    ['cachedTokens', 'estimatedCostUsd', 'pricingBasis', 'note'],
    path,
  );
  const out: TokenUsageMetric = {
    status: 'measured',
    inputTokens: assertIntegerMin(obj.inputTokens, 0, `${path}.inputTokens`),
    outputTokens: assertIntegerMin(obj.outputTokens, 0, `${path}.outputTokens`),
  };
  if (obj.cachedTokens !== undefined) {
    out.cachedTokens = assertIntegerMin(obj.cachedTokens, 0, `${path}.cachedTokens`);
  }
  if (obj.estimatedCostUsd !== undefined) {
    out.estimatedCostUsd = assertNonNegativeNumber(
      obj.estimatedCostUsd,
      `${path}.estimatedCostUsd`,
    );
  }
  if (obj.pricingBasis !== undefined) {
    out.pricingBasis = assertSafeFreeText(obj.pricingBasis, `${path}.pricingBasis`);
  }
  if (obj.note !== undefined) out.note = assertSafeFreeText(obj.note, `${path}.note`);
  return out;
}

function validateScenarioSummary(
  input: unknown,
  repeatCount: number,
  path: string,
): ScenarioRepeatSummary {
  const obj = assertObject(input, path);
  assertAllowedKeys(
    obj,
    ['scenarioId', 'scenarioVersion', 'bound', 'outcomes', 'repeatable', 'differenceCount'],
    ['repeatDurationsMs'],
    path,
  );
  const scenarioId = assertRegexString(
    obj.scenarioId,
    SCENARIO_ID_RE,
    'must match EDD-(DEV|VAL)-NNN',
    `${path}.scenarioId`,
  );
  const scenarioVersion = assertRegexString(
    obj.scenarioVersion,
    SEMVER_RE,
    'must be a semantic version (MAJOR.MINOR.PATCH)',
    `${path}.scenarioVersion`,
  );
  const bound = assertBoolean(obj.bound, `${path}.bound`);
  if (!Array.isArray(obj.outcomes) || obj.outcomes.length === 0) {
    throw new Error(`${path}.outcomes must be a non-empty array.`);
  }
  const outcomes = obj.outcomes.map((outcome, idx) =>
    assertEnum(outcome, RESULT_OUTCOMES, `${path}.outcomes[${idx}]`),
  );
  if (outcomes.length !== repeatCount) {
    throw new Error(
      `${path}.outcomes length (${outcomes.length}) must match repeatability.repeatCount (${repeatCount}).`,
    );
  }
  const repeatable = assertBoolean(obj.repeatable, `${path}.repeatable`);
  const differenceCount = assertIntegerMin(obj.differenceCount, 0, `${path}.differenceCount`);
  if (repeatable && differenceCount !== 0) {
    throw new Error(`${path}.differenceCount must be 0 when repeatable is true.`);
  }
  if (!repeatable && differenceCount === 0) {
    throw new Error(`${path}.differenceCount must be > 0 when repeatable is false.`);
  }

  const out: ScenarioRepeatSummary = {
    scenarioId,
    scenarioVersion,
    bound,
    outcomes,
    repeatable,
    differenceCount,
  };
  if (obj.repeatDurationsMs !== undefined) {
    if (!Array.isArray(obj.repeatDurationsMs) || obj.repeatDurationsMs.length === 0) {
      throw new Error(`${path}.repeatDurationsMs must be a non-empty array.`);
    }
    const durations = obj.repeatDurationsMs.map((d, idx) =>
      assertNonNegativeNumber(d, `${path}.repeatDurationsMs[${idx}]`),
    );
    if (durations.length !== repeatCount) {
      throw new Error(
        `${path}.repeatDurationsMs length (${durations.length}) must match repeatability.repeatCount (${repeatCount}).`,
      );
    }
    out.repeatDurationsMs = durations;
  }
  return out;
}

function validateJourneyBaseline(
  input: unknown,
  path: string,
): NonNullable<EvalRunRecord['journeyBaseline']> {
  const obj = assertObject(input, path);
  assertAllowedKeys(
    obj,
    [
      'source',
      'commit',
      'opencodeVersion',
      'networkEnforcement',
      'ciRunId',
      'artifactId',
      'recordedAt',
      'journeys',
    ],
    [],
    path,
  );
  const recordedAt = assertNonEmptyString(obj.recordedAt, `${path}.recordedAt`);
  if (!isValidIso8601Timestamp(recordedAt)) {
    throw new Error(`${path}.recordedAt must be a valid ISO 8601 timestamp.`);
  }
  if (!Array.isArray(obj.journeys) || obj.journeys.length === 0) {
    throw new Error(`${path}.journeys must be a non-empty array.`);
  }
  const seenJourneyIds = new Set<string>();
  const journeys: JourneyBaselineEntry[] = obj.journeys.map((raw, idx) => {
    const jPath = `${path}.journeys[${idx}]`;
    const j = assertObject(raw, jPath);
    assertAllowedKeys(
      j,
      [
        'id',
        'journey',
        'testOutcome',
        'recordOutcome',
        'handoffCount',
        'roleTransitions',
        'skillsInvoked',
        'toolCallCount',
        'violationCount',
      ],
      ['repeatsByteIdentical', 'notes'],
      jPath,
    );
    if (!Array.isArray(j.skillsInvoked)) {
      throw new Error(`${jPath}.skillsInvoked must be an array.`);
    }
    const skillsInvoked = j.skillsInvoked.map((rawSkill, sIdx) => {
      const sPath = `${jPath}.skillsInvoked[${sIdx}]`;
      const sk = assertObject(rawSkill, sPath);
      assertAllowedKeys(sk, ['skillId', 'loaded'], [], sPath);
      return {
        skillId: assertNonEmptyString(sk.skillId, `${sPath}.skillId`),
        loaded: assertBoolean(sk.loaded, `${sPath}.loaded`),
      };
    });
    const entry: JourneyBaselineEntry = {
      id: assertNonEmptyString(j.id, `${jPath}.id`),
      journey: assertNonEmptyString(j.journey, `${jPath}.journey`),
      testOutcome: assertEnum(j.testOutcome, JOURNEY_TEST_OUTCOMES, `${jPath}.testOutcome`),
      recordOutcome: assertEnum(
        j.recordOutcome,
        JOURNEY_RECORD_OUTCOMES,
        `${jPath}.recordOutcome`,
      ),
      handoffCount: assertIntegerMin(j.handoffCount, 0, `${jPath}.handoffCount`),
      roleTransitions: assertStringArray(j.roleTransitions, `${jPath}.roleTransitions`),
      skillsInvoked,
      toolCallCount: assertIntegerMin(j.toolCallCount, 0, `${jPath}.toolCallCount`),
      violationCount: assertIntegerMin(j.violationCount, 0, `${jPath}.violationCount`),
    };
    if (seenJourneyIds.has(entry.id)) {
      throw new Error(`${path}.journeys contains duplicate id "${entry.id}".`);
    }
    seenJourneyIds.add(entry.id);
    if (entry.recordOutcome === 'pass' && entry.violationCount !== 0) {
      throw new Error(
        `${jPath} has recordOutcome "pass" and must have violationCount 0 (found ${entry.violationCount}).`,
      );
    }
    if (j.repeatsByteIdentical !== undefined) {
      entry.repeatsByteIdentical = assertBoolean(
        j.repeatsByteIdentical,
        `${jPath}.repeatsByteIdentical`,
      );
    }
    if (j.notes !== undefined) entry.notes = assertSafeFreeText(j.notes, `${jPath}.notes`);
    return entry;
  });

  // journeyBaseline.commit/ciRunId/artifactId intentionally identify the referenced #62 CI run
  // independently of repository.commit when the baseline aggregates an archived suite run.
  return {
    source: assertSafeFreeText(obj.source, `${path}.source`),
    commit: assertRegexString(
      obj.commit,
      COMMIT_SHA_RE,
      'must be a 7-40 character lower-case hex Git commit SHA',
      `${path}.commit`,
    ),
    opencodeVersion: assertNonEmptyString(obj.opencodeVersion, `${path}.opencodeVersion`),
    networkEnforcement: assertEnum(
      obj.networkEnforcement,
      JOURNEY_NETWORK_ENFORCEMENTS,
      `${path}.networkEnforcement`,
    ),
    ciRunId: assertNonEmptyString(obj.ciRunId, `${path}.ciRunId`),
    artifactId: assertNonEmptyString(obj.artifactId, `${path}.artifactId`),
    recordedAt,
    journeys,
  };
}

function assertNotObservedMetricHasPlaceholderValue(
  result: EvalResult,
  metric: CoreMetricName,
  path: string,
): void {
  const m = result.metrics;
  const mismatch =
    (metric === 'handoffCount' && m.handoffCount !== 0) ||
    (metric === 'roleTransitions' && m.roleTransitions.length > 0) ||
    (metric === 'skillsInvoked' && m.skillsInvoked.length > 0) ||
    (metric === 'humanInterventions' && m.humanInterventions !== 0) ||
    (metric === 'permissionAmbiguities' && m.permissionAmbiguities !== 0) ||
    (metric === 'reviewDetectedDefects' && m.reviewDetectedDefects !== 0) ||
    (metric === 'escapedDefects' && m.escapedDefects !== 0) ||
    (metric === 'tokenCostUsd' && m.tokenCostUsd !== undefined) ||
    (metric === 'durationMs' && result.durationMs !== 0);
  if (mismatch) {
    throw new Error(
      `${path} records a non-placeholder value for "${metric}", which is listed in metricObservation.notObserved.`,
    );
  }
}

function assertNonObservedResultHasZeroMetrics(result: EvalResult, path: string): void {
  const m = result.metrics;
  if (
    m.handoffCount !== 0 ||
    m.roleTransitions.length > 0 ||
    m.skillsInvoked.length > 0 ||
    m.humanInterventions !== 0 ||
    m.permissionAmbiguities !== 0 ||
    m.reviewDetectedDefects !== 0 ||
    m.escapedDefects !== 0 ||
    m.tokenCostUsd !== undefined
  ) {
    throw new Error(
      `${path} has non-decided outcome "${result.outcome}" and must record zero/empty metrics without tokenCostUsd.`,
    );
  }
}

/**
 * Validates an EDD v1 / BH-051 run record against schemaVersion 1 rules and cross-field invariants,
 * delegating embedded runManifest and results to the #225 contract validators.
 */
export function validateRunRecord(input: unknown, path = 'runRecord'): EvalRunRecord {
  const obj = assertObject(input, path);
  assertAllowedKeys(
    obj,
    [
      'schemaVersion',
      'recordId',
      'protocolVersion',
      'recordKind',
      'repository',
      'runner',
      'hostEnvironment',
      'modelVerification',
      'taskClassification',
      'runManifest',
      'repeatability',
      'results',
      'metricObservation',
      'supplementaryMetrics',
      'limitations',
      'waivers',
    ],
    ['baselineRef', 'hostCapabilityPrerequisites', 'journeyBaseline'],
    path,
  );

  if (obj.schemaVersion !== EVAL_SCHEMA_VERSION) {
    throw new Error(`${path}.schemaVersion must be ${EVAL_SCHEMA_VERSION}.`);
  }
  const recordId = assertSafeFreeText(obj.recordId, `${path}.recordId`);
  const protocolVersion = assertRegexString(
    obj.protocolVersion,
    SEMVER_RE,
    'must be a semantic version (MAJOR.MINOR.PATCH)',
    `${path}.protocolVersion`,
  );
  const recordKind = assertEnum(obj.recordKind, RUN_RECORD_KINDS, `${path}.recordKind`);

  let baselineRef: string | undefined;
  if (obj.baselineRef !== undefined) {
    baselineRef = assertSafeFreeText(obj.baselineRef, `${path}.baselineRef`);
  } else if (recordKind === 'candidate') {
    throw new Error(`${path}.baselineRef is required when recordKind is "candidate".`);
  }

  const repoObj = assertObject(obj.repository, `${path}.repository`);
  assertAllowedKeys(repoObj, ['commit', 'harnessVersion', 'dirty'], [], `${path}.repository`);
  const repository = {
    commit: assertRegexString(
      repoObj.commit,
      COMMIT_SHA_RE,
      'must be a 7-40 character lower-case hex Git commit SHA',
      `${path}.repository.commit`,
    ),
    harnessVersion: assertSafeFreeText(
      repoObj.harnessVersion,
      `${path}.repository.harnessVersion`,
    ),
    dirty: assertBoolean(repoObj.dirty, `${path}.repository.dirty`),
  };

  const runnerObj = assertObject(obj.runner, `${path}.runner`);
  assertAllowedKeys(
    runnerObj,
    ['executedBy', 'executionKind'],
    ['authorizedBy', 'ciRunRef'],
    `${path}.runner`,
  );
  const executionKind = assertEnum(
    runnerObj.executionKind,
    EXECUTION_KINDS,
    `${path}.runner.executionKind`,
  );
  const runner: EvalRunRecord['runner'] = {
    executedBy: assertSafeFreeText(runnerObj.executedBy, `${path}.runner.executedBy`),
    executionKind,
  };
  if (runnerObj.authorizedBy !== undefined) {
    runner.authorizedBy = assertSafeFreeText(
      runnerObj.authorizedBy,
      `${path}.runner.authorizedBy`,
    );
  } else if (executionKind === 'agent-assisted') {
    throw new Error(
      `${path}.runner.authorizedBy is required when executionKind is "agent-assisted".`,
    );
  }
  if (runnerObj.ciRunRef !== undefined) {
    runner.ciRunRef = assertSafeFreeText(runnerObj.ciRunRef, `${path}.runner.ciRunRef`);
  }

  const hostObj = assertObject(obj.hostEnvironment, `${path}.hostEnvironment`);
  assertAllowedKeys(
    hostObj,
    ['host', 'hostVersion', 'os', 'networkEnforcement', 'hermetic'],
    ['notes'],
    `${path}.hostEnvironment`,
  );
  const hostEnvironment: EvalRunRecord['hostEnvironment'] = {
    host: assertEnum(hostObj.host, EVAL_HOSTS, `${path}.hostEnvironment.host`),
    hostVersion: assertSafeFreeText(hostObj.hostVersion, `${path}.hostEnvironment.hostVersion`),
    os: assertSafeFreeText(hostObj.os, `${path}.hostEnvironment.os`),
    networkEnforcement: assertEnum(
      hostObj.networkEnforcement,
      NETWORK_ENFORCEMENTS,
      `${path}.hostEnvironment.networkEnforcement`,
    ),
    hermetic: assertBoolean(hostObj.hermetic, `${path}.hostEnvironment.hermetic`),
  };
  if (hostObj.notes !== undefined) {
    hostEnvironment.notes = assertSafeFreeText(hostObj.notes, `${path}.hostEnvironment.notes`);
  }

  const mvObj = assertObject(obj.modelVerification, `${path}.modelVerification`);
  assertAllowedKeys(
    mvObj,
    ['status', 'evidence'],
    ['observedRoleModels'],
    `${path}.modelVerification`,
  );
  const mvStatus = assertEnum(
    mvObj.status,
    MODEL_VERIFICATION_STATUSES,
    `${path}.modelVerification.status`,
  );
  const modelVerification: EvalRunRecord['modelVerification'] = {
    status: mvStatus,
    evidence: assertSafeFreeText(mvObj.evidence, `${path}.modelVerification.evidence`),
  };
  if (mvObj.observedRoleModels !== undefined) {
    if (mvStatus === 'unverified') {
      throw new Error(
        `${path}.modelVerification.observedRoleModels is forbidden when status is "unverified".`,
      );
    }
    const ormObj = assertObject(
      mvObj.observedRoleModels,
      `${path}.modelVerification.observedRoleModels`,
    );
    const observedRoleModels = Object.create(null) as Record<string, string>;
    for (const [role, model] of Object.entries(ormObj)) {
      if (FORBIDDEN_PROTOTYPE_KEYS.has(role)) {
        throw new Error(
          `${path}.modelVerification.observedRoleModels contains forbidden key "${role}".`,
        );
      }
      observedRoleModels[role] = assertSafeFreeText(
        model,
        `${path}.modelVerification.observedRoleModels.${role}`,
      );
    }
    modelVerification.observedRoleModels = observedRoleModels;
  }

  let hostCapabilityPrerequisites: EvalRunRecord['hostCapabilityPrerequisites'];
  if (obj.hostCapabilityPrerequisites !== undefined) {
    const capObj = assertObject(
      obj.hostCapabilityPrerequisites,
      `${path}.hostCapabilityPrerequisites`,
    );
    assertAllowedKeys(
      capObj,
      [
        'matrixSource',
        'sameRoleApprovalTransition',
        'localRemoteIsolation',
        'perRoleCommands',
        'skillsMcpExposure',
        'actualModelRouting',
      ],
      [],
      `${path}.hostCapabilityPrerequisites`,
    );
    hostCapabilityPrerequisites = {
      matrixSource: assertNonEmptyString(
        capObj.matrixSource,
        `${path}.hostCapabilityPrerequisites.matrixSource`,
      ),
      sameRoleApprovalTransition: assertEnum(
        capObj.sameRoleApprovalTransition,
        CAPABILITY_STATUSES,
        `${path}.hostCapabilityPrerequisites.sameRoleApprovalTransition`,
      ),
      localRemoteIsolation: assertEnum(
        capObj.localRemoteIsolation,
        CAPABILITY_STATUSES,
        `${path}.hostCapabilityPrerequisites.localRemoteIsolation`,
      ),
      perRoleCommands: assertEnum(
        capObj.perRoleCommands,
        CAPABILITY_STATUSES,
        `${path}.hostCapabilityPrerequisites.perRoleCommands`,
      ),
      skillsMcpExposure: assertEnum(
        capObj.skillsMcpExposure,
        CAPABILITY_STATUSES,
        `${path}.hostCapabilityPrerequisites.skillsMcpExposure`,
      ),
      actualModelRouting: assertEnum(
        capObj.actualModelRouting,
        CAPABILITY_STATUSES,
        `${path}.hostCapabilityPrerequisites.actualModelRouting`,
      ),
    };
  }

  const tcObj = assertObject(obj.taskClassification, `${path}.taskClassification`);
  assertAllowedKeys(
    tcObj,
    ['taskClasses', 'taskCriteria'],
    ['methodologyMode', 'rigor'],
    `${path}.taskClassification`,
  );
  const taskClassification: EvalRunRecord['taskClassification'] = {
    taskClasses: assertUniqueEnumArray(
      tcObj.taskClasses,
      REPRESENTATIVE_TASK_CLASSES,
      `${path}.taskClassification.taskClasses`,
      1,
    ),
    taskCriteria: assertSafeFreeTextArray(
      tcObj.taskCriteria,
      `${path}.taskClassification.taskCriteria`,
      1,
    ),
  };
  if (tcObj.methodologyMode !== undefined) {
    taskClassification.methodologyMode = assertEnum(
      tcObj.methodologyMode,
      METHODOLOGY_MODES,
      `${path}.taskClassification.methodologyMode`,
    );
  }
  if (tcObj.rigor !== undefined) {
    taskClassification.rigor = assertEnum(
      tcObj.rigor,
      RIGOR_LEVELS,
      `${path}.taskClassification.rigor`,
    );
  }

  const runManifest = validateRunManifest(obj.runManifest, `${path}.runManifest`);
  if (
    modelVerification.observedRoleModels !== undefined &&
    runManifest.modelConfig.roleModels !== undefined
  ) {
    for (const role of Object.keys(modelVerification.observedRoleModels)) {
      if (!Object.hasOwn(runManifest.modelConfig.roleModels, role)) {
        throw new Error(
          `${path}.modelVerification.observedRoleModels.${role} is not declared in runManifest.modelConfig.roleModels.`,
        );
      }
    }
  }
  if (hostEnvironment.host !== runManifest.host) {
    throw new Error(
      `${path}.hostEnvironment.host "${hostEnvironment.host}" must match runManifest.host "${runManifest.host}".`,
    );
  }
  if (runManifest.mode === 'deterministic' && modelVerification.status !== 'loopback-fixture') {
    throw new Error(
      `${path}.modelVerification.status must be "loopback-fixture" when runManifest.mode is "deterministic".`,
    );
  }
  if (runManifest.mode === 'live' && modelVerification.status === 'loopback-fixture') {
    throw new Error(
      `${path}.modelVerification.status cannot be "loopback-fixture" when runManifest.mode is "live".`,
    );
  }

  const repObj = assertObject(obj.repeatability, `${path}.repeatability`);
  assertAllowedKeys(
    repObj,
    ['repeatCount', 'allRepeatable', 'executedScenarios', 'totalScenarios', 'scenarioSummaries'],
    [],
    `${path}.repeatability`,
  );
  const repeatCount = assertIntegerMin(repObj.repeatCount, 1, `${path}.repeatability.repeatCount`);
  const allRepeatable = assertBoolean(
    repObj.allRepeatable,
    `${path}.repeatability.allRepeatable`,
  );
  const executedScenarios = assertIntegerMin(
    repObj.executedScenarios,
    0,
    `${path}.repeatability.executedScenarios`,
  );
  const totalScenarios = assertIntegerMin(
    repObj.totalScenarios,
    1,
    `${path}.repeatability.totalScenarios`,
  );
  if (!Array.isArray(repObj.scenarioSummaries) || repObj.scenarioSummaries.length === 0) {
    throw new Error(`${path}.repeatability.scenarioSummaries must be a non-empty array.`);
  }
  const scenarioSummaries = repObj.scenarioSummaries.map((raw, idx) =>
    validateScenarioSummary(raw, repeatCount, `${path}.repeatability.scenarioSummaries[${idx}]`),
  );

  const manifestIds = new Set(runManifest.scenarioIds);
  if (manifestIds.size !== runManifest.scenarioIds.length) {
    throw new Error(`${path}.runManifest.scenarioIds must not contain duplicate scenario IDs.`);
  }
  if (totalScenarios !== runManifest.scenarioIds.length) {
    throw new Error(
      `${path}.repeatability.totalScenarios (${totalScenarios}) must equal runManifest.scenarioIds.length (${runManifest.scenarioIds.length}).`,
    );
  }
  if (scenarioSummaries.length !== runManifest.scenarioIds.length) {
    throw new Error(
      `${path}.repeatability.scenarioSummaries length (${scenarioSummaries.length}) must equal runManifest.scenarioIds.length (${runManifest.scenarioIds.length}).`,
    );
  }

  const summaryById = new Map<string, ScenarioRepeatSummary>();
  for (const summary of scenarioSummaries) {
    if (summaryById.has(summary.scenarioId)) {
      throw new Error(
        `${path}.repeatability.scenarioSummaries contains duplicate scenarioId "${summary.scenarioId}".`,
      );
    }
    if (!manifestIds.has(summary.scenarioId)) {
      throw new Error(
        `${path}.repeatability.scenarioSummaries scenarioId "${summary.scenarioId}" is not in runManifest.scenarioIds.`,
      );
    }
    summaryById.set(summary.scenarioId, summary);
  }
  const computedExecuted = scenarioSummaries.filter((s) =>
    s.outcomes.some((outcome) => outcome !== 'skipped'),
  ).length;
  if (executedScenarios !== computedExecuted) {
    throw new Error(
      `${path}.repeatability.executedScenarios (${executedScenarios}) must match non-skipped summary count (${computedExecuted}).`,
    );
  }
  const computedAllRepeatable = scenarioSummaries.every((s) => s.repeatable);
  if (allRepeatable !== computedAllRepeatable) {
    throw new Error(
      `${path}.repeatability.allRepeatable (${allRepeatable}) must match scenarioSummaries repeatability (${computedAllRepeatable}).`,
    );
  }

  if (!Array.isArray(obj.results) || obj.results.length === 0) {
    throw new Error(`${path}.results must be a non-empty array.`);
  }
  const results = obj.results.map((raw, idx) => validateResult(raw, `${path}.results[${idx}]`));
  const resultIds = new Set<string>();
  results.forEach((result, idx) => {
    const rPath = `${path}.results[${idx}]`;
    if (resultIds.has(result.scenarioId)) {
      throw new Error(`${path}.results contains duplicate scenarioId "${result.scenarioId}".`);
    }
    resultIds.add(result.scenarioId);
    if (result.runId !== runManifest.runId) {
      throw new Error(`${rPath}.runId "${result.runId}" must match runManifest.runId "${runManifest.runId}".`);
    }
    const summary = summaryById.get(result.scenarioId);
    if (summary === undefined) {
      throw new Error(`${rPath}.scenarioId "${result.scenarioId}" is missing from scenarioSummaries.`);
    }
    if (result.scenarioVersion !== summary.scenarioVersion) {
      throw new Error(
        `${rPath}.scenarioVersion "${result.scenarioVersion}" must match scenarioSummary version "${summary.scenarioVersion}".`,
      );
    }
    if (result.outcome !== summary.outcomes[0]) {
      throw new Error(
        `${rPath}.outcome "${result.outcome}" must match scenarioSummary repeat-1 outcome "${summary.outcomes[0]}".`,
      );
    }
    if (result.outcome !== 'pass' && result.outcome !== 'fail') {
      assertNonObservedResultHasZeroMetrics(result, rPath);
    }
  });
  if (resultIds.size !== runManifest.scenarioIds.length) {
    throw new Error(
      `${path}.results length (${results.length}) must cover all ${runManifest.scenarioIds.length} scenarios in runManifest.scenarioIds.`,
    );
  }

  const moObj = assertObject(obj.metricObservation, `${path}.metricObservation`);
  assertAllowedKeys(moObj, ['observed', 'notObserved'], [], `${path}.metricObservation`);
  const observed = assertUniqueEnumArray(
    moObj.observed,
    CORE_METRIC_NAMES,
    `${path}.metricObservation.observed`,
  );
  const notObserved = assertUniqueEnumArray(
    moObj.notObserved,
    CORE_METRIC_NAMES,
    `${path}.metricObservation.notObserved`,
  );
  const observedSet = new Set(observed);
  const notObservedSet = new Set(notObserved);
  for (const name of notObserved) {
    if (observedSet.has(name)) {
      throw new Error(
        `${path}.metricObservation metric "${name}" cannot appear in both observed and notObserved.`,
      );
    }
  }
  if (observed.length + notObserved.length !== CORE_METRIC_NAMES.length) {
    const missing = CORE_METRIC_NAMES.filter(
      (name) => !observedSet.has(name) && !notObservedSet.has(name),
    );
    throw new Error(
      `${path}.metricObservation must partition all core metrics; missing: ${missing.join(', ')}.`,
    );
  }
  const hasDecidedResult = results.some((r) => r.outcome === 'pass' || r.outcome === 'fail');
  if (!hasDecidedResult && observed.length > 0) {
    throw new Error(
      `${path}.metricObservation.observed must be empty when no result has outcome "pass" or "fail".`,
    );
  }
  for (const result of results) {
    const rPath = `${path}.results[${result.scenarioId}]`;
    for (const metric of notObserved) {
      assertNotObservedMetricHasPlaceholderValue(result, metric, rPath);
    }
  }

  const smObj = assertObject(obj.supplementaryMetrics, `${path}.supplementaryMetrics`);
  assertAllowedKeys(
    smObj,
    [
      'requirementCoverage',
      'reworkCycles',
      'planDriftCount',
      'contextReconstructionCount',
      'evidenceQuality',
      'tokenUsage',
      'plannedApprovalGates',
    ],
    [],
    `${path}.supplementaryMetrics`,
  );
  const supplementaryMetrics: EvalRunRecord['supplementaryMetrics'] = {
    requirementCoverage: validateRequirementCoverage(
      smObj.requirementCoverage,
      `${path}.supplementaryMetrics.requirementCoverage`,
    ),
    reworkCycles: validateCountMetric(
      smObj.reworkCycles,
      `${path}.supplementaryMetrics.reworkCycles`,
    ),
    planDriftCount: validateCountMetric(
      smObj.planDriftCount,
      `${path}.supplementaryMetrics.planDriftCount`,
    ),
    contextReconstructionCount: validateCountMetric(
      smObj.contextReconstructionCount,
      `${path}.supplementaryMetrics.contextReconstructionCount`,
    ),
    evidenceQuality: validateEvidenceQuality(
      smObj.evidenceQuality,
      `${path}.supplementaryMetrics.evidenceQuality`,
    ),
    tokenUsage: validateTokenUsage(smObj.tokenUsage, `${path}.supplementaryMetrics.tokenUsage`),
    plannedApprovalGates: validateCountMetric(
      smObj.plannedApprovalGates,
      `${path}.supplementaryMetrics.plannedApprovalGates`,
    ),
  };
  if (
    !hasDecidedResult &&
    Object.values(supplementaryMetrics).some((metric) => metric.status === 'measured')
  ) {
    throw new Error(
      `${path}.supplementaryMetrics cannot report "measured" when no result has outcome "pass" or "fail".`,
    );
  }

  let journeyBaseline: EvalRunRecord['journeyBaseline'];
  if (obj.journeyBaseline !== undefined) {
    journeyBaseline = validateJourneyBaseline(obj.journeyBaseline, `${path}.journeyBaseline`);
  }

  const limitations = assertSafeFreeTextArray(obj.limitations, `${path}.limitations`, 1);
  if (!Array.isArray(obj.waivers)) throw new Error(`${path}.waivers must be an array.`);
  const waivers = obj.waivers.map((raw, idx) => {
    const wPath = `${path}.waivers[${idx}]`;
    const w = assertObject(raw, wPath);
    assertAllowedKeys(w, ['scope', 'reason', 'approvedBy'], ['reference'], wPath);
    const entry: EvalRunRecord['waivers'][number] = {
      scope: assertSafeFreeText(w.scope, `${wPath}.scope`),
      reason: assertSafeFreeText(w.reason, `${wPath}.reason`),
      approvedBy: assertSafeFreeText(w.approvedBy, `${wPath}.approvedBy`),
    };
    if (w.reference !== undefined) {
      entry.reference = assertSafeFreeText(w.reference, `${wPath}.reference`);
    }
    return entry;
  });

  const out: EvalRunRecord = {
    schemaVersion: EVAL_SCHEMA_VERSION,
    recordId,
    protocolVersion,
    recordKind,
    repository,
    runner,
    hostEnvironment,
    modelVerification,
    taskClassification,
    runManifest,
    repeatability: {
      repeatCount,
      allRepeatable,
      executedScenarios,
      totalScenarios,
      scenarioSummaries,
    },
    results,
    metricObservation: { observed, notObserved },
    supplementaryMetrics,
    limitations,
    waivers,
  };
  if (baselineRef !== undefined) out.baselineRef = baselineRef;
  if (hostCapabilityPrerequisites !== undefined) {
    out.hostCapabilityPrerequisites = hostCapabilityPrerequisites;
  }
  if (journeyBaseline !== undefined) out.journeyBaseline = journeyBaseline;
  return out;
}

/** Reads and validates an evaluation run record JSON file from disk. */
export function loadRunRecord(filePath: string): EvalRunRecord {
  let raw: string;
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_RUN_RECORD_BYTES) {
      throw new Error(
        `file size ${stat.size} bytes exceeds maximum allowed ${MAX_RUN_RECORD_BYTES} bytes.`,
      );
    }
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read run record ${filePath}: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in run record ${filePath}: ${message}`);
  }
  return validateRunRecord(parsed, filePath);
}
