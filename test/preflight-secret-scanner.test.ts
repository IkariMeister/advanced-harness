import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { formatScannerProbe, MAX_SECRET_SCAN_BYTES, probeGitleaks, safeGitleaksRuleId, scanAddedText } from '../src/preflight/secret-scanner.ts';

test('scanner probe does not expose command output or scanned content', () => {
  const probe = probeGitleaks();
  assert.ok(['gitleaks', 'builtin', 'unavailable'].includes(probe.backend));
  assert.ok(typeof probe.available === 'boolean');
  assert.equal(probe.available, probe.backend === 'gitleaks');
  assert.ok(!JSON.stringify(probe).includes('secret'));
  assert.equal(formatScannerProbe({ available: true, backend: 'gitleaks' }), 'Gitleaks available (gitleaks backend).');
  assert.equal(formatScannerProbe({ available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' }), 'Gitleaks absent; built-in fallback available (Gitleaks is not installed.)');
});

test('built-in scanner reports sanitized rule and location only', () => {
  const result = scanAddedText([{ path: 'src/credentials.txt', line: 4, text: '-----BEGIN PRIVATE KEY----- SUPER_SECRET_SAMPLE_VALUE' }], { probe: () => ({ available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' }) });
  assert.equal(result.backend, 'builtin');
  assert.equal(result.complete, true);
  assert.equal(result.findings[0]?.rule, 'private-key');
  assert.equal(result.findings[0]?.line, 4);
  assert.ok(!JSON.stringify(result).includes('SUPER_SECRET_SAMPLE_VALUE'));
});

test('Gitleaks backend maps JSON findings to sanitized added-line locations', () => {
  let capturedOptions: any;
  let capturedArgs: string[] = [];
  let capturedReport = '';
  const run = (_command: string, args: string[], _options: unknown) => {
    capturedArgs = args;
    capturedOptions = _options;
    const report = args[args.indexOf('--report-path') + 1]!;
    capturedReport = report;
    writeFileSync(report, JSON.stringify([{ RuleID: 'generic-api-key', StartLine: 1, Secret: 'RAW_SECRET_MUST_NOT_ESCAPE' }]));
    return { status: 1, error: undefined };
  };
  process.env.GITLEAKS_TEST_MUST_NOT_ESCAPE = 'ambient';
  let result;
  try { result = scanAddedText([{ path: 'src/key.ts', line: 12, text: 'fake test payload' }], { probe: () => ({ available: true, backend: 'gitleaks' }), run: run as never }); }
  finally { delete process.env.GITLEAKS_TEST_MUST_NOT_ESCAPE; }
  assert.equal(result.complete, true);
  assert.deepEqual(result.findings, [{ rule: safeGitleaksRuleId('generic-api-key'), path: 'src/key.ts', line: 12, redacted: true }]);
  assert.ok(!JSON.stringify(result).includes('RAW_SECRET_MUST_NOT_ESCAPE'));
  assert.equal(capturedArgs.includes('--config'), true);
  assert.equal(capturedArgs.includes('--redact=100'), true);
  assert.equal(capturedOptions.cwd, tmpdir());
  assert.equal(capturedOptions.env.GITLEAKS_TEST_MUST_NOT_ESCAPE, undefined);
  assert.equal(capturedOptions.timeout, 10_000);
  assert.equal(existsSync(capturedReport), false, 'temporary report is removed after scanning');
});

test('empty, oversized, and contiguous run inputs have bounded isolated invocations', () => {
  let calls = 0;
  const payloads: string[] = [];
  const reportRoots: string[] = [];
  let probeCalls = 0;
  const run = (_command: string, args: string[], options: any) => {
    calls += 1;
    payloads.push(options.input);
    const report = args[args.indexOf('--report-path') + 1]!;
    reportRoots.push(report.replace(/report-\d+\.json$/, ''));
    writeFileSync(report, '[]');
    return { status: 0, error: undefined };
  };
  const probe = () => { probeCalls += 1; return { available: true as const, backend: 'gitleaks' as const }; };
  assert.equal(scanAddedText([], { probe, run: run as never }).complete, true);
  assert.equal(calls, 0, 'empty input skips the scan subprocess');
  assert.equal(probeCalls, 0, 'empty input also skips the capability probe');
  assert.equal(scanAddedText([{ path: 'large.txt', line: 1, text: 'x'.repeat(4 * 1024 * 1024 + 1) }], { probe, run: run as never }).complete, false);
  assert.equal(calls, 0, 'oversized input is inconclusive before spawning');
  assert.equal(probeCalls, 0, 'oversized input is rejected before either backend probe');
  const result = scanAddedText([
    { path: 'a.txt', origin: 'committed', line: 1, text: 'alpha' },
    { path: 'a.txt', origin: 'committed', line: 2, text: '' },
    { path: 'a.txt', origin: 'committed', line: 3, text: 'omega' },
    { path: 'a.txt', origin: 'staged', line: 4, text: 'staged' },
    { path: 'b.txt', origin: 'staged', line: 1, text: 'other file' },
  ], { probe, run: run as never });
  assert.equal(result.complete, true);
  assert.deepEqual(payloads, ['alpha\n\nomega', 'staged', 'other file']);
  assert.equal(calls, 3, 'one invocation per contiguous file/origin run');
  assert.equal(reportRoots.every(path => !existsSync(path)), true, 'temporary reports are removed after scanning');
});

test('aggregate scanner payload at exactly 4 MiB is accepted', () => {
  let calls = 0;
  const run = (_command: string, args: string[]) => {
    calls += 1;
    writeFileSync(args[args.indexOf('--report-path') + 1]!, '[]');
    return { status: 0, error: undefined };
  };
  const result = scanAddedText([{ path: 'exact-cap.txt', line: 1, text: 'x'.repeat(MAX_SECRET_SCAN_BYTES) }], { probe: () => ({ available: true, backend: 'gitleaks' }), run: run as never });
  assert.equal(result.complete, true);
  assert.equal(calls, 1);
});

test('Gitleaks finding locations retain their complete path for exact exception matching', () => {
  const path = `src/${'deep/'.repeat(80)}token.txt`;
  const run = (_command: string, args: string[]) => {
    writeFileSync(args[args.indexOf('--report-path') + 1]!, JSON.stringify([{ RuleID: 'long-path-rule', StartLine: 1 }]));
    return { status: 1, error: undefined };
  };
  const result = scanAddedText([{ path, line: 42, text: 'payload' }], { probe: () => ({ available: true, backend: 'gitleaks' }), run: run as never });
  assert.equal(result.complete, true);
  assert.equal(result.findings[0]?.path, path);
  assert.ok(result.findings[0]!.path.length > 300);
  assert.equal(MAX_SECRET_SCAN_BYTES, 4 * 1024 * 1024);
});

test('Gitleaks failures and malformed reports are inconclusive without raw diagnostics', () => {
  const change = [{ path: 'src/key.ts', line: 2, text: 'RAW_SECRET_MUST_NOT_ESCAPE' }];
  let failureTemp = '';
  const failed = scanAddedText(change, { probe: () => ({ available: true, backend: 'gitleaks' }), run: ((_command: string, args: string[]) => { failureTemp = args[args.indexOf('--report-path') + 1]!.replace(/report-\d+\.json$/, ''); return { status: 3, error: undefined }; }) as never });
  assert.equal(failed.complete, false);
  assert.ok(!JSON.stringify(failed).includes('RAW_SECRET_MUST_NOT_ESCAPE'));
  assert.equal(existsSync(failureTemp), false, 'temporary reports are removed after scanner failure');
  const malformed = scanAddedText(change, { probe: () => ({ available: true, backend: 'gitleaks' }), run: ((_command: string, args: string[]) => { writeFileSync(args[args.indexOf('--report-path') + 1]!, '{not json'); return { status: 0, error: undefined }; }) as never });
  assert.equal(malformed.complete, false);
  assert.ok(!JSON.stringify(malformed).includes('RAW_SECRET_MUST_NOT_ESCAPE'));
});

test('Gitleaks exit status must agree with a valid nonempty or empty JSON report', () => {
  const change = [{ path: 'src/key.ts', line: 2, text: 'sample' }];
  const execute = (status: number, body: unknown) => (_command: string, args: string[]) => {
    writeFileSync(args[args.indexOf('--report-path') + 1]!, JSON.stringify(body));
    return { status, error: undefined };
  };
  const emptyWithLeakStatus = scanAddedText(change, { probe: () => ({ available: true, backend: 'gitleaks' }), run: execute(1, []) as never });
  assert.equal(emptyWithLeakStatus.complete, false);
  const findingWithCleanStatus = scanAddedText(change, { probe: () => ({ available: true, backend: 'gitleaks' }), run: execute(0, [{ RuleID: 'safe-rule', StartLine: 1 }]) as never });
  assert.equal(findingWithCleanStatus.complete, false);
  const clean = scanAddedText(change, { probe: () => ({ available: true, backend: 'gitleaks' }), run: execute(0, []) as never });
  assert.equal(clean.complete, true);
});

test('untrusted RuleID strings are represented by a safe stable label', () => {
  const hostile = 'credentialSECRET\u0001\r\nforged-line';
  const label = safeGitleaksRuleId(hostile);
  assert.match(label, /^gitleaks-[a-f0-9]{64}$/);
  assert.ok(!label.includes('credentialSECRET'));
  assert.ok(!/[\u0000-\u001f\u007f]/.test(label));
  assert.equal(safeGitleaksRuleId(hostile), label);
});

test('hostile report RuleID is sanitized before a finding is returned', () => {
  const hostile = 'api_secret_VALUE\u0000\r\nforged';
  const run = (_command: string, args: string[]) => {
    writeFileSync(args[args.indexOf('--report-path') + 1]!, JSON.stringify([{ RuleID: hostile, StartLine: 1, Secret: 'NEVER_OUTPUT_SECRET' }]));
    return { status: 1, error: undefined };
  };
  const result = scanAddedText([{ path: 'safe.txt', line: 9, text: 'payload' }], { probe: () => ({ available: true, backend: 'gitleaks' }), run: run as never });
  assert.equal(result.complete, true);
  assert.equal(result.findings[0]?.rule, safeGitleaksRuleId(hostile));
  assert.ok(!JSON.stringify(result).includes(hostile));
  assert.ok(!JSON.stringify(result).includes('NEVER_OUTPUT_SECRET'));
  assert.ok(!/[\u0000-\u001f\u007f]/.test(JSON.stringify(result)));
});
