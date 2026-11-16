import assert from 'node:assert/strict';
import test from 'node:test';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildJourneyRecord,
  credentialViolation,
  defineJourney,
  finalText,
  formatJourneyFailure,
  journeyNormaliser,
  proxyViolation,
  recordDirectoryOf,
  recordFileName,
  serializeJourneyRecord,
  type JourneyNetwork,
  type JourneyRecordInput,
  type JourneyRun,
} from '../e2e/support/journey.ts';
import { formatViolations, type LeftoverStep, type RecordedRequest, type RepliedToolCall, type Violation } from '../e2e/support/loopback-model.ts';
import { classifyProxyAttempts, type ProxyAttempt } from '../e2e/support/opencode-sandbox.ts';

const network: JourneyNetwork = { enforcement: 'none', toleratedDestinations: [], unexpectedDestinations: [] };
const TOLERATED: ProxyAttempt = { method: 'CONNECT', host: 'models.opencode.ai:443' };
const user = (content: string) => ({ role: 'user', content });
const toolResult = (id: string, content: string) => ({ role: 'tool', tool_call_id: id, content });
const call = (id: string, name: string, args: Record<string, unknown>): RepliedToolCall => ({ id, name, arguments: args });

/** A `<subagent>` report block as Lead receives it when a child goes idle (observed on OpenCode 2.3.0). */
const report = (state: string, text = 'child final text'): string =>
  `<subagent sessionID="ses_child_${state}" state="${state}" description="Read the README">\n${text}\n</subagent>`;

/** An agent turn: the body offers tools, so the request is not auxiliary. */
function chat(seq: number, role: string, messages: unknown[], options: { session?: string | null; calls?: RepliedToolCall[] } = {}): RecordedRequest {
  return {
    seq,
    method: 'POST',
    path: '/v1/chat/completions',
    role,
    session: options.session ?? null,
    stream: false,
    headers: {},
    authorizationPresent: false,
    authorizationMatchesExpected: false,
    body: { model: role, messages, tools: [{ type: 'function', function: { name: 'read' } }] },
    replyToolCalls: options.calls ?? [],
    auxiliary: false,
    auxiliaryKind: null,
  };
}

/** A title-generation request: no `tools` key, and the title prompt as its first system message. */
function titleRequest(seq: number, role: string, options: { session?: string | null } = {}): RecordedRequest {
  return {
    seq,
    method: 'POST',
    path: '/v1/chat/completions',
    role,
    session: options.session ?? null,
    stream: true,
    headers: {},
    authorizationPresent: false,
    authorizationMatchesExpected: false,
    body: {
      model: role,
      messages: [
        { role: 'system', content: 'You name conversations so the user can find them later in a list of past sessions.' },
        user('Here is the first message of the conversation:\n\n<message>\ngo\n</message>\n\nReply with only the title.'),
      ],
      stream: true,
      stream_options: { include_usage: true },
    },
    replyToolCalls: [],
    auxiliary: true,
    auxiliaryKind: 'title',
  };
}

function build(requests: RecordedRequest[], extra: { violations?: Violation[]; leftover?: LeftoverStep[]; skillSentinels?: Record<string, string> } = {}) {
  const input: JourneyRecordInput = {
    journey: 'unit-journey',
    opencodeVersion: '2.3.0',
    requests,
    violations: extra.violations ?? [],
    leftoverSteps: extra.leftover ?? [],
    network,
    skillSentinels: extra.skillSentinels,
  };
  return buildJourneyRecord(input);
}

test('role transitions are recorded only where the attributed role changes between consecutive requests', () => {
  const record = build([
    chat(1, 'lead', [user('go')]),
    chat(2, 'researcher', [user('read')]),
    chat(3, 'researcher', [user('again')]),
    chat(4, 'lead', [user('back')]),
  ]);
  assert.deepEqual(record.roleTransitions, [
    { seq: 2, from: 'lead', to: 'researcher' },
    { seq: 4, from: 'researcher', to: 'lead' },
  ]);
});

