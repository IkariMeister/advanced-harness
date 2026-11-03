import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, lstatSync, readdirSync, rmdirSync } from 'node:fs';
import { basename, dirname, join, resolve, parse as pathParse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertSafeFilesystemPath } from './installation-receipt.ts';
import { saveInstallation, type Ask } from './native-installer.ts';
import { chooseCodexCatalog, type CodexCatalogModel, type CodexModelDiscovery } from './codex-model-catalog.ts';
import { nativeRoles, type NativeRole } from './native-role-types.ts';
import { loadRoleDefinitions } from './role-definitions.ts';
import { codexDestructiveGitPrefixes, type CodexPrefixPattern } from './security-guardrails.ts';
import { loadWorkflowCommands, workflowCommandIds } from './workflow-commands.ts';
import { codexChildRoles, codexProfileName, codexRolePolicies, codexRoleLauncherSource, compileCodexLeadBlock, compileCodexRoleProfile, compileCodexRoleStatusSchema, extractCodexLeadBlock, mergeCodexLeadBlock } from './codex-role-processes.ts';
import { createSuccessorReceipt, discoverReceiptChain, finalizeSuccessor, recoverFailedSuccessor, revalidatePendingSuccessor, writePendingSuccessor, type HarnessVersionStamp, type ManagedFileEvidence } from './receipt-lineage.ts';

type PlannedFile = { path: string; content: string; before: string | undefined; kind: string };
const quote = (text: string): string => JSON.stringify(text);
const roleId = (value: string): boolean => /^[a-z][a-z0-9_-]{0,63}$/.test(value);
const validMcpId = (value: string): boolean => value.length > 0 && !/[\r\n\0]/.test(value);
export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const canonicalPath = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
export const encodeCodexYamlScalar = (value: string): string => JSON.stringify(value);

// Supported TOML subset: basic/literal keys, basic tables, single-line strings,
// scalar primitives, arrays, and inline tables. Multiline strings and arrays of
// tables are intentionally rejected so edits can preserve original source slices.

type CodexTomlTable = { path: string; parts: string[]; start: number; end: number };
type CodexTomlEntry = { key: string[]; table: string[]; valueStart: number; valueEnd: number; value: unknown; line: number };
type CodexTomlDocument = { tables: CodexTomlTable[]; entries: CodexTomlEntry[] };

function stripTomlComment(line: string): string {
  let quoteChar = '';
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoteChar === '"') {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') quoteChar = '';
    } else if (quoteChar === "'") {
      if (ch === "'") quoteChar = '';
    } else if (ch === '"' || ch === "'") quoteChar = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function keyParts(text: string): string[] | undefined {
  const parts: string[] = [];
  let i = 0;
  let needPart = true;
  while (i < text.length) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (i === text.length) return undefined;
    let value: string;
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i++]!; const start = i;
      while (i < text.length && text[i] !== q) { if (q === '"' && text[i] === '\\') i++; i++; }
      if (i >= text.length) return undefined;
      const raw = text.slice(start - 1, i + 1);
      i++;
      try { value = decodeTomlString(raw); } catch { return undefined; }
    } else {
      const start = i; while (/[A-Za-z0-9_-]/.test(text[i] ?? '')) i++;
      if (i === start) return undefined; value = text.slice(start, i);
    }
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) return undefined; parts.push(value); needPart = false;
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (i === text.length) break;
    if (text[i++] !== '.') return undefined;
    needPart = true;
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (i === text.length) return undefined;
  }
  return parts.length && !needPart ? parts : undefined;
}

function hasExactPath(paths: Iterable<string>, candidate: string): boolean {
  const wanted = JSON.parse(candidate) as string[];
  for (const path of paths) {
    const existing = JSON.parse(path) as string[];
    if (existing.length === wanted.length && existing.every((part, index) => part === wanted[index])) return true;
  }
  return false;
}
function hasDescendantPath(paths: Iterable<string>, candidate: string): boolean {
  const wanted = JSON.parse(candidate) as string[];
  for (const path of paths) {
    const existing = JSON.parse(path) as string[];
    if (existing.length >= wanted.length && wanted.every((part, index) => existing[index] === part)) return true;
  }
  return false;
}
function isPrefix(a: string[], b: string[]): boolean { return a.length <= b.length && a.every((part, index) => part === b[index]); }
function assignmentDelimiter(text: string): number {
  let quote = ''; let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === '"') { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quote = ''; }
    else if (quote === "'") { if (ch === "'") quote = ''; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '=') return i;
  }
  return -1;
}

function decodeTomlString(raw: string): string {
  if (raw.startsWith("'")) return raw.slice(1, -1);
  const value = JSON.parse(raw) as string;
  return value;
}

function parseTomlScalar(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith('"') || value.startsWith("'")) return decodeTomlString(value);
  if (value === 'true' || value === 'false') return value === 'true';
  const digits = '[0-9](?:_?[0-9])*';
  const dec = `(?:0|[1-9](?:_?[0-9])*)`;
  if (new RegExp(`^[+-]?${dec}$`).test(value)) return Number(value.replaceAll('_', ''));
  if (/^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/.test(value)) return Number.parseInt(value.slice(2).replaceAll('_', ''), 16);
  if (/^0o[0-7](?:_?[0-7])*$/.test(value)) return Number.parseInt(value.slice(2).replaceAll('_', ''), 8);
  if (/^0b[01](?:_?[01])*$/.test(value)) return Number.parseInt(value.slice(2).replaceAll('_', ''), 2);
  if (new RegExp(`^[+-]?${dec}(?:\\.${digits}(?:[eE][+-]?${digits})?|[eE][+-]?${digits})$|^[+-]?${dec}\\.${digits}(?:[eE][+-]?${digits})?$`).test(value)) return Number(value.replaceAll('_', ''));
  if (/^[+-]?(?:inf|nan)$/.test(value)) return value;
  return value;
}

function parseTomlValue(source: string, initial: number, path: string, lineNumber: number): { end: number; value: unknown } {
  const fail = (): never => { throw new Error(`Unsupported or malformed TOML value in ${path} at line ${lineNumber}; refusing to edit it.`); };
  const spaces = (index: number) => { while (source[index] === ' ' || source[index] === '\t') index++; return index; };
  let index = spaces(initial);
  const ch = source[index];
  if (ch === '"' || ch === "'") {
    const quoteChar = ch;
    index++;
    while (index < source.length) {
      const code = source.charCodeAt(index);
      if (quoteChar === '"' && source[index] === '\\') {
        const esc = source[index + 1];
        if (!esc) return fail();
        if ('btnfr"\\'.includes(esc)) { index += 2; continue; }
        if (esc === 'u' || esc === 'U') {
          const length = esc === 'u' ? 4 : 8;
          const hex = source.slice(index + 2, index + 2 + length);
          if (hex.length !== length || !/^[0-9A-Fa-f]+$/.test(hex)) return fail();
          const point = Number.parseInt(hex, 16);
          if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return fail();
          index += length + 2;
          continue;
        }
        return fail();
      }
      if (source[index] === quoteChar) {
        const token = source.slice(spaces(initial), index + 1);
        let decoded: string;
        try { decoded = decodeTomlString(token); } catch { return fail(); }
        return { end: index + 1, value: decoded };
      }
      if (code < 0x20 && source[index] !== '\t') return fail();
      index++;
    }
    return fail();
  }
  if (ch === '[') {
    index++;
    index = spaces(index);
    if (source[index] === ']') return { end: index + 1, value: [] };
    const values: unknown[] = [];
    while (index < source.length) {
      const item = parseTomlValue(source, index, path, lineNumber);
      values.push(item.value);
      index = item.end;
      index = spaces(index);
      if (source[index] === ']') return { end: index + 1, value: values };
      if (source[index] !== ',') return fail();
      index = spaces(index + 1);
      if (source[index] === ']') return { end: index + 1, value: values }; // TOML arrays permit a trailing comma.
    }
    return fail();
  }
  if (ch === '{') {
    index = spaces(index + 1);
    const seen = new Set<string>();
    if (source[index] === '}') return { end: index + 1, value: Object.create(null) };
    const values = Object.create(null) as Record<string, unknown>;
    while (index < source.length) {
      const start = index;
      const delimiter = assignmentDelimiter(source.slice(index));
      if (delimiter < 0) return fail();
      index += delimiter;
      const parts = keyParts(source.slice(start, index));
      if (!parts) return fail();
      const key = JSON.stringify(parts);
      if ([...seen].some(existing => { const prior = JSON.parse(existing) as string[]; return isPrefix(prior, parts) || isPrefix(parts, prior); })) return fail();
      seen.add(key);
      index = spaces(index);
      if (source[index] !== '=') return fail();
      const keyPath = [...(keyParts(source.slice(start, index)) ?? [])];
      const item = parseTomlValue(source, index + 1, path, lineNumber);
      let target = values;
      for (const keyPart of keyPath.slice(0, -1)) {
        if (!Object.prototype.hasOwnProperty.call(target, keyPart)) Object.defineProperty(target, keyPart, { value: Object.create(null), writable: true, enumerable: true, configurable: true });
        target = target[keyPart] as Record<string, unknown>;
      }
      Object.defineProperty(target, keyPath.at(-1)!, { value: item.value, writable: true, enumerable: true, configurable: true });
      index = item.end;
      index = spaces(index);
      if (source[index] === '}') return { end: index + 1, value: values };
      if (source[index] !== ',') return fail();
      index = spaces(index + 1);
      if (source[index] === '}') return fail(); // TOML inline tables do not permit a trailing comma.
    }
    return fail();
  }
  const start = index;
  while (index < source.length && !/[\s,\]}]/.test(source[index]!)) index++;
  const bare = source.slice(start, index);
  const digits = '[0-9](?:_?[0-9])*';
  const unsignedDecimal = '(?:0|[1-9](?:_?[0-9])*)';
  const integer = new RegExp(`^[+-]?${unsignedDecimal}$`);
  const based = /^0(?:x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/;
  const float = new RegExp(`^[+-]?${unsignedDecimal}(?:\\.${digits}(?:[eE][+-]?${digits})?|[eE][+-]?${digits})$|^[+-]?${unsignedDecimal}\\.${digits}(?:[eE][+-]?${digits})?$`);
  if (bare === 'true' || bare === 'false' || integer.test(bare) || based.test(bare) || float.test(bare) || /^[+-]?(?:inf|nan)$/.test(bare)) {
    return { end: index, value: bare === 'true' ? true : bare === 'false' ? false : Number(bare.replaceAll('_', '')) };
  }
  return fail();
}

