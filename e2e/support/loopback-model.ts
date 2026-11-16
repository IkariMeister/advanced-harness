// Loopback model fixture for the agent E2E suite (BH-034, issue #62).
//
// A local fake model provider bound to 127.0.0.1 that answers OpenAI-style
// chat-completion requests from scripted per-role steps and records every
// request. It is a test double: it is not a model and shows nothing about real
// model behaviour. Built on node:http only.
//
// OBSERVED on OpenCode 2.3.0 (second observation run): the request shape (POST
// /v1/chat/completions with `stream`, `stream_options.include_usage`, and a `tools`
// array on agent turns), the tool-call and tool-result echo, and that a streamed reply
// in this fixture's SSE form was accepted (run exit 0, echoed assistant tool call).
// That is one run, not a conformance test. NOT verified: the usage chunk's effect on
// OpenCode, any request shape beyond the ones listed, and behaviour on other versions.
// Auxiliary requests (no `tools`, for example title generation) are answered by the
// fixture and never consume a scripted step. All response construction lives in the
// "Wire format" section so it can be adjusted in one place.

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

export type JsonObject = Record<string, unknown>;

export interface ToolCallSpec { name: string; arguments: Record<string, unknown> }

/** Final assistant text, or one assistant turn that calls tools. */
export type ScriptReply = string | ToolCallSpec[];

export interface StepExpectation {
  /** Substrings that must appear in the tool-result messages trailing the request. */
  toolResultsInclude?: string[];
  /** Tool names that must appear in the request's `tools` array. */
  toolsOffered?: string[];
  /** Substrings that must appear in the latest user message. */
  latestUserIncludes?: string[];
}

export interface ScriptStep { reply: ScriptReply; expect?: StepExpectation }

/** A tool call the fixture replied with, carrying the fixture-assigned id (`call_<journey>_<n>`). */
export interface RepliedToolCall { id: string; name: string; arguments: Record<string, unknown> }

export interface RecordedRequest {
  seq: number;
  method: string;
  path: string;
  /** Attributed role id, or null when the request could not be attributed. */
  role: string | null;
  /** Raw session identifier from the configured header, or null. Normalised by journey.ts. */
  session: string | null;
  stream: boolean;
  /** Header map with credential-bearing headers redacted; `host` is dropped because it carries the port. */
  headers: Record<string, string>;
  /** Whether an Authorization header was present. Its value is never recorded. */
  authorizationPresent: boolean;
  /** Whether the Authorization value equalled `expectedAuthorization`. False when none was configured. */
  authorizationMatchesExpected: boolean;
  /** Parsed JSON object body, or null when the body was not a JSON object. */
  body: unknown;
  /** Tool calls this request was answered with, in order. */
  replyToolCalls: RepliedToolCall[];
  /** True for an auxiliary chat-completion request (see classifyRequest). Auxiliary requests never consume a step. */
  auxiliary: boolean;
  /** Kind of an auxiliary request: `title` for title generation, `other` for any other. Null when not auxiliary. */
  auxiliaryKind: AuxiliaryKind | null;
}

/** `title` when the first system message starts with the title-generation prompt, otherwise `other`. */
export type AuxiliaryKind = 'title' | 'other';

export interface RequestClassification { auxiliary: boolean; auxiliaryKind: AuxiliaryKind | null }

export interface Violation { step: number | null; role: string | null; expected: string; received: string }

export interface LeftoverStep { role: string; step: number; expected: string }