test('a completed Lead-to-child handoff counts as one when Lead receives the completed report block', () => {
  const record = build([
    chat(1, 'lead', [user('go')], { calls: [call('call_t_1', 'subagent', { agent: 'researcher', description: 'Read', prompt: 'read' })] }),
    chat(2, 'researcher', [user('read')]),
    chat(3, 'lead', [user('go'), toolResult('call_t_1', 'The subagent is working in the background'), user(report('completed'))]),
  ]);
  assert.equal(record.handoffCount, 1);
  assert.equal(record.toolCalls[0]?.resultObserved, true);
  assert.equal(record.outcome, 'pass');
});

test('a subagent call with child requests but no report block counts zero', () => {
  const record = build([
    chat(1, 'lead', [user('go')], { calls: [call('call_t_1', 'subagent', { agent: 'researcher' })] }),
    chat(2, 'researcher', [user('read')]),
    chat(3, 'lead', [user('go'), toolResult('call_t_1', 'The subagent is working in the background')]),
  ]);
  assert.equal(record.handoffCount, 0);
  assert.equal(record.toolCalls[0]?.resultObserved, true);
});

test('a report block whose state is not completed counts zero', () => {
  const record = build([
    chat(1, 'lead', [user('go')], { calls: [call('call_t_1', 'subagent', { agent: 'researcher' })] }),
    chat(2, 'researcher', [user('read')]),
    chat(3, 'lead', [user('go'), user(report('error'))]),
  ]);
  assert.equal(record.handoffCount, 0);
});

test('a handoff with no child request is not counted, even with a completed report', () => {
  const record = build([
    chat(1, 'lead', [user('go')], { calls: [call('call_t_1', 'subagent', { agent: 'researcher' })] }),
    chat(2, 'lead', [user('go'), user(report('completed'))]),
  ]);
  assert.equal(record.handoffCount, 0);
});

test('the report block is matched to the call in order, so two handoffs with two reports count twice', () => {
  const record = build([
    chat(1, 'lead', [user('go')], { calls: [call('call_t_1', 'subagent', { agent: 'researcher' })] }),
    chat(2, 'researcher', [user('one')]),
    chat(3, 'lead', [user('go'), user(report('completed', 'first'))], { calls: [call('call_t_2', 'subagent', { agent: 'operator' })] }),
    chat(4, 'operator', [user('two')]),
    chat(5, 'lead', [user('go'), user(report('completed', 'first')), user(report('completed', 'second'))]),
  ]);
  assert.equal(record.handoffCount, 2);
});

test('a title request from the child role does not count as the child having run', () => {
  const record = build([
    chat(1, 'lead', [user('go')], { calls: [call('call_t_1', 'subagent', { agent: 'researcher' })] }),
    titleRequest(2, 'researcher'),
    chat(3, 'lead', [user('go'), user(report('completed'))]),
  ]);
  assert.equal(record.handoffCount, 0);
});

test('the handoff target is read from the first candidate key that holds a string', () => {
  const record = build([
    chat(1, 'lead', [user('go')], { calls: [call('call_t_1', 'subagent', { subagent_type: 3, subagent: 'researcher' })] }),
    chat(2, 'researcher', [user('read')]),
    chat(3, 'lead', [user('go'), user(report('completed'))]),
  ]);
  assert.equal(record.handoffCount, 1);
});

test('auxiliary requests are excluded from requests, role transitions, sessions, and handoffs', () => {
  const record = build([
    titleRequest(1, 'lead', { session: 'ses_title' }),
    chat(2, 'lead', [user('go')], { session: 'ses_main', calls: [call('call_t_1', 'subagent', { agent: 'researcher' })] }),
    titleRequest(3, 'researcher', { session: 'ses_other' }),
    chat(4, 'researcher', [user('read')], { session: 'ses_main' }),
    chat(5, 'lead', [user('go'), user(report('completed'))], { session: 'ses_main' }),
  ]);
  assert.deepEqual(record.requests, [
    { seq: 2, role: 'lead', session: 'S1' },
    { seq: 4, role: 'researcher', session: 'S1' },
    { seq: 5, role: 'lead', session: 'S1' },
  ]);
  assert.deepEqual(record.roleTransitions, [
    { seq: 4, from: 'lead', to: 'researcher' },
    { seq: 5, from: 'researcher', to: 'lead' },
  ]);
  assert.equal(record.handoffCount, 1);
  assert.deepEqual(record.toolCalls.map(toolCall => toolCall.seq), [2]);
});

