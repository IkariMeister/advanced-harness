import type { AnyReceipt } from './installation-receipt.ts';
import { planUninstall } from './installation-receipt.ts';
import { applyManagedFilePlan, planV2Restore, prepareManagedFilePlan } from './receipt-lineage.ts';
import type { HostId } from './host-registry.ts';

export async function runUninstallFlow(input: {
  receipt: AnyReceipt;
  current: string;
  confirm: (message: string) => Promise<string>;
  output: (message: string) => void;
  error: (message: string) => void;
  save: (updated: string) => void;
  backupParent?: string;
  host?: HostId;
}): Promise<number> {
  const plan = planUninstall(input.receipt, input.current);
  if (plan.conflicts.length) {
    input.error(`Uninstall blocked by concurrent edits to: ${plan.conflicts.join(', ')}. No fields changed.`);
    return 1;
  }
  if (input.receipt.version === 2 && input.receipt.managedFiles?.length) {
    const managed = planV2Restore(input.receipt, input.current);
    if (managed.conflicts.length) {
      input.error(`Uninstall blocked by managed-file conflicts: ${managed.conflicts.join(', ')}. No configuration, managed-file, receipt, or backup writes made.`);
      return 1;
    }
  }
  input.output(`Planned actions (${plan.actions.length}):`);
  for (const action of plan.actions) input.output(`  ${action}`);
  if ((await input.confirm('Type uninstall to continue: ')).trim() !== 'uninstall') {
    input.output('Cancelled; no configuration writes made.');
    return 0;
  }
  const reviewedAgain = planUninstall(input.receipt, input.current);
  if (reviewedAgain.conflicts.length) {
    input.error(`Uninstall blocked because restore evidence changed during confirmation: ${reviewedAgain.conflicts.join(', ')}. No writes made.`);
    return 1;
  }
  if (reviewedAgain.updated !== plan.updated) {
    input.error('Uninstall plan changed during confirmation. No writes made; review and retry.');
    return 1;
  }
  if (input.receipt.version === 2 && input.receipt.managedFiles?.length) {
    const managed = planV2Restore(input.receipt, input.current);
    if (managed.conflicts.length) {
      input.error(`Uninstall blocked because managed-file evidence changed during confirmation: ${managed.conflicts.join(', ')}. No writes made.`);
      return 1;
    }
  }
  let managedExecution: ReturnType<typeof prepareManagedFilePlan> | undefined;
  if (input.receipt.version === 2 && input.receipt.managedFiles?.length && input.backupParent) {
    try { managedExecution = prepareManagedFilePlan(input.receipt, input.backupParent); }
    catch (err) { input.error(`Uninstall preflight failed; no writes made: ${String(err)}`); return 1; }
  }
  let saved = false;
  if (plan.updated === input.current) {
    input.output('No configuration changes needed; no backup or configuration write created.');
  } else {
    input.save(plan.updated);
    saved = true;
  }
  if (input.receipt.version === 2 && input.receipt.managedFiles?.length && input.backupParent) {
    try {
      const fileResult = applyManagedFilePlan(input.receipt, input.backupParent, managedExecution);
      for (const mod of fileResult.modified) input.output(`Managed file restored: ${mod}`);
      for (const backup of fileResult.backups) input.output(`Private backup: ${backup}`);
    } catch (err) {
      input.error(`Uninstall partially completed${saved ? '; configuration was restored' : ''}. ${String(err)}. Review completed work and backups before retrying.`);
      return 1;
    }
  }
  return 0;
}
