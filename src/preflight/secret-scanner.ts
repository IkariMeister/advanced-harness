import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

export type ScannerProbe = { available: true; backend: 'gitleaks'; executable?: string } | { available: false; backend: 'builtin' | 'unavailable'; reason: string };
export const MAX_SECRET_SCAN_BYTES = 4 * 1024 * 1024;
const LIMIT = MAX_SECRET_SCAN_BYTES;
const TIMEOUT_MS = 10_000;
const GITLEAKS_CONFIG = fileURLToPath(new URL('./gitleaks.toml', import.meta.url));
const MIN_GITLEAKS = [8, 30, 1] as const;
type TempDirectoryFactory = (prefix: string) => string;
const defaultTempDirectory: TempDirectoryFactory = prefix => mkdtempSync(join(tmpdir(), prefix));

/** spawnSync requires an integer timeout; zero means no timeout, so sub-ms budgets expire. */
function boundedTimeout(remainingMs: number, maximumMs: number): number | undefined {
  const timeout = Math.floor(Math.min(remainingMs, maximumMs));
  return timeout >= 1 ? timeout : undefined;
}

function scannerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GITLEAKS_')));
}

export function formatScannerProbe(probe: ScannerProbe): string {
  if (probe.available) return 'Gitleaks available (gitleaks backend).';
  if (probe.backend === 'builtin') return `Gitleaks absent; built-in fallback available (${probe.reason})`;
  return `Gitleaks probe failed; scanning unavailable (${probe.reason})`;
}

/** Content-free, bounded capability probe shared by doctor and preflight. */
export function probeGitleaks(deadline = performance.now() + TIMEOUT_MS, makeTempDirectory: TempDirectoryFactory = defaultTempDirectory, dependencies: { run?: typeof spawnSync; now?: () => number; resolveExecutable?: () => string | undefined } = {}): ScannerProbe {
  const now = dependencies.now ?? (() => performance.now());
  const run = dependencies.run ?? spawnSync;
  const executable = dependencies.resolveExecutable?.() ?? resolveGitleaks();
  if (!executable) return { available: false, backend: 'builtin', reason: 'Gitleaks is not installed in an absolute PATH entry.' };
  let privateCwd: string;
  try { privateCwd = makeTempDirectory('harness-gitleaks-probe-'); } catch { return { available: false, backend: 'unavailable', reason: 'Gitleaks probe temporary directory could not be created.' }; }
  const timeout = boundedTimeout(deadline - now(), 3000);
  if (timeout === undefined) { rmSync(privateCwd, { recursive: true, force: true }); return { available: false, backend: 'unavailable', reason: 'Gitleaks aggregate scan deadline exceeded.' }; }
  const options = { encoding: 'utf8' as const, timeout, maxBuffer: 32 * 1024, cwd: privateCwd, env: scannerEnvironment() };
  let version;
  try { version = run(executable, ['version'], options); } finally { rmSync(privateCwd, { recursive: true, force: true }); }
  if (version.error || version.status !== 0) return { available: false, backend: 'unavailable', reason: 'Gitleaks is present but its version probe failed.' };
  if (!isSupportedGitleaksVersion(version.stdout)) return { available: false, backend: 'unavailable', reason: 'Gitleaks 8.30.1 or newer is required.' };
  let probeCwd: string;
  try { probeCwd = makeTempDirectory('harness-gitleaks-probe-'); } catch { return { available: false, backend: 'unavailable', reason: 'Gitleaks probe temporary directory could not be created.' }; }
  const probeTimeout = boundedTimeout(deadline - now(), 3000);
  if (probeTimeout === undefined) { rmSync(probeCwd, { recursive: true, force: true }); return { available: false, backend: 'unavailable', reason: 'Gitleaks aggregate scan deadline exceeded.' }; }
  let command;
  try { command = run(executable, ['stdin', '--help'], { ...options, timeout: probeTimeout, cwd: probeCwd }); } finally { rmSync(probeCwd, { recursive: true, force: true }); }
  if (command.error || command.status !== 0 || !/--report-format/.test(command.stdout) || !/--report-path/.test(command.stdout) || !/--config/.test(command.stdout) || !/--redact/.test(command.stdout)) return { available: false, backend: 'unavailable', reason: 'Gitleaks stdin JSON report interface is unavailable.' };
  return { available: true, backend: 'gitleaks', executable };
}

