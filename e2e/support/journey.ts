// Journey library and journey record for the agent E2E suite (BH-034, issue #62).
//
// The journey record is a suite-level artifact at `version: 1`. Issue #225's evaluation
// contracts are merged but define an evaluation result, not this record. Mapping the record
// into an evaluation result belongs to the runner (#226).
//
// buildJourneyRecord is a pure function of the fixture's request log, violations,
// leftover steps, and metadata. Its output has no timestamps or ports. The sandbox root and the parent's
// home directory are replaced with placeholders; other absolute paths a tool result quotes are not rewritten.
// runJourney is the only function here that starts a process or a server.

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { nativeRoles } from '../../src/native-role-types.ts';
import {
  isCredentialHeaderName,
  isJsonObject,
  messagesOf,
  startLoopbackModel,
  toolResultText,
  contentText,
  type LeftoverStep,
  type LoopbackModel,
  type RecordedRequest,
  type RepliedToolCall,
  type ScriptReply,
  type ScriptStep,
  type StepExpectation,
  type ToolCallSpec,
  type Violation,
} from './loopback-model.ts';
import {
  classifyProxyAttempts,
  destinationOf,
  isLoopbackHost,
  isToleratedAttempt,
  networkHostsIn,
  parentHomeDirectories,
  runOpenCode,
  scrubHome,
  scrubSandbox,
  sortedUnique,
  startProxyRecorder,
  type OpenCodeRunResult,
  type OpenCodeSandbox,
  type ProxyAttempt,
} from './opencode-sandbox.ts';

// ---------------------------------------------------------------------------
// Defining journeys
// ---------------------------------------------------------------------------

export interface JourneyDefinition {
  /** Lower-case words separated by hyphens, for example `subagent-handoff`. */
  readonly name: string;
  /** Scripted steps per role id, consumed in order. */
  readonly steps: Readonly<Record<string, readonly ScriptStep[]>>;
  /** Skill id to the sentinel that proves the host loaded that skill. */
  readonly skillSentinels?: Readonly<Record<string, string>> | undefined;
}

const JOURNEY_NAME = /^[a-z][a-z0-9-]*$/;

export function defineJourney(definition: JourneyDefinition): JourneyDefinition {
  if (!JOURNEY_NAME.test(definition.name)) {
    throw new Error(`Journey name must be lower-case words separated by hyphens: ${JSON.stringify(definition.name)}`);
  }
  return definition;
}

const withExpect = (reply: ScriptReply, expect: StepExpectation | undefined): ScriptStep =>
  expect === undefined ? { reply } : { reply, expect };

/** A scripted turn that answers with final assistant text. */
export function finalText(text: string, expect?: StepExpectation): ScriptStep {
  return withExpect(text, expect);
}

/** A scripted turn that calls one tool. */
export function callTool(name: string, args: Record<string, unknown>, expect?: StepExpectation): ScriptStep {
  return withExpect([{ name, arguments: args }], expect);
}

/** A scripted turn that calls several tools in one assistant message. */
export function callTools(calls: ToolCallSpec[], expect?: StepExpectation): ScriptStep {
  return withExpect(calls, expect);
}

// ---------------------------------------------------------------------------
// Journey record (version 1, suite-level artifact)
// ---------------------------------------------------------------------------

/**
 * Network part of the record. Both lists are sorted and de-duplicated `METHOD host` strings, and neither holds
 * counts, so repeated retries of one destination leave the record unchanged.
 */
export interface JourneyNetwork {
  enforcement: 'netns' | 'none';
  /** Tolerated startup destinations that were attempted (see TOLERATED_STARTUP_DESTINATIONS). Not violations. */
  toleratedDestinations: string[];
  /** Attempts that are not tolerated. Any entry here is a violation. */
  unexpectedDestinations: string[];
}

export interface JourneyRecordInput {
  journey: string;
  opencodeVersion: string;
  requests: readonly RecordedRequest[];
  violations: readonly Violation[];
  leftoverSteps: readonly LeftoverStep[];
  network: JourneyNetwork;
  /** Skill id to the sentinel that must appear in the tool result for `loaded` to be true. */
  skillSentinels?: Readonly<Record<string, string>> | undefined;
  /** Argument keys tried in order for a handoff's target role. Defaults to DEFAULT_HANDOFF_KEYS. */
  handoffTargetKeys?: readonly string[] | undefined;
  /** Sandbox root. When given, violation text is normalised (see journeyNormaliser). */
  sandboxRoot?: string | undefined;
  /** Parent home directories replaced with `<home>` in every string of the record. Absent: none. */
  homeDirectories?: readonly string[] | undefined;
  /** Match home directories regardless of letter case (Windows). Absent: case-sensitive. */
  caseInsensitiveHomes?: boolean | undefined;
}