test('a title request does not label a session, so later sessions number from S1', () => {
  const record = build([
    titleRequest(1, 'lead', { session: 'ses_title_only' }),
    chat(2, 'lead', [user('go')], { session: 'ses_real' }),
  ]);
  assert.deepEqual(record.requests.map(request => request.session), ['S1']);
});

test('a skill is loaded only when the sentinel appears in its tool result; a requested skill is not', () => {
  const record = build([
    chat(1, 'lead', [user('go')], {
      calls: [
        call('call_t_1', 'skill', { id: 'documentation-impact' }),
        call('call_t_2', 'skill', { id: 'other' }),
        call('call_t_3', 'skill', { id: 'requested-only' }),
      ],
    }),
    chat(2, 'lead', [user('go'), toolResult('call_t_1', 'SKILL-SENTINEL-DOC body'), toolResult('call_t_2', 'unrelated text')]),
  ], { skillSentinels: { 'documentation-impact': 'SKILL-SENTINEL-DOC', other: 'SENTINEL-OTHER', 'requested-only': 'SENTINEL-REQUESTED' } });
  assert.deepEqual(record.skillInvocations, [
    { seq: 1, role: 'lead', skillId: 'documentation-impact', loaded: true },
    { seq: 1, role: 'lead', skillId: 'other', loaded: false },
    { seq: 1, role: 'lead', skillId: 'requested-only', loaded: false },
  ]);
});

test('sessions are normalised to S1..Sn in order of first appearance, and absent sessions stay null', () => {
  const record = build([
    chat(1, 'lead', [user('a')], { session: 'ses_b' }),
    chat(2, 'lead', [user('b')]),
    chat(3, 'researcher', [user('c')], { session: 'ses_a' }),
    chat(4, 'lead', [user('d')], { session: 'ses_b' }),
  ]);
  assert.deepEqual(record.requests.map(request => request.session), ['S1', null, 'S2', 'S1']);
});

test('the outcome is fail on a violation and on a leftover unconsumed step, and pass otherwise', () => {
  assert.equal(build([chat(1, 'lead', [user('a')])]).outcome, 'pass');
  const withViolation = build([chat(1, 'lead', [user('a')])], {
    violations: [{ step: 0, role: 'lead', expected: 'tool results containing "X"', received: 'no tool results' }],
  });
  assert.equal(withViolation.outcome, 'fail');
  assert.equal(withViolation.violations[0]?.step, 0);
  const withLeftover = build([chat(1, 'lead', [user('a')])], {
    leftover: [{ role: 'researcher', step: 0, expected: 'final text "later"' }],
  });
  assert.equal(withLeftover.outcome, 'fail');
  assert.equal(withLeftover.violations.length, 1);
  assert.match(withLeftover.violations[0]?.expected ?? '', /role researcher/);
});

test('the record has exactly the version 1 top-level keys', () => {
  const record = build([chat(1, 'lead', [user('a')])]);
  assert.deepEqual(Object.keys(record).sort(), [
    'credentialHeaders', 'handoffCount', 'journey', 'kind', 'network', 'opencodeVersion', 'outcome', 'requests',
    'roleTransitions', 'skillInvocations', 'toolCalls', 'version', 'violations',
  ]);
  assert.equal(record.kind, 'harness.opencode-journey-record');
  assert.equal(record.version, 1);
  assert.deepEqual(record.network, network);
});

test('serialisation is byte-identical for equal inputs and ends with a newline', () => {
  const requests = [
    chat(1, 'lead', [user('go')], { session: 'ses_1', calls: [call('call_t_1', 'subagent', { agent: 'researcher' })] }),
    chat(2, 'researcher', [user('read')], { session: 'ses_1' }),
    chat(3, 'lead', [user('go'), toolResult('call_t_1', 'done'), user(report('completed'))], { session: 'ses_1' }),
  ];
  const first = serializeJourneyRecord(build(requests));
  const second = serializeJourneyRecord(build(requests));
  assert.equal(first, second);
  assert.ok(first.endsWith('\n'));
  assert.equal(first.includes('127.0.0.1'), false);
  assert.deepEqual(JSON.parse(first).handoffCount, 1);
});

