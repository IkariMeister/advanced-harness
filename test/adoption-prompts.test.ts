import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptExisting, planUninstall, persistAdoptionReceipt } from '../src/installation-receipt.ts';
import { selectAdoptionFields } from '../src/adoption-prompts.ts';
import { adoptionPreviewAction } from '../src/adoption-prompts.ts';

function answers(values: string[]) {
  const asked: string[] = [];
  return { asked, prompt: async (question: string) => { asked.push(question); return values.shift() ?? ''; } };
}

test('bulk yes adopts present agent fields for removal and always asks roots separately', async t => {
  const io = answers(['yes', 'acknowledge', '']);
  const present = ['agents.lead.model', 'agents.qa.system', 'default_agent', 'model'];
  const result = await selectAdoptionFields(present, true, io.prompt);
  assert.deepEqual(result, { selected: [], removed: ['agents.lead.model', 'agents.qa.system'], acknowledged: ['agents.lead.model', 'agents.qa.system'] });
  assert.match(io.asked[0]!, /agent fields for removal/);
  assert.match(io.asked[1]!, /all selected agent fields/);
  assert.match(io.asked[2]!, /Root setting default_agent/);
  assert.match(io.asked[3]!, /Root setting model/);
  const current = '{"agents":{"lead":{"model":"new/l"},"qa":{"system":"managed"},"custom":{"model":"keep"}},"default_agent":"lead","model":"root/new","keep":true}';
  const receipt = adoptExisting('opencode.json', current, undefined, result.selected, result.removed, result.acknowledged);
  assert.deepEqual(receipt.changes.map(c => c.path.join('.')), ['agents.lead.model', 'agents.qa.system']);
  const plan = planUninstall(receipt, current);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(JSON.parse(plan.updated), { agents: { lead: {}, qa: {}, custom: { model: 'keep' } }, default_agent: 'lead', model: 'root/new', keep: true });
});

test('unknown-history removal wording is explicit', async () => {
  const warnings: string[] = [];
  const io = answers(['yes', 'acknowledge', '']);
  await selectAdoptionFields(['agents.lead.model', 'default_agent'], false, io.prompt, warning => warnings.push(warning));
  assert.ok(warnings.some(w => w.includes('explicitly adopted fields will be removed') && w.includes('prior state remains unknown')));
  assert.ok(warnings.every(w => !w.includes('recorded as the prior state')));
});

test('bulk no offers one per-agent choice, acknowledgement, evidence restore, defaults, and blank keep', async () => {
  const io = answers(['n', 'adopt', 'acknowledge', 'restore', '', 'remove', 'acknowledge']);
  const result = await selectAdoptionFields(['agents.lead.model', 'agents.qa.system', 'default_agent', 'model'], true, io.prompt);
  assert.deepEqual(result, { selected: ['agents.qa.system'], removed: ['agents.lead.model', 'model'], acknowledged: ['agents.lead.model', 'model'] });
  assert.equal(io.asked.filter(q => q.startsWith('For ')).length, 2);
  assert.ok(io.asked.some(q => q.includes('Acknowledge unknown history for lead')));
  assert.ok(io.asked.some(q => q.startsWith('Root setting default_agent')));
  assert.ok(io.asked.some(q => q.startsWith('Root setting model')));
});

test('bulk yes with evidence still routes acknowledged agent fields to removal, not restoration', () => {
  const io = answers(['y', 'acknowledge', '']);
  return selectAdoptionFields(['agents.lead.model', 'default_agent'], true, io.prompt).then(result => {
    assert.deepEqual(result, { selected: [], removed: ['agents.lead.model'], acknowledged: ['agents.lead.model'] });
    assert.equal(io.asked.length, 3);
    assert.match(io.asked[2]!, /Root setting default_agent/);
    const current = '{"agents":{"lead":{"model":"new/l"}},"default_agent":"lead"}';
    const before = '{"agents":{"lead":{"model":"old/l"}},"default_agent":"old"}';
    const receipt = adoptExisting('opencode.json', current, before, result.selected, result.removed, result.acknowledged);
    assert.deepEqual(receipt.changes.map(c => c.path.join('.')), ['agents.lead.model']);
    assert.equal(adoptionPreviewAction(receipt.changes[0]!, result.removed), 'agents.lead.model: remove explicitly adopted field; prior state unknown');
    assert.deepEqual(JSON.parse(planUninstall(receipt, current).updated), { agents: { lead: {} }, default_agent: 'lead' });
  });
});

test('bulk removal preview stays unknown with or without supplied evidence; selected absence restoration stays evidence-backed', async () => {
  for (const hasEvidence of [false, true]) {
    const io = answers(['yes', 'acknowledge']);
    const decision = await selectAdoptionFields(['agents.lead.model'], hasEvidence, io.prompt);
    const current = '{"agents":{"lead":{"model":"new/l"}}}';
    const before = hasEvidence ? '{"agents":{}}' : undefined;
    const receipt = adoptExisting('opencode.json', current, before, decision.selected, decision.removed, decision.acknowledged);
    assert.equal(adoptionPreviewAction(receipt.changes[0]!, decision.removed), 'agents.lead.model: remove explicitly adopted field; prior state unknown');
  }
  const io = answers(['n', 'restore']);
  const decision = await selectAdoptionFields(['agents.lead.model'], true, io.prompt);
  const current = '{"agents":{"lead":{"model":"new/l"}}}';
  const receipt = adoptExisting('opencode.json', current, '{"agents":{}}', decision.selected, decision.removed, decision.acknowledged);
  assert.equal(adoptionPreviewAction(receipt.changes[0]!, decision.removed), 'agents.lead.model: restore evidence-backed prior absence on later uninstall');
});

test('bulk no and blank per-agent/root answers keep unmanaged; restore without evidence also keeps', async () => {
  const io = answers(['', 'restore', '', 'restore']);
  const warnings: string[] = [];
  const result = await selectAdoptionFields(['agents.lead.model', 'default_agent'], false, io.prompt, warning => warnings.push(warning));
  assert.deepEqual(result, { selected: [], removed: [], acknowledged: [] });
  assert.equal(io.asked.length, 3);
  assert.equal(warnings.filter(w => w.includes('No before-config evidence')).length, 1);
});

test('final adopt cancellation with a non-empty bulk removal receipt candidate writes nothing', async t => {
  const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'adoption-prompt-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'opencode.json');
  const current = '{"agents":{"lead":{"model":"new/l"}}}';
  writeFileSync(target, current);
  const io = answers(['yes', 'acknowledge']);
  const selected = await selectAdoptionFields(['agents.lead.model'], false, io.prompt);
  const receipt = adoptExisting(target, current, undefined, selected.selected, selected.removed, selected.acknowledged);
  assert.equal(receipt.changes.length, 1, 'the bulk removal decision must produce a non-empty receipt candidate');
  const final = answers(['no']);
  const answer = await final.prompt('Type adopt to record this provenance only: ');
  assert.equal(answer, 'no');
  if (answer.trim() === 'adopt') persistAdoptionReceipt(root, receipt, current, undefined, undefined, true);
  assert.equal(final.asked.length, 1, 'the final confirmation was reached');
  assert.deepEqual(readdirSync(root), ['opencode.json']);
  assert.equal(readFileSync(target, 'utf8'), current);
});
