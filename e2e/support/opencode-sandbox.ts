// Process harness for the agent E2E suite (BH-034, issue #62).
//
// The pinned version, version parsing, the child-environment builder, scrubbing, and the child process runner.
// Sandbox creation calls the installer's exported functions in the order that src/installer-flow.ts uses them
// for a project-scope OpenCode install, WITHOUT its prompts, receipts, or backups. Nothing here installs into
// the real home directory.
//
// Safety rules (see docs/agent-e2e.md):
// - The OpenCode binary comes only from HARNESS_E2E_OPENCODE (absolute path to a file). PATH is never searched.
// - Only the child PID this module spawned is ever terminated, and its descendants by that PID. Nothing is
//   killed by image name and no process list is enumerated.
// - Inside the sandbox, service or PTY state files may be read to report them, never to find PIDs to kill.

import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRoot } from '../../test/temp-directory.ts';
import { loadNativeDefinitions, updateNativeConfiguration } from '../../src/native-installer.ts';
import { nativeRoles, type NativeRole } from '../../src/native-role-types.ts';
import { applyProcedureFiles, canonicalProcedurePath, discoverProcedureSkills, planProcedureDeployment } from '../../src/procedure-deployment.ts';
import { applyCommandDeployment, filterCommandPlanForExecution, loadWorkflowCommands, planCommandDeployment } from '../../src/command-deployment.ts';

