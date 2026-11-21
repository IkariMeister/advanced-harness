// Agent E2E journeys (BH-034, issue #62). Run by `npm run e2e:opencode`.
//
// Each journey runs the real OpenCode 2.3.0 binary (from HARNESS_E2E_OPENCODE) in a fresh sandbox with the real
// installed harness prompts and policy, against the loopback model fixture. Scripted turns only: the suite proves
// host plumbing, not model quality, model entitlement, or that a role used a particular model.
//
// Without the binary every journey is SKIPPED (a skip is not a pass). With HARNESS_E2E_REQUIRE=1 a missing or wrong
// binary is a failure. Each journey runs sequentially in its own sandbox with no retries. HARNESS_E2E_NETNS=1 is
// checked against the live network interfaces before any journey runs. HARNESS_E2E_RECORD_DIR keeps a copy of each
// journey record.
//
// Observed in real runs against OpenCode 2.3.0 (observations, not a conformance test):
// - Earlier pre-#261 runs executed `read` (J1) and `shell` (J2) while J3 was `todo` (`Permission denied: skill`) and
//   J3a asserted that denial. #261 added per-role `skill.load` allow rules, enabled J3, and retired J3a; CI `agent-e2e`
//   run 44845273743 for head 99c18069 passed 5/5 on PR merge ref 7276d92f (demonstrating `read`, `shell`, `skill` load,
//   and `edit` against the loopback fixture). Live OpenCode / interactive TTY spot-checks remain waived, not passed.
// - --auto approved Operator's `ask` shell rule in the child session (J2): both shell calls ran.
// - The installed policy does not offer `shell` to Lead. OpenCode returns `No tool named "shell" is currently
//   available` as the tool result (J4a).
// - OpenCode 2.3.0 attempts CONNECT models.opencode.ai:443 on every run. That destination is tolerated (see
//   TOLERATED_STARTUP_DESTINATIONS in e2e/support/opencode-sandbox.ts). The J1 `glob` call also caused
//   CONNECT github.com:443 (a ripgrep download), which is why no journey uses glob or grep.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenCodeSandbox, currentLoopbackCheck, enforcementOf, INSTALL_COMMIT_SUBJECT, readSandboxFile, resolveOpenCodeBinary, scrubSandbox, SCRATCH_NOTES_SENTINEL, SCRATCH_README_SENTINEL, SENTINEL_COMMIT_SUBJECT, type OpenCodeSandbox } from '../e2e/support/opencode-sandbox.ts';
import { callTool, defineJourney, finalText, formatJourneyFailure, recordDirectoryOf, runJourney, startJourneyFixture, type JourneyDefinition, type JourneyRun } from '../e2e/support/journey.ts';
import { toolResultText, type RecordedRequest } from '../e2e/support/loopback-model.ts';

const RUN_TIMEOUT_MS = 150_000;
const JOURNEY_TIMEOUT_MS = 240_000;
/** Two runs per case (determinism), so the test budget is doubled. */
const TWO_RUN_TIMEOUT_MS = 480_000;
const SUBAGENT_TOOL = 'subagent';
const SKILL_ID = 'harness-procedure-documentation-impact';
/** A stable line from the compiled documentation-impact procedure body (skills/documentation-impact/SKILL.md). */
const SKILL_SENTINEL = 'List each affected artifact';
const NOTES_REPLACEMENT = 'E2E-NOTES-EDITED-7f3a';
/** Present in the tool result of a child delegation the parent has not yet heard back from (observed on 2.3.0). */
const INTERMEDIATE_MARKER = 'working in the background';
/** A child report arrives as a user message whose opening tag carries state="completed". */
const REPORT_COMPLETED = 'state="completed"';
/** Permission denial or rejection wording in a tool result. The result text is quoted in any failure. */
const DENIAL = /\b(?:permission (?:was )?(?:denied|rejected)|denied by|rejected by|user rejected|requires approval|not allowed by|blocked by)\b/i;
/**
 * The observed OpenCode 2.3.0 reply to a tool call for a tool that is not offered. Quotes may appear escaped (as
 * `\"`) because the record's received text is JSON-stringified and tool results can carry JSON.
 */
