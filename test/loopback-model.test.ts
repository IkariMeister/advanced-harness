import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import test from 'node:test';
import { callTool, finalText } from '../e2e/support/journey.ts';
import { classifyRequest, formatViolations, startLoopbackModel, type LoopbackModel, type LoopbackModelOptions } from '../e2e/support/loopback-model.ts';

async function open(t: { after: (fn: () => Promise<void>) => void }, options: LoopbackModelOptions): Promise<LoopbackModel> {
  const model = await startLoopbackModel(options);
  t.after(() => model.close());
  return model;
}

const chat = (baseURL: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${baseURL}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const user = (content: string) => ({ role: 'user', content });

/** An agent turn offers tools; without this array a request is auxiliary. */
const TOOLS = [{ type: 'function', function: { name: 'read' } }];

/** Opening system prompt of OpenCode's title-generation request (observed on 2.3.0). */
const TITLE_SYSTEM = 'You name conversations so the user can find them later in a list of past sessions.';

function parseSse(text: string): { events: string[]; chunks: any[] } {
  const events = text.split('\n\n').filter(event => event !== '');
  const chunks = events
    .filter(event => event !== 'data: [DONE]')
    .map(event => {
      assert.ok(event.startsWith('data: '), `unexpected SSE line: ${event}`);
      return JSON.parse(event.slice('data: '.length));
    });
  return { events, chunks };
}

function reassembleToolCalls(chunks: any[]): { id: string; name: string; arguments: string }[] {
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for (const chunk of chunks) {
    for (const delta of chunk.choices[0].delta.tool_calls ?? []) {
      const call = calls.get(delta.index) ?? { id: '', name: '', arguments: '' };
      calls.set(delta.index, {
        id: delta.id ?? call.id,
        name: delta.function?.name ?? call.name,
        arguments: call.arguments + (delta.function?.arguments ?? ''),
      });
    }
  }
  return [...calls.values()];
}

test('the fixture listens on 127.0.0.1 with an ephemeral port', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead' } });
  assert.match(model.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.ok(model.port > 0);
  assert.equal(model.baseURL, `http://127.0.0.1:${model.port}/v1`);
});

test('a scripted text reply comes back as a non-streaming chat completion', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead' }, script: { lead: [{ reply: 'hello from lead' }] } });
  const response = await chat(model.baseURL, { model: 'lead', messages: [user('hi')], tools: TOOLS });
  assert.equal(response.status, 200);
  const payload: any = await response.json();
  assert.equal(payload.object, 'chat.completion');
  assert.equal(payload.choices[0].message.role, 'assistant');
  assert.equal(payload.choices[0].message.content, 'hello from lead');
  assert.equal(payload.choices[0].finish_reason, 'stop');
  assert.deepEqual(payload.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.deepEqual(model.violations, []);
});

test('a scripted tool call comes back non-streaming with a deterministic id and JSON arguments', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead' } });
  model.enqueue('lead', [callTool('read', { filePath: 'README.md' })]);
  const payload: any = await (await chat(model.baseURL, { model: 'lead', messages: [user('go')], tools: TOOLS })).json();
  const message = payload.choices[0].message;
  assert.equal(payload.choices[0].finish_reason, 'tool_calls');
  assert.equal(message.content, null);
  assert.equal(message.tool_calls[0].id, 'call_unit_1');
  assert.equal(message.tool_calls[0].type, 'function');
  assert.equal(message.tool_calls[0].function.name, 'read');
  assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { filePath: 'README.md' });
});