/** The single source of truth for the pinned OpenCode version (`opencode --version` prints `opencode v2.3.0`). */
export const REQUIRED_OPENCODE_VERSION = '2.3.0';
/** Accepts exactly `opencode v<semver>`, `v<semver>`, or `<semver>` as the whole trimmed output. */
export const VERSION_LINE = /^(?:opencode v|v)?(\d+\.\d+\.\d+)$/;
export const PROVIDER = 'harness-loopback';
export const SCRATCH_README_SENTINEL = 'E2E-README-SENTINEL-7f3a';
export const SCRATCH_NOTES_SENTINEL = 'E2E-NOTES-SENTINEL-7f3a';
export const SENTINEL_COMMIT_SUBJECT = 'e2e-sentinel-commit';
export const INSTALL_COMMIT_SUBJECT = 'e2e-harness-install';
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const ACTIVITY_POLL_MS = 1000;
const VERSION_TIMEOUT_MS = 30_000;
const PROXY_LINE_LIMIT = 8192;
const PROXY_SOCKET_TIMEOUT_MS = 5000;
const HOST_LIMIT = 200;
const SANDBOX_NAME = /^[a-z][a-z0-9-]*$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const URL_IN_LOG = /https?:\/\/[^\s"'<>`]+/gi;
const AGENTS_DIRECTORY = fileURLToPath(new URL('../../agents/', import.meta.url));
const SKILLS_DIRECTORY = fileURLToPath(new URL('../../skills/', import.meta.url));
const COMMANDS_DIRECTORY = fileURLToPath(new URL('../../.opencode/commands/', import.meta.url));
export const GIT_CONFIG = '[user]\n\tname = Harness E2E Sandbox\n\temail = e2e-sandbox@sandbox.invalid\n[init]\n\tdefaultBranch = main\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n';

/**
 * Denylist of inherited variables removed from the child environment. Pattern-based and case-insensitive: a name
 * that matches any pattern is removed, so this is not an allowlist and an unlisted secret name is not caught by
 * design. Covers credential shapes (secret, password, credential, key, token, PAT suffixes, and vendor prefixes),
 * OpenCode and npm state, every GIT_* variable (repository location, index, object store, identity, and config
 * overrides), HTTP, HTTPS, ALL, and NO proxy variables in any letter case, the test runner's NODE_TEST_CONTEXT,
 * the Windows HOMEDRIVE and HOMEPATH variables, launch-directory state, and HARNESS_E2E_* variables.
 * Names the child needs (PATH, SystemRoot, COMSPEC, TEMP, TMP, and the home variables set by childEnvironment)
 * match none of these patterns; the unit tests assert that.
 */
export const REMOVED_ENVIRONMENT: readonly RegExp[] = [
  // Credential shapes.
  /SECRET/i, /PASSWORD/i, /PASSWD/i, /CREDENTIAL/i, /_KEY$/i, /_TOKEN$/i, /_PAT$/i, /^NODE_AUTH_TOKEN$/i,
  /^SSH_/i, /^GH_/i, /^GITHUB_/i, /^NPM_CONFIG_/i, /^AWS_/i, /^AZURE_/i, /^GOOGLE_/i, /^ANTHROPIC_/i, /^OPENAI_/i,
  // Provider, tool, and Git state. Every GIT_* name is removed; childEnvironment then sets its own Git variables.
  /^OPENCODE_/i, /^GIT_/i, /^NODE_OPTIONS$/i, /^NODE_TEST_CONTEXT$/i, /^XDG_/i,
  /^HOMEDRIVE$/i, /^HOMEPATH$/i, /^HARNESS_E2E_/i,
  // Proxy variables, in every letter case.
  /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i,
  // Launch-directory and npm state. An inherited PWD made OpenCode boot in the launch directory (observed).
  /^PWD$/i, /^OLDPWD$/i, /^INIT_CWD$/i, /^npm_/i,
];

/** True when an inherited variable name is removed from the child environment (see REMOVED_ENVIRONMENT). */
export function isRemovedEnvironmentName(name: string): boolean {
  return REMOVED_ENVIRONMENT.some(pattern => pattern.test(name));
}

/** Pure check of a `--version` stdout. Returns the bare version, or undefined when the output does not match. */
export function parseOpenCodeVersion(stdout: string): string | undefined {
  return VERSION_LINE.exec(stdout.trim())?.[1];
}

/**
 * Removes absolute sandbox paths, including forward-slash and JSON-escaped forms, replacing each with `<sandbox>`.
 * `caseInsensitive` (pass true on Windows) also matches the root regardless of letter case. Absent: case-sensitive.
 */
export function scrubSandbox(text: string, root: string, caseInsensitive = false): string {
  if (root === '') return text;
  const forward = root.replaceAll('\\', '/');
  const variants = new Set([root, forward, JSON.stringify(root).slice(1, -1), JSON.stringify(forward).slice(1, -1)]);
  if (!caseInsensitive) {
    let result = text;
    for (const variant of variants) result = result.replaceAll(variant, '<sandbox>');
    return result;
  }
  const ordered = [...variants].sort((a, b) => b.length - a.length);
  return text.replace(new RegExp(ordered.map(escapeForPattern).join('|'), 'gi'), '<sandbox>');
}

/**
 * The parent process's home directory values: `home` (from os.homedir()), USERPROFILE, and HOME, without empty or
 * duplicate values. Used only to scrub output; the child is always given the sandbox home instead.
 */
export function parentHomeDirectories(env: NodeJS.ProcessEnv, home: string): string[] {
  return [...new Set([home, env.USERPROFILE ?? '', env.HOME ?? ''].filter(value => value !== ''))];
}

const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Replaces each home directory, in raw, forward-slash, and JSON-escaped forms, with `<home>`. Longest variants
 * first. `caseInsensitive` is passed by the caller (true on Windows, where path case is not significant).
 */
export function scrubHome(text: string, homes: readonly string[], caseInsensitive: boolean): string {
  const variants = new Set<string>();
  for (const home of homes) {
    if (home === '') continue;
    const forward = home.replaceAll('\\', '/');
    for (const variant of [home, forward, JSON.stringify(home).slice(1, -1), JSON.stringify(forward).slice(1, -1)]) {
      if (variant !== '') variants.add(variant);
    }
  }
  if (variants.size === 0) return text;
  const ordered = [...variants].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(ordered.map(escapeForPattern).join('|'), caseInsensitive ? 'gi' : 'g');
  return text.replace(pattern, '<home>');
}

/**
 * The names of all interfaces' addresses that are not internal (loopback). Pure: `interfaces` is the map that
 * os.networkInterfaces() returns. An empty result means every address is loopback or internal.
 */
export function nonInternalAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  return Object.entries(interfaces).flatMap(([name, entries]) =>
    (entries ?? []).filter(entry => entry.internal !== true).map(entry => `${name} ${entry.address}`));
}

export type NetnsCheck =
  | { status: 'not-requested' }
  | { status: 'verified' }
  | { status: 'failed'; reason: string };

