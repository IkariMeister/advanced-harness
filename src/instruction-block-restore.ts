/**
 * Uninstall of shared instruction files (CLAUDE.md, AGENTS.md): remove only what the harness
 * owns there and keep everything else, including edits a later update recorded as installed
 * content. Pure planning; the receipt restore applies the result with its usual preflight,
 * backup, and changed-after-review checks.
 */

// Other marked sections (project, integrations, paths) belong to harness:setup and
// harness:integrations, which an install does not own, so they are kept like user content.
const ownedSections = ['lead', 'model-preferences'] as const;
const reference = /^[ \t]*@AGENTS\.md[ \t]*(?=\r?$)/m;

const marker = (section: string, edge: 'start' | 'end') => `<!-- advanced-harness:${section}:${edge} -->`;
const count = (text: string, needle: string) => text.split(needle).length - 1;
const normalizeEol = (text: string) => text.replaceAll('\r\n', '\n');

/** The one well-formed block in the text; undefined when markers are absent, duplicated, unbalanced, or out of order. */
function blockRange(text: string, section: string): [number, number] | undefined {
  const start = marker(section, 'start'), end = marker(section, 'end');
  if (count(text, start) !== 1 || count(text, end) !== 1) return undefined;
  const from = text.indexOf(start), to = text.indexOf(end);
  return from < to ? [from, to + end.length] : undefined;
}

/** Cuts a range with its line ending and the blank line that separated it from the content above. */
function cut(text: string, from: number, to: number): string {
  const end = text.startsWith('\r\n', to) ? to + 2 : text.startsWith('\n', to) ? to + 1 : to;
  const head = text.slice(0, from), tail = text.slice(end);
  if (!head.trim()) return tail.replace(/^(?:\r?\n)+/, '');
  return (head.endsWith('\r\n\r\n') ? head.slice(0, -2) : head.endsWith('\n\n') ? head.slice(0, -1) : head) + tail;
}

type EvidenceState = { absent?: true; content?: string; contentBase64?: string; digest?: string };

function textOf(state: EvidenceState): string | undefined {
  if (state.content !== undefined) return state.content;
  return state.contentBase64 !== undefined ? Buffer.from(state.contentBase64, 'base64').toString('utf8') : undefined;
}

export type InstructionBlockRestore =
  | { conflict: true }
  /** `next` undefined removes the file. `keepsEdits` is false when the result is the recorded prior state. */
  | { conflict?: false; next: Buffer | undefined; keepsEdits: boolean };

/**
 * Returns undefined when block-level restore does not apply, leaving the whole-file rules in
 * charge: not an instruction file, no owned block recorded, no readable evidence, or a prior
 * state that already held such a block, which removing the block would not restore.
 */
export function planInstructionBlockRestore(
  file: { kind: string; before: EvidenceState; after: EvidenceState },
  current: Buffer,
): InstructionBlockRestore | undefined {
  if (file.kind !== 'instructions') return undefined;
  const installed = textOf(file.after);
  const prior = file.before.absent ? undefined : textOf(file.before);
  if (installed === undefined || (!file.before.absent && prior === undefined)) return undefined;
  const sections = ownedSections.filter(section => installed.includes(marker(section, 'start')));
  if (!sections.length) return undefined;
  if (prior !== undefined && ownedSections.some(section => prior.includes(marker(section, 'start')) || prior.includes(marker(section, 'end')))) return undefined;
  const text = current.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(current)) return { conflict: true };

  let remaining = text;
  for (const section of sections) {
    const recorded = blockRange(installed, section);
    if (!recorded) return undefined;
    const found = blockRange(remaining, section);
    if (!found || normalizeEol(remaining.slice(...found)) !== normalizeEol(installed.slice(...recorded))) return { conflict: true };
    remaining = cut(remaining, ...found);
  }
  // The installer adds this line outside the Lead block; a line the user already had stays.
  if (sections.includes('lead') && reference.test(installed) && !(prior !== undefined && reference.test(prior))) {
    const line = reference.exec(remaining);
    if (line) remaining = cut(remaining, line.index, line.index + line[0].length);
  }

  if (prior === undefined) {
    if (!remaining.trim()) return { next: undefined, keepsEdits: false };
  } else if (remaining.trimEnd() === prior.trimEnd()) {
    return { next: Buffer.from(prior, 'utf8'), keepsEdits: false };
  }
  return { next: Buffer.from(remaining, 'utf8'), keepsEdits: true };
}