export interface JourneyViolation { step: number | null; expected: string; received: string }
export interface JourneyRequest { seq: number; role: string | null; session: string | null }
export interface JourneyToolCall { seq: number; role: string | null; tool: string; args: Record<string, unknown>; resultObserved: boolean }
export interface RoleTransition { seq: number; from: string; to: string }
export interface SkillInvocation { seq: number; role: string | null; skillId: string | null; loaded: boolean }

export interface JourneyRecord {
  kind: 'harness.opencode-journey-record';
  version: 1;
  journey: string;
  opencodeVersion: string;
  outcome: 'pass' | 'fail';
  violations: JourneyViolation[];
  requests: JourneyRequest[];
  toolCalls: JourneyToolCall[];
  roleTransitions: RoleTransition[];
  handoffCount: number;
  skillInvocations: SkillInvocation[];
  network: JourneyNetwork;
  /**
   * Sorted, de-duplicated lower-case names of credential-shaped headers (for example `authorization`) seen on any
   * request, auxiliary requests included. Names only: no header value is ever recorded. Any entry is a violation.
   */
  credentialHeaders: string[];
}

const LEAD_ROLE = 'lead';
const SUBAGENT_TOOL = 'subagent';
const SKILL_TOOL = 'skill';
const CHAT_PATH = '/v1/chat/completions';
/**
 * Argument keys tried in order for a handoff's target role; the first holding a string wins. `agent` is the key
 * observed on OpenCode 2.3.0 (second observation run); the rest are fallbacks only.
 */
export const DEFAULT_HANDOFF_KEYS: readonly string[] = ['agent', 'subagent', 'subagent_type', 'name', 'id'];
/** Opening tag of a subagent report block: `<subagent sessionID="..." state="..." description="...">`. */
const REPORT_OPEN_TAG = /<subagent\b([^>]*)>/g;
const REPORT_STATE = /\bstate="([^"]*)"/;
const COMPLETED = 'completed';

interface ToolCallSite { seq: number; role: string | null; call: RepliedToolCall }

