import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNativeDefinitions, nativeRoles, updateNativeConfiguration, type NativeRole } from '../src/native-installer.ts';
import { verifyRuntime } from '../src/native-diagnostics.ts';

const executable = process.env.HARNESS_LIVE_OPENCODE;

test('live OpenCode reports scoped hidden/disabled roles and an unavailable model without inference', { skip: !executable, timeout: 120000 }, async t => {
  // Explicit opt-in: uses the user's existing CLI/service connection and may start it.
  // Only this disposable project's config is written; no global config or credentials.
  const parent = join(homedir(), 'Projects');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'harness-doctor-live-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const definitions = loadNativeDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));
  const assignments = Object.fromEntries(nativeRoles.map(role => [role, `harness-doctor-unavailable-provider/unavailable-model#low`])) as Record<NativeRole, string>;
  const configuration = updateNativeConfiguration('{"agents":{"lead":{"hidden":true},"operator":{"disabled":true}}}', definitions, assignments, false);
  writeFileSync(join(directory, 'opencode.jsonc'), configuration);
  const expected = Object.fromEntries(nativeRoles.map(role => [role, { ...definitions[role], model: assignments[role] }]));
  const report = await verifyRuntime({ directory, executable: executable! }, expected);
  assert.equal(report.ok, false);
  assert.match(report.checks.find(check => check.role === 'lead')!.issues.join(' '), /Hidden/);
  assert.match(report.checks.find(check => check.role === 'operator')!.issues.join(' '), /Not discovered/);
  assert.match(report.checks.find(check => check.role === 'qa')!.issues.join(' '), /not active.*absent or disabled/);
});
