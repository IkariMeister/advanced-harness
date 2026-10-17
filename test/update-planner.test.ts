import test from 'node:test';
import assert from 'node:assert/strict';
import { computeUnifiedDiff, planUpdate } from '../src/update-planner.ts';
import { nativeRoles, type NativeDefinition } from '../src/native-installer.ts';
import type { ReceiptSnapshot } from '../src/receipt-lineage.ts';

test('computeUnifiedDiff computes simple additions and removals', () => {
  const diff = computeUnifiedDiff('line1\nline2', 'line1\nline3');
  assert.ok(diff.some(l => l.startsWith('  line1')));
  assert.ok(diff.some(l => l.startsWith('- line2')));
  assert.ok(diff.some(l => l.startsWith('+ line3')));
});

test('planUpdate reports unchanged when installed matches source templates', () => {
  const definitions = Object.fromEntries(
    nativeRoles.map(role => [
      role,
      {
        description: `Description of ${role}`,
        mode: role === 'lead' ? 'primary' : 'subagent',
        model: 'openai/gpt-6-luna',
        permissions: [],
        system: `System prompt for ${role}`
      }
    ])
  ) as Record<string, NativeDefinition>;

  const config = {
    agents: Object.fromEntries(
      nativeRoles.map(role => [
        role,
        {
          description: `Description of ${role}`,
          mode: role === 'lead' ? 'primary' : 'subagent',
          model: 'custom/model#high',
          permissions: [],
          system: `System prompt for ${role}`,
          custom_tag: 'preserved'
        }
      ])
    )
  };

  const headEntry = {
    file: 'native-install-1.json',
    text: '{}',
    identity: '1',
    digest: 'a'.repeat(64),
    receipt: {
      version: 2 as const,
      id: '00000000-0000-0000-0000-000000000000',
      target: '/test/opencode.json',
      complete: true as const,
      status: 'complete' as const,
      provenance: 'installer' as const,
      predecessor: null,
      changes: [],
      createdContainers: [],
      permissions: [],
      harnessVersion: { version: '0.1.0', commit: 'abcdef' }
    }
  };

  const snapshot: ReceiptSnapshot = {
    directory: '/test',
    target: '/test/opencode.json',
    fingerprint: '123',
    entries: [headEntry],
    head: headEntry
  };

  const plan = planUpdate(config, definitions, snapshot);
  assert.equal(plan.hasChanges, false);
  assert.equal(plan.migrationNotes.length, 0);
  assert.equal(plan.roles.lead.status, 'unchanged');
  assert.deepEqual(plan.roles.lead.preservedFields.customFields, ['custom_tag']);
  assert.equal(plan.roles.lead.preservedFields.model, 'custom/model#high');
});

test('planUpdate detects prompt and description changes and migration notes', () => {
  const definitions = Object.fromEntries(
    nativeRoles.map(role => [
      role,
      {
        description: `Source desc of ${role}`,
        mode: role === 'lead' ? 'primary' : 'subagent',
        model: 'openai/gpt-6-luna',
        permissions: [],
        system: `New system prompt for ${role}`
      }
    ])
  ) as Record<string, NativeDefinition>;

  const config = {
    agents: {
      lead: {
        description: 'Old desc of lead',
        mode: 'primary',
        model: 'openai/gpt-6-astra#medium',
        permissions: [],
        system: 'Old system prompt for lead'
      }
    }
  };

  const snapshot: ReceiptSnapshot = {
    directory: '/test',
    target: '/test/opencode.json',
    fingerprint: '123',
    entries: []
  };

  const plan = planUpdate(config, definitions, snapshot);
  assert.equal(plan.hasChanges, true);
  assert.equal(plan.roles.lead.status, 'both-changed');
  assert.ok(plan.roles.lead.diffLines && plan.roles.lead.diffLines.length > 0);
  assert.equal(plan.roles.operator.status, 'not-installed');
  assert.ok(plan.migrationNotes.some(n => n.includes('No installation receipt found')));
});