/** Assigns S1, S2, ... in order of first appearance; null stays null. One labeller per record or summary. */
export function sessionLabeller(): (raw: string | null) => string | null {
  const labels = new Map<string, string>();
  return raw => {
    if (raw === null) return null;
    const existing = labels.get(raw);
    if (existing !== undefined) return existing;
    const label = `S${labels.size + 1}`;
    labels.set(raw, label);
    return label;
  };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Normaliser for recorded text. Replaces the sandbox root (raw, forward-slash, and JSON-escaped forms) with
 * `<sandbox>`, collapses separators in the sandbox-relative part to `/`, and numbers `ses_`, `prt_`, and `msg_`
 * identifiers as `ses_1`, `prt_1`, `msg_1` in order of first appearance. One normaliser per record, so the same
 * text always yields the same output for a given run.
 */
export function journeyNormaliser(sandboxRoot: string | undefined): (text: string) => string {
  const roots = sandboxRoot === undefined || sandboxRoot === ''
    ? []
    : [...new Set([sandboxRoot, sandboxRoot.replaceAll('\\', '/'), JSON.stringify(sandboxRoot).slice(1, -1)])].sort((a, b) => b.length - a.length);
  const rootPattern = roots.length > 0 ? new RegExp(`(?:${roots.map(escapeRegExp).join('|')})([^\\s"',;]*)`, 'g') : undefined;
  const labels = new Map<string, Map<string, number>>();
  const label = (kind: string, raw: string): string => {
    const byKind = labels.get(kind) ?? new Map<string, number>();
    labels.set(kind, byKind);
    const existing = byKind.get(raw);
    if (existing !== undefined) return `${kind}_${existing}`;
    const next = byKind.size + 1;
    byKind.set(raw, next);
    return `${kind}_${next}`;
  };
  return text => {
    let out = rootPattern === undefined ? text : text.replace(rootPattern, (_match: string, rest: string) => `<sandbox>${rest.replace(/\\+/g, '/')}`);
    out = out.replace(/\bses_[A-Za-z0-9]+/g, match => label('ses', match));
    out = out.replace(/\bprt_[A-Za-z0-9]+/g, match => label('prt', match));
    out = out.replace(/\bmsg_[A-Za-z0-9]+/g, match => label('msg', match));
    return out;
  };
}

function transitionsOf(ordered: readonly RecordedRequest[]): RoleTransition[] {
  const transitions: RoleTransition[] = [];
  let previous: string | null = null;
  for (const request of ordered) {
    if (request.role === null) continue;
    if (previous !== null && request.role !== previous) transitions.push({ seq: request.seq, from: previous, to: request.role });
    previous = request.role;
  }
  return transitions;
}

/** Tool-result text returned to the same role by a later request, or undefined when none was observed. */
function resultFor(ordered: readonly RecordedRequest[], site: ToolCallSite): string | undefined {
  if (site.role === null) return undefined;
  for (const later of ordered) {
    if (later.seq <= site.seq || later.role !== site.role) continue;
    const text = toolResultText(later.body, site.call.id);
    if (text !== undefined) return text;
  }
  return undefined;
}

function skillInvocationOf(ordered: readonly RecordedRequest[], site: ToolCallSite, sentinels: Readonly<Record<string, string>>): SkillInvocation {
  const raw = site.call.arguments.id;
  const skillId = typeof raw === 'string' ? raw : null;
  const sentinel = skillId !== null && Object.hasOwn(sentinels, skillId) ? sentinels[skillId] : undefined;
  const result = resultFor(ordered, site);
  return {
    seq: site.seq,
    role: site.role,
    skillId,
    loaded: result !== undefined && sentinel !== undefined && sentinel !== '' && result.includes(sentinel),
  };
}

function handoffTarget(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** One subagent report block seen in a Lead request: the request's seq and the block's `state` attribute. */
interface ReportBlock { seq: number; state: string }

/**
 * Report blocks in order of first appearance. Lead's history is cumulative, so a block is counted only in the first
 * Lead request whose user messages contain it (the blocks already counted are the prefix of each later list).
 */
function reportBlocksOf(ordered: readonly RecordedRequest[]): ReportBlock[] {
  const reports: ReportBlock[] = [];
  let seen = 0;
  for (const request of ordered) {
    if (request.role !== LEAD_ROLE) continue;
    const states = userReportStates(request.body);
    for (const state of states.slice(seen)) reports.push({ seq: request.seq, state });
    seen = Math.max(seen, states.length);
  }
  return reports;
}

/** `state` attribute of every subagent report opening tag in the user messages of one request, in order. */
function userReportStates(body: unknown): string[] {
  const states: string[] = [];
  for (const message of messagesOf(body)) {
    if (message.role !== 'user') continue;
    for (const match of contentText(message.content).matchAll(REPORT_OPEN_TAG)) {
      const state = REPORT_STATE.exec(match[1] ?? '')?.[1];
      if (state !== undefined) states.push(state);
    }
  }
  return states;
}

/**
 * Completed handoffs. A handoff is counted when all three hold, and each Lead subagent call is matched to the next
 * report block (in order of occurrence) that arrives after it:
 * 1. Lead made a `subagent` call (site) whose target role can be read from its arguments (see handoffTarget);
 * 2. the target role made at least one non-auxiliary request after that call (the child ran);
 * 3. the next report block after the call is a Lead user message with `state="completed"`.
 * The session id inside a report is not stable and is never compared. `ordered` holds only non-auxiliary chat
 * requests, so title requests cannot satisfy condition 2. A report whose state is not `completed` consumes its call
 * and counts zero.
 */
function countHandoffs(ordered: readonly RecordedRequest[], sites: readonly ToolCallSite[], keys: readonly string[]): number {
  const reports = reportBlocksOf(ordered);
  let next = 0;
  let completed = 0;
  for (const site of sites) {
    if (site.call.name !== SUBAGENT_TOOL || site.role !== LEAD_ROLE) continue;
    const target = handoffTarget(site.call.arguments, keys);
    if (target === undefined) continue;
    const childRan = ordered.some(request => request.seq > site.seq && request.role === target);
    if (!childRan) continue;
    const index = reports.findIndex((report, position) => position >= next && report.seq > site.seq);
    if (index < 0) continue;
    next = index + 1;
    if (reports[index]?.state === COMPLETED) completed += 1;
  }
  return completed;
}

function journeyViolations(violations: readonly Violation[], leftover: readonly LeftoverStep[], normalise: (text: string) => string): JourneyViolation[] {
  return [
    ...violations.map(violation => ({
      step: violation.step,
      expected: normalise(violation.role === null ? violation.expected : `role ${violation.role}: ${violation.expected}`),
      received: normalise(violation.received),
    })),
    ...leftover.map(step => ({
      step: step.step,
      expected: normalise(`role ${step.role}: ${step.expected}`),
      received: 'run ended before this scripted step was requested',
    })),
  ];
}

/** Names of the credential-shaped headers one recorded request carried (lower-case). The value is never read. */
function credentialHeaderNamesOf(request: RecordedRequest): string[] {
  const names = Object.keys(request.headers).filter(isCredentialHeaderName).map(name => name.toLowerCase());
  if (request.authorizationPresent) names.push('authorization');
  return names;
}

/**
 * The violation for credential-shaped headers on any request, or undefined when none was seen. The suite sends no
 * API key, so an Authorization header (or another credential-shaped header) means the child carried one.
 */
export function credentialViolation(credentialHeaders: readonly string[]): JourneyViolation | undefined {
  if (credentialHeaders.length === 0) return undefined;
  return {
    step: null,
    expected: 'no request carries a credential-shaped header (the suite sends no API key)',
    received: `credential-shaped header names seen on requests: ${credentialHeaders.join(', ')}`,
  };
}

/**
 * Replaces each home directory with `<home>` in every string of a value, object keys included. Pure. Strings that
 * hold no home directory come back unchanged.
 */
function scrubHomeDeep(value: unknown, homes: readonly string[], caseInsensitive: boolean): unknown {
  if (typeof value === 'string') return scrubHome(value, homes, caseInsensitive);
  if (Array.isArray(value)) return value.map(item => scrubHomeDeep(item, homes, caseInsensitive));
  if (isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]): [string, unknown] => [
      scrubHome(key, homes, caseInsensitive),
      scrubHomeDeep(item, homes, caseInsensitive),
    ]));
  }
  return value;
}

