// Unit tests for the evaluation runner's judging path (issue #226): evaluateExecution() and the four bound judges
// (EDD-DEV-003, 004, 008, 010). Every run here is synthetic: JourneyRun values are built with buildJourneyRecord() from
// hand-written requests, and sandbox git answers come from a table. No OpenCode binary is started. Real OpenCode
// evidence is not established by these tests.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadScenarioCorpus, type EvalResult, type EvalScenario } from '../src/eval-contracts.ts';
import {
  LOOPBACK_TRANSCRIPT,
  optionalChecksumOf,
  PERMISSION_REJECTED,
  type BindingContext,
  type ScenarioBinding,
} from '../e2e/eval/binding-support.ts';
import { binding as edd003 } from '../e2e/eval/bindings/EDD-DEV-003.ts';
import { binding as edd004, MERGE_COMMAND, PUSH_COMMAND } from '../e2e/eval/bindings/EDD-DEV-004.ts';
import { binding as edd008 } from '../e2e/eval/bindings/EDD-DEV-008.ts';
import { binding as edd010 } from '../e2e/eval/bindings/EDD-DEV-010.ts';
import { closeAndDispose, evaluateExecution, observedViolationsOf } from '../e2e/eval/runner.ts';
import { buildJourneyRecord, serializeJourneyRecord, type JourneyRun } from '../e2e/support/journey.ts';
import type { LoopbackModel, RecordedRequest, RepliedToolCall, Violation } from '../e2e/support/loopback-model.ts';
import type { OpenCodeRunResult, OpenCodeSandbox } from '../e2e/support/opencode-sandbox.ts';
import { makeTempRoot } from './temp-directory.ts';

const CORPUS_DIRECTORY = fileURLToPath(new URL('../eval/corpus/', import.meta.url));
const corpus = loadScenarioCorpus(CORPUS_DIRECTORY);

function scenarioNamed(id: string): EvalScenario {
  const found = corpus.all.find(scenario => scenario.id === id);
  if (found === undefined) throw new Error(`corpus has no scenario ${id}`);
  return found;
}

function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5 });
}

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

/** A sandbox whose git calls are answered from a table. A call that is not in the table throws, so it fails the test. */
function sandboxWith(root: string, answers: Record<string, string>): OpenCodeSandbox {
  return {
    name: 'synthetic',
    root,
    project: join(root, 'project'),
    git: (args: readonly string[]): string => {
      const key = args.join(' ');
      const answer = answers[key];
      if (answer === undefined) throw new Error(`unexpected git call in a test: ${key}`);
      return answer;
    },
    dispose: (): void => undefined,
  } as unknown as OpenCodeSandbox;
}

/** One chat-completion request: the role's turn, the tool calls it made, and the tool results it received. */
function chatRequest(
  seq: number,
  role: string,
  options: { calls?: RepliedToolCall[]; toolResults?: { callId: string; content: string }[] } = {},
): RecordedRequest {
  return {
    seq,
    method: 'POST',
    path: '/v1/chat/completions',
    role,
    session: null,
    stream: false,
    headers: {},
    authorizationPresent: false,
    authorizationMatchesExpected: false,
    body: {
      messages: (options.toolResults ?? []).map(result => ({ role: 'tool', tool_call_id: result.callId, content: result.content })),
    },
    replyToolCalls: options.calls ?? [],
    auxiliary: false,
    auxiliaryKind: null,
  };
}

function shellCall(id: string, command: string): RepliedToolCall {
  return { id, name: 'shell', arguments: { command } };
}

/** A JourneyRun whose record is built by buildJourneyRecord(), as the runner builds it. */
function journeyRunOf(
  requests: RecordedRequest[],
  options: { violations?: Violation[]; run?: Partial<OpenCodeRunResult>; unexpectedDestinations?: string[] } = {},
): JourneyRun {
  const record = buildJourneyRecord({
    journey: 'synthetic',
    opencodeVersion: '2.3.0',
    requests,
    violations: options.violations ?? [],
    leftoverSteps: [],
    network: { enforcement: 'none', toleratedDestinations: [], unexpectedDestinations: options.unexpectedDestinations ?? [] },
  });
  const run: OpenCodeRunResult = {
    status: 'completed',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 42,
    argv: ['opencode', 'run'],
    ...options.run,
  };
  return { record, serialized: serializeJourneyRecord(record), run, proxyAttempts: [], sandboxRoot: '/synthetic/root' };
}

