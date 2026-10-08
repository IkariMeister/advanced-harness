import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgedToolCall, probeCases, probePreflight, probeVerdict, stripOpenCodeEnvironment, type CanaryEvent, type ProbeCase } from '../spike/opencode/forged-tool-probe.ts';

// This is an opt-in real-runtime experiment, not part of the unit test suite.
const cli = process.argv[2];
if (!cli || !existsSync(cli)) throw new Error('Usage: node examples/forged-tool-runtime-probe.ts <opencode-cli-executable> [parent-directory]');
const parent = resolve(process.argv[3] ?? join(homedir(), 'Projects'));
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'harness-runtime-probe-'));
const project = join(root, 'project');
const runtime = join(root, 'runtime');
const adapter = join(project, '.opencode', 'plugins', 'advanced-harness');
mkdirSync(adapter, { recursive: true });
const source = fileURLToPath(new URL('../spike/opencode/', import.meta.url));
for (const name of ['server.ts', 'host-adapter.ts', 'host-adapter-policy.ts', 'host-ipc-client.ts', 'package.json']) {
  copyFileSync(join(source, name), join(adapter, name));
}
// Invoke npm's JS entrypoint, not npm.cmd (which execFile cannot spawn on Windows).
const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
if (!existsSync(npm)) throw new Error('npm JS entrypoint unavailable; run this driver through npm run runtime-probe');
execFileSync(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: adapter, stdio: 'inherit' });

const eventsFile = join(root, 'canary-events.jsonl');
// The adapter is registered first, then harmless executors and an observer.
// shell permission is deliberately allowed: its catalog removal must prevent
// dispatch even if the unfiltered registry contains a permitted implementation.
writeFileSync(join(adapter, 'server.ts'), `
import adapter from './host-adapter.ts';
import { Plugin } from '@opencode/plugin';
import { appendFileSync } from 'node:fs';
const record = value => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(value) + '\\n');
export default Plugin.define({
  id: 'advanced-harness.trusted-runtime-probe',
  async setup(ctx) {
    await adapter.setup(ctx);
    await ctx.tool.transform(editor => {
      for (const [name, event] of [['harness_status', 'status-executed'], ['shell', 'shell-executed']]) {
        editor.add({ name, description: 'Harmless trusted probe canary',
          input: { type: 'object', properties: { command: { type: 'string' } }, additionalProperties: false },
          options: { permission: name, codemode: false },
          async execute() { record({ event }); return { content: event }; },
        });
      }
    });
    record({ event: 'registry', tools: (await ctx.tool.list()).map(tool => tool.id) });
    await ctx.session.hook('context', event => record({ event: 'catalog', agent: event.agent, tools: Object.keys(event.tools) }));
  },
});
`);

let active: ProbeCase = 'status-control';
let injected = false;
let eventOffset = 0;
const requests: Array<{ probe: ProbeCase; path: string; body: Record<string, unknown> }> = [];
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4 * 1024 * 1024) throw new Error('Oversized provider request');
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    requests.push({ probe: active, path: request.url ?? '', body });
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    // Never inject adversarial calls when the filter/canaries did not load.
    const recorded = existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8').slice(eventOffset).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as CanaryEvent) : [];
    const lastCatalog = recorded.findLast(event => event.event === 'catalog');
    if (active !== 'status-control' && (!lastCatalog?.tools?.includes('harness_status') || lastCatalog.tools.includes('shell'))) {
      response.writeHead(409).end('Probe setup invalid: filtered catalog not observed');
      return;
    }
    const call = !injected ? forgedToolCall(active) : null;
    injected = true;
    const message = call ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_probe', type: 'function', function: call }] }
      : { role: 'assistant', content: 'PROBE_COMPLETE' };
    if (body.stream === true) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: call }] }
        : { role: 'assistant', content: 'PROBE_COMPLETE' };
      for (const [part, finish] of [[delta, null], [{}, call ? 'tool_calls' : 'stop']] as const) {
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model: 'scripted', choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion', created: 1, model: 'scripted', choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  } catch (error) { response.writeHead(400).end(String(error)); }
});
await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No loopback provider address');
const config = {
  $schema: 'https://opencode.ai/config.json',
  model: 'harness-probe/scripted', default_agent: 'lead', snapshots: false,
  permissions: [{ action: '*', resource: '*', effect: 'deny' }],
  agents: { lead: { mode: 'primary', model: 'harness-probe/scripted', steps: 3,
    system: 'Trusted scripted-provider runtime test. No external services or native commands.',
    permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'harness_status', resource: '*', effect: 'allow' }, { action: 'shell', resource: '*', effect: 'allow' }],
  } },
  providers: { 'harness-probe': { name: 'Loopback scripted test provider',
    package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-test-not-a-secret' },
    models: { scripted: { capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 32768, output: 1024 } } },
  } },
};
writeFileSync(join(project, '.opencode', 'opencode.jsonc'), JSON.stringify(config, null, 2));
const inherited = stripOpenCodeEnvironment(process.env);
const env = { ...inherited, PWD: project, INIT_CWD: project, HOME: join(runtime, 'home'), USERPROFILE: join(runtime, 'home'),
  XDG_CONFIG_HOME: join(runtime, 'config'), XDG_DATA_HOME: join(runtime, 'data'), XDG_CACHE_HOME: join(runtime, 'cache'), XDG_STATE_HOME: join(runtime, 'state'),
  OPENCODE_DB: join(runtime, 'probe.sqlite'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
};
for (const directory of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME]) mkdirSync(directory, { recursive: true });
const results: Array<Record<string, unknown>> = [];
console.log(`Trusted runtime probe: ${root}`);
try {
  for (const probe of probeCases) {
    active = probe;
    injected = false;
    const before = existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8').length : 0;
    eventOffset = before;
    const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
      const child = spawn(resolve(cli), ['run', '--standalone', '--agent', 'lead', '--model', 'harness-probe/scripted', '--format', 'json', '--title', probe, 'Execute the trusted scripted probe.'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timeout = setTimeout(() => child.kill(), 60_000);
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); resolveRun({ code, stdout, stderr }); });
    });
    const events = (existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8').slice(before) : '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { event: string; tools?: string[] });
    const toolErrors = run.stdout.split('\n').filter(Boolean).flatMap(line => {
      try { const event = JSON.parse(line); return typeof event.part?.state?.error === 'string' ? [event.part.state.error] : []; }
      catch { return []; }
    });
    const evidence = toolErrors.join('\n');
    const verdict = probeVerdict(probe, events.map(event => event.event), evidence);
    results.push({ probe, verdict, injected, events, ...run });
    console.log(`${probe}: ${verdict}`);
    if (events.some(event => event.event === 'shell-executed')) break;
    if (probe === 'status-control' && !probePreflight(events)) {
      console.log('Preflight failed: no adversarial calls will be injected.');
      process.exitCode = 2;
      break;
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  writeFileSync(join(root, 'provider-exchanges.json'), JSON.stringify(requests, null, 2));
  writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ cli: resolve(cli), version: execFileSync(resolve(cli), ['--version'], { encoding: 'utf8', env }).trim(), route: 'custom OpenAI-compatible Chat Completions over loopback', wrapperControlPassed: results.some(result => result.probe === 'wrapper-status-control' && result.verdict === 'wrapper-control-passed') }, null, 2));
}
if (results.some(result => String(result.verdict).startsWith('FAILED'))) process.exitCode = 1;
console.log('Evidence retained. This custom Chat Completions route is not proof about the ChatGPT/OpenAI wrapper route.');
