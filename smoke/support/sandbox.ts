// Isolated-home sandbox for smoke journeys. Each sandbox owns a throwaway HOME,
// USERPROFILE, XDG_CONFIG_HOME, APPDATA, LOCALAPPDATA, recovery directory, Git
// identity, and a scratch Git "Android" checkout, then runs the real harness:*
// scripts against it. Answers are piped (non-TTY); see docs/smoke-test-plan.md.
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempRoot } from '../../test/temp-directory.ts';

export const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const support = resolve(fileURLToPath(new URL('./', import.meta.url)));

export type Step = { prompt: RegExp; answer: string };
export type RunResult = { code: number | null; stdout: string; stderr: string; transcript: string; unansweredSteps: Step[] };
export type RunOptions = { steps?: Step[]; tty?: boolean; cwd?: string; timeoutMs?: number; onPrompt?: (prompt: string) => void };

export interface Sandbox {
  root: string;
  home: string;
  xdgConfigHome: string;
  project: string;
  recoveryDirectory: string;
  openCodeLog: string;
  env: NodeJS.ProcessEnv;
  run(script: string, args: string[], options?: RunOptions): Promise<RunResult>;
  openCodeCalls(): { args: string[]; cwd: string }[];
  dispose(): void;
}

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b[()][A-Z0-9]|\u001b[=>]/g, '');

function installOpenCodeStub(bin: string): { executable: string; nodeOptions?: string } {
  mkdirSync(bin, { recursive: true });
  const entry = join(support, 'opencode-stub-entry.mjs');
  if (process.platform === 'win32') {
    const executable = join(bin, 'opencode.exe');
    try { linkSync(process.execPath, executable); } catch { copyFileSync(process.execPath, executable); }
    return { executable, nodeOptions: `--import=${pathToFileURL(entry).href}` };
  }
  const executable = join(bin, 'opencode');
  writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`);
  chmodSync(executable, 0o755);
  return { executable };
}

export function createSandbox(name: string): Sandbox {
  const root = makeTempRoot(`ah-smoke-${name}-`);
  const home = join(root, 'home');
  const xdgConfigHome = join(home, '.config');
  const project = join(root, 'android-app');
  const recoveryDirectory = join(home, 'Projects', 'advanced-harness-backups');
  const openCodeLog = join(root, 'opencode-calls.jsonl');
  for (const directory of [home, xdgConfigHome, project, join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')]) mkdirSync(directory, { recursive: true });
  const gitConfig = join(home, '.gitconfig');
  writeFileSync(gitConfig, '[user]\n\tname = Smoke Sandbox\n\temail = smoke@sandbox.invalid\n[init]\n\tdefaultBranch = main\n');
  const stub = installOpenCodeStub(join(root, 'bin'));

  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|XDG_.*|APPDATA|LOCALAPPDATA|ADVANCED_HARNESS_.*|OPENCODE_.*|GIT_CONFIG.*|NODE_OPTIONS|NODE_TEST_CONTEXT)$/i.test(key)));
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdgConfigHome,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    ADVANCED_HARNESS_RECOVERY_DIR: recoveryDirectory,
    OPENCODE_BIN: stub.executable,
    SMOKE_OPENCODE_LOG: openCodeLog,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
    ...(stub.nodeOptions ? { NODE_OPTIONS: stub.nodeOptions } : {}),
  };

  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env, stdio: 'pipe', windowsHide: true });
  writeFileSync(join(project, 'settings.gradle.kts'), 'rootProject.name = "smoke-android-app"\ninclude(":app")\n');
  mkdirSync(join(project, 'app'), { recursive: true });
  writeFileSync(join(project, 'app', 'build.gradle.kts'), 'plugins { id("com.android.application") }\n');
  writeFileSync(join(project, 'AGENTS.md'), '# Smoke Android App\n\nPre-existing project instructions that the harness must preserve.\n');
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'Initial sandbox project');

  const run = (script: string, args: string[], options: RunOptions = {}) => new Promise<RunResult>((resolveRun, reject) => {
    const steps = [...(options.steps ?? [])];
    const nodeArgs = [...(options.tty === false ? [] : ['--import', pathToFileURL(join(support, 'tty-preload.mjs')).href]), join(repoRoot, 'scripts', script), ...args];
    const child = spawn(process.execPath, nodeArgs, { cwd: options.cwd ?? project, env, stdio: 'pipe', windowsHide: true });
    let stdout = '', stderr = '', transcript = '', pending = '';
    let idle: NodeJS.Timeout | undefined;
    const fail = (message: string) => { child.kill(); reject(new Error(`${message}\n--- transcript (${script}) ---\n${transcript.slice(-4000)}\n--- stderr ---\n${stderr.slice(-2000)}`)); };
    const deadline = setTimeout(() => fail(`Timed out after ${options.timeoutMs ?? 60000} ms`), options.timeoutMs ?? 60000);
    child.stdout.on('data', chunk => {
      const text = stripAnsi(String(chunk));
      stdout += text; transcript += text; pending += text;
      const step = steps[0];
      if (step && step.prompt.test(pending)) {
        const promptText = pending;
        steps.shift();
        pending = '';
        options.onPrompt?.(promptText);
        transcript += `«${step.answer}»\n`;
        child.stdin.write(`${step.answer}\n`);
      }
      if (idle) clearTimeout(idle);
      // A prompt that no scripted step answers would otherwise hang until the deadline.
      if (/: $/.test(pending)) idle = setTimeout(() => fail(`Unexpected prompt with no scripted answer (next expected: ${steps[0]?.prompt ?? 'none'})`), 5000);
    });
    child.stderr.on('data', chunk => { const text = stripAnsi(String(chunk)); stderr += text; transcript += text; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(deadline); if (idle) clearTimeout(idle);
      resolveRun({ code, stdout, stderr, transcript, unansweredSteps: steps });
    });
    if (!options.steps) child.stdin.end();
  });

  return {
    root, home, xdgConfigHome, project, recoveryDirectory, openCodeLog, env, run,
    openCodeCalls: () => existsSync(openCodeLog) ? readFileSync(openCodeLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    dispose: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
  };
}

/** Relative path → content digest for every file under a directory (empty when absent). */
export function tree(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.set(relative(directory, path).split(sep).join('/'), readFileSync(path, 'utf8'));
    }
  };
  walk(directory);
  return files;
}

/** SHA-256/size fingerprints; never returns file contents or reversible encodings. Symlinks are not followed. */
export function realHomeFingerprintOf(paths: Iterable<string>): Map<string, string> {
  const fingerprints = new Map<string, string>();
  const fingerprint = (path: string): string => {
    let info;
    try { info = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'; throw error; }
    if (info.isSymbolicLink()) return 'symlink';
    if (info.isFile()) { const hash = createHash('sha256'); let size = 0; const fd = openSync(path, 'r'); try { const buffer = Buffer.alloc(64 * 1024); for (;;) { const count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break; size += count; hash.update(buffer.subarray(0, count)); } } finally { closeSync(fd); } return `file:${size}:${hash.digest('hex')}`; }
    if (info.isDirectory()) return `directory:${readdirSync(path).sort().map(name => `${name}:${fingerprint(join(path, name))}`).join('|')}`;
    return 'other';
  };
  for (const path of paths) {
    const real = join(homedir(), path);
    fingerprints.set(path, fingerprint(real));
  }
  return fingerprints;
}
