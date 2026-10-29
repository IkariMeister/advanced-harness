import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { applyEdits, modify } from 'jsonc-parser';
import { configurationField, createReceipt, modifyJsonc, assertSafeFilesystemPath } from './installation-receipt.ts';
import { parseConfiguration, saveInstallation, type Ask, type NativeRole } from './native-installer.ts';
import { reconcilePermissions, type PermissionRule, type ReconciliationResult } from './permission-reconciliation.ts';
import { createSuccessorReceipt, discoverReceiptChain, finalizeSuccessor, receiptReconciliationOptions, recoverFailedSuccessor, revalidatePendingSuccessor, revalidateReceiptSnapshot, writePendingSuccessor, type ReceiptSnapshot, type V2Receipt } from './receipt-lineage.ts';

export const prFeedbackPermissionRules: readonly PermissionRule[] = [
  { action: 'shell', resource: 'gh pr view', effect: 'allow' },
  { action: 'shell', resource: 'gh pr view *', effect: 'allow' },
  { action: 'shell', resource: 'gh.exe pr view', effect: 'allow' },
  { action: 'shell', resource: 'gh.exe pr view *', effect: 'allow' },
];

const permissionPath = ['agents', 'external', 'permissions'];
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const rulesEqual = (left: PermissionRule, right: PermissionRule) => left.action === right.action && left.resource === right.resource && left.effect === right.effect;

function appendJsoncArrayEntries(text: string, path: string[], startIndex: number, entries: readonly PermissionRule[]): string {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  let updated = bom ? text.slice(1) : text;
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' } };
  for (const [offset, entry] of entries.entries()) {
    updated = applyEdits(updated, modify(updated, [...path, startIndex + offset], entry, options));
  }
  return bom + updated;
}

export type PrFeedbackPermissionPreview = {
  target: string;
  original: string;
  updated: string;
  recoveryDirectory: string;
  snapshot: ReceiptSnapshot;
  plan: ReconciliationResult;
  receipt?: V2Receipt;
};

export type PrFeedbackPermissionDependencies = {
  ask?: Ask;
  output(message: string): void;
  error(message: string): void;
  save?: typeof saveInstallation;
  writePending?: typeof writePendingSuccessor;
  finalize?: typeof finalizeSuccessor;
};

/** Read-only preview. It accepts only an active, complete v2 receipt chain that manages External permissions. */
export function previewPrFeedbackPermissions(target: string, recoveryDirectory = resolve(homedir(), 'Projects', 'advanced-harness-backups')): PrFeedbackPermissionPreview {
  target = assertSafeFilesystemPath(target, 'file');
  if (!existsSync(target) || !lstatSync(target).isFile()) throw new Error('Select an existing regular OpenCode configuration file.');
  const original = readFileSync(target, 'utf8');
  parseConfiguration(original, target);
  const permissions = configurationField(original, permissionPath);
  if (!Array.isArray(permissions)) throw new Error('Installed External permissions are missing or malformed. No changes made.');

  const snapshot = discoverReceiptChain(recoveryDirectory, target);
  const head = snapshot.head?.receipt;
  if (!head || head.version !== 2 || head.status !== 'complete' || !head.complete) throw new Error('A complete active v2 installation receipt chain is required. No changes made.');
  const externalEvidence = head.permissions.find(entry => same(entry.path, permissionPath));
  const externalChange = head.changes.find(change => same(change.path, permissionPath));
  if (!externalEvidence || !externalChange || !same(externalEvidence.order, permissions) || !same(externalChange.after, { value: permissions })) {
    throw new Error('The active receipt does not match installed External permissions. Resolve receipt/configuration drift first.');
  }

  const options = receiptReconciliationOptions(snapshot);
  const previous = options.permissions?.external;
  if (!previous) throw new Error('The active receipt lacks External permission ownership/order evidence. No changes made.');
  const missing = prFeedbackPermissionRules.filter(rule => !permissions.some(existing => rulesEqual(existing as PermissionRule, rule)));
  const plan = reconcilePermissions({ existing: permissions as PermissionRule[], prior: previous.prior, previousOrder: previous.previousOrder,
    desired: missing.map(rule => ({ rule, sources: ['integration:gh'] })) });
  if (plan.preview.conflicts.length) throw new Error(`Permission conflict; no changes made: ${plan.preview.conflicts.map(conflict => conflict.message).join(' ')}`);
  if (plan.preview.removals.length || plan.preview.additions.some(rule => !prFeedbackPermissionRules.some(expected => rulesEqual(expected, rule))) ||
      plan.preview.additions.length !== missing.length || plan.rules.filter(rule => !permissions.some(existing => rulesEqual(existing, rule))).some(rule => !prFeedbackPermissionRules.some(expected => rulesEqual(expected, rule)))) {
    throw new Error('The reconciled result exceeds the four approved External rules. No changes made.');
  }
  // The original permission sequence must remain intact; the only new rules are the approved additions.
  let cursor = 0;
  for (const rule of permissions as PermissionRule[]) {
    while (cursor < plan.rules.length && !rulesEqual(plan.rules[cursor]!, rule)) cursor++;
    if (cursor === plan.rules.length) throw new Error('Permission reconciliation would alter existing rules. No changes made.');
    cursor++;
  }
  if (!same(plan.rules, [...permissions, ...plan.preview.additions])) throw new Error('The approved rules cannot be added without changing existing permission order. No changes made.');

  const updated = plan.preview.additions.length ? appendJsoncArrayEntries(original, permissionPath, permissions.length, plan.preview.additions) : original;
  parseConfiguration(updated, 'reviewed External permission update');
  const changes = createReceipt(target, original, updated).changes;
  if (changes.some(change => !same(change.path, permissionPath)) || (changes.length > 0 && changes.length !== 1)) throw new Error('The JSONC patch would change fields outside External permissions. No changes made.');
  const receipt = changes.length ? createSuccessorReceipt(snapshot, original, updated, { external: plan } as Partial<Record<NativeRole, ReconciliationResult>>) : undefined;
  if (receipt && (!same(receipt.changes.filter(change => !same(change.path, permissionPath)), head.changes.filter(change => !same(change.path, permissionPath))) ||
      !same(receipt.permissions.filter(entry => entry.path[1] !== 'external'), head.permissions.filter(entry => entry.path[1] !== 'external')))) {
    throw new Error('Receipt preview exceeds the External permissions scope. No changes made.');
  }
  return { target, original, updated, recoveryDirectory: resolve(recoveryDirectory), snapshot, plan, ...(receipt ? { receipt } : {}) };
}