/** Parse the supported TOML subset structurally and refuse ambiguity before any prompt or write. */
function parseCodexToml(text: string, path: string): CodexTomlDocument {
  const explicitTables = new Set<string>();
  const values = new Set<string>();
  const scalarPaths = new Set<string>();
  const tables: CodexTomlTable[] = [];
  const entries: CodexTomlEntry[] = [];
  let currentTable: string[] = [];
  let offset = 0;
  let lineNumber = 0;
  const lines = text.split(/(?<=\n)/);
  for (const rawLine of lines) {
    lineNumber++;
    const raw = rawLine.replace(/[\r\n]+$/, '');
    const content = stripTomlComment(raw).trim();
    const actualLine = lineNumber;
    if (!content) { offset += rawLine.length; continue; }
    const tableMatch = /^\[\s*(.*?)\s*\]$/.exec(content);
    if (tableMatch) {
      const parts = keyParts(tableMatch[1]!);
      if (!parts) throw new Error(`Unsupported TOML table in ${path} at line ${actualLine}; refusing to edit it.`);
      const tablePath = JSON.stringify(parts);
      if (hasExactPath(explicitTables, tablePath) || hasDescendantPath(explicitTables, tablePath)) throw new Error(`Duplicate or out-of-order TOML table in ${path} at line ${actualLine}.`);
      const tableParts = parts;
      if ([...scalarPaths].some(valuePath => { const valueParts = JSON.parse(valuePath) as string[]; return isPrefix(valueParts, tableParts); })) throw new Error(`TOML scalar/table collision in ${path} at line ${actualLine}.`);
      if (tables.length) tables[tables.length - 1]!.end = offset;
      explicitTables.add(tablePath);
      currentTable = parts;
      tables.push({ path: parts.join('.'), parts, start: offset, end: text.length });
      offset += rawLine.length;
      continue;
    }
    if (content.startsWith('[')) throw new Error(`Unsupported or malformed TOML table in ${path} at line ${actualLine}; refusing to edit it.`);
    const uncommented = stripTomlComment(raw);
    const leading = raw.search(/\S/);
    const equals = assignmentDelimiter(uncommented);
    if (equals < 0) throw new Error(`Unsupported or malformed TOML assignment in ${path} at line ${actualLine}; refusing to edit it.`);
    const keyText = uncommented.slice(leading, equals).trimEnd();
    const parts = keyParts(keyText);
    if (!parts) throw new Error(`Unsupported TOML key in ${path} at line ${actualLine}; refusing to edit it.`);
    const fullKey = JSON.stringify([...currentTable, ...parts]);
    const fullParts = [...currentTable, ...parts];
    if ([...values].some(existing => { const prior = JSON.parse(existing) as string[]; return isPrefix(prior, fullParts) || isPrefix(fullParts, prior); }) || hasDescendantPath(explicitTables, fullKey)) throw new Error(`Duplicate TOML key or scalar/table collision in ${path} at line ${actualLine}.`);
    const valueStart = equals + 1;
    const parsedValue = parseTomlValue(uncommented, valueStart, path, actualLine);
    const valueEnd = parsedValue.end;
    if (uncommented.slice(valueEnd).trim()) throw new Error(`Trailing or malformed TOML value in ${path} at line ${actualLine}; refusing to edit it.`);
    values.add(fullKey);
    scalarPaths.add(fullKey);
    const leadingValue = uncommented.slice(valueStart).match(/^[ \t]*/)?.[0].length ?? 0;
    entries.push({ key: parts, table: [...currentTable], valueStart: offset + valueStart + leadingValue, valueEnd: offset + valueEnd, value: parsedValue.value, line: actualLine });
    offset += rawLine.length;
  }
  return { tables, entries };
}

export function validateCodexToml(text: string, path = 'Codex TOML'): void {
  parseCodexToml(text, path);
}

function appendSettings(existing: string | undefined): string {
  const text = existing ?? '';
  const parsed = parseCodexToml(text, 'config.toml');
  const rootHas = (key: string) => parsed.entries.some(entry => entry.table.length === 0 && entry.key.length === 1 && entry.key[0] === key);
  const blocks: string[] = [];
  if (!rootHas('sandbox_mode')) blocks.push('sandbox_mode = "read-only"');
  if (!rootHas('approval_policy')) blocks.push('approval_policy = "on-request"');
  if (!blocks.length) return text;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const separator = (prefix: string) => !prefix ? '' : prefix.endsWith(`${newline}${newline}`) ? '' : prefix.endsWith(newline) ? newline : `${newline}${newline}`;
  const document = parseCodexToml(text, 'config.toml');
  const firstTable = document.tables[0]?.start;
  if (firstTable !== undefined) {
    const prefix = text.slice(0, firstTable);
    const insertion = `${separator(prefix)}${blocks.join(`${newline}${newline}`)}${newline}${newline}`;
    return text.slice(0, firstTable) + insertion + text.slice(firstTable);
  }
  return `${text}${separator(text)}${blocks.join(`${newline}${newline}`)}${newline}`;
}

/** Adds `[features] multi_agent = false` when unset; an explicit user `true` is kept and reported. */
export function disableMultiAgent(text: string, output: (message: string) => void = () => {}): string {
  const document = parseCodexToml(text, 'config.toml');
  const entry = document.entries.find(item => (item.table.length === 1 && item.table[0] === 'features' && item.key.length === 1 && item.key[0] === 'multi_agent')
    || (item.table.length === 0 && item.key.length === 2 && item.key[0] === 'features' && item.key[1] === 'multi_agent'));
  if (entry) {
    if (entry.value !== false) output('Warning: config.toml sets features.multi_agent explicitly; Lead could spawn in-process subagents that share its sandbox. Set it to false to keep roles isolated.');
    return text;
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const table = document.tables.find(item => item.parts.length === 1 && item.parts[0] === 'features');
  let result: string;
  if (table) {
    const section = text.slice(table.start, table.end);
    const suffix = /(?:\r?\n[ \t]*)*$/.exec(section)?.[0] ?? '';
    const bodyEnd = table.end - suffix.length;
    result = `${text.slice(0, bodyEnd)}${newline}multi_agent = false${suffix || newline}${text.slice(table.end)}`;
  } else {
    result = `${text.replace(/\s*$/, '')}${text.trim() ? `${newline}${newline}` : ''}[features]${newline}multi_agent = false${newline}`;
  }
  validateCodexToml(result, 'updated config.toml');
  return result;
}

/**
 * What the harness changed in config.toml, kept in the state manifest so uninstall can undo exactly
 * those edits. The receipt stores config.toml only as a digest (it can hold MCP credentials), so the
 * prior file cannot be restored wholesale.
 */
export type CodexConfigEdits = {
  addedRootKeys: string[];
  multiAgentAdded: boolean;
  /** config.toml did not exist before the first install, so uninstall may remove it once it is empty. */
  configCreated: boolean;
  featuresTableAdded: boolean;
  /** toolsAfter is the exact disabled_tools array the harness left; a different current array was customized. */
  mcp: Record<string, { enabledBefore: boolean | null; addedTools: string[]; toolsKeyAdded: boolean; toolsAfter?: string[] | null }>;
};

const findEntry = (document: CodexTomlDocument, table: string[], key: string) =>
  document.entries.find(entry => entry.table.join('\u0000') === table.join('\u0000') && entry.key.length === 1 && entry.key[0] === key)
  ?? (table.length ? document.entries.find(entry => entry.table.length === 0 && entry.key.join('\u0000') === [...table, key].join('\u0000')) : undefined);

const sameTools = (a: readonly unknown[] | null | undefined, b: readonly unknown[] | null | undefined) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((name, index) => name === b[index]));

/**
 * MCP records keyed by server ID in a null-prototype object: IDs such as `constructor` or
 * `__proto__` are valid TOML keys and must be ordinary own entries, never inherited or a prototype.
 */
function ownRecords(records: CodexConfigEdits['mcp'] | undefined): CodexConfigEdits['mcp'] {
  const result = Object.create(null) as CodexConfigEdits['mcp'];
  for (const [id, record] of Object.entries(records ?? {})) result[id] = structuredClone(record);
  return result;
}

