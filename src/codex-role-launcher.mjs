#!/usr/bin/env node
// Advanced Harness Codex role launcher (#45). Installed to $CODEX_HOME/advanced-harness/codex-role.mjs
// and run by Lead, one launch per role task, each under host permission. Each role runs as its own `codex exec` process
// with the settings from $CODEX_HOME/harness-<role>.config.toml.
//
// The security settings are re-applied with -c on every launch and resume: `codex exec resume` takes
// no -p/-s, and a resumed thread otherwise falls back to the base config (#45 spike, 2026-11-02).
// Self-contained on purpose: the installed copy must not depend on the harness checkout.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Comment line marking the one role (External) that may use the MCP servers selected at install. Codex ignores comments. */
export const mcpMarker = /^# advanced-harness: mcp=allowed\r?$/m;

/** Keys re-applied on every invocation. developer_instructions stays in the thread history on resume. */
export const securityKeys = ['sandbox_mode', 'approval_policy', 'sandbox_workspace_write.network_access', 'sandbox_workspace_write.writable_roots', 'model', 'model_reasoning_effort'];

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
export function buildRoleInvocation({ role, profileText, mcpServers, mcpAllowed, mcpSelected = [], resumeId, task, schemaPath, resultPath, workspaceRoot }) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(role) || role === 'lead') throw new Error(`Not a launchable role: ${role}`);
  if (!task || !task.trim()) throw new Error('A task is required.');
  // Codex reads a lone "-" prompt from stdin, which the launcher closes: it would run with no task.
  if (task.trim() === '-') throw new Error('The task cannot be "-".');
  const profile = parseProfile(profileText);
  if (!profile.has('sandbox_workspace_write.writable_roots')) throw new Error(`Role profile for ${role} lacks sandbox_workspace_write.writable_roots; reinstall the harness.`);
  const baselineRoots = profile.get('sandbox_workspace_write.writable_roots');
  if (baselineRoots !== '[]') throw new Error(`Role profile for ${role} has an incompatible writable_roots baseline; reinstall the harness.`);
  const overrides = [];
  for (const key of securityKeys) {
    if (!profile.has(key)) throw new Error(`Role profile for ${role} lacks ${key}; reinstall the harness.`);
    let value = profile.get(key);
    if (key === 'sandbox_workspace_write.writable_roots') {
      if (role === 'implementer') {
        if (!isAbsolute(workspaceRoot ?? '')) throw new Error('Implementer requires a validated absolute workspace root.');
        value = `[${JSON.stringify(workspaceRoot)}]`;
      } else value = '[]';
    }
    overrides.push('-c', `${key}=${value}`);
  }
  // Fail closed: every MCP server the effective config knows about is switched off, except the servers
  // selected at install for the role that owns MCP. Selected servers stay disabled in the base config, so
  // this is the only place they are turned on; their disabled_tools still apply.
  for (const name of mcpServers) overrides.push('-c', `mcp_servers.${tomlKey(name)}.enabled=${mcpAllowed && mcpSelected.includes(name)}`);
  const output = ['--json', '--output-schema', schemaPath, '-o', resultPath];
  // Codex plugins are off for every child (#209). A plugin-provided MCP server has no [mcp_servers.<name>] table, so
  // the -c override for it would create a partial table that Codex rejects at config load.
  // "--" ends the options: a task starting with "-" is text, never a Codex flag that could widen the sandbox.
  return resumeId
    ? ['exec', 'resume', '--disable', 'plugins', ...overrides, ...output, '--', resumeId, task]
    : ['-p', `harness-${role}`, '--disable', 'plugins', 'exec', ...overrides, ...output, '--', task];
}

/** Codex subprocess boundary, injectable for launcher-entry regression tests. */
export const launcherRuntime = {
  execFileSync: (file, args, options) => execFileSync(file, args, options),
  spawnSync: (file, args, options) => spawnSync(file, args, options),
};

/**
 * Discovery call for a role's MCP servers, run with Codex plugins disabled so only servers defined in config.toml are listed.
 * `run(args)` executes Codex and returns its stdout. Throws, naming the role and Codex's stderr, when the listing fails, so no
 * role starts with an unknown MCP set.
 */
