import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  supportedHosts,
  isSupportedHost,
  parseHostSelection,
  selectNativeHost,
  askHostSelection,
  HOST_MODEL_PRESETS,
  HOST_CAPABILITIES,
  detectInstalledHosts,
  registerHostAdapter,
  getHostAdapter,
  clearRegisteredAdapters,
  type HostId,
  type HostAdapter
} from '../src/host-registry.ts';
import {
  createSuccessorReceipt,
  discoverReceiptChain,
  finalizeSuccessor,
  writePendingSuccessor,
  readReceiptForRestore,
  planV2Restore,
  applyManagedFilePlan,
  type ReceiptSnapshot,
  type ManagedFileEvidence
} from '../src/receipt-lineage.ts';
import { assertNoReceiptOverlap, effectiveReceiptHost } from '../src/installation-receipt.ts';
import { diagnoseHost } from '../src/native-diagnostics.ts';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import { runIntegrationFlow } from '../src/integration-cli-flow.ts';
import { nativeRoles } from '../src/native-installer.ts';
import { makeTempRoot } from './temp-directory.ts';

function createTempDir(prefix: string): string {
  return makeTempRoot(`${prefix}-`);
}

test('supportedHosts and parseHostSelection validate all hosts, aliases, and errors', () => {
  assert.deepEqual(supportedHosts, ['opencode', 'claude-code', 'antigravity', 'codex', 'cursor']);

  // Valid single host
  assert.deepEqual(parseHostSelection('opencode'), ['opencode']);
  assert.deepEqual(parseHostSelection('claude-code'), ['claude-code']);
  assert.deepEqual(parseHostSelection('antigravity'), ['antigravity']);
  assert.deepEqual(parseHostSelection('codex'), ['codex']);
  assert.deepEqual(parseHostSelection('cursor'), ['cursor']);

  // Case insensitivity & trimming
  assert.deepEqual(parseHostSelection('  Claude-Code  '), ['claude-code']);
  assert.deepEqual(parseHostSelection('ANTIGRAVITY'), ['antigravity']);

  // 'all' expansion
  assert.deepEqual(parseHostSelection('all'), [...supportedHosts]);

  // Comma-separated list with deduplication and canonical ordering
  assert.deepEqual(
    parseHostSelection('cursor, opencode, antigravity, opencode'),
    ['opencode', 'antigravity', 'cursor']
  );

  // Errors on empty or invalid hosts
  assert.throws(() => parseHostSelection(''), /Host selection cannot be empty/);
  assert.throws(() => parseHostSelection('   '), /Host selection cannot be empty/);
  assert.throws(() => parseHostSelection('unknown-host'), /Unsupported host: "unknown-host"/);
  assert.throws(() => parseHostSelection('opencode,invalid,cursor'), /Unsupported host: "invalid"/);
});

test('native dispatch selection is shared and fails closed for unsupported/mixed hosts', () => {
  assert.deepEqual(selectNativeHost(['claude-code']), { host: 'claude-code', unsupported: [], multi: false });
  assert.deepEqual(selectNativeHost(['codex']), { unsupported: ['codex'], multi: false });
  assert.deepEqual(selectNativeHost(['claude-code', 'opencode']), { unsupported: [], multi: true });
  assert.deepEqual(selectNativeHost(['codex', 'opencode']), { unsupported: ['codex'], multi: true });
  assert.deepEqual(selectNativeHost(['cursor']), { unsupported: ['cursor'], multi: false });
});

test('askHostSelection defaults on Enter and re-asks invalid, multi-host, and all entries', async () => {
  const inputs = ['', 'invalid-host', 'claude-code,codex', 'all', ' Claude-Code '];
  const questions: string[] = [];
  const notices: string[] = [];
  const ask = async (question: string, suggested?: string) => {
    questions.push(question);
    return inputs.shift() ?? suggested ?? '';
  };

  assert.equal(await askHostSelection(ask, 'opencode', message => notices.push(message)), 'opencode');
  assert.equal(questions.length, 1);
  assert.doesNotMatch(questions[0]!, /comma-separated|all/);

  assert.equal(await askHostSelection(ask, 'opencode', message => notices.push(message)), 'claude-code');
  assert.equal(questions.length, 5);
  assert.equal(notices.length, 3);
  assert.match(notices[0]!, /Unsupported host: "invalid-host"/);
  assert.match(notices[1]!, /Select one host/);
  assert.match(notices[2]!, /Select one host/);
});

