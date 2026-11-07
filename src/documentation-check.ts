import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { workflowCommandIds } from './workflow-commands.ts';

export interface DocumentationDiagnostic { file: string; line: number; message: string }

const recursiveRoots = ['docs', 'agents', 'commands', 'skills'];
function markdownFiles(root: string): string[] {
  const result: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      const path = join(directory, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && extname(name).toLowerCase() === '.md') result.push(path);
    }
  };
  // Keep repository-root discovery bounded: worktrees and unrelated directories
  // must not become part of the documentation check merely by being present.
  try {
    for (const name of readdirSync(root).sort()) {
      if (extname(name).toLowerCase() === '.md' && statSync(join(root, name)).isFile()) result.push(join(root, name));
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const entry of recursiveRoots) {
    const path = resolve(root, entry);
    try { if (statSync(path).isDirectory()) walk(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return [...new Set(result)].sort();
}

interface Fence { char: string; length: number; language: string }
interface LineState { delimiter: boolean; fence: Fence | undefined }
const commandFenceLanguages = new Set(['text', 'sh', 'bash', 'shell', 'powershell', 'ps1', 'cmd', 'console']);

/**
 * One fence scan shared by every pass. As in CommonMark, a fence closes only on the
 * same character, at least as long as the opener, with no info string, so a nested
 * ``` example inside a ```` block stays inside it.
 */
function fenceStates(lines: readonly string[]): LineState[] {
  let open: Fence | undefined;
  return lines.map(line => {
    if (open) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]![0] === open.char && close[1]!.length >= open.length) {
        open = undefined;
        return { delimiter: true, fence: undefined };
      }
      return { delimiter: false, fence: open };
    }
    // A backtick fence's info string cannot contain backticks; otherwise it is inline code.
    const opening = /^\s*(?:(`{3,})([^`]*)|(~{3,})(.*))$/.exec(line);
    if (!opening) return { delimiter: false, fence: undefined };
    const marker = (opening[1] ?? opening[3])!;
    const info = (opening[2] ?? opening[4] ?? '').trim();
    open = { char: marker[0]!, length: marker.length, language: (/^[\w+-]*/.exec(info)?.[0] ?? '').toLowerCase() };
    return { delimiter: true, fence: undefined };
  });
}

/** Index of the first line after YAML front matter, or 0 when there is none. */
function frontMatterEnd(lines: readonly string[]): number {
  if (lines[0] !== '---') return 0;
  const close = lines.findIndex((line, index) => index > 0 && (line === '---' || line === '...'));
  return close === -1 ? 0 : close + 1;
}

/** Blanks inline code spans so bracketed code is not read as Markdown links or references. */
const withoutCodeSpans = (line: string) => line.replace(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, span => ' '.repeat(span.length));

const slug = (s: string) => s.toLowerCase().trim().replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
/** Heading text as GitHub anchors it: link and image text only, without their destinations or inline HTML. */
const headingText = (raw: string) => raw
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
  .replace(/<[^>]+>/g, '');
const setextUnderline = /^ {0,3}(?:=+|-+)\s*$/;
const notParagraph = /^\s*(?:$|[-*+]\s|\d+[.)]\s|>|#|\||<!--)/;

function headingAnchors(markdown: string): Set<string> {
  const lines = markdown.split(/\r?\n/);
  const states = fenceStates(lines);
  const body = frontMatterEnd(lines);
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  const add = (text: string) => {
    const base = slug(headingText(text));
    const occurrence = counts.get(base) ?? 0;
    counts.set(base, occurrence + 1);
    anchors.add(occurrence ? `${base}-${occurrence}` : base);
  };
  const isText = (index: number) => index >= body && !states[index]!.delimiter && !states[index]!.fence;
  lines.forEach((line, index) => {
    if (!isText(index)) return;
    for (const m of line.matchAll(/<[a-z][^>]*?\s(?:id|name)\s*=\s*["']([^"']+)["']/gi)) anchors.add(m[1]!.toLowerCase());
    const atx = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) { add(atx[1]!); return; }
    const previous = lines[index - 1];
    if (setextUnderline.test(line) && previous !== undefined && isText(index - 1) && !notParagraph.test(previous) && !setextUnderline.test(previous)) add(previous.trim());
  });
  return anchors;
}

// npm options may come before the script name (`npm run -s docs:check`); a script name never starts with `-`.
const npmOptions = String.raw`(?:--?[a-z][\w-]*(?:=\S*)?\s+)*`;
const npmScriptName = String.raw`([a-z0-9][a-z0-9:_-]*)`;
const scriptName = (raw: string) => raw.replace(/:+$/, '');

/** A repository path from an inline code span, without a `#fragment` or `:line[:column]` suffix; placeholders and globs are excluded. */
function repositoryPath(raw: string): string | undefined {
  if (/[<>*{}$]/.test(raw)) return undefined;
  return raw.replace(/[.,;:)]+$/, '').replace(/#.*$/, '').replace(/:\d+(?::\d+)?(?:-\d+)?$/, '');
}

