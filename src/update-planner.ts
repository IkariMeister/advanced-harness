import { nativeRoles, type NativeDefinition, type NativeRole } from './native-installer.ts';
import { reconcilePermissions, type ReconciliationResult } from './permission-reconciliation.ts';
import type { ReceiptSnapshot } from './receipt-lineage.ts';

export type RolePromptDiff = {
  role: NativeRole;
  status: 'unchanged' | 'prompt-changed' | 'description-changed' | 'both-changed' | 'not-installed';
  installedDescription?: string | undefined;
  sourceDescription: string;
  installedPrompt?: string | undefined;
  sourcePrompt: string;
  diffLines?: string[] | undefined;
  preservedFields: {
    model?: string | undefined;
    customFields: string[];
  };
};

export type UpdatePlan = {
  roles: Record<NativeRole, RolePromptDiff>;
  plans: Partial<Record<NativeRole, ReconciliationResult>>;
  migrationNotes: string[];
  hasChanges: boolean;
};

export function computeUnifiedDiff(oldText: string, newText: string): string[] {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const lines: string[] = [];

  // Simple and readable line diff comparison
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      lines.push(`  ${oldLines[i]}`);
      i++;
      j++;
    } else if (i < oldLines.length && !newLines.slice(j).includes(oldLines[i]!)) {
      lines.push(`- ${oldLines[i]}`);
      i++;
    } else if (j < newLines.length) {
      lines.push(`+ ${newLines[j]}`);
      j++;
    } else {
      lines.push(`- ${oldLines[i]}`);
      i++;
    }
  }
  return lines;
}

export function planUpdate(
  currentConfig: Record<string, unknown>,
  definitions: Record<NativeRole, NativeDefinition>,
  snapshot: ReceiptSnapshot
): UpdatePlan {
  const agents = (currentConfig.agents ?? {}) as Record<string, Record<string, unknown>>;
  const roles = {} as Record<NativeRole, RolePromptDiff>;
  const plans: Partial<Record<NativeRole, ReconciliationResult>> = {};
  const migrationNotes: string[] = [];

  const receipt = snapshot.head?.receipt;
  if (!receipt) {
    migrationNotes.push('No installation receipt found. Update will record a new v2 receipt lineage head.');
  } else if (receipt.version === 1) {
    migrationNotes.push('Installed receipt is legacy v1. Update will upgrade lineage to a cumulative v2 receipt.');
  } else if (!receipt.harnessVersion) {
    migrationNotes.push('Installed v2 receipt has no harness version stamp. Update will record the current harness version and commit.');
  }

  let hasChanges = false;

  for (const role of nativeRoles) {
    const installed = agents[role];
    const source = definitions[role];

    if (!installed) {
      roles[role] = {
        role,
        status: 'not-installed',
        sourceDescription: source.description,
        sourcePrompt: source.system,
        preservedFields: { customFields: [] }
      };
      hasChanges = true;
      continue;
    }

    const installedPrompt = typeof installed.system === 'string' ? installed.system.trim() : '';
    const sourcePrompt = source.system.trim();
    const promptChanged = installedPrompt !== sourcePrompt;

    const installedDesc = typeof installed.description === 'string' ? installed.description.trim() : '';
    const sourceDesc = source.description.trim();
    const descChanged = installedDesc !== sourceDesc;

    let status: RolePromptDiff['status'] = 'unchanged';
    if (promptChanged && descChanged) status = 'both-changed';
    else if (promptChanged) status = 'prompt-changed';
    else if (descChanged) status = 'description-changed';

    if (status !== 'unchanged') hasChanges = true;

    // Check preserved fields
    const knownKeys = new Set(['description', 'mode', 'model', 'permissions', 'system']);
    const customFields = Object.keys(installed).filter(k => !knownKeys.has(k));
    const model = typeof installed.model === 'string' ? installed.model : undefined;

    let diffLines: string[] | undefined;
    if (promptChanged) {
      diffLines = computeUnifiedDiff(installedPrompt, sourcePrompt);
    }

    roles[role] = {
      role,
      status,
      installedDescription: installedDesc,
      sourceDescription: sourceDesc,
      installedPrompt,
      sourcePrompt,
      diffLines,
      preservedFields: {
        model,
        customFields
      }
    };

    // Reconcile permissions
    const existingRules = Array.isArray(installed.permissions) ? (installed.permissions as any[]) : [];
    let priorOwned: any[] = [];
    let previousOrder: any[] | undefined = undefined;

    if (receipt && receipt.version === 2) {
      const p = receipt.permissions.find(entry => entry.path[1] === role);
      if (p) {
        priorOwned = p.owned;
        previousOrder = p.order;
      }
    }

    const desiredRules = ((source.permissions ?? []) as any[]).map(rule => ({
      rule,
      sources: [`native:${role}`]
    }));
    const reconciliation = reconcilePermissions({
      existing: existingRules,
      prior: priorOwned,
      desired: desiredRules,
      retiringSources: [`native:${role}`],
      ...(previousOrder ? { previousOrder } : {})
    });

    plans[role] = reconciliation;
    if (
      reconciliation.preview.additions.length ||
      reconciliation.preview.removals.length ||
      reconciliation.preview.retainedObsolete.length
    ) {
      hasChanges = true;
    }
  }

  return {
    roles,
    plans,
    migrationNotes,
    hasChanges
  };
}
