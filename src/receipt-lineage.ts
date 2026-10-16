import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { assertSafeFilesystemPath, configurationField, createReceipt, modifyJsonc, planLegacyUninstall, readReceiptDocument, validateLegacyReceipt, type AnyReceipt, type FieldChange, type InstallationReceipt } from './installation-receipt.ts';
import { nativeRoles, type NativeReconciliationOptions, type NativeRole } from './native-installer.ts';
import { reconcilePermissions, type AttributedRule, type PermissionRule, type ReconciliationResult } from './permission-reconciliation.ts';

export type PermissionEvidence = { path: string[]; order: PermissionRule[]; owned: AttributedRule[]; opaque?: FieldChange };
export type V2Receipt = Omit<InstallationReceipt, 'version' | 'status'> & {
  version: 2; id: string; status: 'pending' | 'complete';
  predecessor: { file: string; identity: string; digest: string } | null;
  permissions: PermissionEvidence[];
};
type Entry = { file: string; text: string; identity: string; digest: string; receipt: AnyReceipt };
export type ReceiptSnapshot = { directory: string; target: string; fingerprint: string; entries: Entry[]; head?: Entry };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const canonicalTarget = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const key = (path: string[]) => path.join('.');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const unwrap = (v: unknown) => (v as {absent?: boolean}).absent ? undefined : (v as {value?: unknown}).value;
const evidence = (v: unknown) => v === undefined ? { absent: true } : { value: v };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validRule = (v: unknown): v is PermissionRule => record(v) && Object.keys(v).length === 3 && typeof v.action === 'string' && typeof v.resource === 'string' && ['allow', 'ask', 'deny'].includes(String(v.effect));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validated = new WeakMap<object, { snapshot: ReceiptSnapshot; serialized: string }>();

export function validateV2Receipt(value: unknown, target: string, allowPending = false): V2Receipt {
  if (!record(value) || Object.keys(value).some(k => !['version', 'id', 'target', 'complete', 'status', 'provenance', 'changes', 'createdContainers', 'predecessor', 'permissions'].includes(k))) throw new Error('Unsupported v2 receipt fields.');
  const { id, predecessor, permissions, ...base } = value;
  validateLegacyReceipt({ ...base, version: 1 }, target, allowPending);
  if (value.version !== 2 || value.provenance !== 'installer' || !['pending', 'complete'].includes(String(value.status)) || typeof id !== 'string' || !uuid.test(id) || !Array.isArray(permissions)) throw new Error('Invalid v2 receipt identity/status.');
  if (predecessor !== null && (!record(predecessor) || Object.keys(predecessor).sort().join() !== 'digest,file,identity' || typeof predecessor.file !== 'string' || basename(predecessor.file) !== predecessor.file || /[/\\]/.test(predecessor.file) || !/^native-(install|adoption)-.+\.json$/.test(predecessor.file) || typeof predecessor.identity !== 'string' || typeof predecessor.digest !== 'string' || !/^[a-f0-9]{64}$/.test(predecessor.digest))) throw new Error('Invalid predecessor reference.');
  const receipt = value as unknown as V2Receipt;
  const paths = new Set<string>();
  for (const p of receipt.permissions) {
    if (!record(p) || Object.keys(p).some(k => !['path', 'order', 'owned', 'opaque'].includes(k)) || !Array.isArray(p.path) || p.path.length !== 3 || p.path[0] !== 'agents' || !nativeRoles.includes(p.path[1] as NativeRole) || p.path[2] !== 'permissions' || paths.has(key(p.path)) || !Array.isArray(p.order) || !p.order.every(validRule) || !Array.isArray(p.owned)) throw new Error('Invalid permission provenance.');
    paths.add(key(p.path));
    for (const owned of p.owned) if (!record(owned) || Object.keys(owned).sort().join() !== 'rule,sources' || !validRule(owned.rule) || !Array.isArray(owned.sources) || owned.sources.some(s => typeof s !== 'string' || !s.trim()) || new Set(owned.sources).size !== owned.sources.length) throw new Error('Invalid permission source evidence.');
    const check = reconcilePermissions({ existing: p.order, prior: p.owned, desired: [] });
    if (check.preview.conflicts.length) throw new Error('Ambiguous permission provenance order.');
    const change = receipt.changes.find(c => key(c.path) === key(p.path));
    if (!change || !equal(unwrap(change.after), p.order)) throw new Error('Permission order differs from latest field evidence.');
    const original = unwrap(change.before);
    if (Array.isArray(original) && p.owned.some(o => original.some(r => equal(r, o.rule)))) throw new Error('Receipt cannot own an original preexisting permission rule.');
    if (p.opaque) {
      validateLegacyReceipt({ version: 1, target, complete: true, provenance: 'installer', changes: [p.opaque], createdContainers: [] }, target);
      if (!equal(p.opaque.path, p.path) || !equal(p.opaque.before, change.before)) throw new Error('Invalid opaque legacy permission baseline.');
    }
  }
  if (receipt.changes.some(c => c.path.at(-1) === 'permissions' && !paths.has(key(c.path)))) throw new Error('Missing v2 permission evidence.');
  return receipt;
}