/**
 * The loopback-only namespace check. Unset or any value other than '1': not requested (nothing is claimed). '1'
 * with every interface address internal: verified. '1' with any non-internal address: failed, so the suite must
 * not run journeys as passing. Pure: takes the interfaces map and the flag value.
 */
export function checkLoopbackOnlyNetwork(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, flag: string | undefined): NetnsCheck {
  if (flag !== '1') return { status: 'not-requested' };
  const exposed = nonInternalAddresses(interfaces);
  if (exposed.length === 0) return { status: 'verified' };
  return {
    status: 'failed',
    reason: `HARNESS_E2E_NETNS=1 was set but the process is not in a loopback-only network namespace: non-loopback addresses are present (${exposed.join('; ')}). Run the suite inside a loopback-only namespace, or unset HARNESS_E2E_NETNS. No journey was run.`,
  };
}

/** The journey record's network enforcement: `netns` only when the flag was set AND the check passed. */
export function enforcementOf(check: NetnsCheck): 'netns' | 'none' {
  return check.status === 'verified' ? 'netns' : 'none';
}

/** The loopback-only check against the live interfaces, for the suite's startup. */
export function currentLoopbackCheck(flag: string | undefined): NetnsCheck {
  return checkLoopbackOnlyNetwork(networkInterfaces(), flag);
}

/** Distinct non-loopback host names in http(s) URLs found in text. A hint for the human, not a guarantee. */
export function networkHostsIn(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.matchAll(URL_IN_LOG)) {
    try {
      const hostname = new URL(match[0]).hostname;
      if (hostname !== '' && !LOOPBACK_HOSTS.has(hostname)) hosts.add(hostname);
    } catch {
      // Not a URL: ignored.
    }
  }
  return [...hosts].sort();
}

// ---------------------------------------------------------------------------
// Layout and child environment
// ---------------------------------------------------------------------------

export interface SandboxLayout {
  root: string;
  home: string;
  project: string;
  xdgConfigHome: string;
  backups: string;
  gitConfig: string;
}

export function sandboxLayout(root: string): SandboxLayout {
  const home = join(root, 'home');
  return {
    root,
    home,
    project: join(root, 'project'),
    xdgConfigHome: join(home, '.config'),
    backups: join(root, 'backups'),
    gitConfig: join(root, 'gitconfig'),
  };
}

export function createLayoutDirectories(layout: SandboxLayout): void {
  const directories = [
    layout.project, layout.backups, layout.xdgConfigHome,
    join(layout.home, '.local', 'share'), join(layout.home, '.local', 'state'), join(layout.home, '.cache'),
    join(layout.home, 'AppData', 'Roaming'), join(layout.home, 'AppData', 'Local'),
  ];
  for (const directory of directories) mkdirSync(directory, { recursive: true });
}

export interface ChildEnvironmentOptions {
  /** When set, the HTTP(S) proxy variables point here and NO_PROXY covers loopback. */
  proxyUrl?: string;
}

/**
 * Builds a child environment: inherited variables minus REMOVED_ENVIRONMENT, then HOME/XDG/APPDATA redirection,
 * OPENCODE_DB inside the sandbox, Git config isolation, and PWD set to `directory`. Pure: `inherited` is a parameter.
 */
export function childEnvironment(inherited: NodeJS.ProcessEnv, layout: SandboxLayout, directory: string, options: ChildEnvironmentOptions = {}): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(inherited).filter(([name]) => !REMOVED_ENVIRONMENT.some(pattern => pattern.test(name))));
  const env: NodeJS.ProcessEnv = {
    ...kept,
    HOME: layout.home,
    USERPROFILE: layout.home,
    XDG_CONFIG_HOME: layout.xdgConfigHome,
    XDG_DATA_HOME: join(layout.home, '.local', 'share'),
    XDG_STATE_HOME: join(layout.home, '.local', 'state'),
    XDG_CACHE_HOME: join(layout.home, '.cache'),
    APPDATA: join(layout.home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(layout.home, 'AppData', 'Local'),
    OPENCODE_DB: join(layout.root, 'opencode.db'),
    GIT_CONFIG_GLOBAL: layout.gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
    PWD: directory,
  };
  if (options.proxyUrl !== undefined) {
    // Set after the removal above, so these are the suite's own values and never inherited ones.
    for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) env[name] = options.proxyUrl;
    env.NO_PROXY = '127.0.0.1,localhost,::1';
    env.no_proxy = '127.0.0.1,localhost,::1';
  }
  return env;
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