/** Diffs config.toml before and after an install, then folds in edits recorded by earlier installs. */
export function codexConfigEdits(before: string, after: string, prior?: CodexConfigEdits, created = false): CodexConfigEdits {
  const was = parseCodexToml(before, 'config.toml'), now = parseCodexToml(after, 'config.toml');
  const edits: CodexConfigEdits = {
    addedRootKeys: [...new Set([...(prior?.addedRootKeys ?? []), ...['sandbox_mode', 'approval_policy'].filter(key => !findEntry(was, [], key) && findEntry(now, [], key))])],
    multiAgentAdded: (prior?.multiAgentAdded ?? false) || (!findEntry(was, ['features'], 'multi_agent') && Boolean(findEntry(now, ['features'], 'multi_agent'))),
    configCreated: prior ? prior.configCreated : created,
    featuresTableAdded: (prior?.featuresTableAdded ?? false) || (!was.tables.some(table => table.path === 'features') && now.tables.some(table => table.path === 'features')),
    mcp: ownRecords(prior?.mcp),
  };
  for (const table of now.tables.filter(item => item.parts.length === 2 && item.parts[0] === 'mcp_servers')) {
    const id = table.parts[1]!, path = ['mcp_servers', id];
    const enabledWas = findEntry(was, path, 'enabled')?.value, enabledNow = findEntry(now, path, 'enabled')?.value;
    const toolsWas = findEntry(was, path, 'disabled_tools'), toolsNow = findEntry(now, path, 'disabled_tools');
    const oldTools = Array.isArray(toolsWas?.value) ? toolsWas.value as string[] : [];
    const added = Array.isArray(toolsNow?.value) ? (toolsNow.value as string[]).filter(name => !oldTools.includes(name)) : [];
    const previous = Object.hasOwn(edits.mcp, id) ? edits.mcp[id] : undefined;
    // A server recorded by an earlier install keeps its record current even when this run adds nothing.
    if (enabledWas === enabledNow && !added.length && !previous) continue;
    // A list the user changed since the last install stays marked as changed: adopting it as the
    // harness baseline would let uninstall narrow a user-customized list without a kept warning.
    const toolsBefore = Array.isArray(toolsWas?.value) ? toolsWas.value as string[] : null;
    const customized = previous !== undefined && previous.toolsAfter !== undefined && !sameTools(toolsBefore, previous.toolsAfter);
    edits.mcp[id] = {
      enabledBefore: previous ? previous.enabledBefore : typeof enabledWas === 'boolean' ? enabledWas : null,
      addedTools: [...new Set([...(previous?.addedTools ?? []), ...added])],
      toolsKeyAdded: previous ? previous.toolsKeyAdded : !toolsWas && Boolean(toolsNow),
      toolsAfter: customized ? previous.toolsAfter as string[] | null : Array.isArray(toolsNow?.value) ? [...toolsNow.value as string[]] : null,
    };
  }
  return edits;
}

/**
 * Undoes recorded harness edits on the current config.toml. A key whose value no longer matches what
 * the harness wrote was changed by the user: it is left in place and listed in `kept`.
 */
export function reverseCodexConfigEdits(text: string, edits: CodexConfigEdits): { text: string; kept: string[] } {
  const kept: string[] = [];
  const document = parseCodexToml(text, 'config.toml');
  const changes: Array<{ start: number; end: number; text: string }> = [];
  const lineOf = (entry: CodexTomlEntry) => {
    const start = text.lastIndexOf('\n', entry.valueStart - 1) + 1;
    const newline = text.indexOf('\n', entry.valueEnd);
    return { start, end: newline < 0 ? text.length : newline + 1 };
  };
  const removeIf = (entry: CodexTomlEntry | undefined, expected: unknown, label: string, withSeparator = false) => {
    if (!entry) return;
    if (entry.value !== expected) { kept.push(label); return; }
    const line = lineOf(entry);
    // The baseline keys are inserted as blocks each followed by one blank line; take that line too.
    const blank = withSeparator ? /^\r?\n/.exec(text.slice(line.end))?.[0].length ?? 0 : 0;
    changes.push({ start: line.start, end: line.end + blank, text: '' });
  };
  const harnessValues: Record<string, string> = { sandbox_mode: 'read-only', approval_policy: 'on-request' };
  for (const key of edits.addedRootKeys) removeIf(findEntry(document, [], key), harnessValues[key], key, true);
  if (edits.multiAgentAdded) removeIf(findEntry(document, ['features'], 'multi_agent'), false, 'features.multi_agent');
  for (const [id, record] of Object.entries(edits.mcp)) {
    const path = ['mcp_servers', id];
    const enabled = findEntry(document, path, 'enabled');
    if (enabled && enabled.value !== false) kept.push(`mcp_servers.${id}.enabled`);
    else if (enabled && record.enabledBefore === null) changes.push({ ...lineOf(enabled), text: '' });
    else if (enabled && record.enabledBefore !== false) changes.push({ start: enabled.valueStart, end: enabled.valueEnd, text: 'true' });
    const tools = findEntry(document, path, 'disabled_tools');
    if (tools && record.addedTools.length) {
      // Only an unchanged list is narrowed: removing entries from a customized list would drop a user restriction.
      const unchanged = Array.isArray(tools.value) && Array.isArray(record.toolsAfter)
        && tools.value.length === record.toolsAfter.length && (tools.value as unknown[]).every((name, index) => name === record.toolsAfter![index]);
      if (!unchanged) { kept.push(`mcp_servers.${id}.disabled_tools`); continue; }
      const remaining = (tools.value as string[]).filter(name => !record.addedTools.includes(name));
      if (!remaining.length && record.toolsKeyAdded) changes.push({ ...lineOf(tools), text: '' });
      else changes.push({ start: tools.valueStart, end: tools.valueEnd, text: `[${remaining.map(quote).join(', ')}]` });
    }
  }
  let result = text;
  for (const change of changes.sort((a, b) => b.start - a.start)) result = result.slice(0, change.start) + change.text + result.slice(change.end);
  if (edits.featuresTableAdded) {
    const after = parseCodexToml(result, 'config.toml');
    const features = after.tables.find(table => table.path === 'features');
    if (features && !after.entries.some(entry => entry.table.length === 1 && entry.table[0] === 'features')) {
      const end = result.indexOf('\n', features.start);
      const start = result.slice(0, features.start).replace(/(\r?\n)+$/, '').length;
      result = result.slice(0, start) + (start ? result.slice(start, features.start).match(/\r?\n/)?.[0] ?? '' : '') + result.slice(end < 0 ? result.length : end + 1);
    }
  }
  validateCodexToml(result, 'restored config.toml');
  return { text: result, kept };
}

export function compileCodexAgent(role: NativeRole, model: string, reasoning: string, description: string, instructions: string): string {
  if (!roleId(role) || !model.trim() || !(CODEX_REASONING_EFFORTS as readonly string[]).includes(reasoning)) throw new Error(`Invalid Codex agent assignment: ${role}`);
  return `name = ${quote(role)}\ndescription = ${quote(description)}\ndeveloper_instructions = ${quote(instructions)}\nmodel = ${quote(model.trim())}\nmodel_reasoning_effort = ${quote(reasoning)}\n`;
}

const codexMergePrefixes: readonly CodexPrefixPattern[] = [['gh', 'pr', 'merge'], ['gh.exe', 'pr', 'merge']];
/** Managed forbidden prefixes: direct merge plus destructive Git (BH-036). */
export const codexForbiddenPrefixes: readonly CodexPrefixPattern[] = [...codexMergePrefixes, ...codexDestructiveGitPrefixes];

const codexPatternSource = (pattern: CodexPrefixPattern): string => `[${pattern.map(token => typeof token === 'string' ? JSON.stringify(token) : codexPatternSource(token)).join(', ')}]`;
const codexPatternLabel = (pattern: CodexPrefixPattern) => pattern.map(token => typeof token === 'string' ? token : `{${token.slice(0, 3).join('|')}${token.length > 3 ? '|…' : ''}}`).join(' ');

export function compileCodexMergeRule(): string {
  const rules = codexForbiddenPrefixes.map(pattern => `prefix_rule(pattern = ${codexPatternSource(pattern)}, decision = "forbidden")\n`).join('');
  return `# BEGIN advanced-harness managed merge rules\n# Denies identifiable direct CLI forms only (gh pr merge, git reset --hard, git clean, force pushes); force flags after an unlisted remote or a refspec are not matched, and indirect/API routes are not blocked.\n${rules}# END advanced-harness managed merge rules\n`;
}

