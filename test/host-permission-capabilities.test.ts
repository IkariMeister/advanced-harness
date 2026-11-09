import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diagnoseHost } from '../src/native-diagnostics.ts';
import { supportedHosts } from '../src/host-registry.ts';
import { formatHostPermissionRow, hostPermissionMatrix, permissionBoundaryStatuses, permissionCapabilities, type HostPermissionRow } from '../src/host-permission-capabilities.ts';

const documentation = readFileSync(new URL('../docs/host-permission-capabilities.md', import.meta.url), 'utf8');
const labels = { opencode: 'OpenCode', 'claude-code': 'Claude Code', antigravity: 'Antigravity', codex: 'Codex', cursor: 'Cursor' };

test('every selectable host has all five boundaries with scoped, traceable evidence and matching documentation', () => {
  assert.deepEqual(Object.keys(hostPermissionMatrix).sort(), [...supportedHosts].sort());
  for (const host of supportedHosts) {
    const row = hostPermissionMatrix[host];
    assert.equal(row.host, host);
    assert.deepEqual(Object.keys(row.capabilities), Object.keys(permissionCapabilities));
    const summary = '| [' + labels[host] + '](#' + host + ') | ' + Object.values(row.capabilities).map(cell => cell.status).join(' | ') + ' |';
    assert.ok(documentation.includes(summary), 'summary drift: ' + host);
    const section = documentation.split('<a id="' + host + '"></a>')[1]!.split('<a id=')[0]!;
    for (const [key, label] of Object.entries(permissionCapabilities)) {
      const cell = row.capabilities[key as keyof typeof permissionCapabilities];
      assert.ok(permissionBoundaryStatuses.includes(cell.status));
      assert.ok(cell.scope.trim());
      assert.ok(cell.evidence.length);
      const links = cell.evidence.map(e => '[' + e.kind + '](' + (e.source.startsWith('https://') ? e.source : '../' + e.source) + ')' + (e.kind === 'live-run' ? '; runner: ' + e.runner : '')).join('; ');
      assert.ok(section.includes('| ' + label + ' | ' + cell.status + ' | ' + cell.scope + ' | ' + links + ' |'), 'detail drift: ' + host + '/' + key);
      for (const evidence of cell.evidence) {
        if (!evidence.source.startsWith('https://')) assert.ok(existsSync(fileURLToPath(new URL('../' + evidence.source.split('#')[0], import.meta.url))), evidence.source);
        if (evidence.kind === 'live-run') assert.ok(evidence.runner.trim());
      }
    }
  }
});

test('Claude Code local/remote isolation is recorded as advisory, and no Claude Code cell claims enforcement (ADR-005)', () => {
  const claude = hostPermissionMatrix['claude-code'].capabilities;
  assert.equal(claude.localRemoteIsolation.status, 'advisory');
  assert.ok(Object.values(claude).every(cell => cell.status !== 'enforced'));
});

for (const status of permissionBoundaryStatuses) {
  test('formatting preserves recorded ' + status + ' with scope and evidence', () => {
    // Synthetic evidence tests the formatter, never promotes a production host row.
    const base = hostPermissionMatrix.codex;
    const row: HostPermissionRow = { ...base, capabilities: { ...base.capabilities, roleCommands: {
      status, scope: 'Only this fixture boundary.', evidence: [{ kind: 'live-run', source: 'https://example.test/run', runner: 'fixture runner' }],
    } } };
    const output = formatHostPermissionRow(row).join('\n');
    assert.ok(output.includes(permissionCapabilities.roleCommands + ': ' + status));
    assert.match(output, /Only this fixture boundary/);
    assert.match(output, /Evidence \(live-run\): https:\/\/example.test\/run; runner: fixture runner/);
    assert.equal(base.capabilities.roleCommands.status, 'unverified', 'formatting cannot mutate evidence');
  });
}

test('healthy installation does not promote unsupported or unverified boundaries', async () => {
  // Cursor has no deployed native adapter: its existing diagnostic can be healthy
  // even though every boundary is unsupported. Matrix evidence stays independent.
  const report = await diagnoseHost('cursor', { scope: 'project', home: '/unused-matrix-fixture-home' });
  assert.equal(report.ok, true);
  assert.equal(report.permissionCapabilities, hostPermissionMatrix.cursor);
  assert.ok(Object.values(report.permissionCapabilities.capabilities).every(cell => cell.status === 'unsupported'));
  assert.ok(formatHostPermissionRow(hostPermissionMatrix.codex).join('\n').includes(': unverified'));
});