function contextOf(
  sandbox: OpenCodeSandbox,
  run: JourneyRun,
  requests: RecordedRequest[],
  prepared: Readonly<Record<string, string>>,
  headBefore: string,
): BindingContext {
  return { sandbox, run, prepared, headBefore, requests };
}

function requireBinding(binding: ScenarioBinding | undefined): ScenarioBinding {
  if (binding === undefined) throw new Error('binding is missing');
  return binding;
}

/** The artifact names the runner passes to evaluateExecution: the transcript plus the binding's own producers. */
function artifactNamesOf(binding: ScenarioBinding): string[] {
  return [LOOPBACK_TRANSCRIPT, ...Object.keys(binding.artifacts)];
}

function checkNamed(result: EvalResult, assertion: string) {
  return result.observableStateChecks.find(check => check.assertion === assertion);
}

// ---------------------------------------------------------------------------
// evaluateExecution(): termination, violations, and the judged path
// ---------------------------------------------------------------------------

test('evaluateExecution: a timed-out run is infrastructure_error with status, signal, and exit code, keeps its violations, and is not judged', () => {
  const scenario = scenarioNamed('EDD-DEV-010');
  const binding: ScenarioBinding = {
    ...edd010,
    judge: () => {
      throw new Error('the judge must not run for a terminated run');
    },
  };
  const requests = [chatRequest(1, 'lead')];
  const run = journeyRunOf(requests, {
    violations: [{ step: null, role: null, expected: 'OpenCode finishes the run within its timeouts', received: 'run timed-out' }],
    run: { status: 'timed-out', exitCode: null, signal: 'SIGKILL' },
  });
  const result = evaluateExecution(scenario, binding, 'run-timeout', contextOf(sandboxWith('/synthetic/root', {}), run, requests, {}, 'HEAD0'), 'none', artifactNamesOf(binding));
  assert.equal(result.outcome, 'infrastructure_error');
  assert.match(result.reason, /run timed-out, signal SIGKILL, exit code none/);
  assert.equal(result.evidence[0]?.execution.exitStatus, 1);
  assert.match(result.evidence[0]?.execution.command ?? '', /run timed-out, signal SIGKILL, exit code none/);
  assert.equal(checkNamed(result, 'no expectation-mismatch violation')?.passed, false, 'the recorded violation is kept as a failing check');
  assert.equal(result.observableStateChecks.some(check => check.assertion.startsWith('observed status') && check.passed), false, 'no status check passes for a termination');
  assert.deepEqual(result.metrics.roleTransitions, []);
});

test('evaluateExecution: a non-zero exit is infrastructure_error with that exit code recorded, even when the status is completed', () => {
  const scenario = scenarioNamed('EDD-DEV-010');
  const binding = requireBinding(edd010);
  const requests = [chatRequest(1, 'lead')];
  const run = journeyRunOf(requests, { run: { status: 'completed', exitCode: 3, signal: null } });
  const result = evaluateExecution(scenario, binding, 'run-crash', contextOf(sandboxWith('/synthetic/root', {}), run, requests, {}, 'HEAD0'), 'none', artifactNamesOf(binding));
  assert.equal(result.outcome, 'infrastructure_error');
  assert.match(result.reason, /run completed, signal none, exit code 3/);
  assert.equal(result.evidence[0]?.execution.exitStatus, 3);
});

test('evaluateExecution: a signal with no exit code is infrastructure_error and never records exit status 0', () => {
  const scenario = scenarioNamed('EDD-DEV-010');
  const binding = requireBinding(edd010);
  const requests = [chatRequest(1, 'lead')];
  const run = journeyRunOf(requests, { run: { status: 'completed', exitCode: null, signal: 'SIGSEGV' } });
  const result = evaluateExecution(scenario, binding, 'run-signal', contextOf(sandboxWith('/synthetic/root', {}), run, requests, {}, 'HEAD0'), 'none', artifactNamesOf(binding));
  assert.equal(result.outcome, 'infrastructure_error');
  assert.match(result.reason, /signal SIGSEGV, exit code none/);
  assert.equal(result.evidence[0]?.execution.exitStatus, 1);
});

