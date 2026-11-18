import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import type { NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { makeTempRoot } from './temp-directory.ts';
import { nativeRoles, type NativeRole } from '../src/native-role-types.ts';
import { loadNativeDefinitions, updateNativeConfiguration } from '../src/native-installer.ts';
import {
  assertStandaloneArguments,
  checkLoopbackOnlyNetwork,
  childEnvironment,
  classifyProxyAttempts,
  createOpenCodeSandbox,
  enforcementOf,
  isLoopbackHost,
  isRemovedEnvironmentName,
  isToleratedAttempt,
  networkHostsIn,
  nonInternalAddresses,
  parentHomeDirectories,
  parseOpenCodeVersion,
  parseProxyRequestLine,
  resolveOpenCodeBinary,
  runArguments,
  runChild,
  sandboxLayout,
  scrubHome,
  scrubSandbox,
  startProxyRecorder,
  TOLERATED_STARTUP_DESTINATIONS,
  type ProxyAttempt,
  type VersionProbe,
} from '../e2e/support/opencode-sandbox.ts';

// Nothing in this file starts OpenCode or contacts a network host. The binary probe is injected, the proxy recorder
// listens on 127.0.0.1 only, and the process tests spawn only short-lived `node` children of this process.
// Sandbox creation runs the installer functions and the local git binary.

const THIS_FILE = fileURLToPath(import.meta.url);
const probeOk: VersionProbe = () => 'opencode v2.3.0\n';

/** The parts of a sandbox opencode.json that this file reads. Each JSON.parse result is cast to it once. */
type ParsedConfig = {
  agents: Record<string, Record<string, unknown>>;
  default_agent?: unknown;
  providers?: Record<string, { env?: unknown; models?: Record<string, unknown>; settings?: { baseURL?: unknown } }>;
};

test('an unset HARNESS_E2E_OPENCODE is a skip, and an error when HARNESS_E2E_REQUIRE=1', () => {
  assert.equal(resolveOpenCodeBinary({}).status, 'skip');
  const required = resolveOpenCodeBinary({ HARNESS_E2E_REQUIRE: '1' });
  assert.equal(required.status, 'error');
  assert.match(required.status === 'error' ? required.reason : '', /HARNESS_E2E_OPENCODE is not set/);
});

test('an empty, relative, or missing binary path is an error, and the version probe never runs', () => {
  let probed = 0;
  const probe: VersionProbe = () => {
    probed += 1;
    return 'opencode v2.3.0';
  };
  assert.equal(resolveOpenCodeBinary({ HARNESS_E2E_OPENCODE: '' }, probe).status, 'error');
  assert.equal(resolveOpenCodeBinary({ HARNESS_E2E_OPENCODE: 'opencode' }, probe).status, 'error');
  const missing = resolveOpenCodeBinary({ HARNESS_E2E_OPENCODE: join(tmpdir(), 'no-such-opencode-binary-for-tests') }, probe);
  assert.equal(missing.status, 'error');
  assert.match(missing.status === 'error' ? missing.reason : '', /existing file/);
  assert.equal(probed, 0);
});

test('an existing absolute file is ready only when its version is exactly 2.3.0', () => {
  const ready = resolveOpenCodeBinary({ HARNESS_E2E_OPENCODE: THIS_FILE }, probeOk);
  assert.deepEqual(ready, { status: 'ready', binary: THIS_FILE, version: '2.3.0' });

  const wrong = resolveOpenCodeBinary({ HARNESS_E2E_OPENCODE: THIS_FILE }, () => 'opencode v2.4.0\n');
  assert.equal(wrong.status, 'error');
  assert.match(wrong.status === 'error' ? wrong.reason : '', /exactly 2\.3\.0/);

  const failed = resolveOpenCodeBinary({ HARNESS_E2E_OPENCODE: THIS_FILE }, () => {
    throw new Error('boom');
  });
  assert.equal(failed.status, 'error');
  assert.match(failed.status === 'error' ? failed.reason : '', /boom/);
});

test('the version line accepts only the whole trimmed output in one of the three accepted forms', () => {
  assert.equal(parseOpenCodeVersion('opencode v2.3.0\n'), '2.3.0');
  assert.equal(parseOpenCodeVersion('  v2.3.0  '), '2.3.0');
  assert.equal(parseOpenCodeVersion('2.3.0'), '2.3.0');
  assert.equal(parseOpenCodeVersion('opencode 2.3.0'), undefined);
  assert.equal(parseOpenCodeVersion('opencode v2.3.0\nextra line'), undefined);
  assert.equal(parseOpenCodeVersion(''), undefined);
});

test('runArguments builds the exact run argv, puts --auto before the message only when asked, and refuses --server or a missing --standalone', () => {
  assert.deepEqual(runArguments('hello', false), [
    'run', '--standalone', '--print-logs', '--log-level', 'debug', '--archived',
    '--agent', 'lead', '--model', 'harness-loopback/lead', '--format', 'json', 'hello',
  ]);
  assert.deepEqual(runArguments('hi', true).slice(-2), ['--auto', 'hi']);
  assert.equal(runArguments('hi', false).includes('--auto'), false);
  assert.throws(() => runArguments('--server', false), /--standalone or with --server/);
  assert.throws(() => assertStandaloneArguments(['run', 'message']), /--standalone/);
  assert.throws(() => assertStandaloneArguments(['--standalone', '--server']), /--server/);
  assert.doesNotThrow(() => assertStandaloneArguments(['--standalone', 'message']));
});

test('the child environment removes credential, OpenCode, npm, and launch-directory variables and redirects the home', () => {
  const root = join(tmpdir(), 'harness-e2e-env-unit');
  const layout = sandboxLayout(root);
  const inherited: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    PWD: '/real/dir',
    OLDPWD: '/old',
    INIT_CWD: '/init',
    npm_config_cache: '/npm',
    FOO_API_KEY: 'redacted-value',
    GITHUB_TOKEN: 'redacted-value',
    OPENAI_API_KEY: 'redacted-value',
    ANTHROPIC_API_KEY: 'redacted-value',
    OPENCODE_CONFIG: '/real/config',
    NODE_OPTIONS: '--inspect',
    HARNESS_E2E_OPENCODE: '/bin/opencode',
    HOME: '/home/real',
    XDG_CONFIG_HOME: '/real/config-home',
    GIT_CONFIG_GLOBAL: '/real/gitconfig',
  };
  const env = childEnvironment(inherited, layout, layout.project);
  for (const name of ['OLDPWD', 'INIT_CWD', 'npm_config_cache', 'FOO_API_KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCODE_CONFIG', 'NODE_OPTIONS', 'HARNESS_E2E_OPENCODE']) {
    assert.equal(env[name], undefined, `${name} must be removed`);
  }
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.PWD, layout.project);
  assert.equal(env.HOME, layout.home);
  assert.equal(env.USERPROFILE, layout.home);
  assert.equal(env.XDG_CONFIG_HOME, layout.xdgConfigHome);
  assert.equal(env.APPDATA, join(layout.home, 'AppData', 'Roaming'));
  assert.equal(env.OPENCODE_DB, join(root, 'opencode.db'));
  assert.equal(env.GIT_CONFIG_GLOBAL, layout.gitConfig);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.NO_PROXY, undefined);
});