function inventory(directory: string, target: string, ignore?: string): { entries: Entry[]; fingerprint: string } {
  assertSafeFilesystemPath(directory, 'directory');
  const entries: Entry[] = [], signatures: unknown[] = [];
  if (!existsSync(directory)) return { entries, fingerprint: hash('[]') };
  for (const file of readdirSync(directory).sort()) {
    if (!/^native-(?:install|adoption)-.*\.json$/.test(file) || file === ignore) continue;
    const path = assertSafeFilesystemPath(join(directory, file), 'file');
    const stat = lstatSync(path), text = readFileSync(path, 'utf8');
    // Include even other targets in optimistic evidence; never store their contents in a receipt.
    signatures.push([file, stat.dev, stat.ino, hash(text)]);
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new Error(`Malformed recovery receipt: ${file}`); }
    if (!record(raw) || typeof raw.target !== 'string') throw new Error(`Invalid recovery receipt: ${file}`);
    if (canonicalTarget(raw.target) !== canonicalTarget(target)) continue;
    const receipt = readReceiptDocument(path, target, true);
    entries.push({ file, text, receipt, digest: hash(text), identity: receipt.version === 2 ? receipt.id : `v1:${file}` });
  }
  return { entries, fingerprint: hash(JSON.stringify(signatures)) };
}

export function discoverReceiptChain(directory: string, target: string): ReceiptSnapshot {
  directory = resolve(directory); target = resolve(target);
  const { entries, fingerprint } = inventory(directory, target);
  const byFile = new Map(entries.map(e => [e.file, e]));
  if (new Set(entries.map(e => e.identity)).size !== entries.length) throw new Error('Duplicate receipt identity.');
  const children = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.receipt.complete || ('status' in entry.receipt && entry.receipt.status === 'pending')) throw new Error(`Pending recovery receipt ${entry.file}; resolve before writing or restoring.`);
    if (entry.receipt.version !== 2 || !entry.receipt.predecessor) continue;
    const ref = entry.receipt.predecessor, parent = byFile.get(ref.file);
    if (!parent || parent.identity !== ref.identity || parent.digest !== ref.digest) throw new Error('Missing or altered receipt predecessor.');
    if (children.has(parent.file)) throw new Error('Forked receipt lineage.');
    children.set(parent.file, entry.file);
    for (const old of parent.receipt.changes) {
      const next = entry.receipt.changes.find(c => key(c.path) === key(old.path));
      if (!next || !equal(next.before, old.before)) throw new Error('Successor lost its original managed baseline.');
    }
    for (const container of parent.receipt.createdContainers) if (!entry.receipt.createdContainers.some(p => equal(p, container))) throw new Error('Successor lost created-container evidence.');
    for (const old of parent.receipt.changes.filter(c => c.path.at(-1) === 'permissions')) {
      const next = entry.receipt.permissions.find(p => equal(p.path, old.path))!;
      const opaque = parent.receipt.version === 1 ? old : parent.receipt.permissions.find(p => equal(p.path, old.path))?.opaque;
      if (!equal(next.opaque, opaque)) throw new Error('Successor changed opaque legacy evidence.');
    }
  }
  for (const entry of entries) {
    const seen = new Set<string>(); let cursor: string | undefined = entry.file;
    while (cursor) { if (seen.has(cursor)) throw new Error('Cyclic receipt lineage.'); seen.add(cursor); cursor = children.get(cursor); }
  }
  const heads = entries.filter(e => !children.has(e.file));
  if (heads.length > 1) throw new Error('Multiple unrelated receipt heads; explicit recovery is required.');
  return { directory, target, fingerprint, entries, ...(heads[0] ? { head: heads[0] } : {}) };
}

export function revalidateReceiptSnapshot(snapshot: ReceiptSnapshot, ignore?: string): void {
  if (inventory(snapshot.directory, snapshot.target, ignore).fingerprint !== snapshot.fingerprint) throw new Error('Receipt evidence changed during review; no write permitted.');
}