test('streamed replies are server-sent events with a role delta, content or tool calls, a stop chunk, and [DONE]', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead' } });
  model.enqueue('lead', [finalText('streamed text'), callTool('read', { filePath: 'README.md' })]);

  const textResponse = await chat(model.baseURL, { model: 'lead', stream: true, messages: [user('one')], tools: TOOLS });
  assert.match(textResponse.headers.get('content-type') ?? '', /^text\/event-stream/);
  const textSse = parseSse(await textResponse.text());
  assert.equal(textSse.events.at(-1), 'data: [DONE]');
  assert.equal(textSse.chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(textSse.chunks.map(chunk => chunk.choices[0].delta.content ?? '').join(''), 'streamed text');
  assert.equal(textSse.chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.equal(textSse.chunks[0].object, 'chat.completion.chunk');

  const toolResponse = await chat(model.baseURL, { model: 'lead', stream: true, messages: [user('two')], tools: TOOLS });
  const toolSse = parseSse(await toolResponse.text());
  assert.equal(toolSse.events.at(-1), 'data: [DONE]');
  const calls = reassembleToolCalls(toolSse.chunks);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.id, 'call_unit_1');
  assert.equal(calls[0]?.name, 'read');
  assert.deepEqual(JSON.parse(calls[0]?.arguments ?? '{}'), { filePath: 'README.md' });
  assert.equal(toolSse.chunks.at(-1).choices[0].finish_reason, 'tool_calls');
});

test('GET /v1/models lists the configured model ids', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead', researcher: 'researcher' } });
  const payload: any = await (await fetch(`${model.baseURL}/models`)).json();
  assert.equal(payload.object, 'list');
  assert.deepEqual(payload.data.map((entry: any) => entry.id), ['lead', 'researcher']);
  assert.deepEqual(model.violations, []);
});

test('an unknown path is a violation answered with 404', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead' } });
  const response = await fetch(`${model.baseURL}/nope`);
  assert.equal(response.status, 404);
  assert.equal(model.violations.length, 1);
  assert.equal(model.violations[0]?.received, 'GET /v1/nope');
});

test('malformed JSON is a violation answered with 400', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead' } });
  const response = await fetch(`${model.baseURL}/chat/completions`, { method: 'POST', body: '{"model":' });
  assert.equal(response.status, 400);
  assert.equal(model.violations.length, 1);
  assert.match(model.violations[0]?.received ?? '', /malformed JSON/);
});

test('an unscripted request is an unscripted-request violation with a terminal reply', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead' } });
  const payload: any = await (await chat(model.baseURL, { model: 'lead', messages: [user('anything')], tools: TOOLS })).json();
  assert.equal(payload.choices[0].finish_reason, 'stop');
  assert.equal(typeof payload.choices[0].message.content, 'string');
  assert.equal(model.violations.length, 1);
  assert.equal(model.violations[0]?.role, 'lead');
  assert.match(model.violations[0]?.received ?? '', /unscripted request/);
});

test('a mismatched expectation is a violation that names what was expected and received', async t => {
  const model = await open(t, {
    journey: 'unit',
    roleByModel: { lead: 'lead' },
    script: { lead: [{ reply: 'x', expect: { toolResultsInclude: ['DONE-MARK'] } }] },
  });
  await chat(model.baseURL, { model: 'lead', messages: [user('no tool results here')], tools: TOOLS });
  assert.equal(model.violations.length, 1);
  const violation = model.violations[0]!;
  assert.equal(violation.step, 0);
  assert.equal(violation.role, 'lead');
  assert.match(violation.expected, /DONE-MARK/);
  assert.match(violation.received, /no tool results/);
  const formatted = formatViolations(model.violations);
  assert.match(formatted, /DONE-MARK/);
  assert.match(formatted, /no tool results/);
});

test('a satisfied expectation checks tool results, offered tools, and the latest user message', async t => {
  const model = await open(t, {
    journey: 'unit',
    roleByModel: { lead: 'lead' },
    script: { lead: [{ reply: 'ok', expect: { toolResultsInclude: ['DONE-MARK'], toolsOffered: ['read'], latestUserIncludes: ['second'] } }] },
  });
  await chat(model.baseURL, {
    model: 'lead',
    messages: [user('first'), { role: 'assistant', content: null }, user('second'), { role: 'tool', tool_call_id: 'call_x', content: 'result DONE-MARK' }],
    tools: TOOLS,
  });
  assert.deepEqual(model.violations, []);
});

test('a latest-user expectation names the substring and the latest user message when it does not match', async t => {
  const model = await open(t, {
    journey: 'unit',
    roleByModel: { lead: 'lead' },
    script: { lead: [{ reply: 'x', expect: { latestUserIncludes: ['state="completed"'] } }] },
  });
  await chat(model.baseURL, { model: 'lead', messages: [user('first'), user('<subagent state="error">x</subagent>')], tools: TOOLS });
  assert.equal(model.violations.length, 1);
  const violation = model.violations[0]!;
  assert.match(violation.expected, /latest user message containing "state=\\"completed\\""/);
  assert.match(violation.received, /latest user message .*state=\\"error\\"/);
});

