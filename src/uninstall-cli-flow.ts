import type { AnyReceipt } from './installation-receipt.ts';
import { planUninstall } from './installation-receipt.ts';

export async function runUninstallFlow(input: {
  receipt: AnyReceipt;
  current: string;
  confirm: (message: string) => Promise<string>;
  output: (message: string) => void;
  error: (message: string) => void;
  save: (updated: string) => void;
}): Promise<number> {
  const plan = planUninstall(input.receipt, input.current);
  if (plan.conflicts.length) {
    input.error(`Uninstall blocked by concurrent edits to: ${plan.conflicts.join(', ')}. No fields changed.`);
    return 1;
  }
  input.output(`Planned actions (${plan.actions.length}):`);
  for (const action of plan.actions) input.output(`  ${action}`);
  if ((await input.confirm('Type uninstall to continue: ')).trim() !== 'uninstall') {
    input.output('Cancelled; no configuration writes made.');
    return 0;
  }
  if (plan.updated === input.current) input.output('No configuration changes needed; no backup or configuration write created.');
  else input.save(plan.updated);
  return 0;
}