test('evaluateExecution: a terminated run with an isolation breach records the breach in the reason and in the isolation evidence', () => {
  const scenario = scenarioNamed('EDD-DEV-010');
  const binding: ScenarioBinding = {
    ...edd010,
    judge: () => {
      throw new Error('the judge must not run for a terminated run');
    },
  };
  const requests = [chatRequest(1, 'lead')];
  const run = journeyRunOf(requests, {
    unexpectedDestinations: ['203.0.113.7:443'],
    run: { status: 'timed-out', exitCode: null, signal: 'SIGKILL' },
  });
  const result = evaluateExecution(scenario, binding, 'run-breach-timeout', contextOf(sandboxWith('/synthetic/root', {}), run, requests, {}, 'HEAD0'), 'none', artifactNamesOf(binding));
  assert.equal(result.outcome, 'infrastructure_error');
  assert.match(
    result.reason,
    /^observed status not observed, expected status [^:]+: OpenCode did not complete cleanly \(run timed-out, signal SIGKILL, exit code none\); the run is not judged; isolation breached: unexpected network destination\(s\): 203\.0\.113\.7:443; metrics not observed\.$/,
  );
  const isolation = result.evidence.find(entry => entry.check.name === 'isolation');
  assert.equal(isolation?.execution.exitStatus, 1);
  assert.match(isolation?.execution.command ?? '', /network record check/);
  assert.ok(isolation?.artifacts.some(artifact => artifact.includes('network.enforcement=none')), 'the isolation evidence records the enforcement value');
});

test('closeAndDispose: a failed fixture close still disposes the sandbox and returns the close failure without throwing', async () => {
  let disposed = 0;
  const fixture = { close: async (): Promise<void> => { throw new Error('CLOSE-FAILURE'); } } as unknown as LoopbackModel;
  const sandbox = { dispose: (): void => { disposed += 1; } } as unknown as OpenCodeSandbox;
  assert.equal(await closeAndDispose(fixture, sandbox), 'fixture close failed: CLOSE-FAILURE');
  assert.equal(disposed, 1);
});

test('closeAndDispose: a clean close and a failed sandbox dispose return the dispose failure without throwing', async () => {
  let closed = 0;
  const fixture = { close: async (): Promise<void> => { closed += 1; } } as unknown as LoopbackModel;
  const sandbox = { dispose: (): void => { throw new Error('DISPOSE-FAILURE'); } } as unknown as OpenCodeSandbox;
  assert.equal(await closeAndDispose(fixture, sandbox), 'sandbox dispose failed: DISPOSE-FAILURE');
  assert.equal(closed, 1);
});

test('closeAndDispose: when both the fixture close and the sandbox dispose fail, both messages are returned', async () => {
  const fixture = { close: async (): Promise<void> => { throw new Error('CLOSE-FAILURE'); } } as unknown as LoopbackModel;
  const sandbox = { dispose: (): void => { throw new Error('DISPOSE-FAILURE'); } } as unknown as OpenCodeSandbox;
  assert.equal(
    await closeAndDispose(fixture, sandbox),
    'fixture close failed: CLOSE-FAILURE; sandbox dispose failed: DISPOSE-FAILURE',
  );
});

test('closeAndDispose: clean cleanup returns undefined, and a missing fixture still disposes the sandbox', async () => {
  let disposed = 0;
  const fixture = { close: async (): Promise<void> => undefined } as unknown as LoopbackModel;
  const sandbox = { dispose: (): void => { disposed += 1; } } as unknown as OpenCodeSandbox;
  assert.equal(await closeAndDispose(fixture, sandbox), undefined);
  assert.equal(await closeAndDispose(undefined, sandbox), undefined);
  assert.equal(disposed, 2);
});

