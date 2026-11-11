import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeGitleaks, scanAddedText } from '../src/preflight/secret-scanner.ts';

test('pinned Gitleaks supports clean and multi-run added-text scans', (context) => {
  const probe = probeGitleaks();
  if (!probe.available) {
    if (process.env.REQUIRE_GITLEAKS === '1') assert.fail(`Required Gitleaks lane unavailable: ${probe.reason}`);
    context.skip(`Gitleaks is not available in this local environment (${probe.reason ?? 'probe failed'}).`);
    return;
  }

  const clean = scanAddedText([{ path: 'clean.txt', origin: 'committed', line: 4, text: 'ordinary source text' }]);
  assert.equal(clean.backend, 'gitleaks');
  assert.equal(clean.complete, true, clean.reason ?? 'Gitleaks clean scan did not complete.');
  assert.deepEqual(clean.findings, []);

  const findings = scanAddedText([
    { path: 'first.txt', origin: 'committed', line: 12, text: 'ghp_7Q2M9L1X8C4D6E0F7Q2M9L1X8C4D6E0F7Q2M9L1X' },
    { path: 'second.txt', origin: 'staged', line: 3, text: 'ghp_7Q2M9L1X8C4D6E0F7Q2M9L1X8C4D6E0F7Q2M9L1X' },
  ]);
  assert.equal(findings.backend, 'gitleaks');
  assert.equal(findings.complete, true);
  assert.equal(findings.findings.length, 2);
  assert.deepEqual(findings.findings.map(({ path, line, origin }) => ({ path, line, origin })), [
    { path: 'first.txt', line: 12, origin: 'committed' },
    { path: 'second.txt', line: 3, origin: 'staged' },
  ]);
  assert.ok(findings.findings.every(finding => /^gitleaks-[a-f0-9]{64}$/.test(finding.rule)));
  assert.equal(findings.findings[0]?.rule, findings.findings[1]?.rule);
});