export function readReceiptForRestore(path: string, target: string, allowPending = false): AnyReceipt {
  const receipt = readReceiptDocument(path, target, allowPending);
  if (allowPending && !receipt.complete) return receipt;
  // Unlinked v1 files retain backward-compatible standalone reading.
  const hasV2 = readdirSync(dirname(resolve(path))).some(file => /^native-install-.*\.json$/.test(file) && file !== basename(path) && (() => {
    const raw = JSON.parse(readFileSync(assertSafeFilesystemPath(join(dirname(resolve(path)), file), 'file'), 'utf8')) as { version?: unknown; target?: unknown };
    return raw.version === 2 && typeof raw.target === 'string' && canonicalTarget(raw.target) === canonicalTarget(target);
  })());
  if (receipt.version === 1 && !hasV2) return receipt;
  const snapshot = discoverReceiptChain(dirname(resolve(path)), target);
  if (snapshot.head?.file !== basename(path)) throw new Error('Superseded receipt cannot be restored independently; select the active head.');
  validated.set(receipt, { snapshot, serialized: JSON.stringify(receipt) });
  return receipt;
}

export function revalidateRestoreReceipt(receipt: AnyReceipt): void {
  const saved = validated.get(receipt);
  if (receipt.version === 2 && !saved) throw new Error('Read the active v2 receipt through validated discovery before restoring.');
  if (saved) {
    if (JSON.stringify(receipt) !== saved.serialized) throw new Error('In-memory receipt evidence changed.');
    revalidateReceiptSnapshot(saved.snapshot);
  }
}

export function receiptReconciliationOptions(snapshot: ReceiptSnapshot): NativeReconciliationOptions {
  const result: NativeReconciliationOptions = { managedFields: {}, permissions: {} };
  const receipt = snapshot.head?.receipt;
  if (!receipt) return result;
  for (const change of receipt.changes) if (change.path.length === 3 && ['description', 'mode', 'system'].includes(change.path[2]!)) {
    const role = change.path[1] as NativeRole, field = change.path[2] as 'description' | 'mode' | 'system';
    const value = unwrap(change.after);
    if (typeof value === 'string') (result.managedFields![role] ??= {})[field] = value;
  }
  if (receipt.version === 2) for (const p of receipt.permissions) result.permissions![p.path[1] as NativeRole] = { prior: p.owned, previousOrder: p.order };
  return result;
}

export function createSuccessorReceipt(snapshot: ReceiptSnapshot, before: string | undefined, after: string, plans: Partial<Record<NativeRole, ReconciliationResult>>): V2Receipt {
  revalidateReceiptSnapshot(snapshot);
  const delta = createReceipt(snapshot.target, before, after), parent = snapshot.head;
  const changes = structuredClone(parent?.receipt.changes ?? []);
  for (const change of delta.changes) {
    const old = changes.find(c => equal(c.path, change.path));
    if (old) old.after = change.after; else changes.push(change);
  }
  const permissions: PermissionEvidence[] = parent?.receipt.version === 2 ? structuredClone(parent.receipt.permissions) : [];
  for (const change of changes.filter(c => c.path.at(-1) === 'permissions')) {
    const role = change.path[1] as NativeRole;
    const plan = plans[role];
    if (!plan && delta.changes.some(c => equal(c.path, change.path))) throw new Error('Permission changes require planner provenance.');
    let state = permissions.find(p => equal(p.path, change.path));
    if (!state) {
      const legacy = parent?.receipt.version === 1 ? parent.receipt.changes.find(c => equal(c.path, change.path)) : undefined;
      state = { path: change.path, order: (unwrap(change.after) ?? []) as PermissionRule[], owned: [], ...(legacy ? { opaque: structuredClone(legacy) } : {}) };
      permissions.push(state);
    }
    if (plan) {
      if (plan.preview.conflicts.length || !equal(configurationField(after, change.path), plan.rules)) throw new Error('Cannot persist conflicting or mismatched permission plan.');
      // Verify ownership against the actual pre-update list, not just a caller's matching rule.
      const current = (configurationField(before ?? '{}', change.path) ?? []) as PermissionRule[];
      for (const p of plan.provenance) if (!state.owned.some(old => equal(old.rule, p.rule)) && current.some(r => equal(r, p.rule))) throw new Error('Cannot claim ownership of a preexisting permission rule.');
      state.owned = structuredClone(plan.provenance); state.order = structuredClone(plan.rules);
      change.after = evidence(plan.rules);
    } else if (!equal(state.order, unwrap(change.after))) throw new Error('Permission changes require planner provenance.');
  }
  const containers = [...(parent?.receipt.createdContainers ?? [])];
  for (const path of delta.createdContainers) if (!containers.some(p => equal(p, path))) containers.push(path);
  const receipt: V2Receipt = { version: 2, id: randomUUID(), target: snapshot.target, complete: true, status: 'complete', provenance: 'installer', predecessor: parent ? { file: parent.file, identity: parent.identity, digest: parent.digest } : null, changes, createdContainers: containers, permissions };
  return validateV2Receipt(receipt, snapshot.target);
}

