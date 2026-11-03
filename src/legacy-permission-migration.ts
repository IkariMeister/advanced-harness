/**
 * Consented legacy permission migration for OpenCode (#160).
 *
 * Legacy (v1) installs keep each role's permission array as opaque whole-field
 * evidence: no rule in it is attributable. Two things then get stuck:
 *  - a harness policy change for a rule that only exists in the legacy array is an
 *    unresolvable identity conflict, and
 *  - any later cleanup of the legacy array makes uninstall see a concurrent edit.
 * Migration, only after the user types `migrate`, adopts the current legacy
 * remainder as the recorded legacy state and drops the legacy-installer rules the
 * current policy replaces. Rules from the pre-install baseline are never dropped.
 */
import { modifyJsonc, type FieldChange } from './installation-receipt.ts';
import { nativeRoles, type NativeDefinition, type NativeRole } from './native-installer.ts';
import type { PermissionRule } from './permission-reconciliation.ts';
import type { ReceiptSnapshot } from './receipt-lineage.ts';

export type LegacyRoleMigration = {
  role: NativeRole;
  /** Legacy-installer rules that the current harness policy replaces. */
  replaced: PermissionRule[];
  /** Rules in the current legacy remainder that the recorded legacy state lacks. */
  adopted: PermissionRule[];
  /** Rules in the recorded legacy state that are no longer in the configuration. */
  dropped: PermissionRule[];
};

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const unwrap = (v: unknown) => (v as { absent?: boolean }).absent ? undefined : (v as { value?: unknown }).value;
const rules = (v: unknown): PermissionRule[] => Array.isArray(v) ? v as PermissionRule[] : [];
/** Multiset difference: each rule in `b` cancels one equal rule in `a`. */
function difference(a: readonly PermissionRule[], b: readonly PermissionRule[]): PermissionRule[] {
  const rest = [...b];
  return a.filter(rule => {
    const at = rest.findIndex(other => equal(other, rule));
    if (at < 0) return true;
    rest.splice(at, 1);
    return false;
  });
}

/** Opaque legacy evidence and owned rules for one role at the active receipt head. */
function legacyEvidence(snapshot: ReceiptSnapshot, role: NativeRole): { opaque: FieldChange; owned: PermissionRule[] } | undefined {
  const receipt = snapshot.head?.receipt;
  const path = ['agents', role, 'permissions'];
  if (!receipt) return undefined;
  if (receipt.version === 1) {
    if (receipt.provenance !== 'installer') return undefined;
    const change = receipt.changes.find(c => equal(c.path, path));
    return change ? { opaque: change, owned: [] } : undefined;
  }
  const entry = receipt.permissions.find(p => equal(p.path, path));
  return entry?.opaque ? { opaque: entry.opaque, owned: entry.owned.map(o => o.rule) } : undefined;
}

export function planLegacyPermissionMigration(
  snapshot: ReceiptSnapshot,
  config: Record<string, unknown>,
  definitions: Record<NativeRole, NativeDefinition>
): LegacyRoleMigration[] {
  const agents = (config.agents ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const result: LegacyRoleMigration[] = [];
  for (const role of nativeRoles) {
    const legacy = legacyEvidence(snapshot, role);
    const current = agents[role]?.permissions;
    if (!legacy || !Array.isArray(current)) continue;
    const remainder = (current as PermissionRule[]).filter(rule => !legacy.owned.some(owned => equal(owned, rule)));
    const recorded = rules(unwrap(legacy.opaque.after));
    const baseline = rules(unwrap(legacy.opaque.before));
    const desired = (definitions[role].permissions ?? []) as PermissionRule[];
    const replaced = remainder.filter((rule, index) =>
      remainder.findIndex(other => equal(other, rule)) === index
      && recorded.some(r => equal(r, rule))
      && !baseline.some(r => equal(r, rule))
      && desired.some(d => d.action === rule.action && d.resource === rule.resource && d.effect !== rule.effect));
    const adopted = difference(remainder, recorded), dropped = difference(recorded, remainder);
    if (replaced.length || adopted.length || dropped.length) result.push({ role, replaced, adopted, dropped });
  }
  return result;
}

/** Configuration text with the replaced legacy rules removed; everything else unchanged. */
export function applyLegacyPermissionMigration(text: string, config: Record<string, unknown>, migrations: readonly LegacyRoleMigration[]): string {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  let updated = bom ? text.slice(1) : text;
  const agents = (config.agents ?? {}) as Record<string, Record<string, unknown>>;
  for (const { role, replaced } of migrations) {
    if (!replaced.length) continue;
    const current = rules(agents[role]?.permissions);
    updated = modifyJsonc(updated, ['agents', role, 'permissions'], current.filter(rule => !replaced.some(r => equal(r, rule))));
  }
  return bom + updated;
}