test('HOST_MODEL_PRESETS covers all 8 roles across all 5 hosts', () => {
  for (const host of supportedHosts) {
    const presets = HOST_MODEL_PRESETS[host];
    assert.ok(presets, `Missing presets for host ${host}`);
    for (const role of nativeRoles) {
      const preset = presets[role];
      assert.ok(preset, `Host ${host} missing preset for role ${role}`);
      if (host === 'codex') assert.equal(preset.model, '', 'Codex assignments must remain user-selected, not guessed presets');
      else assert.ok(preset.model, `Host ${host} role ${role} missing model identifier`);
    }
  }

  // Claude Code uses opus (planner/reviewer), sonnet (lead/researcher/implementer/qa), haiku (operator/external)
  assert.equal(HOST_MODEL_PRESETS['claude-code'].planner.model, 'opus');
  assert.equal(HOST_MODEL_PRESETS['claude-code'].reviewer.model, 'opus');
  assert.equal(HOST_MODEL_PRESETS['claude-code'].lead.model, 'sonnet');
  assert.equal(HOST_MODEL_PRESETS['claude-code'].operator.model, 'haiku');
  assert.equal(HOST_MODEL_PRESETS['claude-code'].external.model, 'haiku');

  // Antigravity uses inherit, pro, flash, flash_lite
  assert.equal(HOST_MODEL_PRESETS.antigravity.lead.model, 'inherit');
  assert.equal(HOST_MODEL_PRESETS.antigravity.planner.model, 'pro');
  assert.equal(HOST_MODEL_PRESETS.antigravity.reviewer.model, 'pro');
  assert.equal(HOST_MODEL_PRESETS.antigravity.implementer.model, 'flash');
  assert.equal(HOST_MODEL_PRESETS.antigravity.operator.model, 'flash_lite');
  assert.equal(HOST_MODEL_PRESETS.antigravity.external.model, 'flash_lite');

  // Cursor uses phased session tiers
  assert.equal(HOST_MODEL_PRESETS.cursor.lead.model, 'standard');
  assert.equal(HOST_MODEL_PRESETS.cursor.planner.model, 'high-reasoning');
});

test('HOST_CAPABILITIES distinguishes deployed OpenCode enforcement from deferred host plans', () => {
  for (const host of supportedHosts) {
    const cap = HOST_CAPABILITIES[host];
    assert.ok(cap, `Missing capability definition for ${host}`);
    assert.ok(cap.displayName);
    assert.ok(cap.isolationModel);
    assert.ok(cap.permissionModel);
    assert.ok(cap.ghPrMergeGuard.length > 0, `Missing gh pr merge guard for ${host}`);
    assert.ok(cap.disclosures.length >= 2, `Missing disclosures for ${host}`);
  }

  assert.equal(HOST_CAPABILITIES.opencode.isolationModel, 'native-subagents');
  assert.equal(HOST_CAPABILITIES.antigravity.isolationModel, 'lead-driven-subagents');
  assert.equal(HOST_CAPABILITIES.antigravity.permissionModel, 'hooks-and-subagent-tool-groups');
  assert.match(HOST_CAPABILITIES.antigravity.ghPrMergeGuard, /PreToolUse/);

  assert.equal(HOST_CAPABILITIES['claude-code'].isolationModel, 'native-subagents');
  assert.equal(HOST_CAPABILITIES['claude-code'].permissionModel, 'settings-permissions-and-disallowed-tools');
  assert.match(HOST_CAPABILITIES['claude-code'].ghPrMergeGuard, /Bash\(gh pr merge\)/);

  for (const host of ['cursor'] as const) {
    assert.equal(HOST_CAPABILITIES[host].isolationModel, 'not-deployed');
    assert.equal(HOST_CAPABILITIES[host].permissionModel, 'not-deployed');
    assert.match(HOST_CAPABILITIES[host].ghPrMergeGuard, /No .* merge guard is deployed/);
    assert.ok(HOST_CAPABILITIES[host].disclosures.some(note => /not deployed|no native role files/i.test(note)));
  }
  assert.equal(HOST_CAPABILITIES.codex.isolationModel, 'native-subagents');
  assert.equal(HOST_CAPABILITIES.codex.permissionModel, 'execpolicy-and-sandbox');
  assert.match(HOST_CAPABILITIES.codex.ghPrMergeGuard, /indirect\/API routes are not universally blocked/);
  assert.equal(HOST_CAPABILITIES.cursor.configLocations.project.includes('.cursor/skills'), true);
});