export type BinaryResolution =
  | { status: 'ready'; binary: string; version: string }
  | { status: 'skip'; reason: string }
  | { status: 'error'; reason: string };

/** Runs `<binary> --version` in a throwaway sandboxed environment and returns its stdout. Throws on failure. */
export type VersionProbe = (binary: string, inherited: NodeJS.ProcessEnv) => string;

export function probeOpenCodeVersion(binary: string, inherited: NodeJS.ProcessEnv): string {
  const root = makeTempRoot('harness-e2e-version-');
  try {
    const layout = sandboxLayout(root);
    createLayoutDirectories(layout);
    const result = spawnSync(binary, ['--version'], {
      cwd: root,
      env: childEnvironment(inherited, layout, root),
      encoding: 'utf8',
      timeout: VERSION_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`exit status ${String(result.status)}`);
    return result.stdout;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

function isExistingFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * Resolves the binary from HARNESS_E2E_OPENCODE only. Unset: skip, or error when HARNESS_E2E_REQUIRE=1.
 * Set but empty, relative, not a file, or reporting a version other than REQUIRED_OPENCODE_VERSION: error.
 */
export function resolveOpenCodeBinary(env: NodeJS.ProcessEnv, probe: VersionProbe = probeOpenCodeVersion): BinaryResolution {
  const value = env.HARNESS_E2E_OPENCODE;
  const required = env.HARNESS_E2E_REQUIRE === '1';
  if (value === undefined) {
    return required
      ? { status: 'error', reason: 'HARNESS_E2E_REQUIRE=1 but HARNESS_E2E_OPENCODE is not set. Set it to the absolute path of OpenCode ' + REQUIRED_OPENCODE_VERSION + '.' }
      : { status: 'skip', reason: 'HARNESS_E2E_OPENCODE is not set; every agent E2E journey is skipped (a skip is not a pass).' };
  }
  if (value === '') return { status: 'error', reason: 'HARNESS_E2E_OPENCODE is set but empty.' };
  if (!isAbsolute(value)) return { status: 'error', reason: 'HARNESS_E2E_OPENCODE must be an absolute path.' };
  if (!isExistingFile(value)) return { status: 'error', reason: 'HARNESS_E2E_OPENCODE does not point to an existing file.' };
  let stdout: string;
  try {
    stdout = probe(value, env);
  } catch (error) {
    return { status: 'error', reason: `OpenCode --version failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const version = parseOpenCodeVersion(stdout);
  if (version !== REQUIRED_OPENCODE_VERSION) {
    return { status: 'error', reason: `OpenCode reported ${JSON.stringify(stdout.trim().split(/\r?\n/, 1)[0]?.slice(0, 80) ?? '')}; the suite requires exactly ${REQUIRED_OPENCODE_VERSION}.` };
  }
  return { status: 'ready', binary: value, version };
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/** Flags shared by every run, in the order of the 2.3.0 usage line. --standalone is always present. */
export const RUN_FLAGS: readonly string[] = [
  '--standalone', '--print-logs', '--log-level', 'debug', '--archived',
  '--agent', 'lead', '--model', `${PROVIDER}/lead`, '--format', 'json',
];

/** Refuses any argv that would not use a private server. Called before every spawn. */
export function assertStandaloneArguments(args: readonly string[]): void {
  if (!args.includes('--standalone') || args.includes('--server')) {
    throw new Error('Refusing to run OpenCode without --standalone or with --server.');
  }
}

/** The exact `run` argv: subcommand, shared flags, optional `--auto`, then the message. */
export function runArguments(message: string, auto: boolean): string[] {
  const args = ['run', ...RUN_FLAGS, ...(auto ? ['--auto'] : []), message];
  assertStandaloneArguments(args);
  return args;
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export interface OpenCodeSandbox {
  name: string;
  root: string;
  project: string;
  layout: SandboxLayout;
  /** Runs git in the scratch project with the sandbox environment. Throws on a non-zero exit. */
  git(args: readonly string[]): string;
  dispose(): void;
}

function removeRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: sandbox could not be removed (${scrubHome(message, parentHomeDirectories(process.env, homedir()), process.platform === 'win32')}).`);
  }
}

/**
 * Installs the harness for OpenCode at project scope into the scratch project, using the installer's exported
 * functions in the order src/installer-flow.ts uses them. Agent `system` and `permissions` are written by
 * updateNativeConfiguration and not changed afterwards. Only the providers block is added.
 */
function installHarness(layout: SandboxLayout, baseURL: string): void {
  const definitions = loadNativeDefinitions(AGENTS_DIRECTORY);
  const assignments = Object.fromEntries(nativeRoles.map(role => [role, `${PROVIDER}/${role}`])) as Record<NativeRole, string>;
  // setDefault true (default_agent lead), setLeadModel false (root model preserved), no replaced models, no prior reconciliation.
  const installed = updateNativeConfiguration('{}\n', definitions, assignments, true, false, [], {});
  const config = JSON.parse(installed) as Record<string, unknown>;
  config.providers = {
    [PROVIDER]: {
      name: 'Harness loopback',
      env: [],
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL },
      models: Object.fromEntries(nativeRoles.map(role => [role, { name: role }])),
    },
  };
  writeFileSync(join(layout.project, 'opencode.json'), `${JSON.stringify(config, null, 2)}\n`);

  const skillPlan = planProcedureDeployment(discoverProcedureSkills(SKILLS_DIRECTORY, 'opencode'), layout.project, [], false);
  applyProcedureFiles(skillPlan, new Set(skillPlan.map(file => canonicalProcedurePath(file.path))), layout.backups);

  const commandsDirectory = join(layout.project, '.opencode', 'commands');
  const commandPlan = planCommandDeployment(loadWorkflowCommands(COMMANDS_DIRECTORY), commandsDirectory, []);
  const { filesToWrite } = filterCommandPlanForExecution(commandPlan, false);
  applyCommandDeployment(filesToWrite, commandsDirectory);
}

/**
 * Creates a fresh sandbox: redirected home, a scratch Git repository with README.md and notes.md (each with a
 * unique sentinel) committed as `e2e-sentinel-commit`, the installed harness committed as `e2e-harness-install`,
 * and a global config with updates disabled. `baseURL` is the loopback fixture's base URL, which must be known
 * before the install commit is written, so the fixture starts first. Throws if creation fails; removes partial state.
 */
export function createOpenCodeSandbox(name: string, options: { baseURL: string }): OpenCodeSandbox {
  if (!SANDBOX_NAME.test(name)) throw new Error(`Sandbox name must be lower-case words separated by hyphens: ${JSON.stringify(name)}`);
  const root = makeTempRoot(`harness-e2e-${name}-`);
  const layout = sandboxLayout(root);
  let complete = false;
  try {
    createLayoutDirectories(layout);
    writeFileSync(layout.gitConfig, GIT_CONFIG);
    const env = childEnvironment(process.env, layout, layout.project);
    const git = (args: readonly string[]): string => execFileSync('git', [...args], { cwd: layout.project, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    git(['init', '--quiet']);
    writeFileSync(join(layout.project, 'README.md'), `# Scratch repository\n\n${SCRATCH_README_SENTINEL}\n`);
    writeFileSync(join(layout.project, 'notes.md'), `# Notes\n\n${SCRATCH_NOTES_SENTINEL}\n`);
    git(['add', 'README.md', 'notes.md']);
    git(['commit', '--quiet', '-m', SENTINEL_COMMIT_SUBJECT]);
    installHarness(layout, options.baseURL);
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', INSTALL_COMMIT_SUBJECT]);
    const globalDirectory = join(layout.xdgConfigHome, 'opencode');
    mkdirSync(globalDirectory, { recursive: true });
    writeFileSync(join(globalDirectory, 'opencode.json'), '{\n  "update": "disable"\n}\n');
    complete = true;
    return { name, root, project: layout.project, layout, git: args => git(args), dispose: () => removeRoot(root) };
  } finally {
    if (!complete) removeRoot(root);
  }
}

// ---------------------------------------------------------------------------
// Proxy recorder
// ---------------------------------------------------------------------------

export interface ProxyAttempt { method: string; host: string }

export interface ProxyRecorder {
  readonly url: string;
  /** One entry per accepted connection, in order. Only the method and host of the first request line are kept. */
  attempts(): ProxyAttempt[];
  close(): Promise<void>;
}

/** Method and host from a proxy request line. Headers and bodies are never passed in and never kept. */
export function parseProxyRequestLine(line: string): ProxyAttempt {
  const [rawMethod = '', target = ''] = line.trim().split(/\s+/);
  const method = /^[A-Z]{1,10}$/.test(rawMethod) ? rawMethod : '(unparsed)';
  let host = '(no host)';
  if (method === 'CONNECT') host = target === '' ? '(unparsed)' : target;
  else if (/^https?:\/\//i.test(target)) {
    try { host = new URL(target).host; } catch { host = '(unparsed)'; }
  }
  return { method, host: host.slice(0, HOST_LIMIT) };
}

/** Starts a loopback recorder on 127.0.0.1 with an ephemeral port. Each connection is counted and then closed. */
export function startProxyRecorder(): Promise<ProxyRecorder> {
  const attempts: ProxyAttempt[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    const attempt: ProxyAttempt = { method: '(no request line)', host: '(none)' };
    attempts.push(attempt);
    sockets.add(socket);
    socket.setTimeout(PROXY_SOCKET_TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => undefined);
    socket.on('close', () => { sockets.delete(socket); });
    let buffered = '';
    let parsed = false;
    socket.on('data', (chunk: Buffer) => {
      if (parsed) return;
      buffered += chunk.toString('latin1');
      const end = buffered.indexOf('\n');
      if (end < 0 && buffered.length < PROXY_LINE_LIMIT) return;
      parsed = true;
      const line = parseProxyRequestLine(end < 0 ? buffered.slice(0, PROXY_LINE_LIMIT) : buffered.slice(0, end));
      attempt.method = line.method;
      attempt.host = line.host;
      buffered = '';
      socket.destroy();
    });
  });
  return new Promise<ProxyRecorder>((resolveRecorder, rejectRecorder) => {
    server.once('error', rejectRecorder);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectRecorder);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        rejectRecorder(new Error('proxy recorder must bind a TCP port on 127.0.0.1'));
        return;
      }
      let closing: Promise<void> | undefined;
      const close = (): Promise<void> => {
        if (closing === undefined) {
          closing = new Promise<void>((done, fail) => {
            for (const socket of sockets) socket.destroy();
            server.close(error => {
              // A recorder that is already closed is not an error: close() stays idempotent.
              if (error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') fail(error);
              else done();
            });
          });
        }
        return closing;
      };
      resolveRecorder({
        url: `http://127.0.0.1:${address.port}`,
        attempts: () => attempts.map(attempt => ({ ...attempt })),
        close,
      });
    });
  });
}

