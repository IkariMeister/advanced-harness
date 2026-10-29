import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { SetupFile } from './project-setup.ts';
import { parseConfiguration } from './native-installer.ts';

export type ContextSection = 'project' | 'integrations' | 'model-preferences' | 'paths';
const marker = (section: ContextSection, edge: string) => `<!-- advanced-harness:${section}:${edge} -->`;

export function readContext(path: string): string | undefined {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024 * 1024) throw new Error('Context must be a regular text file no larger than 1 MiB.');
  return readFileSync(path, 'utf8');
}

export function contextPath(root: string, selected = 'AGENTS.md'): string {
  const path = resolve(root, selected);
  const child = relative(resolve(root), path);
  if (!child || child === '..' || child.startsWith('../') || child.startsWith('..\\') || isAbsolute(child) || !path.toLowerCase().endsWith('.md')) throw new Error('Select a Markdown context file inside the project.');
  return path;
}

function bounds(text: string, section: ContextSection): [number, number] | undefined {
  const start = marker(section, 'start');
  const end = marker(section, 'end');
  const starts = text.split(start).length - 1;
  const ends = text.split(end).length - 1;
  if (starts !== ends || starts > 1 || (starts && text.indexOf(start) > text.indexOf(end))) throw new Error('Ambiguous context markers. Resolve them before setup.');
  return starts ? [text.indexOf(start), text.indexOf(end) + end.length] : undefined;
}

export function contextData(text: string | undefined, section: ContextSection): unknown | undefined {
  if (!text) return undefined;
  const range = bounds(text, section);
  if (!range) return undefined;
  const block = text.slice(...range);
  const fences = [...block.matchAll(/^```json\r?\n([\s\S]*?)\r?\n```\s*$/gm)];
  if (!fences.length && !/^```json/m.test(block)) return undefined; // Legacy instructions-only section.
  if (fences.length !== 1) throw new Error('Ambiguous embedded context settings.');
  try { parseConfiguration(fences[0]![1]!, 'embedded context settings'); return JSON.parse(fences[0]![1]!) as unknown; } catch { throw new Error('Invalid embedded context settings. No files changed.'); }
}

export function updateContext(text: string | undefined, section: ContextSection, data: unknown, instructions: string[]): string {
  const original = text ?? '';
  const range = bounds(original, section);
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  // Payload strings must not introduce section markers; JSON decoding restores < exactly.
  const payload = JSON.stringify(data, null, 2).replaceAll('<', '\\u003c').replaceAll('\n', eol);
  const block = [marker(section, 'start'), `## Advanced Harness ${section} settings`, '', ...instructions, '', '```json', payload, '```', marker(section, 'end')].join(eol);
  if (range) return original.slice(0, range[0]) + block + original.slice(range[1]);
  return original + (original && !original.endsWith('\n') ? eol : '') + (original ? eol : '') + block + eol;
}

/** Detects any harness section, including legacy instructions-only blocks without JSON. */
export function hasContextSection(text: string | undefined, section: ContextSection): boolean {
  return !!text && bounds(text, section) !== undefined;
}

/** Removes a section and the blank line that updateContext placed before it. */
export function removeContext(text: string, section: ContextSection): string {
  const range = bounds(text, section);
  if (!range) return text;
  let [start, end] = range;
  if (text.startsWith('\r\n', end)) end += 2;
  else if (text.startsWith('\n', end)) end += 1;
  const before = text.slice(0, start);
  const trimmed = before.endsWith('\r\n\r\n') ? before.slice(0, -2) : before.endsWith('\n\n') ? before.slice(0, -1) : before;
  return trimmed + text.slice(end);
}

export function prepareContextFiles(root: string, target: string, original: string | undefined, updated: string): SetupFile[] {
  contextPath(root, target);
  const files: SetupFile[] = [{ path: target, original, updated }];
  const agentsPath = join(root, 'AGENTS.md');
  const same = process.platform === 'win32' ? target.toLowerCase() === agentsPath.toLowerCase() : target === agentsPath;
  if (!same) {
    const agents = readContext(agentsPath);
    // A distinct block per selected context path avoids overwriting another context pointer.
    const child = relative(root, target).replaceAll('\\', '/');
    if (/[\r\n`<>]/.test(child)) throw new Error('Context filename cannot contain instruction delimiters.');
    const link = `Read \`${child}\` for Advanced Harness project settings before planning. Ask on conflicts; configuration is not implementation or publishing approval.`;
    const eol = agents?.includes('\r\n') ? '\r\n' : '\n';
    if (!agents?.includes(link)) files.push({ path: agentsPath, original: agents, updated: (agents ?? '') + (agents && !agents.endsWith('\n') ? eol : '') + eol + link + eol });
  }
  return files;
}