function hasActiveCodexPrefixRule(text: string, pattern: CodexPrefixPattern): boolean {
  type Token = { kind: 'identifier' | 'string' | 'punctuation'; value: string; line: number; column: number };
  const tokens: Token[] = [];
  const continuedLines = new Set<number>();
  let index = 0;
  let line = 0;
  let lineStart = 0;
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === '\n') { line++; index++; lineStart = index; continue; }
    if (ch === '\r' || ch === ' ' || ch === '\t' || ch === '\f') { index++; continue; }
    if (ch === '\\' && (text[index + 1] === '\n' || text[index + 1] === '\r')) {
      index++;
      if (text[index] === '\r') index++;
      if (text[index] === '\n') index++;
      line++;
      lineStart = index;
      continuedLines.add(line);
      continue;
    }
    if (ch === '#') {
      while (index < text.length && text[index] !== '\n') index++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const triple = text.startsWith(quote.repeat(3), index);
      const delimiter = quote.repeat(triple ? 3 : 1);
      const startLine = line;
      const column = index - lineStart;
      index += delimiter.length;
      let value = '';
      let closed = false;
      while (index < text.length) {
        if (text.startsWith(delimiter, index)) { index += delimiter.length; closed = true; break; }
        const current = text[index]!;
        if (current === '\\') {
          if (index + 1 >= text.length || text[index + 1] === '\n' || text[index + 1] === '\r') return false;
          const escaped = text[index + 1]!;
          value += escaped === quote || escaped === '\\' ? escaped : `\\${escaped}`;
          index += 2;
          continue;
        }
        if (!triple && (current === '\n' || current === '\r')) return false;
        if (current === '\n') { line++; lineStart = index + 1; }
        value += current;
        index++;
      }
      if (!closed) return false;
      tokens.push({ kind: 'string', value, line: startLine, column });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = index++;
      const column = start - lineStart;
      while (index < text.length && /[A-Za-z0-9_]/.test(text[index]!)) index++;
      tokens.push({ kind: 'identifier', value: text.slice(start, index), line, column });
      continue;
    }
    tokens.push({ kind: 'punctuation', value: ch, line, column: index - lineStart });
    index++;
  }

  const list = (items: CodexPrefixPattern): Array<[Token['kind'], string]> => [
    ['punctuation', '['],
    ...items.flatMap((token, index): Array<[Token['kind'], string]> => [
      ...(index ? [['punctuation', ','] as [Token['kind'], string]] : []),
      ...(typeof token === 'string' ? [['string', token] as [Token['kind'], string]] : list(token)),
    ]),
    ['punctuation', ']'],
  ];
  const expected: Array<[Token['kind'], string]> = [
    ['identifier', 'prefix_rule'], ['punctuation', '('], ['identifier', 'pattern'], ['punctuation', '='],
    ...list(pattern), ['punctuation', ','],
    ['identifier', 'decision'], ['punctuation', '='], ['string', 'forbidden'], ['punctuation', ')'],
  ];
  // Accept only a complete canonical call as the entire unindented physical line.
  // This excludes expression wrappers, assignments, suites, and continuation contexts
  // without trying to interpret or execute Starlark.
  const depthBefore = new Map<Token, number>();
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === 'punctuation' && [')', ']', '}'].includes(token.value)) {
      if (depth === 0) return false;
      depth--;
    }
    depthBefore.set(token, depth);
    if (token.kind === 'punctuation' && ['(', '[', '{'].includes(token.value)) depth++;
  }
  if (depth !== 0) return false;
  const lines = new Map<number, Token[]>();
  for (const token of tokens) lines.set(token.line, [...(lines.get(token.line) ?? []), token]);
  return [...lines.values()].some(lineTokens => lineTokens.length === expected.length
    && lineTokens[0]!.column === 0 && !continuedLines.has(lineTokens[0]!.line) && depthBefore.get(lineTokens[0]!) === 0
    && expected.every(([kind, value], index) => lineTokens[index]!.kind === kind && lineTokens[index]!.value === value));
}

function mergeCodexRules(existing: string | undefined): string {
  const desired = compileCodexMergeRule();
  if (!existing) return desired;
  const begin = '# BEGIN advanced-harness managed merge rules';
  const end = '# END advanced-harness managed merge rules';
  const start = existing.indexOf(begin), finish = existing.indexOf(end);
  if (start >= 0 || finish >= 0) {
    if (start < 0 || finish < start || existing.indexOf(begin, start + begin.length) >= 0 || existing.indexOf(end, finish + end.length) >= 0) throw new Error('Malformed or ambiguous managed Codex rules block; resolve it before updating.');
    return existing.slice(0, start) + desired.trimEnd() + existing.slice(finish + end.length);
  }
  return `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${desired}`;
}