const SUITE_PROXY_NAMES = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
const SUITE_NO_PROXY_NAMES = ['NO_PROXY', 'no_proxy'];
const AMBIENT_PROXY_NAMES = [...SUITE_PROXY_NAMES, ...SUITE_NO_PROXY_NAMES];

test('the child environment sets the full proxy set and loopback NO_PROXY only when a proxy URL is given', () => {
  const layout = sandboxLayout(join(tmpdir(), 'harness-e2e-proxy-unit'));
  const env = childEnvironment({ PATH: '/usr/bin' }, layout, layout.project, { proxyUrl: 'http://127.0.0.1:4000' });
  for (const name of SUITE_PROXY_NAMES) assert.equal(env[name], 'http://127.0.0.1:4000', name);
  for (const name of SUITE_NO_PROXY_NAMES) assert.equal(env[name], '127.0.0.1,localhost,::1', name);
  assert.deepEqual(
    Object.keys(env).filter(name => /_proxy$/i.test(name)).sort(),
    [...AMBIENT_PROXY_NAMES].sort(),
    'exactly the eight proxy names: HTTP, HTTPS, ALL, and NO in both letter cases',
  );
  const withoutProxy = childEnvironment({ PATH: '/usr/bin' }, layout, layout.project);
  assert.deepEqual(Object.keys(withoutProxy).filter(name => /_proxy$/i.test(name)), []);
});