/** Derives the journey record (version 1). Pure: the same input always yields the same record. */
export function buildJourneyRecord(input: JourneyRecordInput): JourneyRecord {
  // Only agent-turn chat-completion requests carry role turns. GET /v1/models, rejected paths, and auxiliary
  // requests (title generation, no `tools`) are excluded from everything derived below.
  const ordered = input.requests
    .filter(request => request.method === 'POST' && request.path === CHAT_PATH && !request.auxiliary)
    .sort((a, b) => a.seq - b.seq);
  const label = sessionLabeller();
  const normalise = journeyNormaliser(input.sandboxRoot);
  const sites: ToolCallSite[] = ordered.flatMap(request => request.replyToolCalls.map(call => ({ seq: request.seq, role: request.role, call })));
  // Credential headers are checked on every request, including auxiliary and rejected ones.
  const credentialHeaders = sortedUnique(input.requests.flatMap(credentialHeaderNamesOf));
  const credential = credentialViolation(credentialHeaders);
  const violations = [
    ...journeyViolations(input.violations, input.leftoverSteps, normalise),
    ...(credential === undefined ? [] : [credential]),
  ];
  const record: JourneyRecord = {
    kind: 'harness.opencode-journey-record',
    version: 1,
    journey: input.journey,
    opencodeVersion: input.opencodeVersion,
    outcome: violations.length > 0 ? 'fail' : 'pass',
    violations,
    credentialHeaders,
    requests: ordered.map(request => ({ seq: request.seq, role: request.role, session: label(request.session) })),
    toolCalls: sites.map(site => ({
      seq: site.seq,
      role: site.role,
      tool: site.call.name,
      args: site.call.arguments,
      resultObserved: resultFor(ordered, site) !== undefined,
    })),
    roleTransitions: transitionsOf(ordered),
    handoffCount: countHandoffs(ordered, sites, input.handoffTargetKeys ?? DEFAULT_HANDOFF_KEYS),
    skillInvocations: sites
      .filter(site => site.call.name === SKILL_TOOL)
      .map(site => skillInvocationOf(ordered, site, input.skillSentinels ?? {})),
    network: {
      enforcement: input.network.enforcement,
      toleratedDestinations: sortedUnique(input.network.toleratedDestinations),
      unexpectedDestinations: sortedUnique(input.network.unexpectedDestinations),
    },
  };
  // Home scrubbing runs last, over every string in the record. The sandbox placeholder is already in place.
  return scrubHomeDeep(record, input.homeDirectories ?? [], input.caseInsensitiveHomes === true) as JourneyRecord;
}

