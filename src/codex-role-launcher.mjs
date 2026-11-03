#!/usr/bin/env node
// Advanced Harness Codex role launcher (#45). Installed to $CODEX_HOME/advanced-harness/codex-role.mjs
// and run by Lead, one approved launch per role task. Each role runs as its own `codex exec` process
// with the settings from $CODEX_HOME/harness-<role>.config.toml.
//
// The security settings are re-applied with -c on every launch and resume: `codex exec resume` takes
// no -p/-s, and a resumed thread otherwise falls back to the base config (#45 spike, 2026-11-02).
// Self-contained on purpose: the installed copy must not depend on the harness checkout.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Comment line marking the one role (External) that keeps the configured MCP servers. Codex ignores comments. */
export const mcpMarker = /^# advanced-harness: mcp=allowed\r?$/m;

/** Keys re-applied on every invocation. developer_instructions stays in the thread history on resume. */
export const securityKeys = ['sandbox_mode', 'approval_policy', 'sandbox_workspace_write.network_access', 'model', 'model_reasoning_effort'];

/**
 * Reads the harness-generated profile subset: `[table]` headers and single-line `key = value` entries.
 * Values are kept as raw TOML so they can be passed to `-c key=value` unchanged.
 */
export function parseProfile(text) {
  const values = new Map();
  let table = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header) { table = header[1]; continue; }
    const entry = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!entry) throw new Error(`Unsupported line in role profile: ${line.slice(0, 60)}`);
    values.set(table ? `${table}.${entry[1]}` : entry[1], entry[2]);
  }
  return values;
}

const tomlKey = name => /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);

/** Builds the codex argument list for one role launch or resume. Pure, for tests. */
export function buildRoleInvocation({ role, profileText, mcpServers, mcpAllowed, resumeId, task, schemaPath, resultPath }) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(role) || role === 'lead') throw new Error(`Not a launchable role: ${role}`);
  if (!task || !task.trim()) throw new Error('A task is required.');
  const profile = parseProfile(profileText);
  const overrides = [];
  for (const key of securityKeys) {
    if (!profile.has(key)) throw new Error(`Role profile for ${role} lacks ${key}; reinstall the harness.`);
    overrides.push('-c', `${key}=${profile.get(key)}`);
  }
  // Fail closed: every MCP server the effective config knows about is switched off unless the role owns MCP.
  if (!mcpAllowed) for (const name of mcpServers) overrides.push('-c', `mcp_servers.${tomlKey(name)}.enabled=false`);
  const output = ['--json', '--output-schema', schemaPath, '-o', resultPath];
  return resumeId
    ? ['exec', 'resume', ...overrides, ...output, resumeId, task]
    : ['-p', `harness-${role}`, 'exec', ...overrides, ...output, task];
}

/** Thread-to-role bindings this launcher records; a resume must name a thread the same role started. */
export const threadRegistryPath = home => join(home, 'advanced-harness', 'role-threads.json');

export function readThreadRegistry(path) {
  if (!existsSync(path)) return {};
  let registry;
  try { registry = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`Malformed role thread registry: ${path}; refusing to resume.`); }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry) || Object.values(registry).some(role => typeof role !== 'string')) {
    throw new Error(`Malformed role thread registry: ${path}; refusing to resume.`);
  }
  return registry;
}

/** Resuming runs with the selected role's permissions while keeping the thread's history, so the thread must be that role's. */
export function assertResumable(registry, threadId, role) {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(threadId)) throw new Error(`Invalid thread ID "${threadId}".`);
  const owner = Object.prototype.hasOwnProperty.call(registry, threadId) ? registry[threadId] : undefined;
  if (owner === undefined) throw new Error(`Unknown thread ${threadId}: only threads started by the role launcher can be resumed.`);
  if (owner !== role) throw new Error(`Thread ${threadId} belongs to ${owner}; it cannot be resumed as ${role}.`);
}

export function recordThread(path, threadId, role) {
  const registry = readThreadRegistry(path);
  registry[threadId] = role;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** CODEX_BIN, else the newest Codex Desktop bundled CLI on Windows, else `codex` on PATH. */
export function findCodexBinary(env = process.env) {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  if (process.platform === 'win32') {
    const bin = join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    if (existsSync(bin)) {
      const candidates = readdirSync(bin).map(dir => join(bin, dir, 'codex.exe')).filter(path => existsSync(path));
      candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (candidates[0]) return candidates[0];
    }
  }
  return 'codex';
}

function parseArgs(argv) {
  const [role, ...rest] = argv;
  const options = { role };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1];
    if (!['--task', '--cd', '--resume'].includes(flag) || value === undefined || options[flag]) throw new Error(`Unknown, duplicate, or incomplete option: ${flag ?? ''}`);
    options[flag] = value;
  }
  return options;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const home = env.CODEX_HOME || join(homedir(), '.codex');
  const profilePath = join(home, `harness-${options.role}.config.toml`);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(options.role ?? '') || options.role === 'lead' || !existsSync(profilePath)) {
    throw new Error(`Unknown role "${options.role}". Expected an installed harness role profile in ${home}.`);
  }
  const registryPath = threadRegistryPath(home);
  // Checked before anything runs: an unknown or other-role thread never starts.
  if (options['--resume'] !== undefined) assertResumable(readThreadRegistry(registryPath), options['--resume'], options.role);
  const profileText = readFileSync(profilePath, 'utf8');
  const mcpAllowed = mcpMarker.test(profileText);
  const codex = findCodexBinary(env);
  const cwd = options['--cd'] ?? process.cwd();
  let mcpServers = [];
  if (!mcpAllowed) {
    // A failed listing aborts the launch rather than starting a role with unknown MCP servers enabled.
    const listed = JSON.parse(execFileSync(codex, ['-p', `harness-${options.role}`, 'mcp', 'list', '--json'], { cwd, env, encoding: 'utf8', windowsHide: true }));
    mcpServers = listed.map(server => String(server.name));
  }
  const outputDir = join(tmpdir(), 'advanced-harness-codex');
  mkdirSync(outputDir, { recursive: true });
  const resultPath = join(outputDir, `${options.role}-${Date.now()}.json`);
  const args = buildRoleInvocation({
    role: options.role, profileText, mcpServers, mcpAllowed, resumeId: options['--resume'], task: options['--task'],
    schemaPath: join(home, 'advanced-harness', 'role-status.schema.json'), resultPath,
  });
  const run = spawnSync(codex, args, { cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  const startedId = run.stdout?.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return undefined; } })
    .find(event => event?.type === 'thread.started')?.thread_id;
  if (options['--resume'] === undefined && typeof startedId === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(startedId)) recordThread(registryPath, startedId, options.role);
  const threadId = startedId ?? options['--resume'];
  let result;
  try { result = JSON.parse(readFileSync(resultPath, 'utf8')); }
  catch { result = { status: 'Needs your decision', summary: 'The role ended without a parseable status report.', details: '' }; }
  console.log(JSON.stringify({ role: options.role, threadId, exitCode: run.status, ...result }, null, 2));
  return run.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