test('inherited proxy variables in any letter case are removed when no proxy URL is given, and replaced when one is', () => {
  const layout = sandboxLayout(join(tmpdir(), 'harness-e2e-ambient-proxy-unit'));
  const inherited: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    ...Object.fromEntries(AMBIENT_PROXY_NAMES.map(name => [name, 'http://ambient.example:3128'])),
  };
  const bare = childEnvironment(inherited, layout, layout.project);
  for (const name of AMBIENT_PROXY_NAMES) assert.equal(bare[name], undefined, `${name} must be removed`);
  assert.equal(bare.PATH, '/usr/bin');
  for (const name of AMBIENT_PROXY_NAMES) assert.equal(isRemovedEnvironmentName(name), true, `${name} must match the denylist`);

  const withProxy = childEnvironment(inherited, layout, layout.project, { proxyUrl: 'http://127.0.0.1:4000' });
  for (const name of SUITE_PROXY_NAMES) assert.equal(withProxy[name], 'http://127.0.0.1:4000', `${name} must be the suite's value`);
  for (const name of SUITE_NO_PROXY_NAMES) assert.equal(withProxy[name], '127.0.0.1,localhost,::1', `${name} must be the suite's value`);
});

test('every inherited GIT_* variable is removed, and the sandbox Git variables survive conflicting inherited values', () => {
  const layout = sandboxLayout(join(tmpdir(), 'harness-e2e-git-unit'));
  const gitNames = [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_COUNT',
  ];
  const inherited: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    ...Object.fromEntries(gitNames.map(name => [name, '/elsewhere'])),
    GIT_CONFIG_GLOBAL: '/real/gitconfig',
    GIT_CONFIG_NOSYSTEM: '0',
    GIT_TERMINAL_PROMPT: '1',
  };
  const env = childEnvironment(inherited, layout, layout.project);
  for (const name of gitNames) {
    assert.equal(env[name], undefined, `${name} must be removed`);
    assert.equal(isRemovedEnvironmentName(name), true, `${name} must match the denylist`);
  }
  assert.equal(env.GIT_CONFIG_GLOBAL, layout.gitConfig);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('scrubSandbox replaces the raw, forward-slash, and JSON-escaped sandbox roots', () => {
  const text = 'a C:\\Temp\\root\\project b C:/Temp/root/project "C:\\\\Temp\\\\root"';
  assert.equal(scrubSandbox(text, 'C:\\Temp\\root'), 'a <sandbox>\\project b <sandbox>/project "<sandbox>"');
  assert.equal(scrubSandbox('unchanged', ''), 'unchanged');
});

test('scrubSandbox matches the root regardless of letter case only when case-insensitive matching is asked for', () => {
  const root = 'C:\\Temp\\Harness-Root';
  const text = 'a c:\\temp\\harness-root\\project b C:/TEMP/harness-root/project "c:\\\\temp\\\\HARNESS-ROOT\\\\project"';
  assert.equal(scrubSandbox(text, root, true), 'a <sandbox>\\project b <sandbox>/project "<sandbox>\\\\project"');
  assert.equal(scrubSandbox(text, root, false), text);
  assert.equal(scrubSandbox(text, root), text);
});

test('networkHostsIn lists distinct non-loopback host names from URLs, lower-cased and sorted', () => {
  assert.deepEqual(
    networkHostsIn('GET http://127.0.0.1:4000/v1 and https://api.example.com/x and http://localhost:1/ and https://Example.com:443/y and https://example.com/z'),
    ['api.example.com', 'example.com'],
  );
});

test('parseProxyRequestLine keeps only the method and host, and treats anything else as unparsed', () => {
  assert.deepEqual(parseProxyRequestLine('CONNECT example.com:443 HTTP/1.1'), { method: 'CONNECT', host: 'example.com:443' });
  assert.deepEqual(parseProxyRequestLine('GET http://example.org/path?x=1 HTTP/1.1'), { method: 'GET', host: 'example.org' });
  assert.deepEqual(parseProxyRequestLine('not a request'), { method: '(unparsed)', host: '(no host)' });
  assert.equal(isLoopbackHost('127.0.0.1:4000'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('[::1]:80'), true);
  assert.equal(isLoopbackHost('example.com:443'), false);
});

test('the proxy recorder counts a connection, records only the request line, and never stores headers', async t => {
  const recorder = await startProxyRecorder();
  t.after(() => recorder.close());
  const socket = connect(Number(new URL(recorder.url).port), '127.0.0.1');
  t.after(() => { socket.destroy(); });
  socket.on('error', () => undefined);
  await new Promise<void>(done => socket.once('connect', () => done()));
  const closed = new Promise<void>(done => socket.once('close', () => done()));
  socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Basic c2VjcmV0\r\n\r\n');
  await closed;
  const attempts = recorder.attempts();
  assert.deepEqual(attempts, [{ method: 'CONNECT', host: 'example.com:443' }]);
  const serialised = JSON.stringify(attempts);
  assert.equal(serialised.includes('c2VjcmV0'), false);
  assert.equal(serialised.includes('Proxy-Authorization'), false);
});

test('creating a sandbox installs the harness with the installer functions and commits it cleanly', async t => {
  const sandbox = createOpenCodeSandbox('unit-install', { baseURL: 'http://127.0.0.1:9/v1' });
  t.after(() => sandbox.dispose());

  const subjects = sandbox.git(['log', '--format=%s']).trim().split('\n');
  assert.deepEqual(subjects, ['e2e-harness-install', 'e2e-sentinel-commit']);
  assert.equal(sandbox.git(['status', '--porcelain']).trim(), '');

  const readme = readFileSync(join(sandbox.project, 'README.md'), 'utf8');
  const notes = readFileSync(join(sandbox.project, 'notes.md'), 'utf8');
  assert.match(readme, /E2E-README-SENTINEL-7f3a/);
  assert.match(notes, /E2E-NOTES-SENTINEL-7f3a/);

  // The expected configuration is the installer's own output with the same assignments and no providers block.
  const definitions = loadNativeDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));
  const assignments = Object.fromEntries(nativeRoles.map(role => [role, `harness-loopback/${role}`])) as Record<NativeRole, string>;
  const expected = JSON.parse(updateNativeConfiguration('{}\n', definitions, assignments, true, false, [], {})) as Record<string, unknown>;
  const actual = JSON.parse(readFileSync(join(sandbox.project, 'opencode.json'), 'utf8')) as ParsedConfig;
  assert.deepEqual(actual.agents, expected.agents);
  assert.equal(actual.default_agent, 'lead');
  assert.deepEqual(Object.fromEntries(Object.entries(actual).filter(([key]) => key !== 'providers')), expected);
  for (const role of nativeRoles) assert.equal(actual.agents[role]?.model, `harness-loopback/${role}`);

  const provider = actual.providers?.['harness-loopback'];
  assert.equal(provider?.settings?.baseURL, 'http://127.0.0.1:9/v1');
  assert.deepEqual(Object.keys(provider?.models ?? {}).sort(), [...nativeRoles].sort());
  assert.deepEqual(provider?.env, []);

  const skill = readFileSync(join(sandbox.project, '.opencode', 'skills', 'harness-procedure-documentation-impact', 'SKILL.md'), 'utf8');
  assert.match(skill, /List each affected artifact/);
  assert.equal(existsSync(join(sandbox.project, '.opencode', 'commands', 'start-issue.md')), true);

  const globalConfig = JSON.parse(readFileSync(join(sandbox.layout.xdgConfigHome, 'opencode', 'opencode.json'), 'utf8'));
  assert.deepEqual(globalConfig, { update: 'disable' });
});