export async function runPrFeedbackPermissionsFlow(options: { target: string; recoveryDirectory?: string; apply?: boolean }, deps: PrFeedbackPermissionDependencies): Promise<number> {
  const preview = previewPrFeedbackPermissions(options.target, options.recoveryDirectory);
  deps.output(`Target: ${preview.target}`);
  deps.output(`External permission additions: ${JSON.stringify(preview.plan.preview.additions)}`);
  deps.output('No preferences, roles, models, or permissions outside External\'s four approved rules are changed by this adapter. Preview is not approval.');
  if (!preview.receipt || preview.updated === preview.original) { deps.output('No changes needed; no receipt or backup will be written.'); return 0; }
  if (!options.apply) { deps.output('Read-only preview only. After separate conversational approval of this exact diff, rerun with --apply.'); return 0; }
  if (!deps.ask || (await deps.ask('After separate conversational approval, type add-pr-feedback-permissions to apply exactly the previewed rules', 'cancel')) !== 'add-pr-feedback-permissions') {
    deps.output('Cancelled. No files, receipts, or backups changed.'); return 0;
  }

  assertSafeFilesystemPath(preview.target, 'file');
  const current = existsSync(preview.target) ? readFileSync(preview.target, 'utf8') : undefined;
  if (current !== preview.original) throw new Error('Configuration changed after preview; no write permitted. Rerun preview and obtain approval for the new diff.');
  revalidateReceiptSnapshot(preview.snapshot);
  const pending = (deps.writePending ?? writePendingSuccessor)(preview.snapshot, preview.receipt);
  let backup: string | undefined;
  try {
    revalidatePendingSuccessor(pending);
    backup = (deps.save ?? saveInstallation)(preview.target, preview.original, preview.updated, preview.recoveryDirectory);
  } catch (error) {
    if (recoverFailedSuccessor(pending, preview.original) !== 'cleared') deps.error(`Configuration save may be partial; pending receipt retained at ${pending.path}. Inspect read-only before any retry.`);
    throw error;
  }
  try { (deps.finalize ?? finalizeSuccessor)(pending, preview.updated); }
  catch (error) { deps.error(`Configuration saved but receipt finalization failed; pending receipt retained at ${pending.path}. Inspect read-only before any retry.`); throw error; }
  if (backup) deps.output(`Private backup: ${backup}`);
  deps.output(`External PR feedback permissions saved. Receipt: ${pending.path}`);
  return 0;
}

export function feedbackPermissionsRecoveryDirectory(home = homedir()): string {
  return resolve(home, 'Projects', 'advanced-harness-backups');
}