export function checkDocumentation(root = process.cwd()): DocumentationDiagnostic[] {
  const diagnostics: DocumentationDiagnostic[] = [];
  const files = markdownFiles(root);
  const content = new Map(files.map(file => [file, readFileSync(file, 'utf8')]));
  const scripts = new Set(Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {}));
  const commandNames = new Set<string>(workflowCommandIds);
  const npmRun = new RegExp(String.raw`\bnpm run\s+${npmOptions}${npmScriptName}`, 'g');
  for (const file of files) {
    const text = content.get(file)!;
    const lines = text.split(/\r?\n/);
    const states = fenceStates(lines);
    const headings = headingAnchors(text);
    const definitions = new Map<string, string>();
    lines.forEach((line, index) => {
      if (states[index]!.delimiter || states[index]!.fence) return;
      for (const match of line.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(\S+)/g)) definitions.set(match[1]!.toLowerCase(), match[2]!);
    });
    const report = (line: number, message: string) => diagnostics.push({ file: normalize(file.slice(root.length + 1)).replaceAll(sep, '/'), line: line + 1, message });
    const destination = (raw: string, index: number) => checkDestination(raw, index, report, file, root, content, headings);
    lines.forEach((line, index) => {
      const { delimiter, fence } = states[index]!;
      if (delimiter || (fence && !commandFenceLanguages.has(fence.language))) return;
      for (const m of line.matchAll(/`\/(start|review|address|report|assess|grill)-([a-z][a-z0-9-]*)`/g)) {
        const command = `${m[1]}-${m[2]}`;
        if (!commandNames.has(command)) report(index, `Unknown native workflow command: /${command}`);
      }
      const prose = withoutCodeSpans(line);
      for (const m of prose.matchAll(/!?(?:\[([^\]]*)\])\(([^)]+)\)/g)) destination(m[2]!, index);
      const used = new Set<string>();
      for (const m of prose.matchAll(/!?(?:\[([^\]]+)\])(?:\[([^\]]*)\])?/g)) {
        const key = (m[2] || m[1]!).toLowerCase();
        if (!definitions.has(key)) continue;
        used.add(key);
        destination(definitions.get(key)!, index);
      }
      for (const m of prose.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)) {
        const key = (m[2] || m[1]!).toLowerCase();
        if (!definitions.has(key)) report(index, `Undefined Markdown reference definition: ${key}`);
        else if (!used.has(key)) { used.add(key); destination(definitions.get(key)!, index); }
      }
      for (const m of line.matchAll(npmRun)) {
        const name = scriptName(m[1]!);
        if (!scripts.has(name)) report(index, `Unknown npm run script: ${name}`);
      }
      for (const m of line.matchAll(/`((?:docs|agents|commands|skills|src|test|scripts|smoke|\.github)\/[^`\s]+)`/g)) {
        const path = repositoryPath(m[1]!);
        if (path !== undefined && !existsRepoPath(root, path)) report(index, `Repository-relative path does not exist: ${path}`);
      }
    });
  }
  const workflow = join(root, '.github', 'workflows');
  const workflowRun = new RegExp(String.raw`^\s*(?:-\s*)?run:\s*npm run\s+${npmOptions}${npmScriptName}(?:\s|$)`);
  try {
    for (const name of readdirSync(workflow).filter(n => /\.(yml|yaml)$/.test(n))) {
      const path = join(workflow, name); const lines = readFileSync(path, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const run = workflowRun.exec(line);
        if (run && !scripts.has(scriptName(run[1]!))) diagnostics.push({ file: `.github/workflows/${name}`, line: i + 1, message: `Unknown workflow npm run script: ${scriptName(run[1]!)}` });
      });
    }
  } catch { /* workflow directory is optional */ }
  return diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.message.localeCompare(b.message));
}

function existsRepoPath(root: string, path: string): boolean {
  try { const stat = statSync(join(root, path)); return stat.isFile() || stat.isDirectory(); } catch { return false; }
}
/** decodeURIComponent throws on a malformed percent sequence; report it instead of aborting the whole check. */
function decoded(value: string): string | undefined { try { return decodeURIComponent(value); } catch { return undefined; } }
function checkDestination(raw: string, line: number, report: (line: number, message: string) => void, file: string, root: string, content: Map<string, string>, headings: Set<string>): void {
  const dest = raw.trim().replace(/^<|>$/g, '').split(/\s+/)[0]!.replace(/&amp;/g, '&');
  if (!dest || /^(?:https?:|mailto:|tel:|data:|#)/i.test(dest)) {
    if (dest.startsWith('#')) checkFragment(dest.slice(1), line, report, file, content, headings);
    return;
  }
  if (/^(?:[a-z]+:|\\\\|\/|~)/i.test(dest) || /^[A-Za-z]:[\\/]/.test(dest) || /\{\{|\$\{/.test(dest)) return;
  const [pathname, fragment] = dest.split('#', 2);
  if (!pathname) { if (fragment) checkFragment(fragment, line, report, file, content, headings); return; }
  const decodedPath = decoded(pathname);
  if (decodedPath === undefined) { report(line, `Malformed percent-encoding in link: ${dest}`); return; }
  const target = resolve(dirname(file), decodedPath);
  if (!target.startsWith(resolve(root) + sep) && target !== resolve(root)) { report(line, `Link escapes repository: ${dest}`); return; }
  try {
    statSync(target);
  } catch { report(line, `Missing local link/image destination: ${dest}`); return; }
  if (!fragment) return;
  const targetText = content.get(target);
  if (targetText === undefined) return;
  const requested = decoded(fragment)?.toLowerCase();
  if (requested === undefined) report(line, `Malformed percent-encoding in link: ${dest}`);
  else if (!headingAnchors(targetText).has(requested)) report(line, `Missing heading fragment: ${dest}`);
}
function checkFragment(fragment: string, line: number, report: (line: number, message: string) => void, file: string, content: Map<string, string>, headings: Set<string>): void {
  if (!file || !content.has(file)) return;
  const requested = decoded(fragment)?.toLowerCase();
  if (requested === undefined) report(line, `Malformed percent-encoding in link: #${fragment}`);
  else if (!headings.has(requested)) report(line, `Missing heading fragment: #${fragment}`);
}