export function listMcpServers(role, run) {
  let stdout;
  try { stdout = run(['-p', `harness-${role}`, '--disable', 'plugins', 'mcp', 'list', '--json']); }
  catch (error) {
    const stderr = String(error?.stderr ?? '').trim();
    const reason = stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(`Codex could not list the MCP servers for role ${role}; no role was launched. Codex said: ${reason}`);
  }
  let listed;
  try { listed = JSON.parse(stdout); }
  catch { throw new Error(`Codex listed the MCP servers for role ${role} in an unreadable format; no role was launched.`); }
  if (!Array.isArray(listed)) throw new Error(`Codex listed the MCP servers for role ${role} in an unexpected format; no role was launched.`);
  return listed.map(server => String(server.name));
}

/** The MCP servers selected at install. Throws when unreadable, so External never starts with a guessed set. */
export function readSelectedMcpServers(home) {
  const path = join(home, '.advanced-harness-state.json');
  let selected;
  try { selected = JSON.parse(readFileSync(path, 'utf8')).selectedMcpServers; }
  catch { throw new Error(`Cannot read the selected MCP servers from ${path}. No role was launched; rerun harness:update.`); }
  if (!Array.isArray(selected) || selected.some(name => typeof name !== 'string')) throw new Error(`Malformed selectedMcpServers in ${path}. No role was launched; rerun harness:update.`);
  return selected;
}

export const threadIdPattern = /^[A-Za-z0-9-]{1,128}$/;
const rolePattern = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Thread-to-role bindings this launcher records; a resume must name a thread the same role started.
 * One file per thread, named by the thread ID and holding the role: each launch creates only its own
 * file, so concurrent launches never overwrite each other's bindings.
 */
export const threadBindingsPath = home => join(home, 'advanced-harness', 'role-threads');

/** All recorded bindings. Throws on anything unexpected, so no role launches on top of unknown state. */
export function readThreadBindings(dir) {
  if (!existsSync(dir)) return {};
  const malformed = detail => new Error(`Malformed role thread bindings in ${dir}: ${detail}. No role was launched; fix or remove that entry.`);
  if (!statSync(dir).isDirectory()) throw malformed('not a directory');
  const bindings = Object.create(null);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let info;
    try { info = statSync(path); } catch { throw malformed(`unreadable entry ${name}`); }
    if (!threadIdPattern.test(name) || !info.isFile()) throw malformed(`unexpected entry ${name}`);
    let role;
    let contents;
    try { contents = readFileSync(path, 'utf8'); } catch { throw malformed(`unreadable entry ${name}`); }
    try { role = JSON.parse(contents); } catch { role = contents.trim(); }
    if (typeof role === 'string') {
      if (!rolePattern.test(role)) throw malformed(`${name} does not name a role`);
    } else if (!role || typeof role !== 'object' || Array.isArray(role) || !rolePattern.test(role.role ?? '')
      || (role.role === 'implementer'
        ? Object.keys(role).sort().join(',') !== 'commonDir,gitDir,role,worktree' || !validateGitIdentity({ top: role.worktree, gitDir: role.gitDir, commonDir: role.commonDir })
        : Object.keys(role).join(',') !== 'role')) {
      throw malformed(`${name} does not name a role binding`);
    }
    bindings[name] = role;
  }
  return bindings;
}

/** Resuming runs with the selected role's permissions while keeping the thread's history, so the thread must be that role's. */
export function assertResumable(bindings, threadId, role) {
  if (!threadIdPattern.test(threadId)) throw new Error(`Invalid thread ID "${threadId}".`);
  const owner = Object.prototype.hasOwnProperty.call(bindings, threadId) ? bindings[threadId] : undefined;
  if (owner === undefined) throw new Error(`Unknown thread ${threadId}: only threads started by the role launcher can be resumed.`);
  const ownerRole = typeof owner === 'object' ? owner.role : owner;
  if (ownerRole !== role) throw new Error(`Thread ${threadId} belongs to ${ownerRole}; it cannot be resumed as ${role}.`);
}