/** True when a recorded host names the loopback interface (the NO_PROXY misrouting case). */
export function isLoopbackHost(host: string): boolean {
  const withoutPort = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '');
  return LOOPBACK_HOSTS.has(withoutPort);
}

/**
 * Destinations OpenCode 2.3.0 contacts on its own at startup, as `METHOD host:port`: the models catalogue refresh,
 * seen on every run as `CONNECT models.opencode.ai:443`. No off switch was found, so an attempt matching one of these
 * is tolerated and is recorded, not reported as a violation. Tied to the pinned version (REQUIRED_OPENCODE_VERSION):
 * re-check this list on any re-pin. Matching is exact on method, host (case-insensitively), and port, with no
 * wildcard or suffix match. A plain-HTTP request to the same host and port is not tolerated.
 */
export const TOLERATED_STARTUP_DESTINATIONS: readonly string[] = ['CONNECT models.opencode.ai:443'];

/** A recorded attempt as `METHOD host`, the form used in network records and violation text. */
export function destinationOf(attempt: ProxyAttempt): string {
  return `${attempt.method} ${attempt.host}`;
}

/** True when the attempt's method exactly, and its host and port, match a tolerated startup destination. */
export function isToleratedAttempt(attempt: ProxyAttempt): boolean {
  const target = attempt.host.toLowerCase();
  return TOLERATED_STARTUP_DESTINATIONS.some(destination => {
    const [method = '', ...hostParts] = destination.split(' ');
    return method === attempt.method && hostParts.join(' ').toLowerCase() === target;
  });
}

