import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRoot } from './temp-directory.ts';
import { CodexDiscoveryError, chooseCodexCatalog, listCodexModels, parseCodexModelPage, withCodexAppServer, type CodexCatalogModel } from '../src/codex-model-catalog.ts';
import { installCodex } from '../src/codex-adapter.ts';
import { nativeRoles } from '../src/native-role-types.ts';

// Minimal stand-in for `codex app-server`: line-delimited JSON-RPC without the jsonrpc header.
const stubServer = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = process.env.STUB_MODE ?? 'ok';
const log = process.env.STUB_LOG;
const reply = message => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (log) appendFileSync(log, message.method + '\\n');
  if (mode === 'exit') process.exit(3);
  if (mode === 'silent') return;
  if (message.id === undefined) return;
  if (message.method === 'initialize') return reply({ id: message.id, result: { userAgent: 'stub' } });
  if (message.method !== 'model/list') return reply({ id: message.id, error: { code: -32601, message: 'unknown' } });
  if (mode === 'error') return reply({ id: message.id, error: { code: -32000, message: 'token=secret' } });
  process.stderr.write('token=secret\\n');
  if (message.params.cursor === 'p2') return reply({ id: message.id, result: { data: [{ id: 'm-small', model: 'small-model', supportedReasoningEfforts: ['low'] }] } });
  reply({ id: message.id, result: { nextCursor: 'p2', data: [
    { id: 'm-big', model: 'big-model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
    { id: 'm-hidden', model: 'internal-model', hidden: true },
  ] } });
});
`;

function stub(t: { after(fn: () => void): void }) {
  const root = makeTempRoot('codex-stub-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'app-server.mjs');
  writeFileSync(script, stubServer);
  return { root, script, log: join(root, 'methods.log') };
}

async function withStub<T>(t: { after(fn: () => void): void }, mode: string, use: Parameters<typeof withCodexAppServer<T>>[1], timeoutMs = 10000) {
  const { script, log } = stub(t);
  const previous = { mode: process.env.STUB_MODE, log: process.env.STUB_LOG };
  process.env.STUB_MODE = mode;
  process.env.STUB_LOG = log;
  try { return { result: await withCodexAppServer(process.execPath, use, timeoutMs, [script]), log }; }
  finally {
    if (previous.mode === undefined) delete process.env.STUB_MODE; else process.env.STUB_MODE = previous.mode;
    if (previous.log === undefined) delete process.env.STUB_LOG; else process.env.STUB_LOG = previous.log;
  }
}

test('app-server discovery pages through model/list, skips hidden models, and sends no other requests', async t => {
  const { result, log } = await withStub(t, 'ok', rpc => listCodexModels(rpc));
  assert.deepEqual(result, [
    { id: 'big-model', efforts: ['medium', 'high'] },
    { id: 'small-model', efforts: ['low'] },
  ]);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['initialize', 'initialized', 'model/list', 'model/list']);
});

test('app-server failures surface controlled messages without raw server output', async t => {
  for (const [mode, expected] of [['error', /rejected the request \(code -32000\)/], ['exit', /exited before answering/]] as const) {
    await assert.rejects(withStub(t, mode, rpc => listCodexModels(rpc)), (error: unknown) => error instanceof CodexDiscoveryError && expected.test(error.message) && !error.message.includes('secret'));
  }
  await assert.rejects(withStub(t, 'silent', rpc => listCodexModels(rpc), 300), /did not answer in time/);
  await assert.rejects(withCodexAppServer(join(stub(t).root, 'missing-codex'), rpc => listCodexModels(rpc), 5000), CodexDiscoveryError);
});

test('model/list parsing rejects unsupported shapes and bounds pagination', async () => {
  assert.throws(() => parseCodexModelPage({ items: [] }), CodexDiscoveryError);
  assert.throws(() => parseCodexModelPage({ data: [{ displayName: 'no id' }] }), CodexDiscoveryError);
  assert.deepEqual(parseCodexModelPage({ data: [{ id: 'only-id' }] }).models, [{ id: 'only-id', efforts: [] }]);
  await assert.rejects(listCodexModels(async () => ({ data: [], nextCursor: 'again' }), 3), /too many pages/);
});

test('catalog choice reports missing, declined, and failed discovery without selecting a model', async () => {
  const output: string[] = [];
  assert.equal(await chooseCodexCatalog(undefined, async () => { throw new Error('no prompt expected'); }, line => output.push(line)), undefined);
  assert.ok(output.some(line => /not available in this run/.test(line)));
  let called = false;
  assert.equal(await chooseCodexCatalog(async () => { called = true; return []; }, async () => 'no', line => output.push(line)), undefined);
  assert.equal(called, false);
  assert.ok(output.some(line => /discovery skipped/.test(line)));
  assert.equal(await chooseCodexCatalog(async () => { throw new Error('token=secret'); }, async () => '', line => output.push(line)), undefined);
  assert.ok(output.some(line => line === 'Live Codex model discovery unavailable: the Codex catalog could not be read.'));
  assert.ok(!output.join('\n').includes('secret'));
});

const catalog: CodexCatalogModel[] = [{ id: 'big-model', efforts: ['medium', 'high'] }, { id: 'small-model', efforts: ['low'] }];

function codexSandbox(t: { after(fn: () => void): void }) {
  const root = makeTempRoot('codex-catalog-install-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project); mkdirSync(home);
  return { project, home, role: (role: string) => join(project, '.codex', 'agents', `${role}.toml`) };
}

/** Answers by role: queues for model, effort and keep prompts; the MCP prompt gets Enter. */
function roleAsk(models: Record<string, string[]>, efforts: Record<string, string[]> = {}, keeps: Record<string, string[]> = {}, confirm = 'install') {
  const asked: string[] = [];
  const take = (queue: Record<string, string[]>, role: string, fallback: string) => queue[role]?.length ? queue[role]!.shift()! : fallback;
  const ask = async (question: string) => {
    asked.push(question);
    const role = question.split(':')[0]!;
    if (question.startsWith('Query the live Codex model catalog')) return '';
    if (question.includes('explicitly assigned Codex model ID')) return take(models, role, '1');
    if (question.includes('reasoning effort')) return take(efforts, role, 'medium');
    if (question.includes('type keep')) return take(keeps, role, '');
    if (question.includes('Type install')) return confirm;
    return '';
  };
  return { ask, asked };
}

const modelOf = (path: string) => /^model = "(.*)"$/m.exec(readFileSync(path, 'utf8'))?.[1];
const effortOf = (path: string) => /^model_reasoning_effort = "(.*)"$/m.exec(readFileSync(path, 'utf8'))?.[1];

test('Codex role prompts list the live catalog and save listed numbers without confirmation', async t => {
  const box = codexSandbox(t);
  const output: string[] = [];
  const { ask, asked } = roleAsk({ qa: ['2'] }, { qa: ['low'] });
  assert.equal(await installCodex({ scope: 'project', project: box.project, home: box.home, ask, output: line => output.push(line), error() {}, discoverModels: async () => catalog }), 0, output.join('\n'));
  assert.ok(output.includes('  1. big-model (efforts: medium, high)'));
  assert.ok(output.some(line => /not proof of account entitlement/.test(line)));
  assert.equal(asked.some(question => question.includes('type keep')), false);
  assert.equal(modelOf(box.role('lead')), 'big-model');
  assert.equal(modelOf(box.role('qa')), 'small-model');
  assert.equal(effortOf(box.role('qa')), 'low');
});

test('an off-catalog model or effort is saved only after keep; Enter chooses again within the attempt limit', async t => {
  const box = codexSandbox(t);
  const output: string[] = [];
  const { ask, asked } = roleAsk(
    { lead: ['ghost-model', 'ghost-model'], planner: ['ghost-model'] },
    { reviewer: ['low', 'high'], implementer: ['low'] },
    { lead: ['', 'keep'], implementer: ['keep'] },
  );
  assert.equal(await installCodex({ scope: 'project', project: box.project, home: box.home, ask, output: line => output.push(line), error() {}, discoverModels: async () => catalog }), 0, output.join('\n'));
  assert.equal(modelOf(box.role('lead')), 'ghost-model', 'kept after an explicit keep on the second attempt');
  assert.equal(asked.filter(question => question.startsWith('lead: explicitly assigned')).length, 2);
  assert.equal(modelOf(box.role('planner')), 'big-model', 'Enter on keep chose again; the next answer picked a listed model');
  assert.equal(effortOf(box.role('reviewer')), 'high', 'Enter on keep re-asked the effort');
  assert.equal(effortOf(box.role('implementer')), 'low');
  assert.ok(output.includes('ghost-model is absent from the live Codex catalog.'));
  assert.ok(output.includes('Reasoning effort low is not listed for big-model in the live Codex catalog (listed: medium, high).'));
});

test('declining keep three times stops before any Codex file, backup, or receipt', async t => {
  const box = codexSandbox(t);
  const { ask } = roleAsk({ operator: ['ghost-model', 'ghost-model', 'ghost-model'] });
  await assert.rejects(installCodex({ scope: 'project', project: box.project, home: box.home, ask, output() {}, error() {}, discoverModels: async () => catalog }), /operator remained invalid after 3 attempts; no changes made/);
  assert.equal(existsSync(join(box.project, '.codex')), false);
  assert.equal(existsSync(join(box.home, 'Projects')), false);
});

test('failed discovery falls back to typed IDs, and cancelling writes nothing', async t => {
  const box = codexSandbox(t);
  const output: string[] = [];
  const { ask } = roleAsk(Object.fromEntries(nativeRoles.map(role => [role, ['typed-model']])), {}, {}, 'cancel');
  assert.equal(await installCodex({ scope: 'project', project: box.project, home: box.home, ask, output: line => output.push(line), error() {}, discoverModels: async () => { throw new CodexDiscoveryError('Codex CLI could not be started. Check that codex is installed (or set CODEX_BIN).'); } }), 0);
  assert.ok(output.includes('Live Codex model discovery unavailable: Codex CLI could not be started. Check that codex is installed (or set CODEX_BIN).'));
  assert.ok(output.includes('Continuing with typed model IDs; they are not checked against a catalog.'));
  assert.equal(existsSync(join(box.project, '.codex')), false);
  assert.equal(existsSync(join(box.home, 'Projects')), false);
});
