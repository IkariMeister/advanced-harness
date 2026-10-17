import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPromptDeployment, deployPrompts } from '../src/prompt-deployment.ts';
import { loadNativeDefinitions, nativeRoles, parseConfiguration, type NativeDefinition, type NativeRole } from '../src/native-installer.ts';
import { discoverReceiptChain } from '../src/receipt-lineage.ts';

const definitions = loadNativeDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'harness-prompt-deploy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('planPromptDeployment throws on missing agents object', () => {
  assert.throws(
    () => planPromptDeployment('{}', definitions, 'opencode.json'),
    /has no native agents object/
  );
});

test('planPromptDeployment throws when native roles are missing', () => {
  const text = JSON.stringify({ agents: { lead: { model: 'test/model' } } });
  assert.throws(
    () => planPromptDeployment(text, definitions, 'opencode.json'),
    /Native role 'operator' is missing/
  );
});

test('planPromptDeployment detects unchanged prompts and reports hasChanges: false', () => {
  const agents: Record<string, unknown> = {};
  for (const role of nativeRoles) {
    agents[role] = {
      model: `provider/${role}#variant`,
      description: definitions[role].description,
      system: definitions[role].system,
      permissions: [{ action: 'shell', resource: '*', effect: 'deny' }]
    };
  }
  const original = JSON.stringify({ agents }, null, 2);
  const plan = planPromptDeployment(original, definitions, 'opencode.json');
  assert.equal(plan.hasChanges, false);
  assert.equal(plan.roles.every(r => !r.descriptionChanged && !r.systemChanged), true);
});

test('planPromptDeployment updates outdated description and system while preserving models and permissions', () => {
  const agents: Record<string, unknown> = {};
  for (const role of nativeRoles) {
    agents[role] = {
      model: `custom-provider/${role}-custom#high`,
      description: 'Outdated description',
      system: 'Outdated system prompt',
      permissions: [
        { action: 'shell', resource: `git *`, effect: 'allow' },
        { action: 'shell', resource: '*', effect: 'deny' }
      ],
      customField: 'preserved-custom-value'
    };
  }
  const original = JSON.stringify({ agents, default_agent: 'lead' }, null, 2);
  const plan = planPromptDeployment(original, definitions, 'opencode.json');
  assert.equal(plan.hasChanges, true);
  assert.equal(plan.roles.every(r => r.descriptionChanged && r.systemChanged), true);

  const updatedConfig = parseConfiguration(plan.updatedText, 'opencode.json');
  assert.equal(updatedConfig.default_agent, 'lead');

  const updatedAgents = updatedConfig.agents as Record<string, Record<string, unknown>>;
  for (const role of nativeRoles) {
    assert.equal(updatedAgents[role]?.description, definitions[role].description);
    assert.equal(updatedAgents[role]?.system, definitions[role].system);
    // Preserves models
    assert.equal(updatedAgents[role]?.model, `custom-provider/${role}-custom#high`);
    // Preserves permissions
    assert.deepEqual(updatedAgents[role]?.permissions, [
      { action: 'shell', resource: `git *`, effect: 'allow' },
      { action: 'shell', resource: '*', effect: 'deny' }
    ]);
    // Preserves custom field
    assert.equal(updatedAgents[role]?.customField, 'preserved-custom-value');
  }
});

test('deployPrompts writes backup, updates config and generates cumulative v2 receipt', (t) => {
  const root = fixture(t);
  const configPath = join(root, 'opencode.json');
  const backupDir = join(root, 'backups');

  const agents: Record<string, unknown> = {};
  for (const role of nativeRoles) {
    agents[role] = {
      model: `openai/${role}#low`,
      description: 'Old description',
      system: 'Old system',
      permissions: []
    };
  }
  const originalText = JSON.stringify({ agents }, null, 2) + '\n';
  writeFileSync(configPath, originalText, 'utf8');

  const result = deployPrompts(configPath, backupDir, {
    definitionsDirectory: fileURLToPath(new URL('../agents/', import.meta.url))
  });

  assert.equal(result.updated, true);
  assert.ok(result.backup);
  assert.ok(result.receiptPath);

  const savedText = readFileSync(configPath, 'utf8');
  const saved = parseConfiguration(savedText, configPath);
  const savedAgents = saved.agents as Record<string, Record<string, unknown>>;
  for (const role of nativeRoles) {
    assert.equal(savedAgents[role]?.description, definitions[role].description);
    assert.equal(savedAgents[role]?.system, definitions[role].system);
    assert.equal(savedAgents[role]?.model, `openai/${role}#low`);
  }

  // Idempotent repeat: no update
  const repeat = deployPrompts(configPath, backupDir, {
    definitionsDirectory: fileURLToPath(new URL('../agents/', import.meta.url))
  });
  assert.equal(repeat.updated, false);

  // Verify receipt chain
  const chain = discoverReceiptChain(backupDir, configPath);
  assert.ok(chain.head);
  assert.equal(chain.head.receipt.version, 2);
  assert.equal(chain.head.receipt.provenance, 'installer');
});

test('deployPrompts refuses config or template drift from the reviewed preview before writes', (t) => {
  const root = fixture(t);
  const configPath = join(root, 'opencode.json');
  const backupDir = join(root, 'backups');
  const agents = Object.fromEntries(nativeRoles.map(role => [role, { description: 'old', system: 'old' }]));
  const original = JSON.stringify({ agents });
  writeFileSync(configPath, original);
  const reviewed = planPromptDeployment(original, definitions, configPath);
  writeFileSync(configPath, original + ' ');
  assert.throws(() => deployPrompts(configPath, backupDir, { reviewedPlan: reviewed }), /changed since preview/);
  assert.equal(existsSync(backupDir), false);
  writeFileSync(configPath, original);
  const changedDefinitions = { ...definitions, lead: { ...definitions.lead, system: definitions.lead.system + ' changed' } };
  assert.throws(() => deployPrompts(configPath, backupDir, {
    reviewedPlan: reviewed,
    deps: { loadDefinitions: () => changedDefinitions }
  }), /changed since preview/);
  assert.equal(existsSync(backupDir), false);
});