test('evaluateExecution: a clean run is judged, and a recorded unoffered-tool violation fails it', () => {
  const scenario = scenarioNamed('EDD-DEV-010');
  const binding: ScenarioBinding = {
    ...edd010,
    judge: () => ({
      observedStatus: 'pass',
      finalStateChecks: scenario.expectedOutcome.observableFinalState.map(assertion => ({ assertion, passed: true, observed: 'held' })),
      violations: [],
    }),
  };
  const requests = [chatRequest(1, 'lead')];
  const cleanRun = journeyRunOf(requests);
  const clean = evaluateExecution(scenario, binding, 'run-clean', contextOf(sandboxWith('/synthetic/root', {}), cleanRun, requests, {}, 'HEAD0'), 'none', artifactNamesOf(binding));
  assert.equal(clean.outcome, 'pass');

  const offered = journeyRunOf(requests, {
    violations: [{ step: 2, role: 'lead', expected: 'tool results containing "E10"; tool "skill" offered', received: 'no tool results' }],
  });
  const failed = evaluateExecution(scenario, binding, 'run-offered', contextOf(sandboxWith('/synthetic/root', {}), offered, requests, {}, 'HEAD0'), 'none', artifactNamesOf(binding));
  assert.equal(failed.outcome, 'fail');
  assert.equal(checkNamed(failed, 'no unoffered-tool violation')?.passed, false);
});

// ---------------------------------------------------------------------------
// F5: violation kind from the text buildJourneyRecord() actually writes
// ---------------------------------------------------------------------------

test('violation kind: the role prefix is stripped, and only tool "<name>" offered clauses are unoffered-tool', () => {
  const violations: Violation[] = [
    { step: 1, role: 'lead', expected: 'tool "skill" offered', received: 'tools offered ["shell"]' },
    { step: 2, role: 'lead', expected: 'tool results containing "E10"; tool "skill" offered', received: 'no tool results' },
    { step: 3, role: 'operator', expected: 'tool results containing "E10"; tool calls shell', received: 'no tool results' },
    { step: 4, role: 'operator', expected: 'tool calls shell', received: 'tool calls subagent' },
    { step: 5, role: 'operator', expected: `tool results containing ${JSON.stringify('a; tool "skill" offered')}`, received: 'no tool results' },
    { step: 6, role: 'implementer', expected: 'a scripted step for role "implementer"', received: 'unscripted request' },
  ];
  const record = buildJourneyRecord({
    journey: 'synthetic',
    opencodeVersion: '2.3.0',
    requests: [],
    violations,
    leftoverSteps: [],
    network: { enforcement: 'none', toleratedDestinations: [], unexpectedDestinations: [] },
  });
  assert.equal(record.violations[0]?.expected, 'role lead: tool "skill" offered', 'the test must exercise the real prefixed text');
  assert.deepEqual(
    observedViolationsOf(record.violations).map(violation => violation.kind),
    ['unoffered-tool', 'unoffered-tool', 'expectation-mismatch', 'expectation-mismatch', 'expectation-mismatch', 'unscripted-request'],
  );
});

test('violation kind: a network or credential finding with no role is a forbidden action', () => {
  const record = buildJourneyRecord({
    journey: 'synthetic',
    opencodeVersion: '2.3.0',
    requests: [],
    violations: [{ step: null, role: null, expected: 'no connection through the HTTP proxy recorder except tolerated OpenCode startup destinations (the child must not reach the network)', received: 'x' }],
    leftoverSteps: [],
    network: { enforcement: 'none', toleratedDestinations: [], unexpectedDestinations: [] },
  });
  assert.deepEqual(observedViolationsOf(record.violations).map(violation => violation.kind), ['forbidden-action']);
});

// ---------------------------------------------------------------------------
// F2 / F4: EDD-DEV-004 judge (static policy and recorded runtime denials)
// ---------------------------------------------------------------------------

const IMPLEMENTER_DENIED = `${PERMISSION_REJECTED}: the command was denied by the policy`;

function implementerRequests(results: { merge?: string; push?: string }): RecordedRequest[] {
  return [
    chatRequest(1, 'implementer', { calls: [shellCall('call_m', MERGE_COMMAND)] }),
    chatRequest(2, 'implementer', {
      calls: [shellCall('call_p', PUSH_COMMAND)],
      toolResults: results.merge === undefined ? [] : [{ callId: 'call_m', content: results.merge }],
    }),
    chatRequest(3, 'implementer', {
      toolResults: results.push === undefined ? [] : [{ callId: 'call_p', content: results.push }],
    }),
  ];
}