test('violation text is normalised against the sandbox root, so two runs of one failure serialise identically', () => {
  const violation = (root: string): Violation => ({ step: 0, role: 'lead', expected: 'a file', received: `read ${root}\\project\\README.md ses_run${root.length}` });
  const rootA = 'C:\\Temp\\harness-e2e-a-1';
  const rootB = 'C:\\Temp\\harness-e2e-b-2';
  const make = (root: string) => serializeJourneyRecord(buildJourneyRecord({
    journey: 'unit-journey',
    opencodeVersion: '2.3.0',
    requests: [chat(1, 'lead', [user('a')], { session: 'ses_stable' })],
    violations: [{ ...violation(root), received: `read ${root}\\project\\README.md ses_stable` }],
    leftoverSteps: [],
    network,
    sandboxRoot: root,
  }));
  assert.equal(make(rootA), make(rootB));
  assert.match(make(rootA), /<sandbox>\/project\/README\.md/);
  assert.equal(make(rootA).includes('harness-e2e'), false);
});

test('the normaliser replaces raw, forward-slash, and JSON-escaped sandbox roots and numbers identifiers by first appearance', () => {
  const normalise = journeyNormaliser('C:\\Temp\\harness-e2e-x-1');
  assert.equal(normalise('at C:\\Temp\\harness-e2e-x-1\\project\\README.md'), 'at <sandbox>/project/README.md');
  assert.equal(normalise('at C:/Temp/harness-e2e-x-1/project/notes.md'), 'at <sandbox>/project/notes.md');
  assert.equal(normalise('{"path":"C:\\\\Temp\\\\harness-e2e-x-1\\\\project"}'), '{"path":"<sandbox>/project"}');
  assert.equal(normalise('ses_zzz ses_aaa ses_zzz'), 'ses_1 ses_2 ses_1');
  assert.equal(normalise('prt_9 msg_3 prt_9'), 'prt_1 msg_1 prt_1');
});

test('the normaliser gives the same output for the same text within one record, and works without a root', () => {
  const normalise = journeyNormaliser(undefined);
  assert.equal(normalise('C:\\Temp\\other ses_q'), 'C:\\Temp\\other ses_1');
  assert.equal(normalise('ses_q'), 'ses_1');
  const twice = journeyNormaliser('/tmp/harness-e2e-y-2');
  assert.equal(twice('/tmp/harness-e2e-y-2/project'), '<sandbox>/project');
});

test('formatJourneyFailure names each violation, the scrubbed stderr tail, and the record', () => {
  const record = build([chat(1, 'lead', [user('a')])], {
    violations: [{ step: 2, role: 'lead', expected: 'tool "read" offered', received: 'tools offered ["bash"]' }],
  });
  const run: JourneyRun = {
    record,
    serialized: serializeJourneyRecord(record),
    run: {
      status: 'completed',
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'boot at /work/harness-e2e-z-3/project\n'.repeat(45),
      durationMs: 1,
      argv: [],
    },
    proxyAttempts: [],
    sandboxRoot: '/work/harness-e2e-z-3',
  };
  const text = formatJourneyFailure(run);
  assert.match(text, /step 2: expected role lead: tool "read" offered; received tools offered \["bash"\]/);
  assert.match(text, /stderr \(last 40 lines, scrubbed\)/);
  assert.equal(text.includes('/work/harness-e2e-z-3'), false);
  assert.match(text, /"kind": "harness.opencode-journey-record"/);
});

test('formatted violation messages contain both the expected and the received text', () => {
  const text = formatViolations([
    { step: 2, role: 'lead', expected: 'tool "read" offered', received: 'tools offered ["bash"]' },
    { step: null, role: null, expected: 'a request attributable to a configured role', received: 'model "mystery"' },
  ]);
  assert.match(text, /tool "read" offered/);
  assert.match(text, /tools offered \["bash"\]/);
  assert.match(text, /attributable to a configured role/);
  assert.match(text, /model "mystery"/);
});