export interface LoopbackModelOptions {
  /** Used in response and tool-call ids (`call_<journey>_<n>`). Defaults to "loopback". */
  journey?: string;
  /** Model id (without the `harness-loopback/` prefix) to role id. Its keys are also the ids served by GET /v1/models. */
  roleByModel: Readonly<Record<string, string>>;
  /** Role id to a sentinel searched for in system messages when the model id does not identify a role. */
  roleSentinels?: Readonly<Record<string, string>>;
  /** 'script' (default) enforces queued steps. 'record' never raises violations and answers unscripted requests with `defaultReply`. */
  mode?: 'script' | 'record';
  /**
   * Text answered in record mode when a role has no queued step. A per-role record maps role id to its text;
   * roles without an entry get the built-in record reply.
   */
  defaultReply?: string | Readonly<Record<string, string>>;
  /** Text answered to every auxiliary request (no `tools`). Default "Loopback title". */
  auxiliaryReply?: string;
  /** Placeholder compared with the Authorization header. Only the boolean result is recorded. */
  expectedAuthorization?: string;
  /** Lower-case header name whose value becomes the request's session identifier. */
  sessionHeader?: string;
  /** Steps queued per role at start. */
  script?: Readonly<Record<string, readonly ScriptStep[]>>;
}

export interface LoopbackModel {
  readonly baseURL: string;
  readonly port: number;
  /** Every request in arrival order, including the GET /v1/models and rejected requests. */
  readonly requests: RecordedRequest[];
  readonly violations: Violation[];
  /** Appends steps to a role's queue. Steps are consumed in order per role. */
  enqueue(role: string, steps: readonly ScriptStep[]): void;
  /** Steps queued but never requested. Does not modify the queues. */
  leftoverSteps(): LeftoverStep[];
  /** Returns the unconsumed steps and empties every queue. */
  discardSteps(): LeftoverStep[];
  /** Stops listening and destroys open sockets. Idempotent. */
  close(): Promise<void>;
}

const MODEL_PREFIX = 'harness-loopback/';
const LOOPBACK_OWNER = 'harness-loopback';
/** Fixed timestamp (2026-01-01T00:00:00Z). Never the wall clock. */
const CREATED = 1767225600;
const TERMINAL_TEXT = 'Loopback fixture stopped after a violation.';
const DEFAULT_RECORD_REPLY = 'Loopback record mode reply.';
const DEFAULT_AUXILIARY_REPLY = 'Loopback title';
/** Opening words of OpenCode's title-generation system prompt (observed on 2.3.0). */
const TITLE_PROMPT_PREFIX = 'You name conversations';
const NOT_AUXILIARY: RequestClassification = { auxiliary: false, auxiliaryKind: null };
const REDACTED = '[redacted]';
const REDACTED_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'cookie']);
const CLIP_LENGTH = 300;

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * True for a header whose value is redacted in recordings (Authorization, X-Api-Key, Api-Key, Cookie). Only the
 * name is ever reported; the value is never kept. Case-insensitive.
 */
export function isCredentialHeaderName(name: string): boolean {
  return REDACTED_HEADERS.has(name.toLowerCase());
}

function clip(text: string): string {
  return text.length > CLIP_LENGTH ? `${text.slice(0, CLIP_LENGTH)}...` : text;
}

/** Messages of a chat-completion body; empty when the body has none. */
export function messagesOf(body: unknown): JsonObject[] {
  const list: unknown = isJsonObject(body) ? body.messages : undefined;
  return Array.isArray(list) ? list.filter(isJsonObject) : [];
}

/** Text of a message `content` value: a string, the text parts of a part array, or JSON for anything else. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  if (Array.isArray(content)) {
    return content.map((part: unknown) => (isJsonObject(part) && typeof part.text === 'string' ? part.text : JSON.stringify(part))).join('\n');
  }
  return JSON.stringify(content);
}

/**
 * Classifies a chat-completion body. A request is AUXILIARY when its body has no `tools` array or an empty one:
 * agent turns always offer tools, while OpenCode's title generation does not. `auxiliaryKind` is `title` when the
 * first system message starts with the title-generation prompt, otherwise `other`. Non-auxiliary requests are
 * `{ auxiliary: false, auxiliaryKind: null }`.
 */