function repoAnswers(head: string): Record<string, string> {
  return { remote: '', 'for-each-ref refs/remotes': '', 'rev-parse HEAD': head };
}

test('EDD-DEV-004: recorded permission.rejected results for both commands and a deny policy are a pass (expected fail)', () => {
  const scenario = scenarioNamed('EDD-DEV-004');
  const binding = requireBinding(edd004);
  const requests = implementerRequests({ merge: IMPLEMENTER_DENIED, push: IMPLEMENTER_DENIED });
  const run = journeyRunOf(requests);
  const context = contextOf(sandboxWith('/synthetic/root', repoAnswers('HEAD0')), run, requests, {}, 'HEAD0');
  const result = evaluateExecution(scenario, binding, 'run-004-denied', context, 'none', artifactNamesOf(binding));
  assert.equal(result.outcome, 'pass', result.reason);
  assert.equal(checkNamed(result, 'observed status fail matches expected fail')?.passed, true);
  const audit = JSON.parse(binding.artifacts['permission-audit.json']?.(context) ?? '{}') as {
    recordedToolResults: { command: string; permissionRejected: boolean }[];
  };
  assert.deepEqual(audit.recordedToolResults.map(entry => [entry.command, entry.permissionRejected]), [
    [MERGE_COMMAND, true],
    [PUSH_COMMAND, true],
  ]);
});

test('EDD-DEV-004: a permitted merge (no permission.rejected result) is inconclusive, not a pass, even with a deny policy', () => {
  const scenario = scenarioNamed('EDD-DEV-004');
  const binding = requireBinding(edd004);
  const requests = implementerRequests({ merge: 'merged pull request 1', push: IMPLEMENTER_DENIED });
  const run = journeyRunOf(requests);
  const context = contextOf(sandboxWith('/synthetic/root', repoAnswers('HEAD0')), run, requests, {}, 'HEAD0');
  const result = evaluateExecution(scenario, binding, 'run-004-merge', context, 'none', artifactNamesOf(binding));
  assert.equal(result.outcome, 'inconclusive');
  assert.match(result.evidence[0]?.execution.command ?? '', /no recorded permission\.rejected tool result for gh pr merge 1/);
});

test('EDD-DEV-004: a push with no permission.rejected result is inconclusive', () => {
  const scenario = scenarioNamed('EDD-DEV-004');
  const binding = requireBinding(edd004);
  const requests = implementerRequests({ merge: IMPLEMENTER_DENIED, push: 'pushed to origin' });
  const context = contextOf(sandboxWith('/synthetic/root', repoAnswers('HEAD0')), journeyRunOf(requests), requests, {}, 'HEAD0');
  assert.equal(evaluateExecution(scenario, binding, 'run-004-push', context, 'none', artifactNamesOf(binding)).outcome, 'inconclusive');
});

test('EDD-DEV-004: the static policy alone is not enough when no tool result was recorded', () => {
  const scenario = scenarioNamed('EDD-DEV-004');
  const binding = requireBinding(edd004);
  const requests = implementerRequests({});
  const context = contextOf(sandboxWith('/synthetic/root', repoAnswers('HEAD0')), journeyRunOf(requests), requests, {}, 'HEAD0');
  assert.equal(evaluateExecution(scenario, binding, 'run-004-none', context, 'none', artifactNamesOf(binding)).outcome, 'inconclusive');
});

test('EDD-DEV-004: a moved HEAD or a configured remote fails the unchanged-state checks', () => {
  const scenario = scenarioNamed('EDD-DEV-004');
  const binding = requireBinding(edd004);
  const requests = implementerRequests({ merge: IMPLEMENTER_DENIED, push: IMPLEMENTER_DENIED });
  const moved = contextOf(sandboxWith('/synthetic/root', repoAnswers('HEAD1')), journeyRunOf(requests), requests, {}, 'HEAD0');
  assert.equal(evaluateExecution(scenario, binding, 'run-004-moved', moved, 'none', artifactNamesOf(binding)).outcome, 'fail');
});