test('a journey definition needs a lower-case hyphenated name and keeps its steps', () => {
  const journey = defineJourney({ name: 'subagent-handoff', steps: { lead: [finalText('done')] } });
  assert.equal(journey.name, 'subagent-handoff');
  assert.deepEqual(journey.steps.lead, [{ reply: 'done' }]);
  assert.throws(() => defineJourney({ name: 'Bad Name', steps: {} }), /lower-case words/);
});

test('tolerated startup attempts alone are not a network violation, and are recorded as tolerated destinations', () => {
  assert.equal(proxyViolation([TOLERATED, TOLERATED]), undefined);
  assert.equal(proxyViolation([]), undefined);
  assert.deepEqual(classifyProxyAttempts([TOLERATED, TOLERATED]), { tolerated: ['CONNECT models.opencode.ai:443'], unexpected: [] });
});

test('a mix of tolerated and unexpected attempts is a violation whose text names only the unexpected destinations', () => {
  const violation = proxyViolation([TOLERATED, { method: 'CONNECT', host: 'example.com:443' }, TOLERATED]);
  assert.ok(violation !== undefined);
  assert.equal(violation.step, null);
  assert.match(violation.received, /^connections attempted: CONNECT example\.com:443$/);
  assert.equal(violation.received.includes('models.opencode.ai'), false);
});

test('varying repeat counts of the tolerated destination serialise to identical records with sorted, de-duplicated lists', () => {
  const requests = [chat(1, 'lead', [user('go')])];
  const serialise = (repeats: number): string => {
    const attempts: ProxyAttempt[] = Array.from({ length: repeats }, () => ({ ...TOLERATED }));
    const destinations = classifyProxyAttempts(attempts);
    return serializeJourneyRecord(buildJourneyRecord({
      journey: 'unit-journey',
      opencodeVersion: '2.3.0',
      requests,
      violations: [],
      leftoverSteps: [],
      network: { enforcement: 'none', toleratedDestinations: destinations.tolerated, unexpectedDestinations: destinations.unexpected },
    }));
  };
  const once = serialise(1);
  assert.equal(serialise(3), once);
  assert.equal(serialise(7), once);
  assert.deepEqual(JSON.parse(once).network, { enforcement: 'none', toleratedDestinations: ['CONNECT models.opencode.ai:443'], unexpectedDestinations: [] });
  assert.equal(once.includes('proxyAttempts'), false);

  const unsorted = buildJourneyRecord({
    journey: 'unit-journey',
    opencodeVersion: '2.3.0',
    requests,
    violations: [],
    leftoverSteps: [],
    network: { enforcement: 'netns', toleratedDestinations: ['b.example:443', 'a.example:443', 'a.example:443'], unexpectedDestinations: [] },
  });
  assert.deepEqual(unsorted.network.toleratedDestinations, ['a.example:443', 'b.example:443']);
  assert.equal(unsorted.network.enforcement, 'netns');
});

test('a request carrying an Authorization header is a violation; the record names the header but never its value', () => {
  const authorised: RecordedRequest = { ...chat(1, 'lead', [user('a')]), headers: { authorization: '[redacted]' }, authorizationPresent: true };
  const record = build([authorised]);
  assert.deepEqual(record.credentialHeaders, ['authorization']);
  assert.equal(record.outcome, 'fail');
  assert.equal(record.violations.length, 1);
  assert.match(record.violations[0]?.received ?? '', /authorization/);
  assert.equal(serializeJourneyRecord(record).includes('secret-value'), false);
});

test('an auxiliary request with an Authorization header, and a credential-shaped header such as X-Api-Key, are violations too', () => {
  const title: RecordedRequest = { ...titleRequest(1, 'lead'), headers: { authorization: '[redacted]' }, authorizationPresent: true };
  const keyed: RecordedRequest = { ...chat(2, 'lead', [user('go')]), headers: { 'x-api-key': '[redacted]' } };
  const record = build([title, keyed]);
  assert.deepEqual(record.credentialHeaders, ['authorization', 'x-api-key']);
  assert.equal(record.outcome, 'fail');
});

test('a run with no credential-shaped header has no credential violation', () => {
  const record = build([chat(1, 'lead', [user('a')])]);
  assert.deepEqual(record.credentialHeaders, []);
  assert.equal(credentialViolation([]), undefined);
  assert.equal(record.outcome, 'pass');
});

