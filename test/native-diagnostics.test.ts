import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessRuntime, cliQuery, decodeRows, expectedAgents, runtimeModelReference, verifyRuntime, type Snapshot } from '../src/native-diagnostics.ts';
import { nativeRoles } from '../src/native-installer.ts';

function fixture() {
  const expected: Record<string, Record<string, unknown>> = Object.fromEntries(nativeRoles.map(role => [role, { mode: role === 'lead' ? 'primary' : 'subagent', model: 'company/nested/model#low' }]));
  const snapshot: Snapshot = {
    agents: nativeRoles.map(role => ({ id: role, mode: role === 'lead' ? 'primary' : 'subagent', hidden: false, model: { providerID: 'company', id: 'nested/model', variant: 'low' } })),
    models: [{ providerID: 'company', id: 'nested/model', modelID: 'underlying-deployment', enabled: true, variants: [{ id: 'low' }] }],
    providers: [{ id: 'company', activation: 'auto' }],
  };
  return { expected, snapshot };
}

test('all eight visible roles and exact runtime model aliases/variants pass catalog verification', () => {
  const { snapshot, expected } = fixture();
  const report = assessRuntime(snapshot, expected);
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 8);
  assert.equal(report.checks[0]?.model, 'company/nested/model#low');
  assert.equal(runtimeModelReference({ providerID: 'p', id: 'm', variant: 'none' }), 'p/m#none');
  assert.equal(runtimeModelReference({ providerID: 'p', model: 'm' }), 'p/m');
});

test('missing installation, hidden/disabled roles and wrong modes are actionable failures', () => {
  const { snapshot, expected } = fixture();
  delete expected.lead;
  expected.operator = { ...expected.operator, disabled: true };
  snapshot.agents[1]!.hidden = true;
  snapshot.agents[2]!.mode = 'primary';
  snapshot.agents = snapshot.agents.filter(row => row.id !== 'qa');
  const report = assessRuntime(snapshot, expected);
  assert.equal(report.ok, false);
  assert.match(report.checks[0]!.issues.join(' '), /install target/);
  assert.match(report.checks[1]!.issues.join(' '), /disabled.*Hidden/);
  assert.match(report.checks[2]!.issues.join(' '), /mode/);
  assert.match(report.checks[7]!.issues.join(' '), /Not discovered/);
});

test('runtime model drift, inheritance, unsupported variants and absent models never substitute', () => {
  const { snapshot, expected } = fixture();
  expected.lead = { model: 'company/different#low' };
  delete snapshot.agents[1]!.model;
  snapshot.agents[2]!.model = { providerID: 'company', id: 'nested/model', variant: 'high' };
  snapshot.agents[3]!.model = { providerID: 'company', id: 'unknown' };
  const report = assessRuntime(snapshot, expected);
  assert.equal(report.ok, false);
  assert.match(report.checks[0]!.issues.join(' '), /differs/);
  assert.match(report.checks[1]!.issues.join(' '), /inheritance/);
  assert.match(report.checks[2]!.issues.join(' '), /Variant high/);
  assert.match(report.checks[3]!.issues.join(' '), /absent or disabled/);
  assert.equal(snapshot.agents[3]!.model && runtimeModelReference(snapshot.agents[3]!.model), 'company/unknown');
});

test('disabled or unconnected providers and disabled models fail verification', () => {
  for (const activation of ['disabled', 'missing']) {
    const { snapshot, expected } = fixture();
    snapshot.providers = activation === 'missing' ? [] : [{ id: 'company', activation }];
    snapshot.models[0]!.enabled = false;
    const report = assessRuntime(snapshot, expected);
    assert.equal(report.ok, false);
    assert.match(report.checks[0]!.issues.join(' '), /not active.*absent or disabled/);
  }
});

test('a runtime model does not mask missing or invalid explicit configuration assignments', () => {
  const { snapshot, expected } = fixture();
  expected.lead = { mode: 'primary' };
  expected.qa = { model: 'invalid' };
  const report = assessRuntime(snapshot, expected);
  assert.equal(report.ok, false);
  assert.match(report.checks[0]!.issues.join(' '), /valid explicit/);
  assert.match(report.checks[7]!.issues.join(' '), /valid explicit/);
});