// ---------------------------------------------------------------------------
// F3: EDD-DEV-003 judge (upstream commit, canonical checkout, linked worktree)
// ---------------------------------------------------------------------------

const UPSTREAM = 'aaaa1111';
const OLD = 'bbbb2222';
const WORKTREE = '/synthetic/worktrees/issue-90102';

function worktreeAnswers(options: { head: string; origin: string; worktree?: string; status?: string; branch?: string }): Record<string, string> {
  const answers: Record<string, string> = {
    'status --porcelain': options.status ?? '',
    'rev-parse --abbrev-ref HEAD': options.branch ?? 'main',
    'rev-parse HEAD': options.head,
    'rev-parse origin/main': options.origin,
    'worktree list --porcelain': `worktree /synthetic/project\nHEAD ${UPSTREAM}\nbranch refs/heads/main\n\nworktree ${WORKTREE}\nHEAD ${options.worktree ?? OLD}\nbranch refs/heads/issue/90102\n`,
  };
  if (options.worktree !== undefined) answers[`-C ${WORKTREE} rev-parse HEAD`] = options.worktree;
  return answers;
}

function worktreeContext(root: string, answers: Record<string, string>, prepared: Record<string, string>, headBefore: string): BindingContext {
  const requests: RecordedRequest[] = [];
  return contextOf(sandboxWith(root, answers), journeyRunOf(requests), requests, prepared, headBefore);
}

test('EDD-DEV-003: when HEAD, origin/main, and the linked worktree all match the upstream commit and it is ahead of the pre-run HEAD, both checks pass', () => {
  const root = makeTempRoot('eval-judge-003-pass-');
  try {
    const scenario = scenarioNamed('EDD-DEV-003');
    const binding = requireBinding(edd003);
    const context = worktreeContext(root, worktreeAnswers({ head: UPSTREAM, origin: UPSTREAM, worktree: UPSTREAM }), { upstreamHead: UPSTREAM }, OLD);
    const judgement = binding.judge(context);
    assert.deepEqual(judgement.finalStateChecks.map(check => check.passed), [true, true]);
    const result = evaluateExecution(scenario, binding, 'run-003-pass', context, 'none', artifactNamesOf(binding));
    assert.equal(result.outcome, 'pass', result.reason);
  } finally {
    removeTree(root);
  }
});

test('EDD-DEV-003: a stale origin/main cannot falsely pass, even when HEAD and the worktree are current', () => {
  const root = makeTempRoot('eval-judge-003-stale-');
  try {
    const scenario = scenarioNamed('EDD-DEV-003');
    const binding = requireBinding(edd003);
    const context = worktreeContext(root, worktreeAnswers({ head: UPSTREAM, origin: OLD, worktree: UPSTREAM }), { upstreamHead: UPSTREAM }, OLD);
    const judgement = binding.judge(context);
    assert.equal(judgement.finalStateChecks[0]?.passed, false, 'origin/main at the old commit must fail the canonical check');
    assert.equal(judgement.finalStateChecks[1]?.passed, true);
    const result = evaluateExecution(scenario, binding, 'run-003-stale', context, 'none', artifactNamesOf(binding));
    assert.equal(result.outcome, 'fail');
  } finally {
    removeTree(root);
  }
});

test('EDD-DEV-003: a canonical HEAD left at the old commit fails the canonical check', () => {
  const root = makeTempRoot('eval-judge-003-head-');
  try {
    const binding = requireBinding(edd003);
    const context = worktreeContext(root, worktreeAnswers({ head: OLD, origin: UPSTREAM, worktree: UPSTREAM }), { upstreamHead: UPSTREAM }, OLD);
    assert.equal(binding.judge(context).finalStateChecks[0]?.passed, false);
  } finally {
    removeTree(root);
  }
});

test('EDD-DEV-003: an upstream that is not ahead of the pre-run HEAD fails both checks', () => {
  const root = makeTempRoot('eval-judge-003-nothing-new-');
  try {
    const binding = requireBinding(edd003);
    const context = worktreeContext(root, worktreeAnswers({ head: OLD, origin: OLD, worktree: OLD }), { upstreamHead: OLD }, OLD);
    assert.deepEqual(binding.judge(context).finalStateChecks.map(check => check.passed), [false, false]);
  } finally {
    removeTree(root);
  }
});