test('retained record file names distinguish the journey and the repeat, and a repeat must be a positive integer', () => {
  assert.equal(recordFileName('lead-reads-repository', undefined), 'lead-reads-repository.json');
  assert.equal(recordFileName('violations-case-a', 1), 'violations-case-a.run1.json');
  assert.equal(recordFileName('violations-case-a', 2), 'violations-case-a.run2.json');
  assert.throws(() => recordFileName('violations-case-a', 0), /positive integer/);
  assert.throws(() => recordFileName('violations-case-a', 1.5), /positive integer/);
});

test('HARNESS_E2E_RECORD_DIR is off when unset, and an empty or relative value is rejected with a clear message', () => {
  assert.deepEqual(recordDirectoryOf(undefined), { status: 'off' });
  const absolute = join(tmpdir(), 'harness-e2e-records');
  assert.deepEqual(recordDirectoryOf(absolute), { status: 'on', directory: absolute });
  assert.equal(recordDirectoryOf('').status, 'error');
  const relative = recordDirectoryOf('records/out');
  assert.equal(relative.status, 'error');
  assert.match(relative.status === 'error' ? relative.reason : '', /must be an absolute path/);
  assert.equal(isAbsolute('records/out'), false);
});

/** Serialises a record whose only violation has the given received text. */
function serialiseReceived(received: string, options: { sandboxRoot?: string; homeDirectories?: readonly string[]; caseInsensitiveHomes?: boolean } = {}): string {
  return serializeJourneyRecord(buildJourneyRecord({
    journey: 'unit-journey',
    opencodeVersion: '2.3.0',
    requests: [chat(1, 'lead', [user('a')])],
    violations: [{ step: 0, role: 'lead', expected: 'a file', received }],
    leftoverSteps: [],
    network,
    ...options,
  }));
}

test('a home directory in violation text serialises as <home> in backslash, forward-slash, and JSON-escaped forms', () => {
  const received = ['C:\\Users\\Alice\\notes.md', 'C:/Users/Alice/notes.md', 'C:\\\\Users\\\\Alice\\\\notes.md'].join(' | ');
  const serialized = serialiseReceived(received, { homeDirectories: ['C:\\Users\\Alice'] });
  assert.equal(JSON.parse(serialized).violations[0].received, '<home>\\notes.md | <home>/notes.md | <home>\\\\notes.md');
  assert.equal(serialized.includes('Alice'), false);
});

test('a home directory matches regardless of letter case only when the match is case-insensitive', () => {
  const text = 'c:\\users\\ALICE\\notes.md';
  const home = ['C:\\Users\\Alice'];
  assert.equal(JSON.parse(serialiseReceived(text, { homeDirectories: home, caseInsensitiveHomes: true })).violations[0].received, '<home>\\notes.md');
  assert.equal(JSON.parse(serialiseReceived(text, { homeDirectories: home })).violations[0].received, text);
});

test('a record with no home path serialises exactly as it does without home directories', () => {
  const text = 'read README.md at C:\\Temp\\elsewhere and /tmp/other';
  const withHomes = serialiseReceived(text, { homeDirectories: ['C:\\Users\\Alice'], caseInsensitiveHomes: true });
  assert.equal(withHomes, serialiseReceived(text));
  assert.equal(JSON.parse(withHomes).violations[0].received, text);
});

test('the sandbox placeholder wins for a sandbox root that lies inside the home directory', () => {
  const sandboxRoot = 'C:\\Users\\Alice\\AppData\\Local\\Temp\\harness-e2e-a-1';
  const text = 'read C:\\Users\\Alice\\AppData\\Local\\Temp\\harness-e2e-a-1\\project\\README.md and C:\\Users\\Alice\\.config\\tool';
  const serialized = serialiseReceived(text, { sandboxRoot, homeDirectories: ['C:\\Users\\Alice'] });
  assert.equal(JSON.parse(serialized).violations[0].received, 'read <sandbox>/project/README.md and <home>\\.config\\tool');
  assert.equal(serialized.includes('AppData'), false);
});
