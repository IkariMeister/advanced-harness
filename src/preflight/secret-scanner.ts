import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ScannerProbe = { available: true; backend: 'gitleaks' } | { available: false; backend: 'builtin' | 'unavailable'; reason: string };
export const MAX_SECRET_SCAN_BYTES = 4 * 1024 * 1024;
const LIMIT = MAX_SECRET_SCAN_BYTES;
const TIMEOUT_MS = 10_000;
const GITLEAKS_CONFIG = fileURLToPath(new URL('./gitleaks.toml', import.meta.url));
const neutralCwd = tmpdir();

function scannerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GITLEAKS_')));
}

export function formatScannerProbe(probe: ScannerProbe): string {
  if (probe.available) return 'Gitleaks available (gitleaks backend).';
  if (probe.backend === 'builtin') return `Gitleaks absent; built-in fallback available (${probe.reason})`;
  return `Gitleaks probe failed; scanning unavailable (${probe.reason})`;
}

/** Content-free, bounded capability probe shared by doctor and preflight. */
export function probeGitleaks(): ScannerProbe {
  const options = { encoding: 'utf8' as const, timeout: 3000, maxBuffer: 32 * 1024, cwd: neutralCwd, env: scannerEnvironment() };
  const version = spawnSync('gitleaks', ['version'], options);
  if (version.error && 'code' in version.error && version.error.code === 'ENOENT') return { available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' };
  if (version.error || version.status !== 0) return { available: false, backend: 'unavailable', reason: 'Gitleaks is present but its version probe failed.' };
  const command = spawnSync('gitleaks', ['stdin', '--help'], options);
  if (command.error || command.status !== 0 || !/--report-format/.test(command.stdout) || !/--report-path/.test(command.stdout) || !/--config/.test(command.stdout) || !/--redact/.test(command.stdout)) return { available: false, backend: 'unavailable', reason: 'Gitleaks stdin JSON report interface is unavailable.' };
  return { available: true, backend: 'gitleaks' };
}

export type SecretFinding = { rule: string; path: string; line: number; redacted: true };
export type AddedLine = { path: string; line: number; text: string; origin?: string };
/** Stable safe label for arbitrary scanner IDs; raw report strings never enter results. */
export function safeGitleaksRuleId(ruleId: string): string {
  return `gitleaks-${createHash('sha256').update(ruleId, 'utf8').digest('hex')}`;
}
const builtinRules: [string, RegExp][] = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g],
  ['high-entropy-assignment', /(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["']?[A-Za-z0-9/+_=-]{32,}/gi],
];

function builtInScan(changes: AddedLine[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const item of changes) for (const [rule, regex] of builtinRules) {
    regex.lastIndex = 0;
    if (regex.test(item.text)) findings.push({ rule, path: item.path.replaceAll('\\', '/'), line: item.line, redacted: true });
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

function gitleaksRun(changes: AddedLine[], dependencies: { run?: typeof spawnSync }, reportRoot: string, reportIndex: number): { findings: SecretFinding[]; complete: boolean; reason?: string } {
  const payload = changes.map(item => item.text).join('\n');
  const reportPath = join(reportRoot, `report-${reportIndex}.json`);
  const args = ['stdin', '--config', GITLEAKS_CONFIG, '--report-format', 'json', '--report-path', reportPath, '--redact=100', '--no-banner'];
  let report: string;
  let status: number | null;
  try {
    const run = (dependencies.run ?? spawnSync)('gitleaks', args, { input: payload, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: LIMIT, cwd: neutralCwd, env: scannerEnvironment() });
    if (run.error || (run.status !== 0 && run.status !== 1)) return { findings: [], complete: false, reason: 'Gitleaks scan failed.' };
    status = run.status;
    report = readFileSync(reportPath, 'utf8');
  } catch { return { findings: [], complete: false, reason: 'Gitleaks report could not be read.' }; }
  try {
    const parsed: unknown = JSON.parse(report || '[]');
    if (!Array.isArray(parsed)) throw new Error('invalid report');
    const findings = parsed.map((value: any) => {
      if (!value || typeof value.RuleID !== 'string' || !Number.isInteger(value.StartLine) || value.StartLine < 1 || value.StartLine > changes.length) throw new Error('invalid finding');
      const location = changes[value.StartLine - 1]!;
      return { rule: safeGitleaksRuleId(value.RuleID), path: location.path.replaceAll('\\', '/'), line: location.line, redacted: true as const };
    });
    if ((status === 0 && findings.length !== 0) || (status === 1 && findings.length === 0)) throw new Error('scanner status does not agree with report');
    return { findings, complete: true };
  } catch { return { findings: [], complete: false, reason: 'Gitleaks returned malformed JSON output.' }; }
}

export function scanAddedText(changes: AddedLine[], dependencies: { probe?: typeof probeGitleaks; run?: typeof spawnSync } = {}): { backend: 'gitleaks' | 'builtin' | 'unavailable'; findings: SecretFinding[]; complete: boolean; reason?: string } {
  const totalBytes = addedTextByteLength(changes);
  if (totalBytes > MAX_SECRET_SCAN_BYTES) return { backend: 'unavailable', findings: [], complete: false, reason: 'Secret scan input exceeded the configured bound.' };
  if (!changes.length) return { backend: 'builtin', findings: [], complete: true };
  const probe = (dependencies.probe ?? probeGitleaks)();
  if (!probe.available && probe.backend === 'builtin') return { backend: 'builtin', findings: builtInScan(changes), complete: true };
  if (!probe.available) return { backend: 'unavailable', findings: [], complete: false, reason: probe.reason };
  const runs = contiguousRuns(changes);
  const temp = mkdtempSync(join(tmpdir(), 'harness-gitleaks-'));
  try {
    const findings: SecretFinding[] = [];
    for (let index = 0; index < runs.length; index += 1) {
      const scanned = gitleaksRun(runs[index]!, dependencies, temp, index);
      if (!scanned.complete) return { backend: 'gitleaks', findings: [], complete: false, ...(scanned.reason === undefined ? {} : { reason: scanned.reason }) };
      findings.push(...scanned.findings);
    }
    return { backend: 'gitleaks', findings, complete: true };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
