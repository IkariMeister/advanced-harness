import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { formatScannerProbe, isSupportedGitleaksVersion, MAX_SECRET_SCAN_BYTES, probeGitleaks, resolveGitleaksExecutable, safeGitleaksRuleId, scanAddedText } from '../src/preflight/secret-scanner.ts';

test('scanner probe does not expose command output or scanned content', () => {
  const probe = probeGitleaks();
  assert.ok(['gitleaks', 'builtin', 'unavailable'].includes(probe.backend));
  assert.ok(typeof probe.available === 'boolean');
  assert.equal(probe.available, probe.backend === 'gitleaks');
  assert.ok(!JSON.stringify(probe).includes('secret'));
  assert.equal(formatScannerProbe({ available: true, backend: 'gitleaks' }), 'Gitleaks available (gitleaks backend).');
  assert.equal(formatScannerProbe({ available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' }), 'Gitleaks absent; built-in fallback available (Gitleaks is not installed.)');
  assert.equal(isSupportedGitleaksVersion('8.30.0'), false);
  assert.equal(isSupportedGitleaksVersion('8.30.1-rc.1'), false, 'a prerelease at the minimum core version sorts before the stable minimum');
  assert.equal(isSupportedGitleaksVersion('8.30.1'), true, 'the official bare minimum release is accepted');
  assert.equal(isSupportedGitleaksVersion('8.30.1+build.4'), true, 'build metadata does not change SemVer precedence');
  assert.equal(isSupportedGitleaksVersion('8.30.2-rc.1'), true, 'a prerelease of a later core version sorts above the minimum');
  assert.equal(isSupportedGitleaksVersion('8.30.2'), true);
  assert.equal(isSupportedGitleaksVersion('8.31.0'), true);
  assert.equal(isSupportedGitleaksVersion('9.0.0'), true);
  assert.equal(isSupportedGitleaksVersion('gitleaks version 8.30.1'), false, 'extra labels are not part of the official response');
  assert.equal(isSupportedGitleaksVersion('build 2026.1.2; gitleaks 9.0.0'), false, 'unrelated numeric triplets are rejected');
  assert.equal(isSupportedGitleaksVersion('8.30.1-rc.01'), false, 'invalid numeric prerelease identifiers are rejected');
});

test('Windows Gitleaks resolution accepts quoted and unquoted absolute PATH entries and only the native executable', () => {
  const found: string[] = [];
  const quoted = resolveGitleaksExecutable('"C:\\Program Files\\Gitleaks";relative', 'win32', candidate => { found.push(candidate); return candidate.toLowerCase() === 'c:\\program files\\gitleaks\\gitleaks.exe'; });
  assert.equal(quoted, 'C:\\Program Files\\Gitleaks\\gitleaks.exe');
  assert.deepEqual(found, ['C:\\Program Files\\Gitleaks\\gitleaks.exe']);
  const unquoted = resolveGitleaksExecutable('C:\\Program Files\\Gitleaks;D:\\Tools', 'win32', candidate => candidate === 'C:\\Program Files\\Gitleaks\\gitleaks.exe');
  assert.equal(unquoted, 'C:\\Program Files\\Gitleaks\\gitleaks.exe');
  assert.equal(resolveGitleaksExecutable('relative;C:\\Tools', 'win32', candidate => candidate.endsWith('.cmd')), undefined);
});

test('present but unusable Gitleaks does not select the built-in fallback', () => {
  const result = scanAddedText([{ path: 'key.txt', line: 1, text: '-----BEGIN PRIVATE KEY-----' }], { probe: () => ({ available: false, backend: 'unavailable', reason: 'Gitleaks version is too old.' }) });
  assert.equal(result.backend, 'unavailable');
  assert.equal(result.complete, false);
  assert.deepEqual(result.findings, []);
});

test('probe and scan temporary-directory creation failures are bounded and sanitized', () => {
  const installed = probeGitleaks();
  const failedProbe = installed.available ? probeGitleaks(undefined, () => { throw new Error('private temp path detail'); }) : installed;
  if (installed.available) {
    assert.equal(failedProbe.available, false);
    if (!failedProbe.available) assert.equal(failedProbe.reason, 'Gitleaks probe temporary directory could not be created.');
  }
  const scan = scanAddedText([{ path: 'sample.txt', line: 1, text: 'plain text' }], {
    probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }),
    createTempDirectory: () => { throw new Error('private temp path detail'); },
  });
  assert.equal(scan.complete, false);
  assert.equal(scan.reason, 'Gitleaks scan temporary directory could not be created.');
  assert.ok(!JSON.stringify({ failedProbe, scan }).includes('private temp path detail'));
});

test('doctor CLI prints the scanner availability line from its real probe path', () => {
  const pathRoot = mkdtempSync(join(tmpdir(), 'harness-doctor-empty-path-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = pathRoot;
  try {
    const doctor = resolve(import.meta.dirname, '../scripts/diagnose-native-harness.ts');
    const result = spawnSync(process.execPath, [doctor, '--scope', 'global', '--host', 'cursor', '--project', process.cwd()], { encoding: 'utf8', env });
    assert.match(result.stdout, /Secret scanner: Gitleaks absent; built-in fallback available \(Gitleaks is not installed in an absolute PATH entry\.\)/);
  } finally { rmSync(pathRoot, { recursive: true, force: true }); }
});

test('optional real Gitleaks 8.30.1+ stdin/report contract', (t) => {
  const probe = probeGitleaks();
  if (!probe.available) { t.skip('no supported native Gitleaks executable on absolute PATH'); return; }
  const payload = 'ghp_7Q2M9L1X8C4D6E0F7Q2M9L1X8C4D6E0F7Q2M9L1X';
  const result = scanAddedText([{ path: 'fixtures/key.txt', line: 6, text: payload }], { probe: () => probe });
  assert.equal(result.complete, true, result.reason);
  assert.ok(result.findings.some(finding => finding.path === 'fixtures/key.txt' && finding.line === 6));
  assert.ok(!JSON.stringify(result).includes(payload));
});

test('built-in scanner reports sanitized rule and location only', () => {
  const result = scanAddedText([{ path: 'src/credentials.txt', line: 4, text: '-----BEGIN PRIVATE KEY----- SUPER_SECRET_SAMPLE_VALUE' }], { probe: () => ({ available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' }) });
  assert.equal(result.backend, 'builtin');
  assert.equal(result.complete, true);
  assert.equal(result.findings[0]?.rule, 'private-key');
  assert.equal(result.findings[0]?.line, 4);
  assert.ok(!JSON.stringify(result).includes('SUPER_SECRET_SAMPLE_VALUE'));
  const markerFindings = scanAddedText([
    { path: 'dsa', line: 1, text: '-----BEGIN DSA PRIVATE KEY-----' },
    { path: 'encrypted', line: 2, text: '-----BEGIN ENCRYPTED PRIVATE KEY-----' },
    { path: 'pgp', line: 3, text: '-----BEGIN PGP PRIVATE KEY BLOCK-----' },
  ], { probe: () => ({ available: false, backend: 'builtin', reason: 'absent' }) });
  assert.deepEqual(markerFindings.findings.map(finding => [finding.rule, finding.path, finding.line]), [
    ['dsa-private-key', 'dsa', 1], ['encrypted-private-key', 'encrypted', 2], ['pgp-private-key', 'pgp', 3],
  ]);
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
  try { result = scanAddedText([{ path: 'src/key.ts', line: 12, text: 'fake test payload' }], { probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }), run: run as never }); }
  finally { delete process.env.GITLEAKS_TEST_MUST_NOT_ESCAPE; }
  assert.equal(result.complete, true);
  assert.deepEqual(result.findings, [{ rule: safeGitleaksRuleId('generic-api-key'), path: 'src/key.ts', line: 12, redacted: true }]);
  assert.ok(!JSON.stringify(result).includes('RAW_SECRET_MUST_NOT_ESCAPE'));
  assert.equal(capturedArgs.includes('--config'), true);
  assert.equal(capturedArgs.includes('--redact=100'), true);
  assert.notEqual(capturedOptions.cwd, tmpdir());
  assert.match(capturedOptions.cwd, /harness-gitleaks-/);
  assert.equal(capturedOptions.env.GITLEAKS_TEST_MUST_NOT_ESCAPE, undefined);
  assert.ok(capturedOptions.timeout > 0 && capturedOptions.timeout <= 10_000);
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
  const probe = () => { probeCalls += 1; return { available: true as const, backend: 'gitleaks' as const, executable: process.execPath }; };
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

test('Gitleaks runs share one deterministic deadline and do not spawn after expiry', () => {
  let now = 1_000;
  const timeouts: number[] = [];
  const reports: string[] = [];
  let calls = 0;
  const run = (_command: string, args: string[], options: any) => {
    calls += 1;
    timeouts.push(options.timeout);
    const report = args[args.indexOf('--report-path') + 1]!;
    reports.push(report.replace(/report-\d+\.json$/, ''));
    writeFileSync(report, '[]');
    now += calls === 1 ? 4_000 : 6_000;
    return { status: 0, error: undefined };
  };
  const result = scanAddedText([
      { path: 'a.txt', line: 1, text: 'one' },
      { path: 'b.txt', line: 1, text: 'two' },
      { path: 'c.txt', line: 1, text: 'three' },
    ], { probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }), run: run as never, now: () => now });
  assert.equal(result.complete, false);
  assert.match(result.reason ?? '', /aggregate scan deadline exceeded/);
  assert.equal(calls, 2, 'the third run is never spawned after the shared deadline expires');
  assert.deepEqual(timeouts, [10_000, 6_000], 'each subprocess receives only the remaining aggregate budget');
  assert.ok(reports.every(path => !existsSync(path)), 'temporary reports are removed on deadline failure');
});

test('fractional remaining scan time is floored and sub-ms scan time expires without spawning', () => {
  const timeouts: number[] = [];
  const run = (_command: string, args: string[], options: any) => {
    timeouts.push(options.timeout);
    writeFileSync(args[args.indexOf('--report-path') + 1]!, '[]');
    return { status: 0, error: undefined };
  };
  const ticks = [0, 659.322673];
  const fractional = scanAddedText([{ path: 'clean.txt', line: 1, text: 'ordinary text' }], {
    probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }),
    run: run as never,
    now: () => ticks.shift()!,
  });
  assert.equal(fractional.complete, true);
  assert.deepEqual(timeouts, [9340], 'spawnSync receives an integer timeout floored from the fractional remaining budget');

  let calls = 0;
  const exhaustedTicks = [0, 9999.2];
  const exhausted = scanAddedText([{ path: 'clean.txt', line: 1, text: 'ordinary text' }], {
    probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }),
    run: (() => { calls += 1; throw new Error('must not spawn with timeout zero'); }) as never,
    now: () => exhaustedTicks.shift()!,
  });
  assert.equal(exhausted.complete, false);
  assert.match(exhausted.reason ?? '', /aggregate scan deadline exceeded/);
  assert.equal(calls, 0, 'a sub-ms budget is expired rather than passed as timeout 0 (unbounded)');
});

test('probe subprocesses receive integer timeouts and sub-ms probe budget expires', () => {
  const directories: string[] = [];
  const makeTemp = (prefix: string) => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  };
  const timeouts: number[] = [];
  const run = (_command: string, args: string[], options: any) => {
    timeouts.push(options.timeout);
    const stdout = args[0] === 'version' ? '8.30.1' : '--report-format --report-path --config --redact';
    return { status: 0, error: undefined, stdout, stderr: '' } as unknown as ReturnType<typeof spawnSync>;
  };
  const available = probeGitleaks(2500.8, makeTemp, { now: () => 0, run: run as never, resolveExecutable: () => process.execPath });
  assert.equal(available.available, true);
  assert.deepEqual(timeouts, [2500, 2500]);
  assert.ok(timeouts.every(timeout => Number.isInteger(timeout) && timeout > 0));
  assert.ok(directories.every(directory => !existsSync(directory)), 'probe temporary directories are removed');

  let calls = 0;
  const expiredDirectories: string[] = [];
  const expired = probeGitleaks(0.8, prefix => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    expiredDirectories.push(directory);
    return directory;
  }, { now: () => 0, run: (() => { calls += 1; throw new Error('must not spawn'); }) as never, resolveExecutable: () => process.execPath });
  assert.equal(expired.available, false);
  assert.equal(expired.backend, 'unavailable');
  assert.match(expired.reason, /aggregate scan deadline exceeded/);
  assert.equal(calls, 0);
  assert.ok(expiredDirectories.every(directory => !existsSync(directory)), 'expired probe temp is removed before return');
});