test('sandbox names must be lower-case words separated by hyphens, and dispose removes the sandbox', t => {
  assert.throws(() => createOpenCodeSandbox('Bad Name', { baseURL: 'http://127.0.0.1:9/v1' }), /lower-case words/);
  const sandbox = createOpenCodeSandbox('unit-dispose', { baseURL: 'http://127.0.0.1:9/v1' });
  // Safety net only: the assertions below dispose the sandbox themselves, and a second dispose is a no-op.
  t.after(() => sandbox.dispose());
  assert.equal(existsSync(sandbox.root), true);
  sandbox.dispose();
  assert.equal(existsSync(sandbox.root), false);
});

test('a sandbox created with inherited GIT_DIR, GIT_WORK_TREE, and identity variables still commits into the sandbox repository', t => {
  const decoy = makeTempRoot('harness-e2e-git-decoy-');
  t.after(() => rmSync(decoy, { recursive: true, force: true, maxRetries: 5 }));
  const decoyGit = join(decoy, '.git');
  const init = spawnSync('git', ['init', '--quiet', decoy], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  // Conflicting values are set on the real process environment, which createOpenCodeSandbox reads through childEnvironment.
  const overrides: Record<string, string> = {
    GIT_DIR: decoyGit,
    GIT_WORK_TREE: decoy,
    GIT_INDEX_FILE: join(decoyGit, 'index'),
    GIT_OBJECT_DIRECTORY: join(decoyGit, 'objects'),
    GIT_CONFIG_GLOBAL: join(decoy, 'inherited-gitconfig'),
    GIT_AUTHOR_EMAIL: 'inherited@example.invalid',
  };
  const saved: Record<string, string | undefined> = {};
  for (const name of Object.keys(overrides)) saved[name] = process.env[name];
  t.after(() => {
    for (const name of Object.keys(overrides)) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  Object.assign(process.env, overrides);

  const sandbox = createOpenCodeSandbox('unit-git-env', { baseURL: 'http://127.0.0.1:9/v1' });
  t.after(() => sandbox.dispose());
  assert.deepEqual(sandbox.git(['log', '--format=%s']).trim().split('\n'), ['e2e-harness-install', 'e2e-sentinel-commit']);
  assert.equal(sandbox.git(['log', '-1', '--format=%ae']).trim(), 'e2e-sandbox@sandbox.invalid');
  const decoyHead = spawnSync('git', ['--git-dir', decoyGit, 'rev-parse', '--verify', '--quiet', 'HEAD'], { encoding: 'utf8' });
  assert.notEqual(decoyHead.status, 0, 'the inherited repository must receive no commit');
});

test('the only tolerated startup destination is CONNECT models.opencode.ai:443, matched on method, host, and port', () => {
  assert.deepEqual(TOLERATED_STARTUP_DESTINATIONS, ['CONNECT models.opencode.ai:443']);
  assert.equal(isToleratedAttempt({ method: 'CONNECT', host: 'models.opencode.ai:443' }), true);
  assert.equal(isToleratedAttempt({ method: 'CONNECT', host: 'MODELS.OPENCODE.AI:443' }), true);
  assert.equal(isToleratedAttempt({ method: 'CONNECT', host: 'models.opencode.ai:80' }), false);
  assert.equal(isToleratedAttempt({ method: 'CONNECT', host: 'evil-models.opencode.ai:443' }), false);
  assert.equal(isToleratedAttempt({ method: 'CONNECT', host: 'models.opencode.ai.example.com:443' }), false);
  assert.equal(isToleratedAttempt({ method: 'CONNECT', host: 'models.opencode.ai' }), false);
  // The method is part of the match: a plain-HTTP request to the same host and port is not tolerated.
  assert.equal(isToleratedAttempt({ method: 'GET', host: 'models.opencode.ai:443' }), false);
  assert.equal(isToleratedAttempt(parseProxyRequestLine('GET http://models.opencode.ai:443/x HTTP/1.1')), false);
});

test('near-miss destinations and plain-HTTP requests without the tolerated method, host, and port are unexpected', () => {
  const attempts: ProxyAttempt[] = [
    { method: 'CONNECT', host: 'models.opencode.ai:80' },
    { method: 'CONNECT', host: 'evil-models.opencode.ai:443' },
    { method: 'CONNECT', host: 'models.opencode.ai.example.com:443' },
    { method: 'CONNECT', host: 'models.opencode.ai' },
    parseProxyRequestLine('GET http://models.opencode.ai/v1/api.json HTTP/1.1'),
    parseProxyRequestLine('GET http://models.opencode.ai:443/x HTTP/1.1'),
  ];
  const classified = classifyProxyAttempts(attempts);
  assert.deepEqual(classified.tolerated, []);
  assert.deepEqual(classified.unexpected, [
    'CONNECT evil-models.opencode.ai:443',
    'CONNECT models.opencode.ai',
    'CONNECT models.opencode.ai.example.com:443',
    'CONNECT models.opencode.ai:80',
    'GET models.opencode.ai',
    'GET models.opencode.ai:443',
  ].sort());
});

test('credential-shaped, OpenCode, Git, npm, and launch-directory names are removed by pattern, case-insensitively', () => {
  const removed = [
    'MY_SECRET_VALUE', 'db_password', 'DB_PASSWD', 'SOME_CREDENTIALS', 'API_KEY', 'FOO_API_KEY', 'FOO_KEY', 'foo_token',
    'FOO_PAT', 'SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_ACTIONS', 'NPM_CONFIG_USERCONFIG', 'npm_config_cache', 'AWS_SECRET_ACCESS_KEY',
    'AZURE_CLIENT_ID', 'GOOGLE_APPLICATION_CREDENTIALS', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'NODE_AUTH_TOKEN',
    'opencode_config', 'HARNESS_E2E_REQUIRE', 'GIT_CONFIG_COUNT', 'XDG_RUNTIME_DIR', 'HOMEDRIVE', 'PWD', 'INIT_CWD',
  ];
  for (const name of removed) assert.equal(isRemovedEnvironmentName(name), true, `${name} must be removed`);
  // Names the child needs on Windows or Linux, and the home-style names childEnvironment sets, are never removed.
  const kept = [
    'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'PROGRAMDATA',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'USERNAME',
  ];
  for (const name of kept) assert.equal(isRemovedEnvironmentName(name), false, `${name} must survive`);
});

test('the child environment keeps PATH and SystemRoot and drops a credential-shaped variable it inherited', () => {
  const layout = sandboxLayout(join(tmpdir(), 'harness-e2e-denylist-unit'));
  const env = childEnvironment({ PATH: 'C:\\bin', SystemRoot: 'C:\\Windows', COMSPEC: 'C:\\Windows\\cmd.exe', TEMP: 'C:\\T', TMP: 'C:\\T', SOME_SECRET: 'redacted-value' }, layout, layout.project);
  assert.equal(env.PATH, 'C:\\bin');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.COMSPEC, 'C:\\Windows\\cmd.exe');
  assert.equal(env.TEMP, 'C:\\T');
  assert.equal(env.TMP, 'C:\\T');
  assert.equal(env.SOME_SECRET, undefined);
});

test('scrubHome replaces the parent home in raw, forward-slash, and JSON-escaped forms, and only ignores case when asked', () => {
  const home = 'C:\\Users\\Jane';
  assert.equal(
    scrubHome('a C:\\Users\\Jane\\x b C:/Users/Jane/y "C:\\\\Users\\\\Jane\\\\z"', [home], false),
    'a <home>\\x b <home>/y "<home>\\\\z"',
  );
  assert.equal(scrubHome('c:\\users\\jane\\x', [home], true), '<home>\\x');
  assert.equal(scrubHome('c:\\users\\jane\\x', [home], false), 'c:\\users\\jane\\x');
  assert.equal(scrubHome('unchanged', [''], false), 'unchanged');
  assert.deepEqual(parentHomeDirectories({ USERPROFILE: 'C:\\Users\\Jane', HOME: 'C:\\Users\\Jane' }, 'C:\\Users\\Jane'), ['C:\\Users\\Jane']);
  assert.deepEqual(parentHomeDirectories({}, ''), []);
});

const entry = (address: string, internal: boolean): NetworkInterfaceInfo => ({
  address,
  netmask: '255.0.0.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/8`,
});

test('the loopback-only check passes only when every interface address is internal, and only when the flag asks for it', () => {
  const loopbackOnly = { lo: [entry('127.0.0.1', true)] };
  const exposed = { lo: [entry('127.0.0.1', true)], eth0: [entry('10.0.0.5', false)] };
  assert.deepEqual(nonInternalAddresses(loopbackOnly), []);
  assert.deepEqual(nonInternalAddresses(exposed), ['eth0 10.0.0.5']);

  assert.deepEqual(checkLoopbackOnlyNetwork(loopbackOnly, '1'), { status: 'verified' });
  const failed = checkLoopbackOnlyNetwork(exposed, '1');
  assert.equal(failed.status, 'failed');
  assert.match(failed.status === 'failed' ? failed.reason : '', /HARNESS_E2E_NETNS=1 was set but the process is not in a loopback-only network namespace/);
  assert.match(failed.status === 'failed' ? failed.reason : '', /eth0 10\.0\.0\.5/);

  // Without the flag nothing is claimed, even on an exposed host.
  assert.deepEqual(checkLoopbackOnlyNetwork(exposed, undefined), { status: 'not-requested' });
  assert.deepEqual(checkLoopbackOnlyNetwork(loopbackOnly, '0'), { status: 'not-requested' });

  // The record says netns only when the flag was set and the check passed.
  assert.equal(enforcementOf(checkLoopbackOnlyNetwork(loopbackOnly, '1')), 'netns');
  assert.equal(enforcementOf(checkLoopbackOnlyNetwork(exposed, '1')), 'none');
  assert.equal(enforcementOf(checkLoopbackOnlyNetwork(loopbackOnly, undefined)), 'none');
});

// --- Process safety (BH-034 F9). Short `node` children only; never OpenCode, never a process found by name. ---

const SLEEP_SCRIPT = 'setTimeout(() => {}, 60000)';
const SHORT_TIMEOUT_MS = 1500;
const IDLE_TIMEOUT_MS = 60_000;

/** Whether a PID names a live process. EPERM means the process exists but is not ours, so it is alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Kills one PID the test itself started. Used only in a finally block; a process that is gone is not an error. */
function killOwnPid(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
}

function sleepingNode(): ChildProcess {
  const child = spawn(process.execPath, ['-e', SLEEP_SCRIPT], { stdio: 'ignore', windowsHide: true, shell: false });
  child.on('error', () => undefined);
  return child;
}

test('a child that outlives its overall timeout is terminated and the result status is timed-out', async () => {
  const result = await runChild(process.execPath, ['-e', SLEEP_SCRIPT], {
    cwd: tmpdir(),
    env: { ...process.env },
    timeoutMs: SHORT_TIMEOUT_MS,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
  });
  assert.equal(result.status, 'timed-out');
  assert.ok(result.durationMs < 60_000, `the run must end at the timeout, not at the child's own sleep (took ${result.durationMs} ms)`);
});

test('an unrelated sleeping node process with the same image name survives the termination', async t => {
  const bystander = sleepingNode();
  const pid = bystander.pid;
  t.after(() => { if (pid !== undefined) killOwnPid(pid); });
  assert.notEqual(pid, undefined, 'the bystander must start');
  const result = await runChild(process.execPath, ['-e', SLEEP_SCRIPT], {
    cwd: tmpdir(),
    env: { ...process.env },
    timeoutMs: SHORT_TIMEOUT_MS,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
  });
  assert.equal(result.status, 'timed-out');
  assert.equal(bystander.exitCode, null, 'the bystander must not have exited');
  assert.equal(bystander.signalCode, null, 'the bystander must not have been signalled');
  assert.equal(alive(pid ?? -1), true, 'the unrelated process must still be alive');
});

test('a grandchild of the timed-out child is also gone (Windows: taskkill /T by PID)', {
  skip: process.platform === 'win32' ? false : 'Windows only; the POSIX process-group variant follows',
  timeout: 60_000,
}, async t => {
  const root = makeTempRoot('harness-e2e-grandchild-');
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const pidFile = join(root, 'grandchild.pid');
  const script = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(SLEEP_SCRIPT)}], { stdio: 'ignore', windowsHide: true });`,
    'writeFileSync(process.argv[1], String(grandchild.pid));',
    `setTimeout(() => {}, 60000);`,
  ].join('\n');
  const result = await runChild(process.execPath, ['-e', script, pidFile], {
    cwd: root,
    env: { ...process.env },
    timeoutMs: 4000,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
  });
  assert.equal(result.status, 'timed-out');
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isInteger(grandchild) && grandchild > 0, `the child must have written its grandchild PID; stderr: ${result.stderr.slice(0, 200)}`);
  t.after(() => killOwnPid(grandchild));
  const deadline = Date.now() + 5000;
  while (alive(grandchild) && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
  assert.equal(alive(grandchild), false, 'the grandchild must be gone after the child was terminated');
});

/**
 * POSIX: true when a PID is gone or is a zombie (killed but not yet reaped by its parent or init). kill(pid, 0)
 * succeeds for a zombie, so the state is read from /proc/<pid>/stat where /proc exists, and from `ps` elsewhere.
 * An unknown state (ps cannot run) is reported as not gone, so the test fails rather than passes by accident.
 */
function posixProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
  }
  if (existsSync('/proc')) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Format: "pid (comm) state ...". The command name may hold spaces or parentheses, so read after the last ')'.
      const state = stat.charAt(stat.lastIndexOf(')') + 2);
      return state === 'Z' || state === 'X';
    } catch {
      // The file vanished between the checks: the process has been reaped.
      return true;
    }
  }
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (ps.error !== undefined) return false;
  const state = ps.stdout.trim();
  return state === '' || state.startsWith('Z');
}

test('POSIX: a grandchild of the timed-out child is also gone after the process group is killed', {
  skip: process.platform === 'win32' ? 'POSIX only; the Windows variant is above' : false,
  timeout: 60_000,
}, async t => {
  const root = makeTempRoot('harness-e2e-grandchild-posix-');
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const pidFile = join(root, 'grandchild.pid');
  // The child is spawned with detached: true (its own process group), and the grandchild inherits that group.
  const script = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(SLEEP_SCRIPT)}], { stdio: 'ignore' });`,
    'writeFileSync(process.argv[1], String(grandchild.pid));',
    'setTimeout(() => {}, 60000);',
  ].join('\n');
  const runTimeoutMs = 4000;
  const result = await runChild(process.execPath, ['-e', script, pidFile], {
    cwd: root,
    env: { ...process.env },
    timeoutMs: runTimeoutMs,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
  });
  assert.equal(result.status, 'timed-out');
  // A missing or empty PID file gets a named failure instead of an opaque ENOENT from readFileSync.
  const pidText = existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : '';
  if (pidText.trim() === '') {
    assert.fail(`the child did not write the grandchild PID file ${pidFile} within the ${runTimeoutMs} ms timeout (status ${result.status}); stderr: ${result.stderr.slice(0, 200)}`);
  }
  const grandchild = Number(pidText);
  assert.ok(Number.isInteger(grandchild) && grandchild > 0, `the child must have written its grandchild PID; stderr: ${result.stderr.slice(0, 200)}`);
  t.after(() => killOwnPid(grandchild));
  const deadline = Date.now() + 5000;
  while (!posixProcessGone(grandchild) && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
  assert.equal(posixProcessGone(grandchild), true, 'the grandchild must be gone (dead or a reaped zombie) after the process group was killed');
});

test('classification keeps sorted, de-duplicated destination lists and no counts', () => {
  const classified = classifyProxyAttempts([
    { method: 'CONNECT', host: 'models.opencode.ai:443' },
    { method: 'CONNECT', host: 'example.com:443' },
    { method: 'CONNECT', host: 'models.opencode.ai:443' },
    { method: 'CONNECT', host: 'example.com:443' },
  ]);
  assert.deepEqual(classified, { tolerated: ['CONNECT models.opencode.ai:443'], unexpected: ['CONNECT example.com:443'] });
});