test('leftover steps are reported and do not change the queues they were left in', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { researcher: 'researcher' } });
  model.enqueue('researcher', [finalText('first'), finalText('second')]);
  await chat(model.baseURL, { model: 'researcher', messages: [user('go')], tools: TOOLS });
  const leftover = model.leftoverSteps();
  assert.equal(leftover.length, 1);
  assert.equal(leftover[0]?.role, 'researcher');
  assert.equal(leftover[0]?.step, 1);
  assert.equal(model.leftoverSteps().length, 1);
  assert.equal(model.discardSteps().length, 1);
  assert.equal(model.leftoverSteps().length, 0);
});

test('requests are matched to their own role queue when roles interleave', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead', researcher: 'researcher' } });
  model.enqueue('lead', [finalText('L1'), finalText('L2')]);
  model.enqueue('researcher', [finalText('R1')]);
  const first = await (await chat(model.baseURL, { model: 'lead', messages: [user('a')], tools: TOOLS })).json() as any;
  const second = await (await chat(model.baseURL, { model: 'harness-loopback/researcher', messages: [user('b')], tools: TOOLS })).json() as any;
  const third = await (await chat(model.baseURL, { model: 'lead', messages: [user('c')], tools: TOOLS })).json() as any;
  assert.equal(first.choices[0].message.content, 'L1');
  assert.equal(second.choices[0].message.content, 'R1');
  assert.equal(third.choices[0].message.content, 'L2');
  assert.deepEqual(model.requests.map(request => request.role), ['lead', 'researcher', 'lead']);
  assert.deepEqual(model.violations, []);
});

test('a system sentinel attributes a request whose model id is unknown', async t => {
  const model = await open(t, {
    journey: 'unit',
    roleByModel: { lead: 'lead' },
    roleSentinels: { researcher: 'RESEARCHER-SENTINEL' },
    script: { researcher: [{ reply: 'sentinel reply' }] },
  });
  const payload: any = await (await chat(model.baseURL, {
    model: 'some-other-model',
    messages: [{ role: 'system', content: 'You are the researcher. RESEARCHER-SENTINEL' }, user('go')],
    tools: TOOLS,
  })).json();
  assert.equal(payload.choices[0].message.content, 'sentinel reply');
  assert.equal(model.requests[0]?.role, 'researcher');
  assert.deepEqual(model.violations, []);
});

test('a request that cannot be attributed is a violation', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead' } });
  await chat(model.baseURL, { model: 'mystery', messages: [user('go')], tools: TOOLS });
  assert.equal(model.violations.length, 1);
  assert.equal(model.violations[0]?.role, null);
  assert.equal(model.violations[0]?.step, null);
});

test('Authorization presence is recorded, its value is never stored, and the header is redacted', async t => {
  const model = await open(t, {
    journey: 'unit',
    roleByModel: { lead: 'lead' },
    expectedAuthorization: 'Bearer loopback-placeholder',
    mode: 'record',
  });
  await chat(model.baseURL, { model: 'lead', messages: [user('with')] }, { Authorization: 'Bearer loopback-placeholder' });
  await chat(model.baseURL, { model: 'lead', messages: [user('without')] });
  const [withHeader, withoutHeader] = model.requests;
  assert.equal(withHeader?.authorizationPresent, true);
  assert.equal(withHeader?.authorizationMatchesExpected, true);
  assert.equal(withHeader?.headers.authorization, '[redacted]');
  assert.equal(withoutHeader?.authorizationPresent, false);
  assert.equal(withoutHeader?.authorizationMatchesExpected, false);
  assert.equal(JSON.stringify(model.requests).includes('loopback-placeholder'), false);
});