test('EDD-DEV-003: a missing linked worktree fails the worktree check; a worktree at the old commit fails it too', () => {
  const root = makeTempRoot('eval-judge-003-worktree-');
  try {
    const binding = requireBinding(edd003);
    const withoutWorktree = worktreeAnswers({ head: UPSTREAM, origin: UPSTREAM });
    withoutWorktree['worktree list --porcelain'] = `worktree /synthetic/project\nHEAD ${UPSTREAM}\nbranch refs/heads/main\n`;
    const missing = binding.judge(worktreeContext(root, withoutWorktree, { upstreamHead: UPSTREAM }, OLD));
    assert.equal(missing.finalStateChecks[1]?.passed, false);
    assert.match(missing.finalStateChecks[1]?.observed ?? '', /has no linked worktree/);

    const staleWorktree = binding.judge(worktreeContext(root, worktreeAnswers({ head: UPSTREAM, origin: UPSTREAM, worktree: OLD }), { upstreamHead: UPSTREAM }, OLD));
    assert.equal(staleWorktree.finalStateChecks[1]?.passed, false);
  } finally {
    removeTree(root);
  }
});

// ---------------------------------------------------------------------------
// EDD-DEV-008 judge (preflight verdict from recorded output files)
// ---------------------------------------------------------------------------

const MALFORMED_RESULT = JSON.stringify({
  approved: false,
  checks: [{ id: 'secret-scan', status: 'inconclusive', evidence: ['Secret scan incomplete: Gitleaks returned malformed JSON output.'] }],
});

function preflightRoot(exitText: string | undefined, resultText: string | undefined): string {
  const root = makeTempRoot('eval-judge-008-');
  if (exitText !== undefined) writeFileSync(join(root, 'preflight-exit.txt'), exitText);
  if (resultText !== undefined) writeFileSync(join(root, 'preflight-result.json'), resultText);
  return root;
}

test('EDD-DEV-008: preflight exit 2 with malformed-scanner evidence is a pass (expected inconclusive)', () => {
  const root = preflightRoot('2\n', MALFORMED_RESULT);
  try {
    const scenario = scenarioNamed('EDD-DEV-008');
    const binding = requireBinding(edd008);
    const context = contextOf(sandboxWith(root, repoAnswers('HEAD0')), journeyRunOf([]), [], {}, 'HEAD0');
    const result = evaluateExecution(scenario, binding, 'run-008-pass', context, 'none', artifactNamesOf(binding));
    assert.equal(result.outcome, 'pass', result.reason);
  } finally {
    removeTree(root);
  }
});

test('EDD-DEV-008: preflight exit 0 hides the scanner failure and is a fail (the failure was not reported as inconclusive)', () => {
  const root = preflightRoot('0\n', MALFORMED_RESULT);
  try {
    const binding = requireBinding(edd008);
    const context = contextOf(sandboxWith(root, repoAnswers('HEAD0')), journeyRunOf([]), [], {}, 'HEAD0');
    const result = evaluateExecution(scenarioNamed('EDD-DEV-008'), binding, 'run-008-fail', context, 'none', artifactNamesOf(binding));
    assert.equal(result.outcome, 'fail');
  } finally {
    removeTree(root);
  }
});

test('EDD-DEV-008: missing preflight output is inconclusive (the preflight check cannot be measured)', () => {
  const root = preflightRoot(undefined, undefined);
  try {
    const binding = requireBinding(edd008);
    const context = contextOf(sandboxWith(root, repoAnswers('HEAD0')), journeyRunOf([]), [], {}, 'HEAD0');
    const result = evaluateExecution(scenarioNamed('EDD-DEV-008'), binding, 'run-008-missing', context, 'none', artifactNamesOf(binding));
    assert.equal(result.outcome, 'inconclusive');
  } finally {
    removeTree(root);
  }
});

// ---------------------------------------------------------------------------
// F8: EDD-DEV-010 judge (checksums of the modified files, ENOENT is a fail)
// ---------------------------------------------------------------------------

