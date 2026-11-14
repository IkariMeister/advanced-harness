import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessRuntime, classifyCliQueryError, cliQuery, DEFAULT_CLI_TIMEOUT_MS, decodeRows, diagnoseHost, effectiveTimeoutMs, expectedAgents, MAX_CLI_TIMEOUT_MS, parseCliTimeoutMs, runtimeModelReference, verifyRuntime, type Snapshot } from '../src/native-diagnostics.ts';
import { hostPermissionMatrix, permissionCapabilities } from '../src/host-permission-capabilities.ts';
import { nativeRoles } from '../src/native-installer.ts';
import { clearRegisteredAdapters, getHostAdapter, registerHostAdapter, supportedHosts, type HostAdapter } from '../src/host-registry.ts';

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

test('CLI transport errors suppress potentially sensitive raw stderr and classify failure modes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'opencode-cli-errors-'));
  const secretDir = join(root, 'secret-user-token-dir');
  mkdirSync(secretDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  try {
    const missing = cliQuery({ directory: root, executable: join(secretDir, 'definitely-not-an-installed-opencode-cli') });
    await assert.rejects(
      missing('/api/agent'),
      error => error instanceof Error
        && /executable was not found \("definitely-not-an-installed-opencode-cli"\)/.test(error.message)
        && !error.message.includes('secret-user-token-dir')
        && /Raw output suppressed/.test(error.message)
        && !error.message.includes('ENOENT'),
    );

    const configFile = join(secretDir, 'opencode.json');
    writeFileSync(configFile, '{}');
    const nonExec = cliQuery({ directory: root, executable: configFile });
    await assert.rejects(
      nonExec('/api/agent'),
      error => error instanceof Error
        && /not an executable binary \("opencode\.json"\)/.test(error.message)
        && !error.message.includes('secret-user-token-dir')
        && /Raw output suppressed/.test(error.message),
    );

    for (const code of ['EACCES', 'EPERM', 'EISDIR', 'ENOEXEC', 'UNKNOWN', 'EINVAL', 'EFTYPE']) {
      const err = classifyCliQueryError({ code }, join(secretDir, 'fake-bin'), 15000);
      assert.match(err.message, /not an executable binary \("fake-bin"\)/, code);
      assert.ok(!err.message.includes('secret-user-token-dir'), code);
    }

    const maxBufErr = classifyCliQueryError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, join(secretDir, 'opencode'), 15000);
    assert.match(maxBufErr.message, /buffer limit/);
    assert.doesNotMatch(maxBufErr.message, /timed out after/);

    const externalSigterm = classifyCliQueryError({ signal: 'SIGTERM', killed: false }, join(secretDir, 'opencode'), 15000);
    assert.doesNotMatch(externalSigterm.message, /timed out after/);
    assert.match(externalSigterm.message, /Raw output suppressed/);

    const apiScript = join(root, 'api.js');
    writeFileSync(apiScript, "console.error('SECRET_TOKEN=should-never-appear'); process.exit(7);\n");
    const nonzero = cliQuery({ directory: root, executable: process.execPath });
    await assert.rejects(nonzero('/api/agent'), error => error instanceof Error && /exited with status 7/.test(error.message) && /Raw output suppressed/.test(error.message) && !error.message.includes('SECRET_TOKEN'));

    writeFileSync(apiScript, "console.log('not-json-secret=123');\n");
    const badJson = cliQuery({ directory: root, executable: process.execPath });
    await assert.rejects(badJson('/api/agent'), error => error instanceof Error && /non-JSON output/.test(error.message) && /Raw output suppressed/.test(error.message) && !error.message.includes('not-json-secret'));

    writeFileSync(apiScript, 'setTimeout(() => {}, 5000);\n');
    const timedOut = cliQuery({ directory: root, executable: process.execPath, timeoutMs: 350 });
    await assert.rejects(timedOut('/api/agent'), error => error instanceof Error && /timed out after 350ms/.test(error.message) && /Raw output suppressed/.test(error.message));

    const winPathErr = classifyCliQueryError({ code: 'ENOENT' }, String.raw`C:\Users\secret-user\opencode.exe`, 15000);
    assert.match(winPathErr.message, /executable was not found \("opencode\.exe"\)/);
    assert.ok(!winPathErr.message.includes('secret-user'));

    assert.equal(effectiveTimeoutMs(undefined), DEFAULT_CLI_TIMEOUT_MS);
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, MAX_CLI_TIMEOUT_MS + 1]) {
      assert.equal(effectiveTimeoutMs(invalid), DEFAULT_CLI_TIMEOUT_MS, String(invalid));
    }
    assert.equal(effectiveTimeoutMs(1), 1);
    assert.equal(effectiveTimeoutMs(MAX_CLI_TIMEOUT_MS), MAX_CLI_TIMEOUT_MS);

    for (const raw of ['0', '-1', '1e3', '0x10', ' 5 ', 'abc', String(MAX_CLI_TIMEOUT_MS + 1)]) {
      assert.equal(parseCliTimeoutMs(raw), undefined, raw);
    }
    assert.equal(parseCliTimeoutMs('1'), 1);
    assert.equal(parseCliTimeoutMs(String(MAX_CLI_TIMEOUT_MS)), MAX_CLI_TIMEOUT_MS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor CLI precedence, ~/ expansion, and INIT_CWD/cwd-relative executable resolution', async () => {
  const { findOpenCode } = await import('../src/native-diagnostics.ts');
  const { homedir } = await import('node:os');
  const previousBin = process.env.OPENCODE_BIN;
  const previousInitCwd = process.env.INIT_CWD;
  try {
    delete process.env.INIT_CWD;
    process.env.OPENCODE_BIN = '~/bin/opencode';
    assert.equal(findOpenCode('~/custom/opencode'), join(homedir(), 'custom', 'opencode'));
    assert.equal(findOpenCode(), join(homedir(), 'bin', 'opencode'));
    assert.equal(findOpenCode('~'), '~');
    assert.equal(findOpenCode('~other/opencode'), resolve('~other/opencode'));
    assert.equal(findOpenCode('$HOME/bin/opencode'), resolve('$HOME/bin/opencode'));
    assert.equal(findOpenCode('./bin/opencode'), resolve('./bin/opencode'));
    assert.equal(findOpenCode('opencode'), 'opencode');
    delete process.env.OPENCODE_BIN;
    const discovered = findOpenCode();
    assert.equal(discovered, process.platform === 'win32' ? (discovered.endsWith('opencode-cli.exe') ? discovered : 'opencode') : 'opencode');
  } finally {
    if (previousBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previousBin;
    if (previousInitCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = previousInitCwd;
  }
});

test('relative --opencode resolves against INIT_CWD or cwd rather than --project, while bare names stay bare', async t => {
  const root = mkdtempSync(join(tmpdir(), 'opencode-cwd-vs-project-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwdDir = join(root, 'caller-cwd');
  const initCwdDir = join(root, 'npm-init-cwd');
  const projectDir = join(root, 'target-project');
  mkdirSync(join(cwdDir, 'bin'), { recursive: true });
  mkdirSync(join(initCwdDir, 'bin'), { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  const previousCwd = process.cwd();
  const previousInitCwd = process.env.INIT_CWD;
  try {
    delete process.env.INIT_CWD;
    process.chdir(cwdDir);
    const { findOpenCode } = await import('../src/native-diagnostics.ts');
    assert.equal(findOpenCode('./bin/opencode'), join(realpathSync(cwdDir), 'bin', 'opencode'));
    assert.notEqual(findOpenCode('./bin/opencode'), join(realpathSync(projectDir), 'bin', 'opencode'));
    assert.equal(findOpenCode('opencode'), 'opencode');

    process.env.INIT_CWD = initCwdDir;
    assert.equal(findOpenCode('./bin/opencode'), join(initCwdDir, 'bin', 'opencode'));
    assert.equal(findOpenCode('opencode'), 'opencode');
  } finally {
    process.chdir(previousCwd);
    if (previousInitCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = previousInitCwd;
  }
});

test('Windows executable discovery uses a controlled LOCALAPPDATA fixture and falls back when absent', { skip: process.platform !== 'win32' }, async t => {
  const { findOpenCode } = await import('../src/native-diagnostics.ts');
  const root = mkdtempSync(join(tmpdir(), 'opencode-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previousLocal = process.env.LOCALAPPDATA;
  const previousBin = process.env.OPENCODE_BIN;
  const appData = join(root, 'controlled-local-app-data');
  const expected = join(appData, 'Programs', '@opencodedesktop', 'resources', 'opencode-cli.exe');
  try {
    process.env.LOCALAPPDATA = appData;
    delete process.env.OPENCODE_BIN;
    mkdirSync(join(appData, 'Programs', '@opencodedesktop', 'resources'), { recursive: true });
    writeFileSync(expected, 'fixture');
    assert.equal(findOpenCode(), expected);
    rmSync(expected);
    assert.equal(findOpenCode(), 'opencode');
  } finally {
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocal;
    if (previousBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previousBin;
  }
});

test('doctor help is noninteractive; invalid project fails safely before querying a service', () => {
  const script = fileURLToPath(new URL('../scripts/diagnose-native-harness.ts', import.meta.url));
  assert.match(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }), /never reloads/);
  assert.throws(() => execFileSync(process.execPath, [script, '--project', 'definitely-not-an-existing-project'], { stdio: 'pipe' }), error => {
    const result = error as { status: number; stderr: Buffer };
    assert.equal(result.status, 2);
    assert.match(result.stderr.toString(), /Select an existing project directory/);
    return true;
  });
});

function sandboxedDoctor(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'harness-doctor-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); const xdg = join(root, 'xdg'); const project = join(root, 'project');
  for (const dir of [home, join(xdg, 'opencode'), project]) mkdirSync(dir, { recursive: true });
  const script = fileURLToPath(new URL('../scripts/diagnose-native-harness.ts', import.meta.url));
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg };
  const run = (args: string[]) => {
    try { return { status: 0, stdout: execFileSync(process.execPath, [script, ...args], { env, encoding: 'utf8', stdio: 'pipe' }), stderr: '' }; }
    catch (error) { const result = error as { status: number; stdout: string; stderr: string }; return { status: result.status, stdout: result.stdout, stderr: result.stderr }; }
  };
  return { home, xdg, project, run };
}

test('doctor surfaces CLI option errors instead of a generic inconclusive message (#145)', t => {
  const { project, run } = sandboxedDoctor(t);
  for (const [args, message] of [
    [['--bogus', 'x'], /Unknown option: --bogus/],
    [['--scope', 'everywhere'], /Invalid --scope; use global or project/],
    [['--project', project, '--project', project], /Duplicate option: --project/],
    [['--scope'], /Missing value for --scope/],
    [['--timeout', '0'], /Invalid --timeout/],
    [['--timeout', '1e3'], /Invalid --timeout/],
    [['--timeout', '0x10'], /Invalid --timeout/],
    [['--timeout', ' 5 '], /Invalid --timeout/],
    [['--timeout', '3000000000'], /Invalid --timeout/],
    [['--timeout', 'abc'], /Invalid --timeout/],
    [['--host', 'not-a-host'], /not-a-host/],
  ] as const) {
    const result = run([...args]);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /Verification inconclusive/);
    assert.equal(result.stdout, '', 'nothing inspected before option validation');
  }
});

test('diagnoseHost at project scope does not count a global footprint as installed (#145)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-doctor-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); const project = join(root, 'project');
  mkdirSync(join(home, '.claude'), { recursive: true }); mkdirSync(project);
  writeFileSync(join(home, '.claude', 'settings.json'), '{}');
  assert.equal((await diagnoseHost('claude-code', { project, home })).installed, true);
  assert.equal((await diagnoseHost('claude-code', { project, home, scope: 'project' })).installed, false);
});

test('doctor --scope project never reads a malformed global OpenCode config (#145)', t => {
  const { xdg, project, run } = sandboxedDoctor(t);
  writeFileSync(join(xdg, 'opencode', 'opencode.json'), '{ "agents": ');
  const scoped = run(['--scope', 'project', '--host', 'opencode', '--project', project]);
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.doesNotMatch(scoped.stderr, /inconclusive/i);
  const both = run(['--host', 'opencode', '--project', project]);
  assert.equal(both.status, 2, 'without --scope the malformed global file is read and fails');
});

test('doctor scope reaches Antigravity and Codex adapters so excluded global artifacts are not inspected (#145)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-doctor-adapter-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); const project = join(root, 'project');
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true }); mkdirSync(join(home, '.codex'), { recursive: true }); mkdirSync(project);
  writeFileSync(join(home, '.gemini', 'config', 'hooks.json'), '{ broken');
  writeFileSync(join(home, '.codex', 'config.toml'), '[unterminated\n');
  const globalIssue = (issues: string[]) => issues.filter(issue => /Global|\.gemini|\.codex/.test(issue) && !/not installed/.test(issue));

  const antigravityBoth = await diagnoseHost('antigravity', { project, home });
  assert.ok(globalIssue(antigravityBoth.issues).length > 0, 'the malformed global hooks.json is reported without a scope');
  const antigravityProject = await diagnoseHost('antigravity', { project, home, scope: 'project' });
  assert.deepEqual(globalIssue(antigravityProject.issues), []);

  const codexBoth = await diagnoseHost('codex', { project, home });
  assert.ok(globalIssue(codexBoth.issues).length > 0, 'the malformed global config.toml is reported without a scope');
  const codexProject = await diagnoseHost('codex', { project, home, scope: 'project' });
  assert.deepEqual(globalIssue(codexProject.issues), []);
});

test('doctor --scope project without --host ignores global footprints when detecting hosts (#145)', t => {
  const { home, project, run } = sandboxedDoctor(t);
  for (const dir of [join(home, '.gemini', 'config'), join(home, '.codex'), join(home, '.claude'), join(home, '.cursor')]) mkdirSync(dir, { recursive: true });
  const scoped = run(['--scope', 'project', '--project', project]);
  assert.equal(scoped.status, 0, scoped.stdout + scoped.stderr);
  assert.match(scoped.stdout, /Inspecting host\(s\): opencode\r?\n/, 'only the default host; no global footprint selects a host');
  assert.doesNotMatch(scoped.stdout, /Inspecting host\(s\):[^\n]*(?:antigravity|codex|claude-code|cursor)/i, 'excluded global hosts must not be selected');
  assert.match(scoped.stdout, /Procedure skills: not-installed \(static validation only\)/, 'the legitimate procedure-skill status remains visible');
  const both = run(['--project', project]);
  assert.match(both.stdout, /Inspecting host\(s\): .*antigravity/,'without --scope the global footprint still selects Antigravity');
});

test('doctor --scope limits OpenCode configuration sources to the requested scope (#145)', t => {
  const { xdg, project, run } = sandboxedDoctor(t);
  writeFileSync(join(xdg, 'opencode', 'opencode.json'), '{}');
  // A missing CLI keeps the test away from any real OpenCode service.
  const global = run(['--scope', 'global', '--host', 'opencode', '--project', project, '--opencode', join(project, 'missing-opencode-cli')]);
  assert.equal(global.status, 1);
  assert.match(global.stderr, /OpenCode runtime check inconclusive/);
  assert.match(global.stdout, /Checking scope: global/);
  assert.ok(global.stdout.includes(join(xdg, 'opencode', 'opencode.json')));
  const scoped = run(['--scope', 'project', '--host', 'opencode', '--project', project]);
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.match(scoped.stdout, /Checking scope: project/);
  assert.match(scoped.stdout, /None at project scope\./);
  assert.ok(!scoped.stdout.includes(join(xdg, 'opencode')), 'global source is excluded at project scope');
});

test('OpenCode doctor prints static procedure-skill status before runtime checks and remains read-only', t => {
  const { project, run } = sandboxedDoctor(t);
  const before = requireDirectoryEntries(project);
  const result = run(['--host', 'opencode', '--project', project]);
  assert.match(result.stdout, /Procedure skills: not-installed \(static validation only\)/);
  assert.match(result.stdout, /OpenCode V2 Diagnostics/);
  assert.equal(requireDirectoryEntries(project), before);
});

test('non-OpenCode doctor prints one merged procedure-skill status for installed and unsupported outcomes', t => {
  const { project, run } = sandboxedDoctor(t);
  for (const [host, status, exitCode] of [['antigravity', 'not-installed', 1], ['cursor', 'unsupported', 0]] as const) {
    const result = run(['--host', host, '--scope', 'project', '--project', project]);
    assert.equal(result.status, exitCode, result.stderr + result.stdout);
    const matches = result.stdout.match(/Procedure skills: .* \(static validation only\)/g) ?? [];
    assert.equal(matches.length, 1, `${host} should display one procedure-skill status`);
    assert.match(result.stdout, new RegExp(`Procedure skills: ${status} \\(static validation only\\)`));
  }
});

test('adapter-backed host reports retain procedure-skill failures in ok aggregation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-doctor-adapter-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const home = join(root, 'home'); const global = join(root, 'global');
  mkdirSync(project); mkdirSync(home); mkdirSync(global);
  writeFileSync(join(project, 'opencode.json'), '{"agents":{"lead":{},"implementer":{}}}');
  mkdirSync(join(project, '.agents', 'rules'), { recursive: true });
  writeFileSync(join(project, '.agents', 'rules', 'advanced-harness-lead.md'), 'lead rule');

  const baseline = supportedHosts.flatMap(host => {
    const adapter = getHostAdapter(host);
    return adapter ? [[host, adapter] as const] : [];
  });
  const restoreAdapters = () => {
    clearRegisteredAdapters();
    for (const [, adapter] of baseline) registerHostAdapter(adapter);
  };
  try {
    for (const host of ['opencode', 'antigravity'] as const) {
      const healthyAdapter: HostAdapter = { host, install: async () => {}, doctor: async () => ({ ok: true, issues: [], notes: [] }) };
      registerHostAdapter(healthyAdapter);
      try {
        const report = await diagnoseHost(host, { project, home, globalDirectory: global, scope: 'project' });
        assert.equal(report.ok, false, `${host} adapter is healthy, but expected installed procedure skill is missing`);
        assert.match(report.issues.join(' '), /Expected installed project procedure skill is missing/);
      } finally {
        restoreAdapters();
      }
    }
  } finally {
    restoreAdapters();
  }
});