test('record mode records every request without violations and answers with the default reply', async t => {
  const model = await open(t, { journey: 'unit', mode: 'record', defaultReply: 'recorded', roleByModel: { lead: 'lead' } });
  const first: any = await (await chat(model.baseURL, { model: 'lead', messages: [user('one')], tools: TOOLS })).json();
  const second: any = await (await chat(model.baseURL, { model: 'unmapped', messages: [user('two')], tools: TOOLS })).json();
  assert.equal(first.choices[0].message.content, 'recorded');
  assert.equal(second.choices[0].message.content, 'recorded');
  assert.equal(model.requests.length, 2);
  assert.equal(model.requests[0]?.seq, 1);
  assert.equal(model.requests[1]?.seq, 2);
  assert.deepEqual(model.violations, []);
});

test('a per-role default reply in record mode answers each role with its own text', async t => {
  const model = await open(t, { journey: 'unit', mode: 'record', defaultReply: { lead: 'DEFAULT-LEAD' }, roleByModel: { lead: 'lead', researcher: 'researcher' } });
  const lead: any = await (await chat(model.baseURL, { model: 'lead', messages: [user('a')], tools: TOOLS })).json();
  const researcher: any = await (await chat(model.baseURL, { model: 'researcher', messages: [user('b')], tools: TOOLS })).json();
  assert.equal(lead.choices[0].message.content, 'DEFAULT-LEAD');
  assert.match(researcher.choices[0].message.content, /Loopback record mode reply/);
});

test('classifyRequest treats a body with no tools, or an empty tools array, as auxiliary', () => {
  assert.deepEqual(classifyRequest({ model: 'lead', messages: [user('hi')] }), { auxiliary: true, auxiliaryKind: 'other' });
  assert.deepEqual(classifyRequest({ model: 'lead', messages: [user('hi')], tools: [] }), { auxiliary: true, auxiliaryKind: 'other' });
  assert.deepEqual(classifyRequest({ model: 'lead', messages: [user('hi')], tools: TOOLS }), { auxiliary: false, auxiliaryKind: null });
});

test('classifyRequest labels an auxiliary request as title only when its first system message is the title prompt', () => {
  const title = { model: 'lead', messages: [{ role: 'system', content: TITLE_SYSTEM }, user('Reply with only the title.')] };
  assert.deepEqual(classifyRequest(title), { auxiliary: true, auxiliaryKind: 'title' });
  const notFirst = { model: 'lead', messages: [{ role: 'system', content: 'You are the lead.' }, { role: 'system', content: TITLE_SYSTEM }, user('x')] };
  assert.deepEqual(classifyRequest(notFirst), { auxiliary: true, auxiliaryKind: 'other' });
});

test('a tool-less title request is answered with the auxiliary reply, consumes no step, and is recorded as auxiliary', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead' }, script: { lead: [finalText('first')] } });
  const title: any = await (await chat(model.baseURL, {
    model: 'lead',
    messages: [{ role: 'system', content: TITLE_SYSTEM }, user('Here is the first message of the conversation:\n\n<message>\ngo\n</message>\n\nReply with only the title.')],
  })).json();
  assert.equal(title.choices[0].message.content, 'Loopback title');
  assert.equal(title.choices[0].finish_reason, 'stop');
  assert.equal(model.leftoverSteps().length, 1);

  const main: any = await (await chat(model.baseURL, { model: 'lead', messages: [user('go')], tools: TOOLS })).json();
  assert.equal(main.choices[0].message.content, 'first');
  assert.equal(model.leftoverSteps().length, 0);
  assert.deepEqual(model.violations, []);
  assert.deepEqual(
    model.requests.map(request => ({ auxiliary: request.auxiliary, auxiliaryKind: request.auxiliaryKind, role: request.role })),
    [{ auxiliary: true, auxiliaryKind: 'title', role: 'lead' }, { auxiliary: false, auxiliaryKind: null, role: 'lead' }],
  );
});

test('a non-title auxiliary request gets the configured reply and kind other', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead' }, auxiliaryReply: 'custom aux' });
  const payload: any = await (await chat(model.baseURL, { model: 'lead', messages: [{ role: 'system', content: 'Summarise.' }, user('x')] })).json();
  assert.equal(payload.choices[0].message.content, 'custom aux');
  assert.equal(model.requests[0]?.auxiliaryKind, 'other');
  assert.deepEqual(model.violations, []);
});