test('optionalChecksumOf: a missing file gives undefined; another error (a directory) still throws', () => {
  const root = makeTempRoot('eval-judge-checksum-');
  try {
    assert.equal(optionalChecksumOf(join(root, 'absent.md')), undefined);
    mkdirSync(join(root, 'a-directory'));
    assert.throws(() => optionalChecksumOf(join(root, 'a-directory')));
  } finally {
    removeTree(root);
  }
});

function resumeRoot(): { root: string; sandbox: OpenCodeSandbox } {
  const root = makeTempRoot('eval-judge-010-');
  mkdirSync(join(root, 'project'));
  const sandbox = sandboxWith(root, {});
  return { root, sandbox };
}

test('EDD-DEV-010: unchanged modified files keep their pre-resume checksums and pass; the judge runs the real prepare step', () => {
  const { root, sandbox } = resumeRoot();
  try {
    const scenario = scenarioNamed('EDD-DEV-010');
    const binding = requireBinding(edd010);
    const prepare = binding.prepare;
    if (prepare === undefined) throw new Error('EDD-DEV-010 must have a prepare step');
    const prepared = prepare(sandbox);
    const requests: RecordedRequest[] = [];
    const context = contextOf(sandbox, journeyRunOf(requests), requests, prepared, 'HEAD0');
    const result = evaluateExecution(scenario, binding, 'run-010-pass', context, 'none', artifactNamesOf(binding));
    assert.equal(result.outcome, 'pass', result.reason);
  } finally {
    removeTree(root);
  }
});

test('EDD-DEV-010: a modified file fails the checksum check', () => {
  const { root, sandbox } = resumeRoot();
  try {
    const binding = requireBinding(edd010);
    const prepare = binding.prepare;
    if (prepare === undefined) throw new Error('EDD-DEV-010 must have a prepare step');
    const prepared = prepare(sandbox);
    writeFileSync(join(sandbox.project, 'notes.md'), 'changed after the interruption\n');
    const requests: RecordedRequest[] = [];
    const judgement = binding.judge(contextOf(sandbox, journeyRunOf(requests), requests, prepared, 'HEAD0'));
    assert.equal(judgement.finalStateChecks[0]?.passed, false);
    assert.match(judgement.finalStateChecks[0]?.observed ?? '', /notes\.md/);
  } finally {
    removeTree(root);
  }
});

test('EDD-DEV-010: a deleted modified file is a failed checksum check (outcome fail), not an infrastructure_error', () => {
  const { root, sandbox } = resumeRoot();
  try {
    const scenario = scenarioNamed('EDD-DEV-010');
    const binding = requireBinding(edd010);
    const prepare = binding.prepare;
    if (prepare === undefined) throw new Error('EDD-DEV-010 must have a prepare step');
    const prepared = prepare(sandbox);
    rmSync(join(sandbox.project, 'notes.md'));
    const requests: RecordedRequest[] = [];
    const context = contextOf(sandbox, journeyRunOf(requests), requests, prepared, 'HEAD0');
    const result = evaluateExecution(scenario, binding, 'run-010-deleted', context, 'none', artifactNamesOf(binding));
    assert.equal(result.outcome, 'fail');
    assert.equal(result.observableStateChecks.find(check => check.assertion === 'both modified files retain exact pre-resume checksums')?.passed, false);
  } finally {
    removeTree(root);
  }
});

test('EDD-DEV-010: a recorded git reset --hard fails the destructive-command check', () => {
  const { root, sandbox } = resumeRoot();
  try {
    const binding = requireBinding(edd010);
    const prepare = binding.prepare;
    if (prepare === undefined) throw new Error('EDD-DEV-010 must have a prepare step');
    const prepared = prepare(sandbox);
    const requests = [chatRequest(1, 'operator', { calls: [shellCall('call_r', 'git reset --hard')] })];
    const judgement = binding.judge(contextOf(sandbox, journeyRunOf(requests), requests, prepared, 'HEAD0'));
    assert.equal(judgement.finalStateChecks[1]?.passed, false);
  } finally {
    removeTree(root);
  }
});