export type PendingSuccessor = { path: string; receipt: V2Receipt; snapshot: ReceiptSnapshot; text: string; fileIdentity: string };
export function writePendingSuccessor(snapshot: ReceiptSnapshot, receipt: V2Receipt): PendingSuccessor {
  revalidateReceiptSnapshot(snapshot);
  validateV2Receipt(receipt, snapshot.target);
  const expected = snapshot.head ? { file: snapshot.head.file, identity: snapshot.head.identity, digest: snapshot.head.digest } : null;
  if (!equal(receipt.predecessor, expected)) throw new Error('Successor does not extend the reviewed active head.');
  assertSafeFilesystemPath(snapshot.directory, 'directory');
  mkdirSync(snapshot.directory, { recursive: true, mode: 0o700 });
  const path = assertSafeFilesystemPath(join(snapshot.directory, `native-install-${receipt.id}.json`), 'file');
  const text = JSON.stringify({ ...receipt, status: 'pending', complete: false }, null, 2) + '\n';
  writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
  const stat = lstatSync(path);
  return { path, receipt: structuredClone(receipt), snapshot, text, fileIdentity: `${stat.dev}:${stat.ino}` };
}

/** Called immediately before saving config and again before finalizing evidence. */
export function revalidatePendingSuccessor(pending: PendingSuccessor): void {
  assertSafeFilesystemPath(pending.path, 'file');
  const stat = lstatSync(pending.path);
  if (`${stat.dev}:${stat.ino}` !== pending.fileIdentity || pending.text !== JSON.stringify({ ...pending.receipt, status: 'pending', complete: false }, null, 2) + '\n') throw new Error('Pending receipt identity/evidence changed.');
  if (readFileSync(pending.path, 'utf8') !== pending.text) throw new Error('Pending receipt changed; retain it for recovery.');
  revalidateReceiptSnapshot(pending.snapshot, basename(pending.path));
}

export function finalizeSuccessor(pending: PendingSuccessor, expectedConfig: string): void {
  revalidatePendingSuccessor(pending);
  assertSafeFilesystemPath(pending.receipt.target, 'file');
  if (readFileSync(pending.receipt.target, 'utf8') !== expectedConfig) throw new Error('Configuration changed before receipt finalization; pending evidence retained.');
  const temporary = `${pending.path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(pending.receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    revalidatePendingSuccessor(pending);
    if (readFileSync(pending.receipt.target, 'utf8') !== expectedConfig) throw new Error('Configuration changed before receipt finalization.');
    renameSync(temporary, pending.path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function recoverFailedSuccessor(pending: PendingSuccessor, expectedConfig: string | undefined): 'cleared' | 'retained' {
  try {
    revalidatePendingSuccessor(pending);
    assertSafeFilesystemPath(pending.receipt.target, 'file');
    const current = existsSync(pending.receipt.target) ? readFileSync(pending.receipt.target, 'utf8') : undefined;
    if (current !== expectedConfig) return 'retained';
    unlinkSync(pending.path);
    return 'cleared';
  } catch { return 'retained'; }
}

export function planV2Restore(receipt: V2Receipt, text: string): { updated: string; actions: string[]; conflicts: string[] } {
  revalidateRestoreReceipt(receipt);
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  let updated = bom ? text.slice(1) : text;
  const actions: string[] = [], conflicts: string[] = [];
  for (const p of receipt.permissions) {
    const change = receipt.changes.find(c => equal(c.path, p.path))!;
    const current = configurationField(text, p.path);
    if (equal(current, unwrap(change.before))) { actions.push(`${key(p.path)}: already restored`); continue; }
    if (!Array.isArray(current)) { conflicts.push(key(p.path)); continue; }
    const plan = reconcilePermissions({ existing: current as PermissionRule[], prior: p.owned, previousOrder: p.order, desired: [], retiringSources: [...new Set(p.owned.flatMap(o => [...o.sources]))], removeObsolete: p.owned.map(o => o.rule) });
    if (plan.preview.conflicts.length) { conflicts.push(key(p.path)); continue; }
    let restored: unknown = plan.rules;
    if (p.opaque) {
      if (!equal(restored, unwrap(p.opaque.after))) { conflicts.push(`${key(p.path)} (opaque legacy array)`); continue; }
      restored = unwrap(p.opaque.before);
    } else if (!plan.rules.length && unwrap(change.before) === undefined) restored = undefined;
    updated = modifyJsonc(updated, p.path, restored);
    actions.push(`${key(p.path)}: restore attributable rules; preserve user additions`);
  }
  const scalar: InstallationReceipt = { version: 1, target: receipt.target, provenance: 'installer', complete: true, changes: receipt.changes.filter(c => c.path.at(-1) !== 'permissions'), createdContainers: receipt.createdContainers };
  const rest = planLegacyUninstall(scalar, bom + updated);
  conflicts.push(...rest.conflicts); actions.push(...rest.actions);
  return { updated: conflicts.length ? text : rest.updated, actions, conflicts };
}