test('aggregate scanner payload at exactly 4 MiB is accepted', () => {
  let calls = 0;
  const run = (_command: string, args: string[]) => {
    calls += 1;
    writeFileSync(args[args.indexOf('--report-path') + 1]!, '[]');
    return { status: 0, error: undefined };
  };
  const result = scanAddedText([{ path: 'exact-cap.txt', line: 1, text: 'x'.repeat(MAX_SECRET_SCAN_BYTES) }], { probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }), run: run as never });
  assert.equal(result.complete, true);
  assert.equal(calls, 1);
});

test('Gitleaks finding locations retain their complete path for exact exception matching', () => {
  const path = `src/${'deep/'.repeat(80)}token.txt`;
  const run = (_command: string, args: string[]) => {
    writeFileSync(args[args.indexOf('--report-path') + 1]!, JSON.stringify([{ RuleID: 'long-path-rule', StartLine: 1 }]));
    return { status: 1, error: undefined };
  };
  const result = scanAddedText([{ path, line: 42, text: 'payload' }], { probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }), run: run as never });
  assert.equal(result.complete, true);
  assert.equal(result.findings[0]?.path, path);
  assert.ok(result.findings[0]!.path.length > 300);
  assert.equal(MAX_SECRET_SCAN_BYTES, 4 * 1024 * 1024);
});