/**
 * The network violation for one run's recorded proxy attempts, or undefined when every attempt is tolerated. The
 * text lists only the unexpected destinations.
 */
export function proxyViolation(attempts: readonly ProxyAttempt[]): Violation | undefined {
  const unexpected = attempts.filter(attempt => !isToleratedAttempt(attempt));
  if (unexpected.length === 0) return undefined;
  const hosts = sortedUnique(unexpected.map(destinationOf)).join('; ');
  const routedToLoopback = unexpected.some(attempt => isLoopbackHost(attempt.host));
  return {
    step: null,
    role: null,
    expected: 'no connection through the HTTP proxy recorder except tolerated OpenCode startup destinations (the child must not reach the network)',
    received: routedToLoopback
      ? `loopback model requests were routed through the HTTP proxy despite NO_PROXY, so the fixture saw none of them: ${hosts}`
      : `connections attempted: ${hosts}`,
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => sortKeys(item));
  if (isJsonObject(value)) {
    const object = value;
    return Object.fromEntries(Object.keys(object).sort().map((key): [string, unknown] => [key, sortKeys(object[key])]));
  }
  return value;
}

/** Stable serialisation: keys sorted at every level, two-space indent, trailing newline. */
export function serializeJourneyRecord(record: JourneyRecord): string {
  return `${JSON.stringify(sortKeys(record), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Running a journey (starts the fixture and the child; used only by the E2E suite)
// ---------------------------------------------------------------------------

/** Lead, operator, external, researcher, planner, implementer, reviewer, qa: each bare model id is its role. */
export const ROLE_MODEL_MAP: Readonly<Record<string, string>> = Object.fromEntries(nativeRoles.map(role => [role, role]));

/**
 * Starts the loopback fixture for one journey in script mode. Start it before the sandbox so the sandbox
 * install commit can carry the fixture's base URL.
 */
export function startJourneyFixture(definition: JourneyDefinition): Promise<LoopbackModel> {
  return startLoopbackModel({
    journey: definition.name,
    mode: 'script',
    roleByModel: ROLE_MODEL_MAP,
    sessionHeader: 'x-opencode-session',
    script: definition.steps,
  });
}

export interface JourneyRunOptions {
  binary: string;
  version: string;
  message: string;
  auto: boolean;
  timeoutMs?: number | undefined;
  idleTimeoutMs?: number | undefined;
  /** Recorded as `network.enforcement`. The suite passes `netns` only when HARNESS_E2E_NETNS=1 AND the check passed. */
  enforcement?: 'netns' | 'none' | undefined;
  /** Directory for a retained copy of the record (HARNESS_E2E_RECORD_DIR). Absent: no retained copy is written. */
  recordDirectory?: string | undefined;
  /** 1-based run number for a journey that runs more than once. Selects the retained file name. */
  repeat?: number | undefined;
}

export type RecordDirectory = { status: 'off' } | { status: 'on'; directory: string } | { status: 'error'; reason: string };

/** Reads HARNESS_E2E_RECORD_DIR. Unset: off. Empty or relative: an error (the directory must be absolute). */
export function recordDirectoryOf(value: string | undefined): RecordDirectory {
  if (value === undefined) return { status: 'off' };
  if (value === '') return { status: 'error', reason: 'HARNESS_E2E_RECORD_DIR is set but empty. Set it to an absolute directory path, or unset it.' };
  if (!isAbsolute(value)) return { status: 'error', reason: 'HARNESS_E2E_RECORD_DIR must be an absolute path. A relative path is rejected, so records are never written to an unexpected location.' };
  return { status: 'on', directory: value };
}

/**
 * Retained record file name: `<journey>.json`, or `<journey>.run<n>.json` for run n of a journey that runs more than
 * once. Deterministic, so a re-run of the suite overwrites the same files.
 */
export function recordFileName(journey: string, repeat: number | undefined): string {
  if (repeat === undefined) return `${journey}.json`;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error(`Record run number must be a positive integer: ${String(repeat)}`);
  return `${journey}.run${repeat}.json`;
}

export interface JourneyRun {
  record: JourneyRecord;
  serialized: string;
  run: OpenCodeRunResult;
  proxyAttempts: ProxyAttempt[];
  sandboxRoot: string;
}

/**
 * Runs one journey end to end: starts the proxy recorder, runs OpenCode, gathers leftover steps and violations,
 * builds and serialises the record, and writes `journey-record.json` into the sandbox root (outside the project).
 * When `recordDirectory` is given, the same bytes are also written there as `recordFileName(journey, repeat)`.
 * Adds violations for a non-zero exit, a timed-out or idle run, and any unexpected connection through the proxy
 * recorder. Tolerated startup destinations are recorded in `network` and are not violations.
 */
export async function runJourney(sandbox: OpenCodeSandbox, fixture: LoopbackModel, definition: JourneyDefinition, options: JourneyRunOptions): Promise<JourneyRun> {
  const proxy = await startProxyRecorder();
  let run: OpenCodeRunResult;
  let proxyAttempts: ProxyAttempt[];
  try {
    run = await runOpenCode(options.binary, sandbox, {
      message: options.message,
      auto: options.auto,
      proxyUrl: proxy.url,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
      activity: () => fixture.requests.length,
    });
    proxyAttempts = proxy.attempts();
  } finally {
    await proxy.close();
  }
  const violations: Violation[] = [...fixture.violations];
  if (run.status !== 'completed') {
    // No duration here: the record must be byte-identical across runs of the same failing journey.
    violations.push({ step: null, role: null, expected: 'OpenCode finishes the run within its timeouts', received: `run ${run.status}` });
  }
  if (run.exitCode !== 0) {
    violations.push({ step: null, role: null, expected: 'OpenCode exits with code 0', received: `exit code ${String(run.exitCode)}${run.signal === null ? '' : ` (signal ${run.signal})`}` });
  }
  const networkViolation = proxyViolation(proxyAttempts);
  if (networkViolation !== undefined) violations.push(networkViolation);
  const destinations = classifyProxyAttempts(proxyAttempts);
  const record = buildJourneyRecord({
    journey: definition.name,
    opencodeVersion: options.version,
    requests: fixture.requests,
    violations,
    leftoverSteps: fixture.leftoverSteps(),
    network: {
      enforcement: options.enforcement ?? 'none',
      toleratedDestinations: destinations.tolerated,
      unexpectedDestinations: destinations.unexpected,
    },
    skillSentinels: definition.skillSentinels,
    sandboxRoot: sandbox.root,
    homeDirectories: parentHomeDirectories(process.env, homedir()),
    caseInsensitiveHomes: process.platform === 'win32',
  });
  const serialized = serializeJourneyRecord(record);
  writeFileSync(join(sandbox.root, 'journey-record.json'), serialized);
  if (options.recordDirectory !== undefined) {
    mkdirSync(options.recordDirectory, { recursive: true });
    writeFileSync(join(options.recordDirectory, recordFileName(definition.name, options.repeat)), serialized);
  }
  return { record, serialized, run, proxyAttempts, sandboxRoot: sandbox.root };
}

/**
 * Failure text for an assertion message: each violation with expected and received, the hint hosts from stderr,
 * the last 40 stderr lines (scrubbed), and the record.
 */
export function formatJourneyFailure(result: JourneyRun): string {
  const violations = result.record.violations.length === 0
    ? '  (none)'
    : result.record.violations.map(violation => `  - step ${violation.step ?? 'none'}: expected ${violation.expected}; received ${violation.received}`).join('\n');
  const stderrLines = scrubSandbox(result.run.stderr, result.sandboxRoot).split(/\r?\n/).filter(line => line !== '').slice(-40);
  const hosts = networkHostsIn(result.run.stderr);
  const text = [
    `journey ${result.record.journey} (OpenCode ${result.record.opencodeVersion}): outcome ${result.record.outcome}, run ${result.run.status}, exit ${String(result.run.exitCode)}`,
    'violations:',
    violations,
    `non-loopback hosts named in stderr (hint only): ${hosts.length === 0 ? 'none' : hosts.join(', ')}`,
    'stderr (last 40 lines, scrubbed):',
    ...stderrLines.map(line => `  ${line}`),
    'journey record:',
    result.serialized,
  ].join('\n');
  // Local output hygiene: the parent's real home directory never appears in printed failure text.
  return scrubHome(text, parentHomeDirectories(process.env, homedir()), process.platform === 'win32');
}
