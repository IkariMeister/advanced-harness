import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join, parse as pathParse, resolve } from 'node:path';
import { parseConfiguration } from './native-installer.ts';
import { parse, parseTree, type Node, type ParseError } from 'jsonc-parser';

export function assertSafeFilesystemPath(path: string, leaf: 'file' | 'directory' | 'either' = 'either'): string {
  const absolute = resolve(path);
  const root = pathParse(absolute).root;
  const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]!);
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`Symlink path component refused: ${cursor}`);
    const final = index === parts.length - 1;
    if (final && leaf === 'file' && !stat.isFile()) throw new Error(`Expected regular file: ${cursor}`);
    if (final && leaf === 'directory' && !stat.isDirectory()) throw new Error(`Expected directory: ${cursor}`);
    if (!final && !stat.isDirectory()) throw new Error(`Non-directory path ancestor refused: ${cursor}`);
  }
  return absolute;
}

function receiptValue(path: string): unknown {
  let value: unknown;
  try {
    const text = readFileSync(path, 'utf8');
    const errors: ParseError[] = [];
    value = parse(text, errors, { allowTrailingComma: false, disallowComments: true });
    if (errors.length) throw new Error();
    const tree = parseTree(text, [], { allowTrailingComma: false, disallowComments: true });
    const check = (node: Node): void => {
      if (node.type === 'object') {
        const keys = new Set<string>();
        for (const property of node.children ?? []) {
          const key = String(property.children?.[0]?.value);
          if (keys.has(key)) throw new Error('duplicate');
          keys.add(key);
        }
      }
      for (const child of node.children ?? []) check(child);
    };
    if (tree) check(tree);
  } catch { throw new Error('Malformed installation receipt (invalid JSON or duplicate keys).'); }
  return value;
}

export const receiptVersion = 1;
export type FieldChange = { path: string[]; before: unknown; after: unknown };
export type InstallationReceipt = { version: 1; target: string; complete: boolean; status?: 'pending' | 'complete'; provenance: 'installer'; changes: FieldChange[]; createdContainers: string[][] };
export type AdoptionReceipt = { version: 1; target: string; complete: true; provenance: 'user-adopted'; changes: FieldChange[]; createdContainers: [] };
export type AnyReceipt = InstallationReceipt | AdoptionReceipt;