/** Creates this thread's binding file exclusively; an existing binding is accepted only if it names the same role. */
export function recordThread(dir, threadId, role, identity) {
  if (!threadIdPattern.test(threadId)) throw new Error(`Invalid thread ID "${threadId}".`);
  if (role === 'implementer' && !validateGitIdentity(identity)) {
    throw new Error('Cannot record Implementer thread without complete Git worktree identity.');
  }
  mkdirSync(dir, { recursive: true });
  const value = role === 'implementer'
    ? { role, worktree: identity.top, gitDir: identity.gitDir, commonDir: identity.commonDir }
    : role;
  try { writeFileSync(join(dir, threadId), `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const owner = readThreadBindings(dir)[threadId];
    if ((typeof owner === 'string' ? owner : owner.role) !== role) throw new Error(`Thread ${threadId} is already bound to ${typeof owner === 'string' ? owner : owner.role}.`);
    if (role === 'implementer' && (typeof owner === 'string' || owner.worktree !== identity.top || owner.gitDir !== identity.gitDir || owner.commonDir !== identity.commonDir)) {
      throw new Error(`Thread ${threadId} is already bound to a different Implementer worktree.`);
    }
  }
}

/**
 * Turns a finished child run into Lead's report and the launcher exit code. A new thread that cannot be
 * recorded is reported, never thrown: the child has already done its work, so its thread ID, exit status
 * and result are kept and the outcome needs a human decision rather than a blind retry.
 */
export function reportRun({ role, resumeId, bindingsPath, stdout, exitCode, resultText, identity }) {
  const startedId = (stdout ?? '').split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return undefined; } })
    .find(event => event?.type === 'thread.started')?.thread_id;
  let result;
  try { result = JSON.parse(resultText ?? ''); }
  catch { result = { status: 'Needs your decision', summary: 'The role ended without a parseable status report.', details: '' }; }
  const threadId = startedId ?? resumeId;
  if (resumeId === undefined && typeof startedId === 'string' && threadIdPattern.test(startedId)) {
    try { recordThread(bindingsPath, startedId, role, identity); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        code: 2,
        report: {
          role, threadId, exitCode, status: 'Needs your decision',
          summary: `The ${role} run finished (exit ${exitCode}) but thread ${startedId} could not be recorded, so it cannot be resumed: ${reason}`,
          details: 'Do not repeat the task blindly: the role may already have changed files or acted. Review roleResult and the working tree, then decide how to continue.',
          roleResult: result,
        },
      };
    }
  }
  return { code: exitCode ?? 1, report: { role, threadId, exitCode, ...result } };
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

function gitIdentity(cwd, env) {
  const git = findGitBinary(env);
  const run = args => launcherRuntime.execFileSync(git, args, {
    cwd, env: cleanGitEnvironment(env), encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000, maxBuffer: 64 * 1024,
  }).trim();
  const normalize = path => {
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    const actual = realpathSync(absolute);
    return process.platform === 'win32' ? actual.toLowerCase() : actual;
  };
  const top = normalize(run(['rev-parse', '--show-toplevel']));
  const gitDir = normalize(run(['rev-parse', '--absolute-git-dir']));
  const commonDirRaw = run(['rev-parse', '--git-common-dir']);
  const commonDir = normalize(commonDirRaw);
  const gitDirRaw = run(['rev-parse', '--git-dir']);
  const linked = normalize(gitDirRaw) !== commonDir;
  if (!linked) throw new Error('Implementer requires a linked Git worktree; no child was launched.');
  return { top, gitDir, commonDir };
}

function findGitBinary(env) {
  if (env.GIT_BIN) return env.GIT_BIN;
  return process.platform === 'win32' ? 'git.exe' : 'git';
}

function cleanGitEnvironment(env) {
  const cleaned = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (/^GIT_/i.test(key)) delete cleaned[key];
  }
  return cleaned;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const home = env.CODEX_HOME || join(homedir(), '.codex');
  const profilePath = join(home, `harness-${options.role}.config.toml`);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(options.role ?? '') || options.role === 'lead' || !existsSync(profilePath)) {
    throw new Error(`Unknown role "${options.role}". Expected an installed harness role profile in ${home}.`);
  }
  const bindingsPath = threadBindingsPath(home);
  // Checked before anything runs: malformed bindings, or an unknown or other-role thread, never start a child.
  const bindings = readThreadBindings(bindingsPath);
  const profileText = readFileSync(profilePath, 'utf8');
  const profile = parseProfile(profileText);
  if (!profile.has('sandbox_workspace_write.writable_roots')) throw new Error(`Role profile for ${options.role} lacks sandbox_workspace_write.writable_roots; reinstall the harness.`);
  if (profile.get('sandbox_workspace_write.writable_roots') !== '[]') throw new Error(`Role profile for ${options.role} has an incompatible writable_roots baseline; reinstall the harness.`);
  const mcpAllowed = mcpMarker.test(profileText);
  const codex = findCodexBinary(env);
  const cwd = options['--cd'] ?? process.cwd();
  if (options.role === 'implementer' && (!options['--cd'] || !isAbsolute(options['--cd']))) {
    throw new Error('Implementer requires an explicit absolute --cd linked worktree root; no child was launched.');
  }
  const canonicalCwd = realpathSync(cwd);
  if (options.role === 'implementer' && canonicalCwd !== resolve(options['--cd'])) {
    throw new Error('Implementer --cd must be the canonical linked worktree path, not a path alias; no child was launched.');
  }
  let identity;
  if (options.role === 'implementer') {
    const found = gitIdentity(canonicalCwd, env);
    const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
    if (!samePath(found.top, canonicalCwd)) throw new Error('Implementer --cd must be exactly the canonical linked worktree root; no child was launched.');
    identity = found;
  }
  if (options['--resume'] !== undefined) {
    assertResumable(bindings, options['--resume'], options.role);
    if (options.role === 'implementer') {
      const binding = bindings[options['--resume']];
      if (typeof binding !== 'object' || !binding || binding.worktree !== identity.top || binding.gitDir !== identity.gitDir || binding.commonDir !== identity.commonDir) {
        throw new Error(`Implementer thread ${options['--resume']} is legacy or belongs to a different worktree; no child was launched.`);
      }
    }
  }
  if (options.role === 'implementer' && !validateGitIdentity(identity)) {
    throw new Error('Implementer Git worktree identity is incomplete; no child was launched.');
  }
  const mcpSelected = mcpAllowed ? readSelectedMcpServers(home) : [];
  // A failed listing aborts the launch rather than starting a role with unknown MCP servers enabled.
  const mcpServers = listMcpServers(options.role, args => launcherRuntime.execFileSync(codex, args, { cwd: canonicalCwd, env, encoding: 'utf8', windowsHide: true }));
  const outputDir = join(tmpdir(), 'advanced-harness-codex');
  mkdirSync(outputDir, { recursive: true });
  const resultPath = join(outputDir, `${options.role}-${Date.now()}.json`);
  const args = buildRoleInvocation({
    role: options.role, profileText, mcpServers, mcpAllowed, mcpSelected, resumeId: options['--resume'], task: options['--task'],
    schemaPath: join(home, 'advanced-harness', 'role-status.schema.json'), resultPath, workspaceRoot: options.role === 'implementer' ? canonicalCwd : undefined,
  });
  const run = launcherRuntime.spawnSync(codex, args, { cwd: canonicalCwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  let resultText;
  try { resultText = readFileSync(resultPath, 'utf8'); } catch { resultText = undefined; }
  const { code, report } = reportRun({ role: options.role, resumeId: options['--resume'], bindingsPath, stdout: run.stdout, exitCode: run.status, resultText, identity });
  console.log(JSON.stringify(report, null, 2));
  return code;
}

export function validateGitIdentity(identity) {
  return Boolean(identity && ['top', 'gitDir', 'commonDir'].every(key => typeof identity[key] === 'string' && identity[key].length > 0));
}

/**
 * Whether this module is the script Node was asked to run. import.meta.url has symlinks resolved and argv[1]
 * does not, so comparing them directly makes a launcher under a linked ~/.codex do nothing and exit 0.
 */
export function isEntryPoint(scriptPath, moduleUrl = import.meta.url) {
  if (!scriptPath) return false;
  let resolved = scriptPath;
  try { resolved = realpathSync(scriptPath); } catch { /* compared as given */ }
  return moduleUrl === pathToFileURL(resolved).href;
}

if (isEntryPoint(process.argv[1])) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