test('Gitleaks failures and malformed reports are inconclusive without raw diagnostics', () => {
  const change = [{ path: 'src/key.ts', line: 2, text: 'RAW_SECRET_MUST_NOT_ESCAPE' }];
  let failureTemp = '';
  const failed = scanAddedText(change, { probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }), run: ((_command: string, args: string[]) => { failureTemp = args[args.indexOf('--report-path') + 1]!.replace(/report-\d+\.json$/, ''); return { status: 3, error: undefined }; }) as never });
  assert.equal(failed.complete, false);
  assert.ok(!JSON.stringify(failed).includes('RAW_SECRET_MUST_NOT_ESCAPE'));
  assert.equal(existsSync(failureTemp), false, 'temporary reports are removed after scanner failure');
  const malformed = scanAddedText(change, { probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }), run: ((_command: string, args: string[]) => { writeFileSync(args[args.indexOf('--report-path') + 1]!, '{not json'); return { status: 0, error: undefined }; }) as never });
  assert.equal(malformed.complete, false);
  assert.ok(!JSON.stringify(malformed).includes('RAW_SECRET_MUST_NOT_ESCAPE'));
});

test('findings from completed scan runs survive a later failed run', () => {
  let invocation = 0;
  const result = scanAddedText([
    { path: 'first.txt', origin: 'committed', line: 3, text: 'first' },
    { path: 'second.txt', origin: 'staged', line: 8, text: 'second' },
  ], {
    probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }),
    run: ((_command: string, args: string[]) => {
      invocation += 1;
      if (invocation === 1) writeFileSync(args[args.indexOf('--report-path') + 1]!, JSON.stringify([{ RuleID: 'safe-id', StartLine: 1 }]));
      return { status: invocation === 1 ? 1 : 3, error: undefined };
    }) as never,
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.findings, [{ rule: safeGitleaksRuleId('safe-id'), path: 'first.txt', line: 3, origin: 'committed', redacted: true }]);
  assert.ok(result.reason && !/secret|token|key/i.test(result.reason));
});