/** Persist only narrowly scoped field history, never a whole configuration snapshot. */
export function writeInstallationReceipt(parent: string, receipt: InstallationReceipt): string {
  if (receipt.version !== receiptVersion || receipt.provenance !== 'installer' || receipt.complete !== true || receipt.status === 'pending') throw new Error('Refusing to write an incomplete or unsupported installation receipt.');
  assertSafeFilesystemPath(receipt.target, 'file');
  const directory = assertSafeFilesystemPath(parent, 'directory');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeFilesystemPath(directory, 'directory');
  const target = join(directory, `native-install-${randomUUID()}.json`);
  writeFileSync(target, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return target;
}

export function writePendingReceipt(parent: string, receipt: InstallationReceipt): string {
  assertSafeFilesystemPath(receipt.target, 'file');
  const pending = { ...receipt, complete: false, status: 'pending' as const };
  const directory = assertSafeFilesystemPath(parent, 'directory');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeFilesystemPath(directory, 'directory');
  const target = join(directory, `native-install-${randomUUID()}.json`);
  writeFileSync(target, JSON.stringify(pending, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return target;
}

export function completePendingReceipt(path: string, receipt: InstallationReceipt): void {
  if (!receipt.complete || !receipt.changes.length) { if (existsSync(path)) unlinkSync(path); return; }
  assertSafeFilesystemPath(path, 'file');
  const pending = receiptValue(path) as InstallationReceipt;
  if (pending.status !== 'pending' || pending.target !== receipt.target) throw new Error('Pending receipt changed unexpectedly; preserve it for recovery.');
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...receipt, status: 'complete' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  assertSafeFilesystemPath(path, 'file');
  try { renameSync(temporary, path); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function removePendingReceipt(path: string): void { if (existsSync(path)) { assertSafeFilesystemPath(path, 'file'); unlinkSync(path); } }
export function recoverFailedInstallation(path: string, expected: string | undefined, target: string): 'cleared' | 'retained' {
  assertSafeFilesystemPath(target, 'file');
  const observed = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  if (observed === expected) { removePendingReceipt(path); return 'cleared'; }
  return 'retained';
}

export function assertNoReceiptOverlap(directory: string, target: string, proposed: InstallationReceipt, currentText: string): void {
  assertSafeFilesystemPath(directory, 'directory');
  assertSafeFilesystemPath(target, 'file');
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^native-(?:install|adoption)-.*\.json$/.test(entry.name)) continue;
    const path = join(directory, entry.name);
    const raw = receiptValue(assertSafeFilesystemPath(path, 'file')) as {target?: unknown} | null;
    if (!raw || typeof raw.target !== 'string') throw new Error(`Invalid recovery receipt ${entry.name}; resolve it before continuing.`);
    if (resolve(raw.target) !== resolve(target)) continue;
    const other = readInstallationReceipt(path, target, true);
    const pending = (other as InstallationReceipt).status === 'pending';
    const stillApplied = other.changes.some(change => JSON.stringify(configurationField(currentText, change.path)) === JSON.stringify(evidenceValue(change.after)));
    if (!pending && !stillApplied) continue;
    const overlap = proposed.changes.map(change => JSON.stringify(change.path)).filter(key => other.changes.some(change => JSON.stringify(change.path) === key));
    if (overlap.length) throw new Error(`Outstanding receipt ${entry.name} overlaps fields ${overlap.map(key => JSON.parse(key).join('.')).join(', ')}; resolve it before installation.`);
  }
}

function evidenceValue(evidence: unknown): unknown { return evidence && typeof evidence === 'object' && Object.hasOwn(evidence, 'absent') ? undefined : (evidence as {value?: unknown})?.value; }

export function writeAdoptionReceipt(parent: string, receipt: AdoptionReceipt): string {
  if (receipt.version !== receiptVersion || receipt.complete !== true || receipt.provenance !== 'user-adopted' || receipt.createdContainers.length) throw new Error('Refusing to write an invalid adoption receipt.');
  const directory = assertSafeFilesystemPath(parent, 'directory');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeFilesystemPath(directory, 'directory');
  const target = join(directory, `native-adoption-${randomUUID()}.json`);
  writeFileSync(target, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return target;
}

export function persistAdoptionReceipt(parent: string, receipt: AdoptionReceipt, expectedConfig: string, beforePath: string | undefined, beforeText: string | undefined, approved: boolean): string | undefined {
  if (!approved || !receipt.changes.length) return undefined;
  assertSafeFilesystemPath(receipt.target, 'file');
  if (readFileSync(receipt.target, 'utf8') !== expectedConfig) throw new Error('Configuration changed during adoption review; no receipt written.');
  if (beforePath) {
    assertSafeFilesystemPath(beforePath, 'file');
    if (beforeText === undefined || readFileSync(beforePath, 'utf8') !== beforeText) throw new Error('Before-config evidence changed during adoption review; no receipt written.');
  }
  assertNoReceiptOverlap(parent, receipt.target, { version: 1, target: receipt.target, complete: true, provenance: 'installer', changes: receipt.changes, createdContainers: [] }, expectedConfig);
  return writeAdoptionReceipt(parent, receipt);
}

export function readInstallationReceipt(path: string, target: string, allowPending = false): AnyReceipt {
  const receiptPath = assertSafeFilesystemPath(path, 'file');
  assertSafeFilesystemPath(target, 'file');
  const value = receiptValue(receiptPath);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed installation receipt.');
  const receipt = value as AnyReceipt;
  const status = (value as Record<string, unknown>).status;
  const topKeys = ['version','target','complete','status','provenance','changes','createdContainers'];
  if (Object.keys(value).some(key => !topKeys.includes(key)) || typeof receipt.target !== 'string' || !receipt.target || receipt.version !== receiptVersion || (receipt.complete !== true && !(allowPending && status === 'pending' && receipt.complete === false)) || (status !== undefined && !['pending','complete'].includes(String(status))) || !['installer', 'user-adopted'].includes(receipt.provenance) || resolve(receipt.target) !== resolve(target) || !Array.isArray(receipt.changes) || !Array.isArray(receipt.createdContainers)) throw new Error('Receipt is incomplete, unsupported, or targets a different configuration.');
  if (receipt.provenance === 'user-adopted' && (receipt.complete !== true || status !== undefined) || receipt.provenance === 'installer' && status === 'pending' && receipt.complete !== false || receipt.provenance === 'installer' && status === 'complete' && receipt.complete !== true) throw new Error('Receipt status and provenance are inconsistent.');
  const validPaths = new Set(['model', 'default_agent']);
  for (const role of ['lead', 'operator', 'external', 'researcher', 'planner', 'implementer', 'reviewer', 'qa']) for (const field of ['description', 'mode', 'model', 'permissions', 'system']) validPaths.add(`agents.${role}.${field}`);
  const seen = new Set<string>();
  for (const change of receipt.changes) {
   const key = Array.isArray(change?.path) ? change.path.join('.') : '';
   const exact = Array.isArray(change?.path) && (change.path.length === 1 && ['model', 'default_agent'].includes(change.path[0]!) || change.path.length === 3 && change.path[0] === 'agents' && ['lead','operator','external','researcher','planner','implementer','reviewer','qa'].includes(change.path[1]!) && ['description','mode','model','permissions','system'].includes(change.path[2]!));
    if (!change || typeof change !== 'object' || Array.isArray(change) || Object.keys(change).some(name => !['path','before','after'].includes(name)) || !Array.isArray(change.path) || change.path.some(segment => typeof segment !== 'string') || !exact || seen.has(key) || !Object.hasOwn(change, 'before') || !Object.hasOwn(change, 'after') || !validEvidence(change.before) || !validEvidence(change.after) || !evidenceTypeValid(change.path, change.before) || !evidenceTypeValid(change.path, change.after)) throw new Error('Receipt contains unsupported field evidence.');
    seen.add(key);
  }
  if (receipt.provenance === 'user-adopted' && receipt.createdContainers.length) throw new Error('Adoption receipts cannot claim installer-created containers.');
  const containerKeys = new Set<string>();
  for (const path of receipt.createdContainers) {
    const key = JSON.stringify(path);
    if (!Array.isArray(path) || path.some(segment => typeof segment !== 'string') || ![['agents'], ...['lead','operator','external','researcher','planner','implementer','reviewer','qa'].map(role => ['agents', role])].some(valid => JSON.stringify(valid) === key) || containerKeys.has(key) || receipt.provenance !== 'installer') throw new Error('Receipt contains invalid created-container evidence.');
    containerKeys.add(key);
  }
  if (receipt.createdContainers.some(path => path.length === 2 && !receipt.changes.some(change => change.path.length === 3 && change.path[0] === 'agents' && change.path[1] === path[1]))) throw new Error('Created role container has no attributable field changes.');
  if (receipt.createdContainers.some(path => path.length === 1 && path[0] === 'agents' && !receipt.createdContainers.some(child => child.length === 2 && child[0] === 'agents'))) throw new Error('Created agents container has no attributable created role entries.');
  if (status !== 'pending' && !receipt.changes.length) throw new Error('Completed receipt must contain field changes.');
  return receipt;
}

function validEvidence(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && ((Object.keys(value).length === 1 && Object.hasOwn(value, 'absent') && (value as {absent: unknown}).absent === true) || (Object.keys(value).length === 1 && Object.hasOwn(value, 'value')));
}

function evidenceTypeValid(path: string[], evidence: unknown): boolean {
  if (evidence && typeof evidence === 'object' && Object.hasOwn(evidence, 'absent')) return true;
  const value = (evidence as {value?: unknown}).value;
  const field = path.at(-1);
  return field === 'permissions' ? Array.isArray(value) : typeof value === 'string';
}

function modifyJsonc(text: string, path: string[], value: unknown): string {
  const { applyEdits, modify } = awaitJsonc();
  const edits = modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' } });
  if (value !== undefined || !path.length) return applyEdits(text, edits);
  const tree = parseTree(text);
  let parent: Node | undefined = tree;
  for (const segment of path.slice(0, -1)) {
    parent = parent?.type === 'object' ? parent.children?.find(prop => prop.children?.[0]?.value === segment)?.children?.[1] : undefined;
  }
  const property = parent?.type === 'object' ? parent.children?.find(prop => prop.children?.[0]?.value === path.at(-1)) : undefined;
  if (parent?.type === 'object' && parent.children?.length === 1 && property) {
    const start = property.offset, end = start + property.length;
    const comma = findContainerComma(text, end, parent.offset + parent.length - 1);
    if (comma >= 0) return text.slice(0, start) + text.slice(comma + 1);
    const preceding = findPreviousComma(text, parent.offset + 1, start);
    if (preceding >= 0) return text.slice(0, preceding) + text.slice(start + property.length);
  }
  const valueNode = property?.children?.[1];
  if (parent?.type !== 'object' || parent.children?.length !== 1 || !valueNode) return applyEdits(text, edits);
  // Locate punctuation within the selected value's parent using parser tokens;
  // textual search is unsafe because comments and string payloads can contain it.
  const comma = findContainerComma(text, valueNode.offset + valueNode.length, parent.offset + parent.length - 1);
  const close = parent.offset + parent.length - 1;
  if (comma < 0 || comma >= close) return applyEdits(text, edits);
  // jsonc-parser may include trailing punctuation in the removal edit. When it
  // does, remove only that comma by offset from the edited result; never rewrite
  // document text with a global regexp.
  if (edits.some(edit => edit.offset <= comma && edit.offset + edit.length > comma)) {
    const updated = applyEdits(text, edits);
    const shiftedComma = comma + edits.filter(edit => edit.offset + edit.length <= comma).reduce((delta, edit) => delta + edit.content.length - edit.length, 0);
    return updated.slice(0, shiftedComma) + updated.slice(shiftedComma + 1);
  }
  return applyEdits(text, [...edits, { offset: comma, length: 1, content: '' }]);
}

function findPreviousComma(text: string, from: number, before: number): number {
  let result = -1, inString = false, escaped = false, lineComment = false, blockComment = false;
  for (let i = from; i < before; i++) {
    const char = text[i]!, next = text[i + 1];
    if (lineComment) { if (char === '\n' || char === '\r') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (inString) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') inString = false; continue; }
    if (char === '"') inString = true;
    else if (char === '/' && next === '/') { lineComment = true; i++; }
    else if (char === '/' && next === '*') { blockComment = true; i++; }
    else if (char === ',') result = i;
  }
  return result;
}

function findContainerComma(text: string, from: number, close: number): number {
  let inString = false, escaped = false, lineComment = false, blockComment = false;
  for (let i = from; i < close; i++) {
    const char = text[i]!, next = text[i + 1];
    if (lineComment) { if (char === '\n' || char === '\r') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (inString) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') inString = false; continue; }
    if (char === '"') { inString = true; continue; }
    if (char === '/' && next === '/') { lineComment = true; i++; continue; }
    if (char === '/' && next === '*') { blockComment = true; i++; continue; }
    if (char === ',') return i;
  }
  return -1;
}

export function adoptExisting(target: string, currentText: string, beforeText: string | undefined, selected: string[], removed: string[], acknowledgedUnknown: string[]): AdoptionReceipt {
  parseConfiguration(currentText, target);
  if (beforeText !== undefined) parseConfiguration(beforeText, 'before configuration');
  const keys = ['agents.lead.description','agents.lead.mode','agents.lead.model','agents.lead.permissions','agents.lead.system', ...['operator','external','researcher','planner','implementer','reviewer','qa'].flatMap(role => ['description','mode','model','permissions','system'].map(field => `agents.${role}.${field}`)), 'default_agent','model'];
  const chosen = new Set([...selected, ...removed]);
  if ([...chosen].some(key => !keys.includes(key)) || selected.some(key => removed.includes(key))) throw new Error('Invalid adoption field selection.');
  const changes: FieldChange[] = [];
  for (const key of keys) {
    if (!chosen.has(key)) continue;
    const path = key.split('.');
    const now = configurationField(currentText, path);
    let prior = beforeText === undefined ? undefined : configurationField(beforeText, path);
    if (selected.includes(key) && beforeText === undefined) throw new Error(`Cannot restore ${key} without supplied before-config evidence.`);
    if (removed.includes(key)) {
      if (!acknowledgedUnknown.includes(key)) throw new Error(`Unknown historical state requires explicit acknowledgment: ${key}`);
      prior = undefined;
    }
    if (JSON.stringify(now) !== JSON.stringify(prior)) changes.push({ path, before: prior === undefined ? { absent: true } : { value: prior }, after: now === undefined ? { absent: true } : { value: now } });
  }
  return { version: 1, target: resolve(target), complete: true, provenance: 'user-adopted', changes, createdContainers: [] };
}

export function configurationField(text: string, path: string[]): unknown {
  let value: unknown = parseConfiguration(text, 'selected configuration');
  for (const key of path) value = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
  return value;
}

export function receiptName(path: string): string { return basename(path); }

export function createReceipt(target: string, beforeText: string | undefined, afterText: string): InstallationReceipt {
  const before = beforeText === undefined ? {} : parseConfiguration(beforeText, target);
  const after = parseConfiguration(afterText, target);
  const changes: FieldChange[] = [];
  const add = (path: string[]) => {
    const a = configurationField(beforeText ?? '{}', path), b = configurationField(afterText, path);
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ path, before: a === undefined ? { absent: true } : { value: a }, after: b === undefined ? { absent: true } : { value: b } });
  };
  for (const role of ['lead', 'operator', 'external', 'researcher', 'planner', 'implementer', 'reviewer', 'qa']) for (const field of ['description', 'mode', 'model', 'permissions', 'system']) add(['agents', role, field]);
  add(['default_agent']); add(['model']);
  const containers: string[][] = [];
  if (!before.agents && after.agents) containers.push(['agents']);
  if (after.agents && typeof after.agents === 'object') for (const role of ['lead','operator','external','researcher','planner','implementer','reviewer','qa']) if (!(before.agents && typeof before.agents === 'object' && Object.hasOwn(before.agents, role)) && Object.hasOwn(after.agents, role)) containers.push(['agents', role]);
  return { version: 1, target: resolve(target), complete: changes.length > 0, provenance: 'installer', changes, createdContainers: containers };
}

export function planUninstall(receipt: AnyReceipt, text: string): { updated: string; actions: string[]; conflicts: string[] } {
  const current = parseConfiguration(text, receipt.target);
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  let body = bom ? text.slice(1) : text;
  const conflicts: string[] = [], actions: string[] = [];
  for (const change of receipt.changes) {
    const now = configurationField(text, change.path);
    const baseline = Object.hasOwn(change.after as object, 'absent') ? undefined : (change.after as { value: unknown }).value;
    const prior = Object.hasOwn(change.before as object, 'absent') ? undefined : (change.before as { value: unknown }).value;
    if (JSON.stringify(now) === JSON.stringify(baseline)) {
      body = modifyJsonc(body, change.path, prior);
      actions.push(change.path.join('.') + (prior === undefined ? ': remove' : ': restore prior value'));
    } else if (JSON.stringify(now) === JSON.stringify(prior)) actions.push(change.path.join('.') + ': already restored');
    else conflicts.push(change.path.join('.'));
  }
  for (const path of [...receipt.createdContainers].sort((a, b) => b.length - a.length)) {
    let value: unknown;
    value = parseConfiguration(bom + body, receipt.target);
    for (const segment of path) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined;
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0) continue;
    if (path.length === 1 && path[0] === 'agents' && Object.keys(value as object).length === 0) {
      // Root-container removal is safe only when the post-field-restore object is empty.
    }
    body = modifyJsonc(body, path, undefined);
    actions.push(path.join('.') + ': remove empty installer-created container');
  }
  const proposed = parseConfiguration(bom + body, receipt.target);
  if (proposed.default_agent !== undefined && !(proposed.agents && typeof proposed.agents === 'object' && Object.hasOwn(proposed.agents, String(proposed.default_agent)))) conflicts.push('default_agent (would reference a missing agent)');
  if (conflicts.length) return { updated: text, actions, conflicts };
  return { updated: bom + body, actions, conflicts };
}

function awaitJsonc(): typeof import('jsonc-parser') {
  // Static module import is kept in the caller module graph; this helper only types it.
  return requireJsonc;
}
import * as requireJsonc from 'jsonc-parser';
