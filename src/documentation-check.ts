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
const slug = (s: string) => s.toLowerCase().trim().replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```+|~~~+)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const base = slug(heading[1]!);
    const occurrence = counts.get(base) ?? 0;
    counts.set(base, occurrence + 1);
    anchors.add(occurrence ? `${base}-${occurrence}` : base);
  }
  return anchors;
}

export function checkDocumentation(root = process.cwd()): DocumentationDiagnostic[] {
  const diagnostics: DocumentationDiagnostic[] = [];
  const files = markdownFiles(root);
  const content = new Map(files.map(file => [file, readFileSync(file, 'utf8')]));
  const scripts = new Set(Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {}));
  const commandNames = new Set<string>(workflowCommandIds);
  for (const file of files) {
    const text = content.get(file)!;
    const lines = text.split(/\r?\n/);
    const headings = headingAnchors(text);
    const definitions = new Map<string, string>();
    let fence: { marker: string; language: string; openingLine: number } | undefined;
    for (const line of lines) {
      const fenceLine = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
      if (fenceLine) { if (fence) fence = undefined; else fence = { marker: fenceLine[1]!, language: fenceLine[2]!.toLowerCase(), openingLine: lines.indexOf(line) }; continue; }
      if (fence) continue;
      for (const match of line.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(\S+)/g)) definitions.set(match[1]!.toLowerCase(), match[2]!);
    }
    const report = (line: number, message: string) => diagnostics.push({ file: normalize(file.slice(root.length + 1)).replaceAll(sep, '/'), line: line + 1, message });
    fence = undefined;
    lines.forEach((line, index) => {
      const fenceLine = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
      if (fenceLine) { if (fence) fence = undefined; else fence = { marker: fenceLine[1]!, language: fenceLine[2]!.toLowerCase(), openingLine: index }; return; }
      const inCommandFence = fence && ['text', 'sh', 'bash', 'shell', 'powershell', 'ps1', 'cmd', 'console'].includes(fence.language);
      if (fence && !inCommandFence) return;
      for (const m of line.matchAll(/`\/(start|review|address|report|assess|grill)-([a-z][a-z0-9-]*)`/g)) {
        const command = `${m[1]}-${m[2]}`;
        if (!commandNames.has(command)) report(index, `Unknown native workflow command: /${command}`);
      }
      for (const m of line.matchAll(/!?(?:\[([^\]]*)\])\(([^)]+)\)/g)) checkDestination(m[2]!, index, report, file, root, content, headings);
      const used = new Set<string>();
      for (const m of line.matchAll(/!?(?:\[([^\]]+)\])(?:\[([^\]]*)\])?/g)) {
        const key = (m[2] || m[1]!).toLowerCase();
        if (!definitions.has(key)) continue;
        used.add(key);
        checkDestination(definitions.get(key)!, index, report, file, root, content, headings);
      }
      for (const m of line.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)) {
        const key = (m[2] || m[1]!).toLowerCase();
        if (!definitions.has(key)) report(index, `Undefined Markdown reference definition: ${key}`);
        else if (!used.has(key)) { used.add(key); checkDestination(definitions.get(key)!, index, report, file, root, content, headings); }
      }
      const npmPattern = /(?:`npm run ([a-z0-9:_-]+)`|\bnpm run ([a-z0-9:_-]+)\b)/g;
      for (const m of line.matchAll(npmPattern)) if (!scripts.has(m[1] ?? m[2]!)) report(index, `Unknown npm run script: ${m[1] ?? m[2]}`);
      for (const m of line.matchAll(/`((?:docs|agents|commands|skills|src|test|scripts|smoke|\.github)\/(?!<|\*)[^`\s]+)`/g)) {
        const path = m[1]!.replace(/[.,;:)]+$/, '');
        if (!existsRepoPath(root, path) && !path.includes('*')) report(index, `Repository-relative path does not exist: ${path}`);
      }
    });
  }
  const workflow = join(root, '.github', 'workflows');
  try {
    for (const name of readdirSync(workflow).filter(n => /\.(yml|yaml)$/.test(n))) {
      const path = join(workflow, name); const lines = readFileSync(path, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const run = /^\s*(?:-\s*)?run:\s*npm run ([a-z0-9:_-]+)(?:\s|$)/.exec(line);
        if (run && !scripts.has(run[1]!)) diagnostics.push({ file: `.github/workflows/${name}`, line: i + 1, message: `Unknown workflow npm run script: ${run[1]}` });
      });
    }
  } catch { /* workflow directory is optional */ }
  return diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.message.localeCompare(b.message));
}

function existsRepoPath(root: string, path: string): boolean { try { return statSync(join(root, path)).isFile() || statSync(join(root, path)).isDirectory(); } catch { return false; } }
function checkDestination(raw: string, line: number, report: (line: number, message: string) => void, file: string, root: string, content: Map<string, string>, headings: Set<string>): void {
  const dest = raw.trim().replace(/^<|>$/g, '').split(/\s+/)[0]!.replace(/&amp;/g, '&');
  if (!dest || /^(?:https?:|mailto:|tel:|data:|#)/i.test(dest)) {
    if (dest.startsWith('#')) checkFragment(dest.slice(1), line, report, file, content, headings);
    return;
  }
  if (/^(?:[a-z]+:|\\\\|\/|~)/i.test(dest) || /^[A-Za-z]:[\\/]/.test(dest) || /\{\{|\$\{/.test(dest)) return;
  const [pathname, fragment] = dest.split('#', 2);
  if (!pathname) { if (fragment) checkFragment(fragment, line, report, file, content, headings); return; }
  const target = resolve(dirname(file), decodeURIComponent(pathname));
  if (!target.startsWith(resolve(root) + sep) && target !== resolve(root)) { report(line, `Link escapes repository: ${dest}`); return; }
  try {
    statSync(target);
    if (fragment) {
      const targetText = content.get(target);
      if (targetText !== undefined) {
        const hs = headingAnchors(targetText);
        const requested = decodeURIComponent(fragment).toLowerCase();
        if (!hs.has(requested)) report(line, `Missing heading fragment: ${dest}`);
      }
    }
  } catch { report(line, `Missing local link/image destination: ${dest}`); }
}
function checkFragment(fragment: string, line: number, report: (line: number, message: string) => void, file: string, content: Map<string, string>, headings: Set<string>): void {
  const decoded = decodeURIComponent(fragment).toLowerCase();
  if (file && content.has(file) && !headings.has(decoded)) report(line, `Missing heading fragment: #${fragment}`);
}