function tomlConfigText(existing: string, selectedServerIds: string[], selectedTools: Record<string, string[]>): string {
  let result = appendSettings(existing);
  for (const id of selectedServerIds) {
    if (!validMcpId(id)) throw new Error(`Invalid Codex MCP server ID: ${id}`);
    const document = parseCodexToml(result, 'config.toml');
    const targetTable = document.tables.find(table => table.parts.length === 2 && table.parts[0] === 'mcp_servers' && table.parts[1] === id);
    if (!targetTable) throw new Error(`Selected MCP server "${id}" is not already configured. Supply its real configuration through the host; no endpoint or command was invented.`);
    const { start, end } = targetTable;
    const section = result.slice(start, end);
    const newline = section.includes('\r\n') ? '\r\n' : '\n';
    const enabled = document.entries.find(entry => entry.table.length === 2 && entry.table[0] === 'mcp_servers' && entry.table[1] === id && entry.key.length === 1 && entry.key[0] === 'enabled');
    const edits: Array<{ start: number; end: number; text: string }> = [];
    const additions: string[] = [];
    if (enabled) {
      if (enabled.value === true) edits.push({ start: enabled.valueStart, end: enabled.valueEnd, text: 'false' });
    } else additions.push('enabled = false');
    const tools = selectedTools[id] ?? [];
    if (tools.length) {
      const existingTools = document.entries.find(entry => entry.table.length === 2 && entry.table[0] === 'mcp_servers' && entry.table[1] === id && entry.key.length === 1 && entry.key[0] === 'disabled_tools');
      if (existingTools) {
        if (!Array.isArray(existingTools.value) || existingTools.value.some(value => typeof value !== 'string')) throw new Error(`Unsupported disabled_tools value in Codex MCP server ${id}; refusing to discard existing data.`);
        const oldNames = existingTools.value as string[];
        const merged = [...new Set([...oldNames, ...tools])];
        if (merged.length !== oldNames.length || merged.some((name, index) => name !== oldNames[index])) edits.push({ start: existingTools.valueStart, end: existingTools.valueEnd, text: `[${merged.map(quote).join(', ')}]` });
      } else additions.push(`disabled_tools = [${tools.map(quote).join(', ')}]`);
    }
    if (additions.length) {
      const suffix = /(?:\r?\n[ \t]*)*$/.exec(section)?.[0] ?? '';
      const bodyEnd = start + section.length - suffix.length;
      const body = section.slice(0, section.length - suffix.length);
      const prefix = body && !body.endsWith('\n') ? newline : '';
      edits.push({ start: bodyEnd, end: bodyEnd + suffix.length, text: `${prefix}${additions.join(newline)}${suffix}` });
    }
    for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  validateCodexToml(result, 'updated config.toml');
  return result;
}

export async function installCodex(options: {
  scope: 'project' | 'global'; project?: string | undefined; home: string; recoveryDirectory?: string | undefined;
  agentsDirectory?: string | undefined; commandsDirectory?: string | undefined; ask: Ask; output(message: string): void; error(message: string): void;
  save?: typeof saveInstallation;
  /** Live catalog for the role prompts; omitted means no discovery (wire discoverCodexModels() when the #45 gate lifts). */
  discoverModels?: CodexModelDiscovery | undefined;
  /** role-processes: one `codex exec` process per role with its own profile (#45); global scope only. */
  mode?: 'shared-agents' | 'role-processes' | undefined;
  harnessVersion?: HarnessVersionStamp | undefined;
}): Promise<number> {
  const { scope, project, home, ask, output } = options;
  const roleProcesses = options.mode === 'role-processes';
  if (roleProcesses && scope !== 'global') throw new Error('Codex role processes install at global scope only: role profiles live in ~/.codex. No changes made.');
  const save = options.save ?? saveInstallation;
  const base = scope === 'project' ? join(project ?? '', '.codex') : join(home, '.codex');
  const configPath = join(base, 'config.toml');
  assertSafeFilesystemPath(configPath, 'file');
  const configBefore = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
  const existing = configBefore ?? '';
  validateCodexToml(existing, configPath);
  const backupParent = options.recoveryDirectory ?? join(home, 'Projects', 'advanced-harness-backups');
  const statePath = join(base, '.advanced-harness-state.json');
  assertSafeFilesystemPath(statePath, 'file');
  const stateBefore = existsSync(statePath) ? readFileSync(statePath, 'utf8') : undefined;
  let stateValue: Record<string, unknown> = {};
  if (stateBefore !== undefined) {
    try {
      const parsed: unknown = JSON.parse(stateBefore);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as Record<string, unknown>).host !== 'codex' || !Array.isArray((parsed as Record<string, unknown>).managed)) throw new Error();
      stateValue = parsed as Record<string, unknown>;
    }
    catch { throw new Error(`Malformed Codex harness state manifest: ${statePath}; no changes made.`); }
  }
  const snapshot = discoverReceiptChain(backupParent, statePath, 'codex');
  if (stateBefore !== undefined && !snapshot.head) throw new Error(`Codex state manifest exists without a matching recovery receipt: ${statePath}. Resolve recovery before updating.`);
    const priorFiles = snapshot.head?.receipt.version === 2 ? snapshot.head.receipt.managedFiles ?? [] : [];
  const previousSelected = Array.isArray(stateValue.selectedMcpServers) ? stateValue.selectedMcpServers.filter((id): id is string => typeof id === 'string') : [];
    let selectedAnswer: string;
    try { selectedAnswer = (await ask('Existing Codex MCP server ID(s) to mark disabled pending route validation (comma-separated; - clears tracking)', previousSelected.join(', '))).trim(); }
    catch { throw new Error('Codex installation cancelled because an interactive prompt was rejected or closed; no changes made.'); }
  const selected = selectedAnswer === '-' ? [] : selectedAnswer ? selectedAnswer.split(',').map(x => x.trim()).filter(Boolean) : previousSelected;
  const selectedTools: Record<string, string[]> = {};
  for (const id of selected) {
    if (!validMcpId(id)) throw new Error(`Invalid Codex MCP server ID: ${id}`);
    const priorTools = stateValue.disabledTools && typeof stateValue.disabledTools === 'object' ? (stateValue.disabledTools as Record<string, unknown>)[id] : undefined;
    const defaults = Array.isArray(priorTools) ? priorTools.filter((name): name is string => typeof name === 'string') : [];
    let raw: string;
    try { raw = (await ask(`Exact tool names on ${id} to add to disabled_tools (comma-separated; - clears tracking only)`, defaults.join(', '))).trim(); }
    catch { throw new Error('Codex installation cancelled because an interactive prompt was rejected or closed; no changes made.'); }
    selectedTools[id] = raw === '-' ? [] : raw ? raw.split(',').map(name => name.trim()).filter(Boolean) : defaults;
  }
  let configAfter = tomlConfigText(existing, selected, selectedTools);
  // In-process subagents share Lead's sandbox, so role-process mode turns spawn_agent off for Lead.
  if (roleProcesses) configAfter = disableMultiAgent(configAfter, output);
  let catalog: CodexCatalogModel[] | undefined;
  try { catalog = await chooseCodexCatalog(options.discoverModels, ask, output); }
  catch { throw new Error('Codex installation cancelled because an interactive prompt was rejected or closed; no changes made.'); }
  const definitions = loadRoleDefinitions(options.agentsDirectory ?? fileURLToPath(new URL('../agents/', import.meta.url)));
  const policies = codexRolePolicies(definitions);
  const roleTarget = (role: NativeRole) => roleProcesses ? join(base, `${codexProfileName(role as typeof codexChildRoles[number])}.config.toml`) : join(base, 'agents', `${role}.toml`);
  const roles: readonly NativeRole[] = roleProcesses ? codexChildRoles : nativeRoles;
  const files: PlannedFile[] = [{ path: configPath, content: configAfter, before: configBefore, kind: 'config' }];
  for (const role of roles) {
    const roleFile = roleTarget(role);
    const currentRole = existsSync(roleFile) ? readFileSync(roleFile, 'utf8') : '';
    let roleParsed: CodexTomlDocument;
    let malformedRoleBefore = false;
    try { roleParsed = parseCodexToml(currentRole, roleFile); }
    catch { roleParsed = { tables: [], entries: [] }; malformedRoleBefore = currentRole.length > 0; }
    const roleValue = (key: string) => roleParsed.entries.find(entry => entry.table.length === 0 && entry.key.length === 1 && entry.key[0] === key)?.value;
    if (malformedRoleBefore) output(`Existing Codex agent ${roleFile} uses unsupported TOML; no defaults inferred. Preserve it or explicitly approve overwrite.`);
    const modelRaw = roleValue('model'); const effortRaw = roleValue('model_reasoning_effort');
    const modelSuggestion = typeof modelRaw === 'string' ? modelRaw : '';
    const effortSuggestion = typeof effortRaw === 'string' ? effortRaw : '';
    // An off-catalog answer is kept only on an explicit "keep"; declining counts as an attempt.
    const keepOffCatalog = async (subject: string): Promise<boolean> => {
      try { return (await ask(`${role}: type keep to save ${subject} anyway (Enter chooses again)`, 'no')).trim() === 'keep'; }
      catch { throw new Error(`Codex model prompt for ${role} was rejected or closed; no changes made.`); }
    };
    let model = ''; let modelAttempts = 0;
    while (!model) {
      if (modelAttempts >= 3) throw new Error(`Codex model assignment for ${role} remained invalid after 3 attempts; no changes made.`);
      let answer: string;
      try { answer = (await ask(`${role}: explicitly assigned Codex model ID${catalog ? ' or listed number' : ''} (required)`, modelSuggestion)).trim(); }
      catch { throw new Error(`Codex model prompt for ${role} was rejected or closed; no changes made.`); }
      modelAttempts++;
      const candidate = catalog && /^\d+$/.test(answer) ? catalog[Number(answer) - 1]?.id ?? '' : answer || (modelSuggestion && modelAttempts === 1 ? modelSuggestion : '');
      if (!candidate || candidate === '-' || /[\r\n\0]/.test(candidate)) { output(`Enter a valid explicit model ID for ${role}; no guessed fallback is used.`); continue; }
      if (catalog && !catalog.some(entry => entry.id === candidate)) {
        output(`${candidate} is absent from the live Codex catalog.`);
        if (!(await keepOffCatalog(candidate))) continue;
      }
      model = candidate;
    }
    const efforts = catalog?.find(entry => entry.id === model)?.efforts ?? [];
    let reasoning = ''; let effortAttempts = 0;
    while (!reasoning) {
      if (effortAttempts >= 3) throw new Error(`Codex reasoning effort for ${role} remained invalid after 3 attempts; no changes made.`);
      let answer: string;
      try { answer = (await ask(`${role}: reasoning effort (low, medium, high)`, effortSuggestion)).trim(); }
      catch { throw new Error(`Codex reasoning prompt for ${role} was rejected or closed; no changes made.`); }
      effortAttempts++;
      const candidate = answer || (effortSuggestion && effortAttempts === 1 ? effortSuggestion : '');
      if (!(CODEX_REASONING_EFFORTS as readonly string[]).includes(candidate)) { output(`Enter one of the supported reasoning efforts: ${CODEX_REASONING_EFFORTS.join(', ')}.`); continue; }
      if (efforts.length && !efforts.includes(candidate)) {
        output(`Reasoning effort ${candidate} is not listed for ${model} in the live Codex catalog (listed: ${efforts.join(', ')}).`);
        if (!(await keepOffCatalog(`${model} with effort ${candidate}`))) continue;
      }
      reasoning = candidate;
    }
    const target = roleFile;
    assertSafeFilesystemPath(target, 'file');
    const compiled = roleProcesses
      ? compileCodexRoleProfile(role as typeof codexChildRoles[number], policies[role as typeof codexChildRoles[number]], model, reasoning, definitions[role].instructions)
      : compileCodexAgent(role, model, reasoning, definitions[role].description, definitions[role].instructions);
    files.push({ path: target, content: compiled, before: existsSync(target) ? currentRole : undefined, kind: 'role' });
  }
  const rulesPath = join(base, 'rules', 'advanced-harness.rules');
  assertSafeFilesystemPath(rulesPath, 'file');
  const rulesBefore = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : undefined;
  const rulesContent = mergeCodexRules(rulesBefore);
  files.push({ path: rulesPath, content: rulesContent, before: rulesBefore, kind: 'rules' });
  if (roleProcesses) {
    const launcherPath = join(base, 'advanced-harness', 'codex-role.mjs');
    const schemaPath = join(base, 'advanced-harness', 'role-status.schema.json');
    const leadPath = join(base, 'AGENTS.md');
    for (const path of [launcherPath, schemaPath, leadPath]) assertSafeFilesystemPath(path, 'file');
    const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    files.push({ path: launcherPath, content: codexRoleLauncherSource(), before: read(launcherPath), kind: 'rules' });
    files.push({ path: schemaPath, content: compileCodexRoleStatusSchema(), before: read(schemaPath), kind: 'rules' });
    files.push({ path: leadPath, content: mergeCodexLeadBlock(read(leadPath), compileCodexLeadBlock(policies, launcherPath, definitions.lead.instructions)), before: read(leadPath), kind: 'instructions' });
  }
  const commands = loadWorkflowCommands(options.commandsDirectory ?? fileURLToPath(new URL('../commands/', import.meta.url)));
  for (const id of workflowCommandIds) {
    const target = join(scope === 'project' ? (project ?? '') : home, '.agents', 'skills', id, 'SKILL.md');
    assertSafeFilesystemPath(target, 'file');
    const body = commands[id].body.replace(/\$ARGUMENTS/g, '<current invocation context; if missing, ask before action>').replace(/\$1/g, '<current invocation parent; if missing, ask before action>').replace(/\$2/g, '<current invocation description; if missing, ask before action>');
    const content = `---\nname: ${id}\ndescription: ${encodeCodexYamlScalar(commands[id].description)}\n---\n${body}`;
    const before = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    const previous = priorFiles.find(entry => canonicalPath(entry.path) === canonicalPath(target));
    const isOwnedCurrent = before !== undefined && previous?.after && !('absent' in previous.after) && ('content' in previous.after ? previous.after.content === before : previous.after.digest === digest(before));
    if (before !== undefined && before !== content && !isOwnedCurrent) {
      output(`Preserving existing shared skill owned/customized by another host: ${target}`);
      continue;
    }
    files.push({ path: target, content, before, kind: 'skill' });
  }
  // Existing unowned/custom role files require explicit per-file consent.
  const selectedFiles: PlannedFile[] = [];
  const declinedRolePaths = new Set<string>();
  for (const file of files) {
      assertSafeFilesystemPath(file.path, 'file');
    if (file.before !== undefined && file.before !== file.content && file.kind === 'role') {
      const prior = priorFiles.find(entry => canonicalPath(entry.path) === canonicalPath(file.path));
      const owned = prior?.after && !('absent' in prior.after) && ('content' in prior.after ? prior.after.content === file.before : prior.after.digest === digest(file.before));
      // A file that still matches the receipt is harness-owned and may be refreshed without consent,
      // even when the harness's role definition changed; only user-edited or unowned files ask.
      if (!owned) {
        let overwrite: string;
        try { overwrite = (await ask(`Overwrite customized/unowned Codex agent ${file.path}?`, 'no')).trim(); }
        catch { throw new Error('Codex installation cancelled because an interactive prompt was rejected or closed; no changes made.'); }
        if (!/^(y|yes)$/i.test(overwrite)) { declinedRolePaths.add(file.path); output(`Preserving customized Codex agent: ${file.path}; the model and reasoning effort entered for it were not applied.`); continue; }
      }
    }
    selectedFiles.push(file);
  }
  const omittedRoles = roles.filter(role => {
    const path = roleTarget(role);
    if (selectedFiles.some(file => file.kind === 'role' && file.path === path)) return false;
    if (declinedRolePaths.has(path)) return true; // the requested assignment was not applied
    if (!existsSync(path)) return true;
    try {
      const document = parseCodexToml(readFileSync(path, 'utf8'), path);
      const value = (key: string) => document.entries.find(entry => entry.table.length === 0 && entry.key.length === 1 && entry.key[0] === key)?.value;
      if (roleProcesses) return ['sandbox_mode', 'model', 'developer_instructions'].some(key => typeof value(key) !== 'string' || !value(key)) || !(CODEX_REASONING_EFFORTS as readonly unknown[]).includes(value('model_reasoning_effort'));
      return value('name') !== role || typeof value('description') !== 'string' || !value('description') || typeof value('developer_instructions') !== 'string' || !value('developer_instructions') || typeof value('model') !== 'string' || !value('model') || !(CODEX_REASONING_EFFORTS as readonly unknown[]).includes(value('model_reasoning_effort'));
    } catch { return true; }
  });
  if (omittedRoles.length) output(`Install will remain incomplete because existing role profiles were preserved: ${omittedRoles.join(', ')}.`);
  output(`Codex ${scope} deployment preview (${selectedFiles.length} files):`);
  for (const file of selectedFiles) output(`  ${file.path}: ${file.before === file.content ? 'current' : file.before === undefined ? 'new' : 'update'}`);
  if (roleProcesses) {
    output('Each child role runs as its own codex exec process with its own sandbox, network and MCP settings; Lead (your Codex Desktop session) only launches them, and you approve every launch.');
    output("Lead's session keeps the read-only baseline; in-process subagents (multi_agent) are turned off when not set. Codex runtime and Desktop approval behavior are not verified by this harness.");
  } else output('Shared baseline adds read-only sandbox and on-request approval only when absent. Codex runtime behavior and universal write gating are not verified. MCP selections remain disabled pending validation. Direct gh pr merge rules are not universal indirect/API protection.');
  if ((await ask('Type install to apply these changes', 'cancel')) !== 'install') { output('Cancelled. No files, backups, or receipts were written.'); return 0; }
  for (const file of selectedFiles) {
    if (file.before === file.content) continue;
    assertSafeFilesystemPath(file.path, 'file');
    const latest = existsSync(file.path) ? readFileSync(file.path, 'utf8') : undefined;
    if (latest !== file.before) throw new Error(`File changed while confirmation was open: ${file.path}. Rerun; no file was overwritten.`);
  }
  const changed = selectedFiles.filter(file => file.before !== file.content);
  // Role-process mode tracks config.toml through its recorded edits instead (see CodexConfigEdits).
  const nextEvidence: ManagedFileEvidence[] = changed.filter(file => !(roleProcesses && file.kind === 'config')).map(file => ({ path: file.path, kind: file.kind === 'skill' ? 'skills' as const : file.kind === 'role' ? 'instructions' as const : file.kind as 'config' | 'rules' | 'instructions', before: file.before === undefined ? { absent: true as const } : file.kind === 'config' ? { digest: digest(file.before) } : { content: file.before }, after: file.kind === 'config' ? { digest: digest(file.content) } : { content: file.content } }));
  const combinedEvidence = structuredClone(priorFiles).filter(file => !(roleProcesses && file.kind === 'config' && canonicalPath(file.path) === canonicalPath(configPath)));
  for (const item of nextEvidence) {
    const old = combinedEvidence.find(evidence => canonicalPath(evidence.path) === canonicalPath(item.path));
    if (old) old.after = item.after; else combinedEvidence.push(item);
  }
  const priorEdits = stateValue.configEdits && typeof stateValue.configEdits === 'object' ? stateValue.configEdits as CodexConfigEdits : undefined;
  const configEdits = roleProcesses ? { configEdits: codexConfigEdits(existing, configAfter, priorEdits, configBefore === undefined) } : {};
  const nextState = JSON.stringify({ ...stateValue, host: 'codex', ...(roleProcesses ? { mode: 'role-processes' } : {}), ...configEdits, selectedMcpServers: selected, disabledTools: selectedTools, managed: combinedEvidence.map(item => ({ path: item.path, after: item.after })) }, null, 2) + '\n';
  if (changed.length === 0 && nextState === stateBefore) {
    output(omittedRoles.length
      ? 'Nothing was written: the selected files are already current, but the requested role assignments were not applied because existing role profiles were preserved.'
      : 'Codex configuration is already current; no files, backups, or receipts written.');
    return omittedRoles.length ? 1 : 0;
  }
  const receipt = createSuccessorReceipt(snapshot, stateBefore, nextState, {}, options.harnessVersion, { host: 'codex', managedFiles: combinedEvidence });
  const pending = writePendingSuccessor(snapshot, receipt);
  const backups: string[] = [];
  const backupSet = new Set<string>();
  let completed = false;
  const attempted: PlannedFile[] = [];
  let stateAttempted = false;
  const createdDirectories: string[] = [];
  const madeBackups = new Map<string, string>();
  // Sticky for the whole transaction: once any save cannot attribute its backup or directories,
  // rollback must keep recovery evidence instead of guessing what to delete.
  let ownershipUnknown = false;
  const recordBackup = (path: string, contents: string) => {
    madeBackups.set(path, contents);
    if (!backupSet.has(path)) { backups.push(path); backupSet.add(path); }
  };
  const saveTracked = (path: string, before: string | undefined, content: string) => {
    let callbackSawBackup = false;
    let callbackSawDirectory = false;
    try {
      const returnedBackup = save(path, before, content, backupParent,
        (backup, contents) => { callbackSawBackup = true; recordBackup(backup, contents); },
        directory => { callbackSawDirectory = true; createdDirectories.push(directory); });
      if (returnedBackup) {
        if (before === undefined) throw new Error(`Saver returned a backup for a previously absent target: ${returnedBackup}`);
        if (!callbackSawBackup) {
          // Matching contents do not prove this transaction created the file: report it, never delete it.
          if (!backupSet.has(returnedBackup)) { backups.push(returnedBackup); backupSet.add(returnedBackup); }
          ownershipUnknown = true;
        } else if (!callbackSawDirectory) ownershipUnknown = true;
      } else if (before !== undefined && !callbackSawBackup) ownershipUnknown = true;
    } catch (error) {
      if (before !== undefined && !callbackSawBackup) ownershipUnknown = true;
      throw error;
    }
  };
  const mkdirTracked = (directory: string) => {
    const missing: string[] = []; let cursor = resolve(directory); const root = pathParse(cursor).root;
    while (cursor !== root && !existsSync(cursor)) { missing.push(cursor); cursor = dirname(cursor); }
    for (const path of missing.reverse()) {
      try { mkdirSync(path); createdDirectories.push(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) throw error; }
    }
  };
  try {
    revalidatePendingSuccessor(pending);
    for (const file of changed) {
      assertSafeFilesystemPath(file.path, 'file');
      if ((existsSync(file.path) ? readFileSync(file.path, 'utf8') : undefined) !== file.before) throw new Error(`Codex target changed during install: ${file.path}`);
    }
    for (const file of changed) {
      mkdirTracked(dirname(file.path));
      attempted.push(file);
      let saveError: unknown;
      try { saveTracked(file.path, file.before, file.content); }
      catch (error) { saveError = error; }
      if (saveError !== undefined) throw saveError;
    }
    stateAttempted = true;
    let stateSaveError: unknown;
    try {
      saveTracked(statePath, stateBefore, nextState);
    } catch (error) { stateSaveError = error; }
    if (stateSaveError !== undefined) throw stateSaveError;
    finalizeSuccessor(pending, nextState);
    completed = true;
  } catch (error) {
    const restore = (path: string, before: string | undefined, expected: string): boolean => {
      try {
        assertSafeFilesystemPath(path, 'file');
        const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
        if (current === before) return true;
        if (current !== expected) return false;
        if (before === undefined) { unlinkSync(path); return true; }
        writeFileSync(path, before, 'utf8');
        return readFileSync(path, 'utf8') === before;
      } catch { return false; }
    };
    let restored = true;
    if (stateAttempted) {
      try {
        const current = existsSync(statePath) ? readFileSync(statePath, 'utf8') : undefined;
        if (current !== stateBefore) restored = restore(statePath, stateBefore, nextState) && restored;
      } catch { restored = false; }
    }
    for (const file of [...attempted].reverse()) restored = restore(file.path, file.before, file.content) && restored;
    if (restored) {
      let cleanupFailed = ownershipUnknown;
      const cleanupBackupDirectories = new Set<string>();
      for (const [backup, expectedBackup] of [...madeBackups].sort(([a], [b]) => b.length - a.length)) try {
        assertSafeFilesystemPath(backup, 'file');
        const info = lstatSync(backup);
        if (!info.isFile() || info.isSymbolicLink() || readFileSync(backup, 'utf8') !== expectedBackup) throw new Error('Backup is not an unchanged transaction-created regular file');
        unlinkSync(backup);
        for (let directory = dirname(backup); directory !== resolve(backupParent) && directory.startsWith(resolve(backupParent) + (process.platform === 'win32' ? '\\' : '/')); directory = dirname(directory)) cleanupBackupDirectories.add(directory);
      } catch { cleanupFailed = true; options.error(`Rollback cleanup could not remove attributable backup: ${backup}`); }
      for (const directory of [...cleanupBackupDirectories].sort((a, b) => b.length - a.length)) try { rmdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') { cleanupFailed = true; options.error(`Rollback cleanup could not remove attributable empty backup directory: ${directory}`); } }
      for (const directory of [...new Set(createdDirectories)].sort((a, b) => b.length - a.length)) try { rmdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { cleanupFailed = true; options.error(`Rollback cleanup could not remove transaction-created empty directory: ${directory}`); } }
      if (!cleanupFailed) try { recoverFailedSuccessor(pending, stateBefore); }
      catch (cleanupError) { cleanupFailed = true; options.error(`Codex rollback verified, but pending recovery evidence could not be removed: ${pending.path}; ${String(cleanupError)}`); }
      if (cleanupFailed) options.error(`Codex file restoration succeeded but backup ownership or rollback cleanup was incomplete; preserve and review recovery evidence at ${pending.path}.`);
    } else {
      options.error(`Codex rollback was incomplete or encountered divergent content; pending recovery evidence retained at ${pending.path}. Review affected files and backups: ${backups.join(', ') || [...madeBackups.keys()].join(', ') || '(none)'}.`);
    }
    throw error;
  }
  output(`Codex artifacts written with cumulative receipt ${pending.path}. Backups: ${backups.length}.`);
  if (!completed) throw new Error('Codex install did not finalize its receipt.');
  output('Inspect Codex Desktop on Windows/macOS and run harness:doctor for static checks. Runtime/approval behavior remains unverified.');
  return omittedRoles.length ? 1 : 0;
}