export function classifyRequest(body: unknown): RequestClassification {
  const tools: unknown = isJsonObject(body) ? body.tools : undefined;
  if (Array.isArray(tools) && tools.length > 0) return { auxiliary: false, auxiliaryKind: null };
  const firstSystem = messagesOf(body).find(message => message.role === 'system');
  const isTitle = firstSystem !== undefined && contentText(firstSystem.content).startsWith(TITLE_PROMPT_PREFIX);
  return { auxiliary: true, auxiliaryKind: isTitle ? 'title' : 'other' };
}

/** Tool names from a chat-completion body's `tools` array (`function.name`, or `name` for a flat entry). */
export function toolNamesOf(body: unknown): string[] {
  const tools: unknown = isJsonObject(body) ? body.tools : undefined;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool: unknown) => {
    if (!isJsonObject(tool)) return [];
    const definition: unknown = isJsonObject(tool.function) ? tool.function : tool;
    if (!isJsonObject(definition)) return [];
    return typeof definition.name === 'string' ? [definition.name] : [];
  });
}

/** Content of the tool-result message answering `callId`, or undefined when the body carries none. */
export function toolResultText(body: unknown, callId: string): string | undefined {
  const match = messagesOf(body).find(message => message.role === 'tool' && message.tool_call_id === callId);
  return match === undefined ? undefined : contentText(match.content);
}

function trailingToolMessages(messages: JsonObject[]): JsonObject[] {
  const trailing: JsonObject[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'tool') break;
    trailing.unshift(message);
  }
  return trailing;
}

function latestUserText(messages: JsonObject[]): string {
  const latest = messages.filter(message => message.role === 'user').at(-1);
  return latest === undefined ? '' : contentText(latest.content);
}

/** Human-readable description of a scripted step, used in leftover-step reports. */
export function describeStep(step: ScriptStep): string {
  const parts: string[] = [];
  const expect = step.expect;
  const results = expect?.toolResultsInclude ?? [];
  const offered = expect?.toolsOffered ?? [];
  const user = expect?.latestUserIncludes ?? [];
  if (results.length > 0) parts.push(`tool results containing ${results.map(needle => JSON.stringify(needle)).join(', ')}`);
  if (offered.length > 0) parts.push(`tools offered ${offered.join(', ')}`);
  if (user.length > 0) parts.push(`latest user message containing ${user.map(needle => JSON.stringify(needle)).join(', ')}`);
  parts.push(typeof step.reply === 'string' ? `final text ${JSON.stringify(clip(step.reply))}` : `tool calls ${step.reply.map(call => call.name).join(', ')}`);
  return parts.join('; ');
}

/** Checks an expectation against a request. Returns one expected/received pair per failed check. */
function checkExpectation(expect: StepExpectation | undefined, body: JsonObject): { expected: string[]; received: string[] } {
  const expected: string[] = [];
  const received: string[] = [];
  if (expect === undefined) return { expected, received };
  const messages = messagesOf(body);
  const trailing = trailingToolMessages(messages).map(message => contentText(message.content)).join('\n');
  for (const needle of expect.toolResultsInclude ?? []) {
    if (trailing.includes(needle)) continue;
    expected.push(`tool results containing ${JSON.stringify(needle)}`);
    received.push(trailing === '' ? 'no tool results' : `tool results ${JSON.stringify(clip(trailing))}`);
  }
  const offered = toolNamesOf(body);
  for (const name of expect.toolsOffered ?? []) {
    if (offered.includes(name)) continue;
    expected.push(`tool ${JSON.stringify(name)} offered`);
    received.push(`tools offered ${JSON.stringify(offered)}`);
  }
  const latest = latestUserText(messages);
  for (const needle of expect.latestUserIncludes ?? []) {
    if (latest.includes(needle)) continue;
    expected.push(`latest user message containing ${JSON.stringify(needle)}`);
    received.push(`latest user message ${JSON.stringify(clip(latest))}`);
  }
  return { expected, received };
}