/** Sorted (by code unit) and de-duplicated copy of the strings. */
export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Splits recorded attempts into tolerated and unexpected destinations, each as a sorted, de-duplicated list of
 * `METHOD host` strings. Counts are not kept: the number of retries OpenCode makes may vary between runs.
 */
export function classifyProxyAttempts(attempts: readonly ProxyAttempt[]): { tolerated: string[]; unexpected: string[] } {
  return {
    tolerated: sortedUnique(attempts.filter(isToleratedAttempt).map(destinationOf)),
    unexpected: sortedUnique(attempts.filter(attempt => !isToleratedAttempt(attempt)).map(destinationOf)),
  };
}

// ---------------------------------------------------------------------------
// Child process
// ---------------------------------------------------------------------------

export type RunStatus = 'completed' | 'timed-out' | 'idle-timeout';

export interface OpenCodeRunOptions {
  message: string;
  auto: boolean;
  /** Proxy recorder URL for the child's HTTP(S) proxy variables. */
  proxyUrl: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  /** Count of fixture requests so far, polled once a second. Idle time counts only after the first request. */
  activity?: () => number;
}

export interface OpenCodeRunResult {
  status: RunStatus;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  argv: string[];
}

/**
 * Terminates the child this module spawned, and its descendants by that PID only. Windows: taskkill /PID /T /F
 * via execFile without a shell. POSIX: SIGKILL to the process group created with detached: true. Never by name.
 */
