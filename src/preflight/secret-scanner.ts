import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ScannerProbe = { available: boolean; backend: 'gitleaks' | 'builtin'; reason?: string };
const LIMIT = 4 * 1024 * 1024;

/** Content-free, bounded capability probe shared by doctor and preflight. */
export function probeGitleaks(): ScannerProbe {
  const version = spawnSync('gitleaks', ['version'], { encoding: 'utf8', timeout: 3000, maxBuffer: 32 * 1024 });
  if (version.error && 'code' in version.error && version.error.code === 'ENOENT') return { available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' };
  if (version.error || version.status !== 0) return { available: false, backend: 'builtin', reason: 'Gitleaks is installed or present but its version probe failed.' };
  const command = spawnSync('gitleaks', ['stdin', '--help'], { encoding: 'utf8', timeout: 3000, maxBuffer: 32 * 1024 });
  if (command.error || command.status !== 0 || !/--report-format/.test(command.stdout) || !/--report-path/.test(command.stdout)) return { available: false, backend: 'builtin', reason: 'Gitleaks stdin JSON report interface is unavailable.' };
  return { available: true, backend: 'gitleaks' };
}

export type SecretFinding = { rule: string; path: string; line: number; redacted: true };
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

function builtInScan(changes: { path: string; line: number; text: string }[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const item of changes) for (const [rule, regex] of builtinRules) {
    regex.lastIndex = 0;
    if (regex.test(item.text)) findings.push({ rule, path: item.path, line: item.line, redacted: true });
  }
  return findings;
}

export function scanAddedText(changes: { path: string; line: number; text: string }[], dependencies: { probe?: typeof probeGitleaks; run?: typeof spawnSync } = {}): { backend: string; findings: SecretFinding[]; complete: boolean; reason?: string } {
  const probe = (dependencies.probe ?? probeGitleaks)();
  if (!probe.available && probe.reason === 'Gitleaks is not installed.') return { backend: 'builtin', findings: builtInScan(changes), complete: true };
  if (!probe.available) return { backend: 'gitleaks', findings: [], complete: false, reason: 'Gitleaks is present but unusable.' };
  const payload = changes.map(item => item.text).join('\n');
  if (Buffer.byteLength(payload) > LIMIT) return { backend: 'gitleaks', findings: [], complete: false, reason: 'Secret scan input exceeded the configured bound.' };
  const temp = mkdtempSync(join(tmpdir(), 'harness-gitleaks-'));
  const reportPath = join(temp, 'report.json');
  let report: string;
  let status: number | null;
  try {
    const run = (dependencies.run ?? spawnSync)('gitleaks', ['stdin', '--report-format', 'json', '--report-path', reportPath, '--redact=100', '--no-banner'], { input: payload, encoding: 'utf8', timeout: 10000, maxBuffer: LIMIT });
    if (run.error || (run.status !== 0 && run.status !== 1)) return { backend: 'gitleaks', findings: [], complete: false, reason: 'Gitleaks scan failed.' };
    status = run.status;
    report = readFileSync(reportPath, 'utf8');
  } catch { return { backend: 'gitleaks', findings: [], complete: false, reason: 'Gitleaks report could not be read.' }; }
  finally { rmSync(temp, { recursive: true, force: true }); }
  try {
    const parsed: unknown = JSON.parse(report || '[]');
    if (!Array.isArray(parsed)) throw new Error('invalid report');
    const findings = parsed.map((value: any) => {
      if (!value || typeof value.RuleID !== 'string' || !Number.isInteger(value.StartLine) || value.StartLine < 1 || value.StartLine > changes.length) throw new Error('invalid finding');
      const location = changes[value.StartLine - 1]!;
      return { rule: safeGitleaksRuleId(value.RuleID), path: location.path.replaceAll('\\', '/').slice(0, 300), line: location.line, redacted: true as const };
    });
    if ((status === 0 && findings.length !== 0) || (status === 1 && findings.length === 0)) throw new Error('scanner status does not agree with report');
    return { backend: 'gitleaks', findings, complete: true };
  } catch { return { backend: 'gitleaks', findings: [], complete: false, reason: 'Gitleaks returned malformed JSON output.' }; }
}