test('non-OpenCode CLI prints procedure-skill errors once and exits nonzero', t => {
  const { project, run } = sandboxedDoctor(t);
  const rules = join(project, '.agents', 'rules');
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, 'advanced-harness-lead.md'), 'lead rule');
  const result = run(['--host', 'antigravity', '--scope', 'project', '--project', project]);
  const combined = result.stdout + result.stderr;
  assert.equal(result.status, 1, combined);
  assert.match(combined, /Procedure skills: installed \(static validation only\)/);
  const missing: string[] = combined.match(/Expected installed project procedure skill is missing: [\w-]+\./g) ?? [];
  assert.equal(missing.length, 9, combined);
  assert.ok(missing.includes('Expected installed project procedure skill is missing: harness-procedure-documentation-impact.'), combined);
  assert.equal(new Set(missing).size, missing.length, combined);
});

function requireDirectoryEntries(directory: string): string {
  return readdirSync(directory).sort().join('|');
}


test('doctor prints exactly the selected host permission rows, without writes or status promotion', t => {
  const { home, project, run } = sandboxedDoctor(t);
  writeFileSync(join(project, 'keep.txt'), 'project sentinel');
  writeFileSync(join(home, 'keep.txt'), 'home sentinel');
  const before = snapshotDirectory(project) + ':' + snapshotDirectory(home);
  for (const host of supportedHosts) {
    const result = run(['--host', host, '--scope', 'project', '--project', project]);
    assert.equal((result.stdout.match(/Host permission capability matrix \[/g) ?? []).length, 1, result.stdout + result.stderr);
    assert.ok(result.stdout.includes('Host permission capability matrix [' + host + ']'), result.stdout);
    for (const [key, label] of Object.entries(permissionCapabilities)) {
      const cell = hostPermissionMatrix[host].capabilities[key as keyof typeof permissionCapabilities];
      assert.ok(result.stdout.includes(label + ': ' + cell.status), host + '/' + key);
      assert.ok(result.stdout.includes(cell.scope));
      for (const evidence of cell.evidence) {
        assert.ok(result.stdout.includes(evidence.source));
        if (evidence.kind === 'live-run') assert.ok(result.stdout.includes('runner: ' + evidence.runner));
      }
    }
    assert.equal(snapshotDirectory(project) + ':' + snapshotDirectory(home), before);
  }
  const all = run(['--host', 'all', '--scope', 'project', '--project', project]);
  assert.equal((all.stdout.match(/Host permission capability matrix \[/g) ?? []).length, supportedHosts.length, all.stdout + all.stderr);
  for (const host of supportedHosts) assert.ok(all.stdout.includes('Host permission capability matrix [' + host + ']'));
  assert.equal(snapshotDirectory(project) + ':' + snapshotDirectory(home), before);
});

test('doctor detected host uses the same evidence row and OpenCode failures retain it', t => {
  const { xdg, project, run } = sandboxedDoctor(t);
  mkdirSync(join(project, '.cursor'));
  const detected = run(['--scope', 'project', '--project', project]);
  assert.equal(detected.status, 0, detected.stdout + detected.stderr);
  assert.match(detected.stdout, /Inspecting host\(s\): cursor/);
  assert.match(detected.stdout, /Host permission capability matrix \[cursor\]/);
  writeFileSync(join(xdg, 'opencode', 'opencode.json'), '{}');
  const failed = run(['--host', 'opencode', '--scope', 'global', '--project', project, '--opencode', join(project, 'absent-cli')]);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /runtime check inconclusive/);
  assert.match(failed.stdout, /Host permission capability matrix \[opencode\]/);
  assert.ok(failed.stdout.includes(permissionCapabilities.roleCommands + ': unverified'));
});


function snapshotDirectory(directory: string): string {
  return JSON.stringify(readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => [
    entry.name,
    entry.isDirectory() ? snapshotDirectory(join(directory, entry.name)) : readFileSync(join(directory, entry.name)).toString('base64'),
  ]));
}