function diagnoseCodexRoleProcesses(root: string, config: CodexTomlDocument): string[] {
  const issues: string[] = [];
  const multiAgent = config.entries.find(item => (item.table.length === 1 && item.table[0] === 'features' && item.key.length === 1 && item.key[0] === 'multi_agent')
    || (item.table.length === 0 && item.key.length === 2 && item.key[0] === 'features' && item.key[1] === 'multi_agent'));
  if (multiAgent?.value !== false) issues.push(`Codex features.multi_agent is not false in ${join(root, 'config.toml')}; Lead could spawn in-process subagents that share its sandbox.`);
  const definitions = loadRoleDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));
  const policies = codexRolePolicies(definitions);
  for (const role of codexChildRoles) {
    const path = join(root, `${codexProfileName(role)}.config.toml`);
    if (!existsSync(path)) { issues.push(`Missing Codex role profile: ${path}`); continue; }
    try {
      assertSafeFilesystemPath(path, 'file');
      const text = readFileSync(path, 'utf8'); validateCodexToml(text, path);
      const document = parseCodexToml(text, path);
      const value = (table: string[], key: string) => document.entries.find(entry => entry.table.join('.') === table.join('.') && entry.key.length === 1 && entry.key[0] === key)?.value;
      const policy = policies[role];
      if (value([], 'sandbox_mode') !== policy.sandbox) issues.push(`Codex role ${role} sandbox_mode is not ${policy.sandbox}: ${path}`);
      if (value([], 'approval_policy') !== 'never') issues.push(`Codex role ${role} approval_policy is not never (children cannot prompt): ${path}`);
      if (value(['sandbox_workspace_write'], 'network_access') !== policy.network) issues.push(`Codex role ${role} network_access is not ${policy.network}: ${path}`);
      if (/^# advanced-harness: mcp=allowed\r?$/m.test(text) !== policy.mcp) issues.push(`Codex role ${role} MCP marker does not match its source policy: ${path}`);
      for (const key of ['model', 'developer_instructions']) if (typeof value([], key) !== 'string' || !value([], key)) issues.push(`Codex role ${role} lacks required explicit ${key}: ${path}`);
      if (!(CODEX_REASONING_EFFORTS as readonly unknown[]).includes(value([], 'model_reasoning_effort'))) issues.push(`Codex role ${role} has unsupported model_reasoning_effort: ${path}`);
    } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
  }
  const launcher = join(root, 'advanced-harness', 'codex-role.mjs');
  if (!existsSync(launcher)) issues.push(`Missing Codex role launcher: ${launcher}`);
  else if (readFileSync(launcher, 'utf8') !== codexRoleLauncherSource()) issues.push(`Codex role launcher differs from this harness version; rerun update: ${launcher}`);
  const schema = join(root, 'advanced-harness', 'role-status.schema.json');
  if (!existsSync(schema)) issues.push(`Missing Codex role status schema: ${schema}`);
  else if (readFileSync(schema, 'utf8') !== compileCodexRoleStatusSchema()) issues.push(`Codex role status schema differs from this harness version; rerun update: ${schema}`);
  // Report drift only: AGENTS.md also holds user content, so doctor never rewrites it.
  const lead = join(root, 'AGENTS.md');
  const extracted = extractCodexLeadBlock(existsSync(lead) ? readFileSync(lead, 'utf8') : '');
  if ('problem' in extracted) issues.push(`Codex Lead block in ${lead} ${extracted.problem}; rerun update.`);
  else if (extracted.block !== compileCodexLeadBlock(policies, launcher, definitions.lead.instructions).trim()) issues.push(`Codex Lead block in ${lead} is empty, edited, or from another harness version; rerun update.`);
  return issues;
}