test('an auxiliary request is never a violation, even with no queued steps or an unattributable model', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead' } });
  const titled: any = await (await chat(model.baseURL, { model: 'lead', messages: [{ role: 'system', content: TITLE_SYSTEM }, user('t')] })).json();
  const unknown: any = await (await chat(model.baseURL, { model: 'mystery', messages: [user('t')] })).json();
  assert.equal(titled.choices[0].message.content, 'Loopback title');
  assert.equal(unknown.choices[0].message.content, 'Loopback title');
  assert.equal(model.requests[1]?.role, null);
  assert.equal(model.requests[1]?.auxiliary, true);
  assert.deepEqual(model.violations, []);
});

test('a streamed auxiliary request is answered as a stream with the auxiliary reply and consumes no step', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead' }, script: { lead: [finalText('scripted')] } });
  const response = await chat(model.baseURL, { model: 'lead', stream: true, messages: [{ role: 'system', content: TITLE_SYSTEM }, user('t')] });
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
  const sse = parseSse(await response.text());
  assert.equal(sse.events.at(-1), 'data: [DONE]');
  assert.equal(sse.chunks.map(chunk => chunk.choices[0].delta.content ?? '').join(''), 'Loopback title');
  assert.equal(sse.chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.equal(model.requests[0]?.stream, true);
  assert.equal(model.requests[0]?.auxiliaryKind, 'title');
  assert.equal(model.leftoverSteps().length, 1);
  assert.deepEqual(model.violations, []);
});

test('in record mode an auxiliary request consumes no step and the next agent turn gets the first step', async t => {
  const model = await open(t, { journey: 'unit', mode: 'record', roleByModel: { lead: 'lead' }, script: { lead: [finalText('scripted')] } });
  const title: any = await (await chat(model.baseURL, { model: 'lead', messages: [{ role: 'system', content: TITLE_SYSTEM }, user('t')] })).json();
  const main: any = await (await chat(model.baseURL, { model: 'lead', messages: [user('go')], tools: TOOLS })).json();
  assert.equal(title.choices[0].message.content, 'Loopback title');
  assert.equal(main.choices[0].message.content, 'scripted');
  assert.deepEqual(model.violations, []);
});

test('a streamed reply ends with a usage chunk before [DONE] only when stream_options.include_usage is true', async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead' }, script: { lead: [finalText('one'), finalText('two')] } });
  const without = parseSse(await (await chat(model.baseURL, { model: 'lead', stream: true, messages: [user('a')], tools: TOOLS })).text());
  assert.equal(without.chunks.some(chunk => 'usage' in chunk), false);
  assert.equal(without.chunks.at(-1).choices[0].finish_reason, 'stop');

  const withUsage = parseSse(await (await chat(model.baseURL, {
    model: 'lead',
    stream: true,
    stream_options: { include_usage: true },
    messages: [user('b')],
    tools: TOOLS,
  })).text());
  assert.equal(withUsage.events.at(-1), 'data: [DONE]');
  assert.deepEqual(withUsage.chunks.at(-1).choices, []);
  assert.deepEqual(withUsage.chunks.at(-1).usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.equal(withUsage.chunks.at(-2).choices[0].finish_reason, 'stop');
  assert.deepEqual(model.violations, []);
});

test('the session header value is recorded raw, and a request without the header records null', async t => {
  const model = await open(t, { journey: 'unit', mode: 'record', roleByModel: { lead: 'lead' }, sessionHeader: 'x-opencode-session' });
  await chat(model.baseURL, { model: 'lead', messages: [user('a')], tools: TOOLS }, { 'x-opencode-session': 'ses_abc123' });
  await chat(model.baseURL, { model: 'lead', messages: [user('b')], tools: TOOLS });
  assert.deepEqual(model.requests.map(request => request.session), ['ses_abc123', null]);
  assert.equal(model.requests[0]?.headers['x-opencode-session'], 'ses_abc123');
});

test('close resolves while a client connection is still open', { timeout: 5000 }, async t => {
  const model = await open(t, { journey: 'unit', roleByModel: { lead: 'lead' } });
  const socket = connect(model.port, '127.0.0.1');
  socket.on('error', () => undefined);
  await once(socket, 'connect');
  // Headers promise a body that never completes, so the server keeps this connection open.
  socket.write('POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"model":');
  await model.close();
  socket.destroy();
});