export function terminateChild(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise<void>(done => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => done());
    });
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  return Promise.resolve();
}

/**
 * Runs one `run` invocation in the sandbox project. The child's cwd and PWD are the scratch project, the argv
 * is runArguments (which refuses a missing --standalone or any --server), and the environment is childEnvironment.
 */
export function runOpenCode(binary: string, sandbox: OpenCodeSandbox, options: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
  const args = runArguments(options.message, options.auto);
  return runChild(binary, args, {
    cwd: sandbox.project,
    env: childEnvironment(process.env, sandbox.layout, sandbox.project, { proxyUrl: options.proxyUrl }),
    timeoutMs: options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    ...(options.activity === undefined ? {} : { activity: options.activity }),
  });
}

export interface ChildRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  idleTimeoutMs: number;
  /** Count of activity so far, polled once a second. Idle time counts only after the count first exceeds zero. */
  activity?: () => number;
}

/**
 * Spawns an executable with the given argv (no shell), enforces the overall and idle timeouts by terminating the
 * child this call spawned (terminateChild), and resolves with its result. runOpenCode is the only production caller;
 * the process-safety tests drive it with a `node` child, which is the injectable seam for testing the timeout paths.
 */
export function runChild(executable: string, args: readonly string[], options: ChildRunOptions): Promise<OpenCodeRunResult> {
  const timeoutMs = options.timeoutMs;
  const idleTimeoutMs = options.idleTimeoutMs;
  return new Promise<OpenCodeRunResult>((resolveRun, rejectRun) => {
    const started = Date.now();
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let stopReason: RunStatus | undefined;
    const stop = (reason: RunStatus): void => {
      if (stopReason !== undefined) return;
      stopReason = reason;
      void terminateChild(child);
    };
    const overall = setTimeout(() => stop('timed-out'), timeoutMs);
    let lastCount = 0;
    let lastChange = Date.now();
    const poll = setInterval(() => {
      if (options.activity === undefined) return;
      const count = options.activity();
      if (count !== lastCount) {
        lastCount = count;
        lastChange = Date.now();
      } else if (count > 0 && Date.now() - lastChange >= idleTimeoutMs) {
        stop('idle-timeout');
      }
    }, ACTIVITY_POLL_MS);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', error => {
      clearTimeout(overall);
      clearInterval(poll);
      rejectRun(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(overall);
      clearInterval(poll);
      resolveRun({ status: stopReason ?? 'completed', exitCode, signal, stdout, stderr, durationMs: Date.now() - started, argv: [...args] });
    });
  });
}

/** Reads a file under the scratch project (sandbox-relative, forward slashes). */
export function readSandboxFile(sandbox: OpenCodeSandbox, relativePath: string): string {
  return readFileSync(join(sandbox.project, ...relativePath.split('/')), 'utf8');
}