export function resolveGitleaksExecutable(pathValue = process.env.PATH ?? '', platform = process.platform, isFile: (path: string) => boolean = path => {
  try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
}): string | undefined {
  const pathApi = platform === 'win32' ? win32 : posix;
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  for (const rawDirectory of pathValue.split(pathDelimiter)) {
    const directory = rawDirectory.trim().replace(/^"(.*)"$/, '$1');
    if (!pathApi.isAbsolute(directory)) continue;
    const candidates = platform === 'win32' ? ['gitleaks.exe'] : ['gitleaks'];
    for (const name of candidates) {
      const candidate = pathApi.resolve(directory, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveGitleaks(): string | undefined { return resolveGitleaksExecutable(); }
export function isSupportedGitleaksVersion(versionText: string): boolean {
  // `gitleaks version` prints one bare SemVer string. Require the whole response so
  // unrelated build/log numbers cannot accidentally satisfy the minimum.
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(versionText.trim());
  if (!match) return false;
  const core = match.slice(1, 4).map(Number);
  if (!core.every(Number.isSafeInteger)) return false;
  if (match[4]?.split('.').some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) return false;
  for (let i = 0; i < MIN_GITLEAKS.length; i += 1) {
    if (core[i] !== MIN_GITLEAKS[i]) return core[i]! > MIN_GITLEAKS[i]!;
  }
  const prerelease = match[4];
  // The minimum is a stable release; every prerelease at the same core version
  // sorts before it under SemVer precedence.
  return prerelease === undefined;
}

export type SecretFinding = { rule: string; path: string; line: number; origin?: string; redacted: true };
export type AddedLine = { path: string; line: number; text: string; origin?: string };
/** Stable safe label for arbitrary scanner IDs; raw report strings never enter results. */
export function safeGitleaksRuleId(ruleId: string): string {
  return `gitleaks-${createHash('sha256').update(ruleId, 'utf8').digest('hex')}`;
}
const builtinRules: [string, RegExp][] = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['dsa-private-key', /-----BEGIN DSA PRIVATE KEY-----/g],
  ['encrypted-private-key', /-----BEGIN ENCRYPTED PRIVATE KEY-----/g],
  ['pgp-private-key', /-----BEGIN PGP PRIVATE KEY BLOCK-----/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g],
  ['high-entropy-assignment', /(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["']?[A-Za-z0-9/+_=-]{32,}/gi],
];

function builtInScan(changes: AddedLine[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const item of changes) for (const [rule, regex] of builtinRules) {
    regex.lastIndex = 0;
    if (regex.test(item.text)) findings.push({ rule, path: item.path.replaceAll('\\', '/'), line: item.line, ...(item.origin === undefined ? {} : { origin: item.origin }), redacted: true });
  }
  return findings;
}

function contiguousRuns(changes: AddedLine[]): AddedLine[][] {
  const runs: AddedLine[][] = [];
  for (const change of changes) {
    const current = runs.at(-1);
    const previous = current?.at(-1);
    if (previous && previous.path === change.path && previous.origin === change.origin && previous.line + 1 === change.line) current!.push(change);
    else runs.push([change]);
  }
  return runs;
}

export function addedTextByteLength(changes: AddedLine[]): number {
  return contiguousRuns(changes).reduce((total, run) => total + run.reduce((runTotal, item) => runTotal + Buffer.byteLength(item.text, 'utf8'), 0) + Math.max(0, run.length - 1), 0);
}

function gitleaksRun(changes: AddedLine[], dependencies: { run?: typeof spawnSync; now: () => number }, reportRoot: string, reportIndex: number, executable: string, deadline: number): { findings: SecretFinding[]; complete: boolean; reason?: string } {
  const payload = changes.map(item => item.text).join('\n');
  const reportPath = join(reportRoot, `report-${reportIndex}.json`);
  const args = ['stdin', '--config', GITLEAKS_CONFIG, '--report-format', 'json', '--report-path', reportPath, '--redact=100', '--no-banner'];
  let report: string;
  let status: number | null;
  try {
    const timeout = boundedTimeout(deadline - dependencies.now(), TIMEOUT_MS);
    if (timeout === undefined) return { findings: [], complete: false, reason: 'Gitleaks aggregate scan deadline exceeded.' };
    const result = (dependencies.run ?? spawnSync)(executable, args, { input: payload, encoding: 'utf8', timeout, maxBuffer: LIMIT, cwd: reportRoot, env: scannerEnvironment() });
    if (result.error || (result.status !== 0 && result.status !== 1)) return { findings: [], complete: false, reason: 'Gitleaks scan failed.' };
    status = result.status;
    report = readFileSync(reportPath, 'utf8');
  } catch { return { findings: [], complete: false, reason: 'Gitleaks report could not be read.' }; }
  try {
    const parsed: unknown = JSON.parse(report || '[]');
    if (!Array.isArray(parsed)) throw new Error('invalid report');
    const findings = parsed.map((value: any) => {
      if (!value || typeof value.RuleID !== 'string' || !Number.isInteger(value.StartLine) || value.StartLine < 1 || value.StartLine > changes.length) throw new Error('invalid finding');
      const location = changes[value.StartLine - 1]!;
      return { rule: safeGitleaksRuleId(value.RuleID), path: location.path.replaceAll('\\', '/'), line: location.line, ...(location.origin === undefined ? {} : { origin: location.origin }), redacted: true as const };
    });
    if ((status === 0 && findings.length !== 0) || (status === 1 && findings.length === 0)) throw new Error('scanner status does not agree with report');
    return { findings, complete: true };
  } catch { return { findings: [], complete: false, reason: 'Gitleaks returned malformed JSON output.' }; }
}

export function scanAddedText(changes: AddedLine[], dependencies: { probe?: typeof probeGitleaks; run?: typeof spawnSync; now?: () => number; createTempDirectory?: TempDirectoryFactory; removeTempDirectory?: typeof rmSync } = {}): { backend: 'gitleaks' | 'builtin' | 'unavailable'; findings: SecretFinding[]; complete: boolean; reason?: string } {
  const totalBytes = addedTextByteLength(changes);
  if (totalBytes > MAX_SECRET_SCAN_BYTES) return { backend: 'unavailable', findings: [], complete: false, reason: 'Secret scan input exceeded the configured bound.' };
  if (!changes.length) return { backend: 'builtin', findings: [], complete: true };
  const now = dependencies.now ?? (() => performance.now());
  const deadline = now() + TIMEOUT_MS;
  const probe = dependencies.probe ? dependencies.probe(deadline) : probeGitleaks(deadline, dependencies.createTempDirectory);
  if (!probe.available && probe.backend === 'builtin') return { backend: 'builtin', findings: builtInScan(changes), complete: true };
  if (!probe.available) return { backend: 'unavailable', findings: [], complete: false, reason: probe.reason };
  const runs = contiguousRuns(changes);
  let temp: string;
  try { temp = (dependencies.createTempDirectory ?? defaultTempDirectory)('harness-gitleaks-'); } catch { return { backend: 'unavailable', findings: [], complete: false, reason: 'Gitleaks scan temporary directory could not be created.' }; }
  const findings: SecretFinding[] = [];
  let outcome: { backend: 'gitleaks' | 'unavailable'; findings: SecretFinding[]; complete: boolean; reason?: string };
  try {
    const executable = probe.executable;
    if (!executable || !isAbsolute(executable)) {
      outcome = { backend: 'unavailable', findings, complete: false, reason: 'Gitleaks executable was not resolved to an absolute path.' };
    } else {
      outcome = { backend: 'gitleaks', findings, complete: true };
      for (let index = 0; index < runs.length; index += 1) {
        const scanned = gitleaksRun(runs[index]!, { ...(dependencies.run === undefined ? {} : { run: dependencies.run }), now }, temp, index, executable, deadline);
        findings.push(...scanned.findings);
        if (!scanned.complete) {
          outcome = { backend: 'gitleaks', findings, complete: false, ...(scanned.reason === undefined ? {} : { reason: scanned.reason }) };
          break;
        }
      }
    }
  } catch {
    outcome = { backend: 'gitleaks', findings, complete: false, reason: 'Gitleaks scan failed.' };
  }
  try { (dependencies.removeTempDirectory ?? rmSync)(temp, { recursive: true, force: true }); }
  catch { return { backend: 'gitleaks', findings: outcome!.findings, complete: false, reason: 'Gitleaks temporary files could not be cleaned up.' }; }
  return outcome!;
}