/** Human-readable violation lines with the expected and received text for each. */
export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map(violation => `- step ${violation.step ?? 'none'}${violation.role === null ? '' : ` (role ${violation.role})`}: expected ${violation.expected}; received ${violation.received}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Wire format (shapes observed on OpenCode 2.3.0, see the file header; adjust here only).
// ---------------------------------------------------------------------------

interface Completion { id: string; model: string; text: string | null; toolCalls: RepliedToolCall[]; finish: 'stop' | 'tool_calls' }

const usage = () => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

const wireToolCall = (call: RepliedToolCall): JsonObject => ({
  id: call.id,
  type: 'function',
  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
});

/** Non-streaming body: one `chat.completion` object. Tool-only replies carry `content: null`. */
export function wireCompletion(completion: Completion): JsonObject {
  const message: JsonObject = { role: 'assistant', content: completion.text };
  if (completion.toolCalls.length > 0) message.tool_calls = completion.toolCalls.map(wireToolCall);
  return {
    id: completion.id,
    object: 'chat.completion',
    created: CREATED,
    model: completion.model,
    choices: [{ index: 0, message, finish_reason: completion.finish }],
    usage: usage(),
  };
}

/**
 * Streaming body: `chat.completion.chunk` objects in order. The caller writes each as `data: <json>` and then `data: [DONE]`.
 * With `includeUsage` (the request's `stream_options.include_usage` is true) a final chunk with `choices: []` and a
 * zero `usage` object comes after the stop chunk, in the standard OpenAI form. Without it no chunk carries usage.
 */
export function wireChunks(completion: Completion, includeUsage = false): JsonObject[] {
  const envelope = { id: completion.id, object: 'chat.completion.chunk', created: CREATED, model: completion.model };
  const chunks: JsonObject[] = [{ ...envelope, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }];
  if (completion.text !== null && completion.text !== '') {
    chunks.push({ ...envelope, choices: [{ index: 0, delta: { content: completion.text }, finish_reason: null }] });
  }
  completion.toolCalls.forEach((call, index) => {
    chunks.push({ ...envelope, choices: [{ index: 0, delta: { tool_calls: [{ index, ...wireToolCall(call) }] }, finish_reason: null }] });
  });
  chunks.push({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: completion.finish }] });
  if (includeUsage) chunks.push({ ...envelope, choices: [], usage: usage() });
  return chunks;
}

const errorBody = (message: string): JsonObject => ({ error: { message, type: 'invalid_request_error' } });

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function recordedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === 'host') continue;
    result[name] = REDACTED_HEADERS.has(name) ? REDACTED : Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

function parseObject(raw: string): JsonObject | undefined {
  let value: unknown = undefined;
  try { value = JSON.parse(raw); } catch { return undefined; }
  return isJsonObject(value) ? value : undefined;
}

interface Queue { pending: ScriptStep[]; nextIndex: number }
type RequestMeta = Omit<RecordedRequest, 'seq' | 'role' | 'stream' | 'body' | 'replyToolCalls' | 'auxiliary' | 'auxiliaryKind'>;

/**
 * Starts the fixture on 127.0.0.1 with an ephemeral port. Resolves once listening.
 * Every request is recorded; violations are structured records, never thrown.
 */
export function startLoopbackModel(options: LoopbackModelOptions): Promise<LoopbackModel> {
  const journey = options.journey ?? 'loopback';
  const mode = options.mode ?? 'script';
  const defaultReply = options.defaultReply ?? DEFAULT_RECORD_REPLY;
  const auxiliaryReply = options.auxiliaryReply ?? DEFAULT_AUXILIARY_REPLY;
  const defaultFor = (role: string | null): string => {
    if (typeof defaultReply === 'string') return defaultReply;
    if (role === null || !Object.hasOwn(defaultReply, role)) return DEFAULT_RECORD_REPLY;
    return defaultReply[role] ?? DEFAULT_RECORD_REPLY;
  };
  const roleByModel = options.roleByModel;
  const roleSentinels = options.roleSentinels ?? {};
  const requests: RecordedRequest[] = [];
  const violations: Violation[] = [];
  const queues = new Map<string, Queue>();
  const sockets = new Set<Socket>();
  let toolCallCount = 0;

  const enqueue = (role: string, steps: readonly ScriptStep[]): void => {
    let queue = queues.get(role);
    if (queue === undefined) {
      queue = { pending: [], nextIndex: 0 };
      queues.set(role, queue);
    }
    queue.pending.push(...steps);
  };

  const leftoverSteps = (): LeftoverStep[] => [...queues].flatMap(([role, queue]) =>
    queue.pending.map((step, offset) => ({ role, step: queue.nextIndex + offset, expected: describeStep(step) })));

  const discardSteps = (): LeftoverStep[] => {
    const leftover = leftoverSteps();
    queues.clear();
    return leftover;
  };

  /** Takes the next queued step for a role, or undefined when the role has none. */
  const takeStep = (role: string): { step: ScriptStep; index: number } | undefined => {
    const queue = queues.get(role);
    const step = queue?.pending.shift();
    if (queue === undefined || step === undefined) return undefined;
    const index = queue.nextIndex;
    queue.nextIndex += 1;
    return { step, index };
  };

  const attribute = (model: string, body: JsonObject): string | null => {
    const id = model.startsWith(MODEL_PREFIX) ? model.slice(MODEL_PREFIX.length) : model;
    if (Object.hasOwn(roleByModel, id)) return roleByModel[id] ?? null;
    const system = messagesOf(body).filter(message => message.role === 'system').map(message => contentText(message.content)).join('\n');
    const matches = Object.entries(roleSentinels)
      .filter(([, sentinel]) => sentinel !== '' && system.includes(sentinel))
      .map(([role]) => role);
    return matches.length === 1 ? (matches[0] ?? null) : null;
  };

  const decide = (role: string | null, model: string, body: JsonObject): { reply: ScriptReply; violation: Violation | null } => {
    if (mode === 'record') {
      const taken = role === null ? undefined : takeStep(role);
      return { reply: taken?.step.reply ?? defaultFor(role), violation: null };
    }
    if (role === null) {
      return {
        reply: TERMINAL_TEXT,
        violation: { step: null, role: null, expected: 'a request attributable to a configured role (by model id, or by a system sentinel)', received: `model ${JSON.stringify(model)} with no matching system sentinel` },
      };
    }
    const taken = takeStep(role);
    if (taken === undefined) {
      return {
        reply: TERMINAL_TEXT,
        violation: {
          step: queues.get(role)?.nextIndex ?? 0,
          role,
          expected: `a scripted step for role ${JSON.stringify(role)}`,
          received: `unscripted request: no steps left for role ${JSON.stringify(role)}; latest user message ${JSON.stringify(clip(latestUserText(messagesOf(body))))}`,
        },
      };
    }
    const failures = checkExpectation(taken.step.expect, body);
    if (failures.expected.length > 0) {
      return { reply: TERMINAL_TEXT, violation: { step: taken.index, role, expected: failures.expected.join('; '), received: failures.received.join('; ') } };
    }
    return { reply: taken.step.reply, violation: null };
  };

  const record = (
    meta: RequestMeta,
    role: string | null,
    body: unknown,
    stream: boolean,
    replyToolCalls: RepliedToolCall[],
    classification: RequestClassification = NOT_AUXILIARY,
  ): void => {
    requests.push({ ...meta, ...classification, seq: requests.length + 1, role, stream, body, replyToolCalls });
  };

  const nextToolCallId = (): string => {
    toolCallCount += 1;
    return `call_${journey}_${toolCallCount}`;
  };

  const chatCompletion = (res: ServerResponse, rawBody: string, meta: RequestMeta): void => {
    const body = parseObject(rawBody);
    if (body === undefined) {
      violations.push({ step: null, role: null, expected: 'a JSON object request body', received: 'malformed JSON body' });
      record(meta, null, null, false, []);
      sendJson(res, 400, errorBody('malformed JSON request body'));
      return;
    }
    const model = typeof body.model === 'string' ? body.model : '';
    const role = attribute(model, body);
    const stream = body.stream === true;
    const streamOptions: unknown = body.stream_options;
    const includeUsage = stream && isJsonObject(streamOptions) && streamOptions.include_usage === true;
    const classification = classifyRequest(body);
    let reply: ScriptReply;
    if (classification.auxiliary) {
      // Auxiliary requests never consume a step and never raise a violation, whatever their role attribution.
      reply = auxiliaryReply;
    } else {
      const decision = decide(role, model, body);
      if (decision.violation !== null) violations.push(decision.violation);
      reply = decision.reply;
    }
    const toolCalls: RepliedToolCall[] = typeof reply === 'string'
      ? []
      : reply.map(call => ({ id: nextToolCallId(), name: call.name, arguments: call.arguments }));
    const seq = requests.length + 1;
    const completion: Completion = {
      id: `chatcmpl-${journey}-${seq}`,
      model,
      text: typeof reply === 'string' ? reply : null,
      toolCalls,
      finish: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
    record(meta, role, body, stream, toolCalls, classification);
    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const chunk of wireChunks(completion, includeUsage)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    sendJson(res, 200, wireCompletion(completion));
  };

  const sessionValue = (headers: IncomingHttpHeaders): string | null => {
    if (options.sessionHeader === undefined) return null;
    const value = headers[options.sessionHeader.toLowerCase()];
    return typeof value === 'string' ? value : null;
  };

  const route = (req: IncomingMessage, res: ServerResponse, rawBody: string): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? '';
    const meta: RequestMeta = {
      method,
      path: url.pathname,
      session: sessionValue(req.headers),
      headers: recordedHeaders(req.headers),
      authorizationPresent: req.headers.authorization !== undefined,
      authorizationMatchesExpected: options.expectedAuthorization !== undefined && req.headers.authorization === options.expectedAuthorization,
    };
    if (method === 'GET' && meta.path === '/v1/models') {
      record(meta, null, null, false, []);
      sendJson(res, 200, {
        object: 'list',
        data: Object.keys(roleByModel).map(id => ({ id, object: 'model', created: CREATED, owned_by: LOOPBACK_OWNER })),
      });
      return;
    }
    if (method === 'POST' && meta.path === '/v1/chat/completions') {
      chatCompletion(res, rawBody, meta);
      return;
    }
    violations.push({ step: null, role: null, expected: 'GET /v1/models or POST /v1/chat/completions', received: `${method} ${meta.path}` });
    record(meta, null, null, false, []);
    sendJson(res, 404, errorBody('not found'));
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('error', () => { res.destroy(); });
    req.on('end', () => {
      try {
        route(req, res, Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        violations.push({ step: null, role: null, expected: 'the fixture to answer every request', received: `internal fixture error: ${error instanceof Error ? error.message : String(error)}` });
        if (!res.headersSent) sendJson(res, 500, errorBody('internal fixture error'));
        else if (!res.writableEnded) res.end();
      }
    });
  };

  for (const [role, steps] of Object.entries(options.script ?? {})) enqueue(role, steps);

  return new Promise<LoopbackModel>((resolve, reject) => {
    const server = createServer(handle);
    let closing: Promise<void> | undefined;
    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.on('close', () => { sockets.delete(socket); });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
        server.close();
        reject(new Error('loopback fixture must bind 127.0.0.1 on a TCP port'));
        return;
      }
      const port = address.port;
      resolve({
        baseURL: `http://127.0.0.1:${port}/v1`,
        port,
        requests,
        violations,
        enqueue,
        leftoverSteps,
        discardSteps,
        close: () => {
          if (closing === undefined) {
            closing = new Promise<void>((done, fail) => {
              server.close(error => (error ? fail(error) : done()));
              server.closeAllConnections();
              for (const socket of sockets) socket.destroy();
            });
          }
          return closing;
        },
      });
    });
  });
}
