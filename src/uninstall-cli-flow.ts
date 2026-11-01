import { lstatSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, join, sep } from 'node:path';
import type { AnyReceipt } from './installation-receipt.ts';
import { planUninstall } from './installation-receipt.ts';
import { applyManagedFilePlan, planV2Restore, prepareManagedFilePlan } from './receipt-lineage.ts';
import type { HostId } from './host-registry.ts';
import { finishGitExclude, previewGitExclude, type GitExcludeOwner } from './git-exclude.ts';

export async function runUninstallFlow(input: {
  receipt: AnyReceipt;
  current: string;
  confirm: (message: string) => Promise<string>;
  output: (message: string) => void;
  error: (message: string) => void;
  save: (updated: string) => void;
  backupParent?: string;
  host?: HostId;
  /** Directory that bounds empty-directory pruning (project root, or the Antigravity global config directory). */
  pruneRoot?: string | undefined;
  /** Project root whose local Git exclude block this host releases; omitted for global targets. */
  excludeRoot?: string | undefined;
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
  const excludeOwner = (['opencode', 'claude-code', 'antigravity'] as const).find(owner => owner === (input.host ?? 'opencode')) as GitExcludeOwner | undefined;
  const exclude = excludeOwner ? previewGitExclude(input.excludeRoot, excludeOwner, input.output, { remove: true }) : undefined;
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
      if (input.pruneRoot) for (const dir of pruneInstalledDirectories(input.receipt, input.pruneRoot)) input.output(`Removed empty installer directory: ${dir}`);
    } catch (err) {
      input.error(`Uninstall partially completed${saved ? '; configuration was restored' : ''}. ${String(err)}. Review completed work and backups before retrying.`);
      return 1;
    }
  }
  finishGitExclude(exclude, input.output, input.error);
  return 0;
}

// Prunes only directories the install created. Candidates are ancestors of managed files whose recorded
// prior state is absent, strictly inside pruneRoot, and removed only when empty after restore. The
// top-level .claude and .agents containers are never pruned: the receipt cannot prove they were absent
// before install, so they are left in place even when empty. Non-empty directories are never touched.
export function pruneInstalledDirectories(receipt: AnyReceipt, pruneRoot: string): string[] {
  if (receipt.version !== 2 || !receipt.managedFiles?.length) return [];
  const root = resolve(pruneRoot);
  const containers = [join(root, '.claude'), join(root, '.agents')];
  const candidates = new Set<string>();
  for (const file of receipt.managedFiles) {
    if (!('absent' in file.before)) continue;
    for (let dir = resolve(dirname(file.path)); ; dir = dirname(dir)) {
      const rel = relative(root, dir);
      if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) break;
      candidates.add(dir);
    }
  }
  const removed: string[] = [];
  for (const dir of [...candidates].sort((a, b) => b.length - a.length)) {
    if (containers.some(container => relative(container, dir) === '')) continue;
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink() || readdirSync(dir).length) continue;
    rmdirSync(dir);
    removed.push(dir);
  }
  return removed;
}
