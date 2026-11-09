import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { probeGitleaks, safeGitleaksRuleId, scanAddedText } from '../src/preflight/secret-scanner.ts';

test('scanner probe does not expose command output or scanned content', () => {
  const probe = probeGitleaks();
  assert.ok(['gitleaks', 'builtin'].includes(probe.backend));
  assert.ok(typeof probe.available === 'boolean');
  assert.ok(!JSON.stringify(probe).includes('secret'));
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
  const run = (_command: string, args: string[], _options: unknown) => {
    const report = args[args.indexOf('--report-path') + 1]!;
    writeFileSync(report, JSON.stringify([{ RuleID: 'generic-api-key', StartLine: 1, Secret: 'RAW_SECRET_MUST_NOT_ESCAPE' }]));
    return { status: 1, error: undefined };
  };
  const result = scanAddedText([{ path: 'src/key.ts', line: 12, text: 'fake test payload' }], { probe: () => ({ available: true, backend: 'gitleaks' }), run: run as never });
  assert.equal(result.complete, true);
  assert.deepEqual(result.findings, [{ rule: safeGitleaksRuleId('generic-api-key'), path: 'src/key.ts', line: 12, redacted: true }]);
  assert.ok(!JSON.stringify(result).includes('RAW_SECRET_MUST_NOT_ESCAPE'));
});

test('Gitleaks failures and malformed reports are inconclusive without raw diagnostics', () => {
  const change = [{ path: 'src/key.ts', line: 2, text: 'RAW_SECRET_MUST_NOT_ESCAPE' }];
  const failed = scanAddedText(change, { probe: () => ({ available: true, backend: 'gitleaks' }), run: (() => ({ status: 3, error: undefined })) as never });
  assert.equal(failed.complete, false);
  assert.ok(!JSON.stringify(failed).includes('RAW_SECRET_MUST_NOT_ESCAPE'));
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