test('filesystem expectations merge later model/visibility overrides and retain earlier role fields', () => {
  const sources = [{ path: 'global', text: '', value: { agents: { lead: { model: 'p/a', mode: 'primary' } } } }, { path: 'project', text: '', value: { agents: { lead: { model: { providerID: 'p', model: 'b', variant: 'high' }, hidden: true } } } }];
  const expected = expectedAgents(sources);
  assert.deepEqual(expected.lead, { mode: 'primary', model: { providerID: 'p', model: 'b', variant: 'high' }, hidden: true });
});

test('wrong-location and malformed API responses are inconclusive, never passes', () => {
  const directory = process.cwd();
  for (const response of [[], {}, { location: { directory }, data: {} }, { location: { directory: '/' }, data: [] }, { location: { directory }, data: [{ id: 'lead' }] }]) assert.throws(() => decodeRows(response, directory, 'agents'), /inconclusive/);
  assert.deepEqual(decodeRows({ location: { directory }, data: [] }, directory, 'agents'), []);
  assert.throws(() => decodeRows({ location: { directory }, data: [{ id: 'p' }] }, directory, 'providers'), /inconclusive/);
});

test('initial empty snapshots retry on the same service until settled, with no generation/reload calls', async () => {
  const { snapshot, expected } = fixture();
  const directory = process.cwd();
  let rounds = 0;
  let pauses = 0;
  const paths: string[] = [];
  const report = await verifyRuntime({ directory }, expected, async path => {
    paths.push(path);
    if (path === '/api/agent') rounds++;
    const key = path === '/api/agent' ? 'agents' : path === '/api/model' ? 'models' : 'providers';
    return { location: { directory }, data: rounds === 1 ? [] : snapshot[key] };
  }, async () => { pauses++; });
  assert.equal(report.ok, true);
  assert.equal(rounds, 2);
  assert.equal(pauses, 1);
  assert.ok(paths.every(path => ['/api/agent', '/api/model', '/api/provider'].includes(path)));
});

test('persistent missing roles stop after bounded retries; API errors remain inconclusive', async () => {
  const directory = process.cwd();
  const { expected } = fixture();
  let calls = 0;
  const report = await verifyRuntime({ directory }, expected, async () => { calls++; return { location: { directory }, data: [] }; }, async () => {});
  assert.equal(report.ok, false);
  assert.equal(calls, 12);
  await assert.rejects(verifyRuntime({ directory }, expected, async () => ({ error: 'private details' })), /inconclusive/);
});

test('CLI transport errors suppress potentially sensitive raw stderr', async () => {
  const query = cliQuery({ directory: process.cwd(), executable: 'definitely-not-an-installed-opencode-cli' });
  await assert.rejects(query('/api/agent'), error => error instanceof Error && /Raw output suppressed/.test(error.message) && !error.message.includes('ENOENT'));
});

test('doctor CLI precedence is explicit executable, OPENCODE_BIN, then platform discovery', async () => {
  const { findOpenCode } = await import('../src/native-diagnostics.ts');
  const previous = process.env.OPENCODE_BIN;
  try {
    process.env.OPENCODE_BIN = 'environment-opencode';
    assert.equal(findOpenCode('explicit-opencode'), 'explicit-opencode');
    assert.equal(findOpenCode(), 'environment-opencode');
    delete process.env.OPENCODE_BIN;
    const discovered = findOpenCode();
    assert.equal(discovered, process.platform === 'win32' ? (discovered.endsWith('opencode-cli.exe') ? discovered : 'opencode') : 'opencode');
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previous;
  }
});

test('doctor help is noninteractive; invalid project fails safely before querying a service', () => {
  const script = fileURLToPath(new URL('../scripts/diagnose-native-harness.ts', import.meta.url));
  assert.match(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }), /never reloads/);
  assert.throws(() => execFileSync(process.execPath, [script, '--project', 'definitely-not-an-existing-project'], { stdio: 'pipe' }), error => {
    const result = error as { status: number; stderr: Buffer };
    assert.equal(result.status, 2);
    assert.match(result.stderr.toString(), /inconclusive/);
    return true;
  });
});