const SHELL_NOT_OFFERED = /No tool named (?:\\*")shell(?:\\*") is currently available/;
const BASE_DIRECTORY = /Base directory for this skill:\s*([^\r\n]+)/;
const EXCERPT_LENGTH = 200;
const REPO_FILE_NAMES = /README\.md|notes\.md/;

// ---------------------------------------------------------------------------
// Journey definitions. Each role's queue is consumed in order; `expect` is checked against that role's request.
// ---------------------------------------------------------------------------

/** J1: Lead reads README.md and notes.md in turn, then answers. No handoff. Only `read`: no glob or grep (see docs). */
const LEAD_READS_REPOSITORY = defineJourney({
  name: 'lead-reads-repository',
  steps: {
    lead: [
      callTool('read', { path: 'README.md' }),
      callTool('read', { path: 'notes.md' }, { toolResultsInclude: [SCRATCH_README_SENTINEL] }),
      finalText('J1 lead final', { toolResultsInclude: [SCRATCH_NOTES_SENTINEL] }),
    ],
  },
});

/** J2: Lead delegates to Operator, which runs two read-only git commands, then reports. */
const LEAD_DELEGATES_GIT_TO_OPERATOR = defineJourney({
  name: 'lead-delegates-git-to-operator',
  steps: {
    lead: [
      callTool(SUBAGENT_TOOL, { agent: 'operator', description: 'Inspect git state', prompt: 'Run git status --porcelain and git log -1 --format=%s, then report both results.' }, { toolsOffered: [SUBAGENT_TOOL] }),
      finalText('J2 lead intermediate', { toolResultsInclude: [INTERMEDIATE_MARKER] }),
      finalText('J2 lead final', { latestUserIncludes: [REPORT_COMPLETED] }),
    ],
    operator: [
      callTool('shell', { command: 'git status --porcelain' }, { toolsOffered: ['shell'] }),
      callTool('shell', { command: 'git log -1 --format=%s' }),
      finalText('J2 operator final', { toolResultsInclude: [INSTALL_COMMIT_SUBJECT] }),
    ],
  },
});

/** J3: Lead delegates to Implementer, which loads the procedure skill and makes one scripted edit. */
const IMPLEMENTER_LOADS_SKILL_AND_EDITS = defineJourney({
  name: 'implementer-loads-skill-and-edits',
  skillSentinels: { [SKILL_ID]: SKILL_SENTINEL },
  steps: {
    lead: [
      callTool(SUBAGENT_TOOL, { agent: 'implementer', description: 'Edit notes', prompt: `Load the ${SKILL_ID} procedure skill, then change the notes sentinel in notes.md.` }, { toolsOffered: [SUBAGENT_TOOL] }),
      finalText('J3 lead intermediate', { toolResultsInclude: [INTERMEDIATE_MARKER] }),
      finalText('J3 lead final', { latestUserIncludes: [REPORT_COMPLETED] }),
    ],
    implementer: [
      callTool('skill', { id: SKILL_ID }),
      callTool('edit', { path: 'notes.md', oldString: SCRATCH_NOTES_SENTINEL, newString: NOTES_REPLACEMENT }, { toolResultsInclude: [SKILL_SENTINEL] }),
      finalText('J3 implementer final'),
    ],
  },
});

/**
 * J4 case a: Lead is scripted to call `shell`, which the installed policy does not offer to Lead. The next scripted
 * step expects the commit subject, so that expectation fails.
 */
const VIOLATION_CASE_A = defineJourney({
  name: 'violations-fail-deterministically-case-a',
  steps: {
    lead: [
      callTool('shell', { command: 'git log -1 --format=%s' }),
      finalText('J4a lead final', { toolResultsInclude: [SENTINEL_COMMIT_SUBJECT] }),
    ],
  },
});