test('Gitleaks exit status must agree with a valid nonempty or empty JSON report', () => {
  const change = [{ path: 'src/key.ts', line: 2, text: 'sample' }];
  const execute = (status: number, body: unknown) => (_command: string, args: string[]) => {
    writeFileSync(args[args.indexOf('--report-path') + 1]!, JSON.stringify(body));
    return { status, error: undefined };
  };
  const emptyWithLeakStatus = scanAddedText(change, { probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }), run: execute(1, []) as never });
  assert.equal(emptyWithLeakStatus.complete, false);
  const findingWithCleanStatus = scanAddedText(change, { probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }), run: execute(0, [{ RuleID: 'safe-rule', StartLine: 1 }]) as never });
  assert.equal(findingWithCleanStatus.complete, false);
  const clean = scanAddedText(change, { probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }), run: execute(0, []) as never });
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
  const result = scanAddedText([{ path: 'safe.txt', line: 9, text: 'payload' }], { probe: () => ({ available: true, backend: 'gitleaks', executable: process.execPath }), run: run as never });
  assert.equal(result.complete, true);
  assert.equal(result.findings[0]?.rule, safeGitleaksRuleId(hostile));
  assert.ok(!JSON.stringify(result).includes(hostile));
  assert.ok(!JSON.stringify(result).includes('NEVER_OUTPUT_SECRET'));
  assert.ok(!/[\u0000-\u001f\u007f]/.test(JSON.stringify(result)));
});