/**
 * The Codex part of uninstall that the receipt does not cover: config.toml (recorded as edits, since the
 * file can hold MCP credentials) and the state manifest. Used as the generic flow's host step, so it is
 * previewed before confirmation and applied only after every receipt-managed file was restored.
 */
/** A role thread binding the launcher writes: a file named by a thread ID that holds one child role's name. */
const codexThreadIdPattern = /^[A-Za-z0-9-]{1,128}$/;

/**
 * Plans the Codex host step of uninstall. `remove` deletes one file; tests replace it to inject failures.
 * Writes run in retry-safe order: thread bindings, then config.toml, and the state manifest last, so a
 * failure leaves the manifest in place and uninstall can be run again.
 */
export function planCodexUninstall(statePath: string, backupParent: string, remove: (path: string) => void = unlinkSync): { actions: string[]; kept: string[]; apply(): string[] } {
  if (!existsSync(statePath)) throw new Error(`Codex state manifest is missing: ${statePath}; uninstall cannot identify the harness configuration edits.`);
  const stateText = readFileSync(statePath, 'utf8');
  let state: { mode?: unknown; configEdits?: CodexConfigEdits };
  try { state = JSON.parse(stateText) as typeof state; } catch { throw new Error(`Malformed Codex state manifest: ${statePath}; no changes made.`); }
  if (state.mode !== 'role-processes' || !state.configEdits) throw new Error('This Codex install has no recorded configuration edits (it predates role-process mode); uninstall is not supported for it. No changes made.');
  const edits = state.configEdits;
  const configPath = join(dirname(statePath), 'config.toml');
  assertSafeFilesystemPath(configPath, 'file');
  const configBefore = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
  const reversed = configBefore === undefined ? undefined : reverseCodexConfigEdits(configBefore, edits);
  const removeConfig = reversed !== undefined && edits.configCreated && !reversed.text.trim();
  // The launcher's thread-to-role bindings are runtime state outside the receipt. Only entries that are
  // bindings by name and content are removed; anything else is kept and reported, never assumed ours.
  const threadsPath = join(dirname(statePath), 'advanced-harness', 'role-threads');
  const bindings: Array<{ path: string; content: string }> = [], unexpected: string[] = [];
  if (existsSync(threadsPath)) {
    if (!lstatSync(threadsPath).isDirectory()) unexpected.push(threadsPath);
    else for (const name of readdirSync(threadsPath)) {
      const path = join(threadsPath, name);
      const content = lstatSync(path).isFile() ? readFileSync(path, 'utf8') : undefined;
      if (content !== undefined && codexThreadIdPattern.test(name) && (codexChildRoles as readonly string[]).includes(content.trim())) bindings.push({ path, content });
      else unexpected.push(path);
    }
  }
  const actions = [
    ...(bindings.length ? [`remove ${bindings.length} role thread binding file(s) in ${threadsPath}`] : []),
    ...unexpected.map(path => `keep ${path} (not a role thread binding; review by hand)`),
    reversed === undefined ? `${configPath}: absent, nothing to reverse`
      : removeConfig ? `remove ${configPath} (created by the harness, nothing else in it)`
      : reversed.text === configBefore ? `${configPath}: no harness edits left to reverse`
      : `reverse harness edits in ${configPath}${reversed.kept.length ? ` (keeping changed: ${reversed.kept.join(', ')})` : ''}`,
    `remove ${statePath}`,
  ];
  return {
    actions,
    kept: reversed?.kept ?? [],
    apply() {
      // Everything reviewed is re-checked before the first write.
      const latest = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
      if (latest !== configBefore) throw new Error(`${configPath} changed after review; nothing was changed by the Codex step`);
      if (readFileSync(statePath, 'utf8') !== stateText) throw new Error(`${statePath} changed after review; nothing was changed by the Codex step`);
      for (const binding of bindings) {
        if (existsSync(binding.path) && (!lstatSync(binding.path).isFile() || readFileSync(binding.path, 'utf8') !== binding.content)) {
          throw new Error(`${binding.path} changed after review; nothing was changed by the Codex step`);
        }
      }
      const lines: string[] = [];
      const backupDir = join(backupParent, `${new Date().toISOString().replaceAll(':', '-')}-codex-uninstall-${digest(statePath).slice(0, 8)}`);
      const backup = (path: string, content: string, folder = backupDir) => {
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const target = join(folder, basename(path));
        writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
        return target;
      };
      let removed = 0;
      try {
        if (bindings.length) {
          const threadBackup = join(backupDir, 'role-threads');
          lines.push(`Private backup of role thread bindings: ${threadBackup}`);
          for (const binding of bindings) {
            if (!existsSync(binding.path)) continue;
            backup(binding.path, binding.content, threadBackup);
            remove(binding.path);
            removed++;
          }
          lines.push(`Removed ${removed} role thread binding file(s) from ${threadsPath}`);
        }
        if (configBefore !== undefined && reversed && reversed.text !== configBefore) {
          lines.push(`Private backup: ${backup(configPath, configBefore)}`);
          if (removeConfig) { remove(configPath); lines.push(`Removed ${configPath}`); }
          else { writeFileSync(configPath, reversed.text, 'utf8'); lines.push(`Reversed harness edits in ${configPath}`); }
        }
        // Last: while the manifest exists, a failed run can simply be retried.
        lines.push(`Private backup: ${backup(statePath, stateText)}`);
        remove(statePath);
        lines.push(`Removed ${statePath}`);
      } catch (error) {
        if (bindings.length && !lines.some(line => line.startsWith('Removed ') && line.includes('role thread binding'))) {
          lines.push(`Removed ${removed} of ${bindings.length} role thread binding file(s) from ${threadsPath}`);
        }
        const kept = existsSync(statePath) ? `${statePath} is kept, so uninstall can be run again` : `${statePath} was already removed`;
        throw new Error(`Codex step failed: ${error instanceof Error ? error.message : String(error)}. Completed before the failure: ${lines.join('; ') || 'nothing'}. ${kept}.`);
      }
      for (const path of unexpected) lines.push(`Kept ${path}: not a role thread binding; review by hand`);
      // Managed-file pruning ran first and kept these directories because the bindings were still in them.
      if (!unexpected.length && bindings.length) {
        for (const dir of [threadsPath, dirname(threadsPath)]) {
          try { rmdirSync(dir); lines.push(`Removed empty installer directory: ${dir}`); } catch { break; /* not empty: left in place */ }
        }
      }
      return lines;
    },
  };
}