/** J4 case b: Lead has one scripted step, so the next request is unscripted. */
const VIOLATION_CASE_B = defineJourney({
  name: 'violations-fail-deterministically-case-b',
  steps: {
    lead: [callTool('read', { path: 'README.md' })],
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Settings shared by every journey, resolved once at startup. */
interface SuiteConfig {
  binary: string;
  version: string;
  enforcement: 'netns' | 'none';
  recordDirectory: string | undefined;
}

interface Execution {
  sandbox: OpenCodeSandbox;
  run: JourneyRun;
  requests: readonly RecordedRequest[];
  headBefore: string;
}

/** Text of the nth tool result of `tool` for `role`, from the first later request of that role that carries it. */
function toolResultOf(requests: readonly RecordedRequest[], role: string, tool: string, nth = 0): string | undefined {
  const sites = requests
    .filter(request => request.role === role && !request.auxiliary)
    .flatMap(request => request.replyToolCalls.filter(call => call.name === tool).map(call => ({ seq: request.seq, call })));
  const site = sites[nth];
  if (site === undefined) return undefined;
  for (const later of requests) {
    if (later.seq <= site.seq || later.role !== role || later.auxiliary) continue;
    const text = toolResultText(later.body, site.call.id);
    if (text !== undefined) return text;
  }
  return undefined;
}

const excerpt = (text: string | undefined): string => (text === undefined ? '(no tool result)' : JSON.stringify(text.slice(0, EXCERPT_LENGTH)));

/** Compares two paths with forward slashes, case-insensitively on Windows. The base must sit under the root. */
function pathInside(base: string, root: string): boolean {
  const fold = (path: string): string => {
    const forward = path.replace(/\\+/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? forward.toLowerCase() : forward;
  };
  const candidate = fold(base);
  return candidate.startsWith(`${fold(root)}/`) && !candidate.split('/').includes('..');
}

/** Fails the assertion with the journey's failure text (violations, stderr tail, and record). */
function expectOn(run: JourneyRun, condition: boolean, message: string): void {
  assert.ok(condition, `${message}\n${formatJourneyFailure(run)}`);
}

function porcelainLines(sandbox: OpenCodeSandbox): string[] {
  return sandbox.git(['status', '--porcelain']).split(/\r?\n/).filter(line => line !== '');
}

/** The finished run and the value that the check returned for it. */
interface Completed<T> { run: JourneyRun; value: T }

/**
 * Runs one journey in a fresh sandbox. The fixture starts first (its base URL goes into the install commit), then the
 * sandbox, then runJourney. `check` runs before the sandbox is removed. Nothing is retried.
 */
async function execute<T>(suite: SuiteConfig, definition: JourneyDefinition, message: string, check: (execution: Execution) => T, repeat?: number): Promise<Completed<T>> {
  const fixture = await startJourneyFixture(definition);
  let sandbox: OpenCodeSandbox | undefined;
  try {
    sandbox = createOpenCodeSandbox(definition.name, { baseURL: fixture.baseURL });
    const headBefore = sandbox.git(['rev-parse', 'HEAD']).trim();
    const run = await runJourney(sandbox, fixture, definition, {
      binary: suite.binary,
      version: suite.version,
      message,
      auto: true,
      timeoutMs: RUN_TIMEOUT_MS,
      enforcement: suite.enforcement,
      recordDirectory: suite.recordDirectory,
      repeat,
    });
    const value = check({ sandbox, run, requests: fixture.requests, headBefore });
    return { run, value };
  } finally {
    // The sandbox is removed even when the fixture fails to close.
    try {
      await fixture.close();
    } finally {
      sandbox?.dispose();
    }
  }
}

// ---------------------------------------------------------------------------
// Registration. Skip, error, or run; never a silent pass.
// ---------------------------------------------------------------------------

const netnsCheck = currentLoopbackCheck(process.env.HARNESS_E2E_NETNS);
const recordDirectory = recordDirectoryOf(process.env.HARNESS_E2E_RECORD_DIR);
const resolution = resolveOpenCodeBinary(process.env);
const preflightFailures = [
  netnsCheck.status === 'failed' ? netnsCheck.reason : undefined,
  recordDirectory.status === 'error' ? recordDirectory.reason : undefined,
].filter((reason): reason is string => reason !== undefined);
const JOURNEY_TITLES = [
  'J1 lead-reads-repository',
  'J2 lead-delegates-git-to-operator',
  'J3 implementer-loads-skill-and-edits',
  'J4 violations-fail-deterministically (case a: shell not offered to Lead)',
  'J4 violations-fail-deterministically (case b: unscripted request)',
];

if (preflightFailures.length > 0) {
  // A failing preflight means no journey runs as passing.
  test('OpenCode E2E preflight check', () => {
    assert.fail(preflightFailures.join(' '));
  });
} else if (resolution.status === 'skip') {
  for (const title of JOURNEY_TITLES) test(title, { skip: resolution.reason }, () => undefined);
} else if (resolution.status === 'error') {
  test('OpenCode E2E preflight check', () => {
    assert.fail(resolution.reason);
  });
} else {
  const suite: SuiteConfig = {
    binary: resolution.binary,
    version: resolution.version,
    enforcement: enforcementOf(netnsCheck),
    recordDirectory: recordDirectory.status === 'on' ? recordDirectory.directory : undefined,
  };

  test(JOURNEY_TITLES[0] ?? 'J1', { timeout: JOURNEY_TIMEOUT_MS }, async () => {
    await execute(suite, LEAD_READS_REPOSITORY, 'Read the repository documents and report the README.', ({ sandbox, run, requests, headBefore }) => {
      expectOn(run, run.record.outcome === 'pass', 'J1: the journey must pass');
      const readReadme = toolResultOf(requests, 'lead', 'read', 0);
      expectOn(run, readReadme !== undefined && readReadme.includes(SCRATCH_README_SENTINEL), `J1: the first read result (README.md) must contain the README sentinel; received ${excerpt(readReadme)}`);
      const readNotes = toolResultOf(requests, 'lead', 'read', 1);
      expectOn(run, readNotes !== undefined && readNotes.includes(SCRATCH_NOTES_SENTINEL), `J1: the second read result (notes.md) must contain the notes sentinel; received ${excerpt(readNotes)}`);
      expectOn(run, run.record.roleTransitions.length === 0, `J1: a Lead-only journey has no role transitions; received ${JSON.stringify(run.record.roleTransitions)}`);
      expectOn(run, run.record.handoffCount === 0, `J1: handoff count must be 0; received ${run.record.handoffCount}`);
      expectOn(run, porcelainLines(sandbox).length === 0, `J1: git status must be empty; received ${JSON.stringify(porcelainLines(sandbox))}`);
      expectOn(run, sandbox.git(['rev-parse', 'HEAD']).trim() === headBefore, 'J1: HEAD must be unchanged');
    });
  });

  test(JOURNEY_TITLES[1] ?? 'J2', { timeout: JOURNEY_TIMEOUT_MS }, async () => {
    await execute(suite, LEAD_DELEGATES_GIT_TO_OPERATOR, 'Check the git state through Operator and report.', ({ sandbox, run, requests, headBefore }) => {
      const status = toolResultOf(requests, 'operator', 'shell', 0);
      const log = toolResultOf(requests, 'operator', 'shell', 1);
      expectOn(run, !(status !== undefined && DENIAL.test(status)), `J2: Operator's git status shell call was denied or rejected in the child session (--auto did not approve the ask rule): ${excerpt(status)}`);
      expectOn(run, !(log !== undefined && DENIAL.test(log)), `J2: Operator's git log shell call was denied or rejected in the child session (--auto did not approve the ask rule): ${excerpt(log)}`);
      // The scratch repository is clean, so `git status --porcelain` prints nothing. The observed result form is not
      // pinned, so this checks conservatively: a result exists, it is not an error or denial, and it names no repo file.
      expectOn(run, status !== undefined && !/"error"/.test(status) && !REPO_FILE_NAMES.test(status), `J2: the git status --porcelain result must show an empty status (no error and no repository file names); received ${excerpt(status)}`);
      expectOn(run, run.record.outcome === 'pass', 'J2: the journey must pass');
      expectOn(run, run.record.roleTransitions.some(t => t.from === 'lead' && t.to === 'operator'), `J2: transitions must include lead to operator; received ${JSON.stringify(run.record.roleTransitions)}`);
      expectOn(run, run.record.roleTransitions.some(t => t.from === 'operator' && t.to === 'lead'), `J2: transitions must include operator to lead; received ${JSON.stringify(run.record.roleTransitions)}`);
      expectOn(run, run.record.handoffCount === 1, `J2: handoff count must be 1; received ${run.record.handoffCount}`);
      expectOn(run, log !== undefined && log.includes(INSTALL_COMMIT_SUBJECT), `J2: Operator's git log result must contain ${INSTALL_COMMIT_SUBJECT}; received ${excerpt(log)}`);
      expectOn(run, porcelainLines(sandbox).length === 0, `J2: git status must be unchanged (empty); received ${JSON.stringify(porcelainLines(sandbox))}`);
      expectOn(run, sandbox.git(['rev-parse', 'HEAD']).trim() === headBefore, 'J2: HEAD must be unchanged');
    });
  });

  test(JOURNEY_TITLES[2] ?? 'J3', { timeout: JOURNEY_TIMEOUT_MS }, async () => {
    await execute(suite, IMPLEMENTER_LOADS_SKILL_AND_EDITS, 'Load the documentation-impact procedure and edit notes.md.', ({ sandbox, run, requests, headBefore }) => {
      const skill = toolResultOf(requests, 'implementer', 'skill');
      expectOn(run, skill !== undefined, `J3: the Implementer's skill call produced no tool result (the skill tool was not offered or not answered); received ${excerpt(skill)}`);
      expectOn(run, !(!skill?.includes(SKILL_SENTINEL) && DENIAL.test(skill ?? '')), `skill tool denied by installed policy: ${excerpt(skill)}`);
      expectOn(run, skill?.includes(SKILL_SENTINEL) === true, `J3: the skill result must contain the skill sentinel "${SKILL_SENTINEL}"; received ${excerpt(skill)}`);
      const base = BASE_DIRECTORY.exec(skill ?? '')?.[1]?.trim();
      expectOn(run, base !== undefined && pathInside(base, sandbox.root), `J3: the loaded skill's base directory must be inside the sandbox; received ${base === undefined ? '(none)' : JSON.stringify(scrubSandbox(base, sandbox.root))}`);
      expectOn(run, run.record.skillInvocations[0]?.loaded === true && run.record.skillInvocations[0]?.skillId === SKILL_ID, `J3: the first skill invocation must load ${SKILL_ID}; received ${JSON.stringify(run.record.skillInvocations)}`);
      expectOn(run, run.record.outcome === 'pass', 'J3: the journey must pass');
      expectOn(run, run.record.roleTransitions.some(t => t.from === 'lead' && t.to === 'implementer'), `J3: transitions must include lead to implementer; received ${JSON.stringify(run.record.roleTransitions)}`);
      expectOn(run, run.record.roleTransitions.some(t => t.from === 'implementer' && t.to === 'lead'), `J3: transitions must include implementer back to lead; received ${JSON.stringify(run.record.roleTransitions)}`);
      expectOn(run, run.record.handoffCount === 1, `J3: handoff count must be 1; received ${run.record.handoffCount}`);
      const notes = readSandboxFile(sandbox, 'notes.md');
      expectOn(run, notes === `# Notes\n\n${NOTES_REPLACEMENT}\n`, `J3: notes.md must contain exactly the scripted change; received ${JSON.stringify(notes)}`);
      const changed = porcelainLines(sandbox).map(line => line.slice(3));
      expectOn(run, JSON.stringify(changed) === JSON.stringify(['notes.md']), `J3: git status must list only notes.md; received ${JSON.stringify(changed)}`);
      expectOn(run, sandbox.git(['rev-parse', 'HEAD']).trim() === headBefore, 'J3: HEAD must be unchanged');
      expectOn(run, run.record.network.unexpectedDestinations.length === 0, `J3: no unexpected network destination may be attempted; received ${JSON.stringify(run.record.network.unexpectedDestinations)}`);
      expectOn(run, run.record.credentialHeaders.length === 0, `J3: no request may carry an Authorization or other credential-shaped header; received ${JSON.stringify(run.record.credentialHeaders)}`);
    });
  });

  test(JOURNEY_TITLES[3] ?? 'J4a', { timeout: TWO_RUN_TIMEOUT_MS }, async () => {
    const caseA = (execution: Execution): void => {
      const { run } = execution;
      expectOn(run, run.record.outcome === 'fail', 'J4a: the record must fail');
      expectOn(run, run.record.violations.length === 1, `J4a: expected exactly one violation; received ${run.record.violations.length}`);
      const violation = run.record.violations[0];
      expectOn(run, violation?.step === 1, `J4a: the violation must be at scripted step 1 (the second step); received step ${String(violation?.step)}`);
      expectOn(run, (violation?.expected ?? '').includes(SENTINEL_COMMIT_SUBJECT), `J4a: the violation must name the commit-subject sentinel; received expected ${JSON.stringify(violation?.expected)}`);
      expectOn(run, SHELL_NOT_OFFERED.test(violation?.received ?? ''), `J4a: the step-1 tool result must show that shell is not offered to Lead (observed: "No tool named \\"shell\\" is currently available"). Received: ${JSON.stringify(violation?.received)}`);
    };
    const first = await execute(suite, VIOLATION_CASE_A, 'J4a: call shell, which is not offered to Lead.', caseA, 1);
    const second = await execute(suite, VIOLATION_CASE_A, 'J4a: call shell, which is not offered to Lead.', caseA, 2);
    assert.equal(first.run.serialized, second.run.serialized, `J4a: the two serialised records must be byte-identical.\nfirst:\n${first.run.serialized}\nsecond:\n${second.run.serialized}`);
  });

  test(JOURNEY_TITLES[4] ?? 'J4b', { timeout: TWO_RUN_TIMEOUT_MS }, async () => {
    const caseB = (execution: Execution): void => {
      const { run } = execution;
      expectOn(run, run.record.outcome === 'fail', 'J4b: the record must fail');
      expectOn(run, run.record.violations.length === 1, `J4b: expected exactly one violation; received ${run.record.violations.length}`);
      const violation = run.record.violations[0];
      expectOn(run, (violation?.expected ?? '').includes('a scripted step for role "lead"'), `J4b: the violation must be an unscripted request for Lead; received expected ${JSON.stringify(violation?.expected)}`);
      expectOn(run, (violation?.received ?? '').includes('unscripted request'), `J4b: the violation must report an unscripted request; received ${JSON.stringify(violation?.received)}`);
    };
    const first = await execute(suite, VIOLATION_CASE_B, 'J4b: one scripted read, then an unscripted request.', caseB, 1);
    const second = await execute(suite, VIOLATION_CASE_B, 'J4b: one scripted read, then an unscripted request.', caseB, 2);
    assert.equal(first.run.serialized, second.run.serialized, `J4b: the two serialised records must be byte-identical.\nfirst:\n${first.run.serialized}\nsecond:\n${second.run.serialized}`);
  });
}
