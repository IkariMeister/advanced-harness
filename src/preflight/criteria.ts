import { readFileSync, statSync } from 'node:fs';
import { duplicateKey } from './policy.ts';
import type { AcceptanceCriteriaInput, CriteriaItem, PreflightCheck } from './types.ts';

/** Fixed check: reports the acceptance criteria a human supplied with `--criteria`. It never sets approval. */
export const ACCEPTANCE_CRITERIA_CHECK_ID = 'acceptance-criteria';
export const MAX_CRITERIA_BYTES = 1024 * 1024;
const MAX_LISTED_ITEMS = 50;
const MAX_TEXT_CODE_POINTS = 240;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Escapes control characters (C0, DEL, C1, and the line and paragraph separators U+2028 and U+2029) and bounds the text
 * to 240 code points. Shared by criteria evidence, the human bypass line, and changed-path evidence.
 */
export function displayText(text: string): string {
  const points = [...text];
  const clipped = points.slice(0, MAX_TEXT_CODE_POINTS).map(character => /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{2028}\u{2029}]/u.test(character) ? `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}` : character).join('');
  return points.length > MAX_TEXT_CODE_POINTS ? `${clipped}…` : clipped;
}

/**
 * Parses the criteria shape `{"items":[{"text":string,"done":boolean}]}`. The top level and each item accept only
 * their named keys, the item list must be nonempty, and a repeated key is refused. Refusal reasons never echo file content.
 */
export function parseAcceptanceCriteria(text: string): AcceptanceCriteriaInput {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { return { error: 'the file is not valid JSON.' }; }
  if (duplicateKey(text) !== undefined) return { error: 'the file repeats a key; keep one value per key.' };
  if (!isObject(value) || Object.keys(value).some(key => key !== 'items')) return { error: 'the top level must be an object whose only key is "items".' };
  const list = value.items;
  if (!Array.isArray(list) || list.length === 0) return { error: '"items" must be a nonempty array.' };
  const items: CriteriaItem[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const item: unknown = list[index];
    const shapeError = `item ${index + 1} must be an object with only "text" (a nonblank string) and "done" (true or false).`;
    if (!isObject(item) || Object.keys(item).some(key => key !== 'text' && key !== 'done')) return { error: shapeError };
    const itemText = item.text;
    const itemDone = item.done;
    if (typeof itemText !== 'string' || !itemText.trim() || typeof itemDone !== 'boolean') return { error: shapeError };
    items.push({ text: itemText, done: itemDone });
  }
  return { items };
}

/** Reads a criteria file of at most 1 MiB. Every failure becomes an error value, which the check reports as inconclusive. */
export function readAcceptanceCriteria(path: string): AcceptanceCriteriaInput {
  let bytes: Buffer;
  try {
    if (statSync(path).size > MAX_CRITERIA_BYTES) return { error: 'the file is larger than 1 MiB.' };
    bytes = readFileSync(path);
  } catch (error) {
    return { error: `the file could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).` };
  }
  if (bytes.length > MAX_CRITERIA_BYTES) return { error: 'the file is larger than 1 MiB.' };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { error: 'the file is not valid UTF-8.' }; }
  return parseAcceptanceCriteria(text);
}

/**
 * Reports done and pending criteria. Pending items warn, and a fully checked list passes. Without a criteria file the
 * check passes with a note, and a file that cannot be used is inconclusive. Checked-off text is never treated as approval.
 */
export const acceptanceCriteriaCheck: PreflightCheck = { id: ACCEPTANCE_CRITERIA_CHECK_ID, run({ criteria }) {
  if (criteria === undefined) return { status: 'pass', evidence: ['no task context supplied'] };
  if ('error' in criteria) return { status: 'inconclusive', evidence: [`Acceptance criteria file could not be used: ${criteria.error}`] };
  const pending = criteria.items.filter(item => !item.done);
  const done = criteria.items.length - pending.length;
  const evidence = [`Acceptance criteria: ${done} done, ${pending.length} pending.`];
  if (pending.length) {
    const shown = pending.slice(0, MAX_LISTED_ITEMS).map(item => `"${displayText(item.text)}"`);
    evidence.push(`Pending: ${shown.join(', ')}${pending.length > MAX_LISTED_ITEMS ? `, … ${pending.length - MAX_LISTED_ITEMS} additional pending item(s)` : ''}.`);
  }
  return {
    status: pending.length ? 'warn' : 'pass',
    evidence,
    metrics: { items: criteria.items.length, done, pending: pending.length },
  };
} };