test('detectInstalledHosts accurately scans project and home config files', () => {
  const tempProject = createTempDir('detect-test');
  const tempHome = createTempDir('detect-home');

  try {
    // Empty directory defaults to ['opencode'] fallback
    const emptyDetected = detectInstalledHosts(tempProject, tempHome);
    assert.deepEqual(emptyDetected, ['opencode']);

    // Add Claude Code markers
    mkdirSync(join(tempProject, '.claude'), { recursive: true });
    writeFileSync(join(tempProject, 'CLAUDE.md'), '# Claude Config');
    const claudeDetected = detectInstalledHosts(tempProject, tempHome);
    assert.deepEqual(claudeDetected, ['claude-code']);

    // Add Antigravity markers in project
    mkdirSync(join(tempProject, '.agents'), { recursive: true });
    writeFileSync(join(tempProject, 'hooks.json'), '{}');
    const multiDetected = detectInstalledHosts(tempProject, tempHome);
    assert.deepEqual(multiDetected, ['claude-code', 'antigravity']);
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('Host adapter registry supports dynamic registration and lookup', () => {
  clearRegisteredAdapters();
  try {
    assert.equal(getHostAdapter('antigravity'), undefined);
    const mockAdapter: HostAdapter = {
      host: 'antigravity',
      install: async () => {},
      update: async () => {},
      doctor: async () => ({ ok: true, issues: [], notes: ['Mock active'] })
    };
    registerHostAdapter(mockAdapter);
    assert.equal(getHostAdapter('antigravity'), mockAdapter);
  } finally {
    clearRegisteredAdapters();
  }
});

test('diagnoseHost produces structured report with presets and disclosures', async () => {
  const tempProject = createTempDir('diag-test');
  try {
    const report = await diagnoseHost('antigravity', { project: tempProject });
    assert.equal(report.host, 'antigravity');
    assert.equal(report.displayName, 'Google Antigravity');
    assert.equal(typeof report.installed, 'boolean');
    assert.ok(report.disclosures.length > 0);
    assert.equal(report.rolePresets.lead.model, 'inherit');
    assert.ok(report.notes.some(n => n.includes('configuration footprint detected') || n.includes('configuration files not detected')));
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
  }
});

test('multi-host receipt lineage: host isolation, managedFiles restore, and assertNoReceiptOverlap', () => {
  const tempDir = createTempDir('receipt-multihost-test');
  const targetConfig = join(tempDir, 'opencode.json');
  writeFileSync(targetConfig, '{"custom": "base"}');

  try {
    // 1. Create a snapshot for opencode
    const snapshotOpenCode = discoverReceiptChain(tempDir, targetConfig, 'opencode');
    assert.equal(snapshotOpenCode.host, 'opencode');
    assert.equal(snapshotOpenCode.entries.length, 0);

    const receiptOpenCode = createSuccessorReceipt(
      snapshotOpenCode,
      '{"custom": "base"}',
      '{"custom": "base", "model": "openai/gpt-4"}',
      {},
      undefined,
      { host: 'opencode' }
    );
    assert.equal(receiptOpenCode.host, 'opencode');
    assert.equal(effectiveReceiptHost(receiptOpenCode), 'opencode');

    const pendingOpenCode = writePendingSuccessor(snapshotOpenCode, receiptOpenCode);
    writeFileSync(targetConfig, '{"custom": "base", "model": "openai/gpt-4"}');
    finalizeSuccessor(pendingOpenCode, '{"custom": "base", "model": "openai/gpt-4"}');

    // 2. Discovering receipt chain for 'claude-code' on the same target does not see the opencode receipt
    const snapshotClaude = discoverReceiptChain(tempDir, targetConfig, 'claude-code');
    assert.equal(snapshotClaude.host, 'claude-code');
    assert.equal(snapshotClaude.entries.length, 0);

    // 3. assertNoReceiptOverlap isolates by host
    // Overlapping proposed change for 'opencode' would collide with the existing opencode receipt
    const proposedChange = {
      version: 1 as const,
      target: targetConfig,
      complete: true,
      provenance: 'installer' as const,
      changes: [{ path: ['model'], before: { absent: true }, after: { value: 'openai/gpt-4' } }],
      createdContainers: []
    };
    assert.throws(
      () => assertNoReceiptOverlap(tempDir, targetConfig, proposedChange, '{"custom": "base", "model": "openai/gpt-4"}', 'opencode'),
      /Outstanding receipt/
    );

    // For 'claude-code', the same change does NOT collide because host isolation partitions the receipts
    assert.doesNotThrow(() => {
      assertNoReceiptOverlap(tempDir, targetConfig, proposedChange, '{"custom": "base", "model": "openai/gpt-4"}', 'claude-code');
    });

    // 4. Managed file evidence tracking and restoration
    const managedFilePath = join(tempDir, 'CLAUDE.md');
    writeFileSync(managedFilePath, '# Managed Instructions');

    const managedFileEvidence: ManagedFileEvidence = {
      path: managedFilePath,
      kind: 'instructions',
      before: { absent: true },
      after: { content: '# Managed Instructions' }
    };

    const receiptClaude = createSuccessorReceipt(
      snapshotClaude,
      undefined,
      '{"custom": "base", "default_agent": "lead"}',
      {},
      undefined,
      { host: 'claude-code', managedFiles: [managedFileEvidence] }
    );
    assert.equal(receiptClaude.host, 'claude-code');
    assert.equal(receiptClaude.managedFiles?.length, 1);

    const pendingClaude = writePendingSuccessor(snapshotClaude, receiptClaude);
    writeFileSync(targetConfig, '{"custom": "base", "default_agent": "lead"}');
    finalizeSuccessor(pendingClaude, '{"custom": "base", "default_agent": "lead"}');

    const discoveredClaude = readReceiptForRestore(pendingClaude.path, targetConfig) as typeof receiptClaude;

    // Test planV2Restore detects managed files
    const restorePlan = planV2Restore(discoveredClaude, '{"custom": "base", "default_agent": "lead"}');
    assert.ok(restorePlan.actions.some(a => a.includes('remove installer-created instructions')));

    // Apply managed file plan
    const restoreResult = applyManagedFilePlan(discoveredClaude, tempDir);
    assert.equal(existsSync(managedFilePath), false);
    assert.ok(restoreResult.modified.some(m => m.includes('removed')));
    assert.equal(restoreResult.backups.length, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Codex and Cursor install/update fail closed before adapters or writes', async () => {
  const tempProject = createTempDir('flow-multihost-test');
  const tempHome = createTempDir('flow-home');
  const logs: string[] = [];
  const ask = async (_q: string, suggested?: string) => suggested ?? '';

  try {
    let adapterCalls = 0;
    const adapter = (host: 'codex') => ({ host, install: async () => { adapterCalls++; }, update: async () => { adapterCalls++; } });
    for (const host of ['codex', 'cursor'] as const) {
      const deps = { ask, output: (msg: string) => logs.push(msg), error: (msg: string) => logs.push(`ERR: ${msg}`), home: tempHome, getHostAdapter: (id: string) => id === 'codex' ? adapter('codex') : undefined };
      assert.equal(await runInstallerFlow({ scope: 'project', project: tempProject, host }, deps), 2, host);
      assert.equal(await runUpdateFlow({ scope: 'project', project: tempProject, host }, deps), 2, host);
    }
    assert.equal(adapterCalls, 0);
    assert.ok(logs.some(l => l.includes('issue #46')));
    assert.ok(logs.some(l => l.includes('issue #45') && l.includes('strict per-role isolation')));
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('integration CLI flow rejects unsupported and multi-host selections before filesystem discovery or checks', async () => {
  let asks = 0;
  const deps = { ask: async () => { asks++; return 'none'; }, output: () => {}, error: () => {}, cwd: 'Z:\\does-not-exist', home: 'Z:\\does-not-exist' };
  for (const host of ['claude-code', 'opencode,codex', 'all']) {
    await assert.rejects(runIntegrationFlow({ scope: 'global', host }, deps), /only OpenCode/);
  }
  assert.equal(asks, 0);
});