export function codexConfigPath(scope: 'project' | 'global', project: string | undefined, home: string): string {
  return resolve(scope === 'project' ? join(project ?? '', '.codex', 'config.toml') : join(home, '.codex', 'config.toml'));
}

export async function diagnoseCodex(options: { project?: string | undefined; home: string; globalDirectory?: string | undefined; scope?: 'global' | 'project' | undefined }): Promise<{ ok: boolean; issues: string[]; notes: string[] }> {
  const roots = [
    ...(options.project && options.scope !== 'global' ? [join(options.project, '.codex')] : []),
    ...(options.scope !== 'project' ? [options.globalDirectory ?? join(options.home, '.codex')] : []),
  ];
  const issues: string[] = [], notes: string[] = [];
  let found = false;
  for (const root of [...new Set(roots.map(path => resolve(path)))]) {
    const config = join(root, 'config.toml');
      if (!existsSync(config)) continue;
      found = true;
    let configText: string;
    try { assertSafeFilesystemPath(config, 'file'); configText = readFileSync(config, 'utf8'); validateCodexToml(configText, config); }
    catch (error) { issues.push(error instanceof Error ? error.message : String(error)); continue; }
    const configDocument = parseCodexToml(configText, config);
    const rootValue = (key: string) => configDocument.entries.find(entry => entry.table.length === 0 && entry.key.length === 1 && entry.key[0] === key)?.value;
    const sandbox = rootValue('sandbox_mode'); const approval = rootValue('approval_policy');
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(String(sandbox))) issues.push(`Codex shared sandbox_mode is missing or unsupported: ${config}`);
    if (!['on-request', 'never', 'granular'].includes(String(approval)) && !(approval && typeof approval === 'object')) issues.push(`Codex shared approval_policy is missing or unsupported: ${config}`);
    const statePathForMode = join(root, '.advanced-harness-state.json');
    let roleProcesses = false;
    try { roleProcesses = existsSync(statePathForMode) && (JSON.parse(readFileSync(statePathForMode, 'utf8')) as { mode?: unknown }).mode === 'role-processes'; } catch { /* reported below */ }
    if (roleProcesses) {
      issues.push(...diagnoseCodexRoleProcesses(root, configDocument));
      notes.push('Role-process mode: each child role runs as its own codex exec process; Lead launches them with your approval.');
    }
    for (const role of roleProcesses ? [] : nativeRoles) {
      const path = join(root, 'agents', `${role}.toml`);
      if (!existsSync(path)) { issues.push(`Missing Codex agent definition: ${path}`); continue; }
      try {
        assertSafeFilesystemPath(path, 'file');
        const text = readFileSync(path, 'utf8'); validateCodexToml(text, path);
        const roleDocument = parseCodexToml(text, path);
        const stringValue = (key: string) => roleDocument.entries.find(entry => entry.table.length === 0 && entry.key.length === 1 && entry.key[0] === key)?.value;
        for (const key of ['name', 'description', 'developer_instructions', 'model', 'model_reasoning_effort']) if (!stringValue(key)) issues.push(`Codex agent ${role} lacks required explicit ${key}: ${path}`);
        if (stringValue('name') !== role) issues.push(`Codex agent name does not match expected role ${role}: ${path}`);
        if (!(CODEX_REASONING_EFFORTS as readonly unknown[]).includes(stringValue('model_reasoning_effort') ?? '')) issues.push(`Codex agent ${role} has unsupported model_reasoning_effort: ${path}`);
      } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
    }
    const skillsDir = join(dirname(root), '.agents', 'skills');
    for (const id of workflowCommandIds) {
      const skill = join(skillsDir, id, 'SKILL.md');
      if (!existsSync(skill)) { issues.push(`Missing shared Codex workflow skill: ${skill}`); continue; }
      assertSafeFilesystemPath(skill, 'file');
      const skillText = readFileSync(skill, 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skillText)?.[1] ?? '';
      if (!new RegExp(`^name:\\s*${id}\\s*$`, 'm').test(frontmatter) || !/^description:\s*\S/m.test(frontmatter)) issues.push(`Malformed Codex workflow skill metadata: ${skill}`);
    }
    const statePath = join(root, '.advanced-harness-state.json');
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as { selectedMcpServers?: unknown; disabledTools?: Record<string, unknown> };
        if (!state || typeof state !== 'object' || !Array.isArray(state.selectedMcpServers)) { issues.push(`Invalid Codex harness state manifest: ${statePath}`); }
        if (Array.isArray(state.selectedMcpServers)) for (const id of state.selectedMcpServers) {
          if (typeof id !== 'string' || !validMcpId(id)) { issues.push(`Invalid MCP identity in Codex state manifest: ${statePath}`); continue; }
          const table = configDocument.tables.find(item => item.parts.length === 2 && item.parts[0] === 'mcp_servers' && item.parts[1] === id);
          const enabled = configDocument.entries.find(item => item.table.length === 2 && item.table[0] === 'mcp_servers' && item.table[1] === id && item.key.length === 1 && item.key[0] === 'enabled');
           if (!table || enabled?.value !== false) issues.push(`Selected Codex MCP server ${id} is not disabled pending validation.`);
          const expectedTools = state.disabledTools?.[id];
          if (Array.isArray(expectedTools)) {
              const tools = configDocument.entries.find(item => item.table.length === 2 && item.table[0] === 'mcp_servers' && item.table[1] === id && item.key.length === 1 && item.key[0] === 'disabled_tools');
              const actual = Array.isArray(tools?.value) ? tools.value : [];
            for (const tool of expectedTools) if (typeof tool !== 'string' || !actual.includes(tool)) issues.push(`Selected Codex MCP tool for ${id} is not disabled: ${String(tool)}`);
          }
        }
      } catch { issues.push(`Malformed Codex harness state manifest: ${statePath}`); }
    }
    const rules = join(root, 'rules', 'advanced-harness.rules');
    if (!existsSync(rules)) issues.push(`Missing Codex direct merge rule: ${rules}`);
    else {
      assertSafeFilesystemPath(rules, 'file');
      const rulesText = readFileSync(rules, 'utf8');
      if (!codexMergePrefixes.every(pattern => hasActiveCodexPrefixRule(rulesText, pattern))) issues.push(`Codex direct gh pr merge rules are missing or malformed: ${rules}`);
      const missingGit = codexDestructiveGitPrefixes.filter(pattern => !hasActiveCodexPrefixRule(rulesText, pattern));
      if (missingGit.length) issues.push(`Codex destructive Git rules are missing or malformed (${missingGit.map(codexPatternLabel).join(', ')}): ${rules}`);
    }
  }
  if (!found) issues.push('Codex configuration is not installed in inspected project/global scope.');
  notes.push('Static TOML/artifact checks only. Codex Desktop load, model availability, MCP connectivity, and approval behavior are not runtime-verified.');
  notes.push('Shared permission settings are inherited; role files cannot override parent sandbox/approval/MCP settings.');
  notes.push('Direct gh pr merge and destructive Git prefix rules do not block indirect scripts, API routes, or force flags placed after the remote.');
  return { ok: issues.length === 0, issues, notes };
}
