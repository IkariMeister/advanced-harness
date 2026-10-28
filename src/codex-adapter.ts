import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertSafeFilesystemPath } from './installation-receipt.ts';
import { saveInstallation, type Ask } from './native-installer.ts';
import { nativeRoles, type NativeRole } from './native-role-types.ts';
import { loadRoleDefinitions } from './role-definitions.ts';
import { loadWorkflowCommands, workflowCommandIds } from './workflow-commands.ts';
import { createSuccessorReceipt, discoverReceiptChain, finalizeSuccessor, recoverFailedSuccessor, revalidatePendingSuccessor, writePendingSuccessor, type ManagedFileEvidence } from './receipt-lineage.ts';

type PlannedFile = { path: string; content: string; before: string | undefined; kind: string };
const quote = (text: string): string => JSON.stringify(text);
const roleId = (value: string): boolean => /^[a-z][a-z0-9_-]{0,63}$/.test(value);
const validMcpId = (value: string): boolean => value.length > 0 && !/[\r\n\0]/.test(value);
export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const canonicalPath = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
export const encodeCodexYamlScalar = (value: string): string => JSON.stringify(value);

type CodexTomlTable = { path: string; parts: string[]; start: number; end: number };
type CodexTomlDocument = { tables: CodexTomlTable[] };

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
  while (i < text.length) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    let value: string;
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i++]!; const start = i;
      while (i < text.length && text[i] !== q) { if (q === '"' && text[i] === '\\') i++; i++; }
      if (i >= text.length) return undefined;
      const raw = text.slice(start, i++);
      try { value = q === '"' ? JSON.parse(`"${raw}"`) as string : raw; } catch { return undefined; }
    } else {
      const start = i; while (/[A-Za-z0-9_-]/.test(text[i] ?? '')) i++;
      if (i === start) return undefined; value = text.slice(start, i);
    }
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) return undefined; parts.push(value);
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (i === text.length) break;
    if (text[i++] !== '.') return undefined;
  }
  return parts.length ? parts : undefined;
}

function hasValuePathConflict(paths: Iterable<string>, candidate: string): boolean {
  const decode = (path: string): string[] => { try { const value: unknown = JSON.parse(path); return Array.isArray(value) ? value as string[] : path.split('.'); } catch { return path.split('.'); } };
  const wanted = decode(candidate);
  for (const path of paths) {
    const existing = decode(path);
    const common = Math.min(existing.length, wanted.length);
    if (common > 0 && existing.slice(0, common).every((part, index) => part === wanted[index])) return true;
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

function parseTomlValue(source: string, initial: number, path: string, lineNumber: number): number {
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
      if (source[index] === quoteChar) return index + 1;
      if (code < 0x20 && source[index] !== '\t') return fail();
      index++;
    }
    return fail();
  }
  if (ch === '[') {
    index++;
    index = spaces(index);
    if (source[index] === ']') return index + 1;
    while (index < source.length) {
      index = parseTomlValue(source, index, path, lineNumber);
      index = spaces(index);
      if (source[index] === ']') return index + 1;
      if (source[index] !== ',') return fail();
      index = spaces(index + 1);
      if (source[index] === ']') return index + 1; // TOML arrays permit a trailing comma.
    }
    return fail();
  }
  if (ch === '{') {
    index = spaces(index + 1);
    const seen = new Set<string>();
    if (source[index] === '}') return index + 1;
    while (index < source.length) {
      const start = index;
      let keyQuote = '';
      let keyEscape = false;
      while (index < source.length) {
        const current = source[index]!;
        if (keyQuote === '"') {
          if (keyEscape) keyEscape = false;
          else if (current === '\\') keyEscape = true;
          else if (current === '"') keyQuote = '';
        } else if (keyQuote === "'") {
          if (current === "'") keyQuote = '';
        } else if (current === '"' || current === "'") keyQuote = current;
        else if (current === '=' || current === ',' || current === '}') break;
        index++;
      }
      const parts = keyParts(source.slice(start, index));
      if (!parts) return fail();
      const key = JSON.stringify(parts);
      if (hasValuePathConflict(seen, key)) return fail();
      seen.add(key);
      index = spaces(index);
      if (source[index] !== '=') return fail();
      index = parseTomlValue(source, index + 1, path, lineNumber);
      index = spaces(index);
      if (source[index] === '}') return index + 1;
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
  if (bare === 'true' || bare === 'false' || integer.test(bare) || based.test(bare) || float.test(bare) || /^[+-]?(?:inf|nan)$/.test(bare)) return index;
  return fail();
}

/** Parse the supported TOML subset structurally and refuse ambiguity before any prompt or write. */
function parseCodexToml(text: string, path: string): CodexTomlDocument {
  const explicitTables = new Set<string>();
  const values = new Set<string>();
  const tables: CodexTomlTable[] = [];
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
      if (hasDescendantPath(explicitTables, tablePath)) throw new Error(`Duplicate or out-of-order TOML table in ${path} at line ${actualLine}.`);
      if (hasValuePathConflict(values, tablePath)) throw new Error(`TOML scalar/table collision in ${path} at line ${actualLine}.`);
      if (tables.length) tables[tables.length - 1]!.end = offset;
      explicitTables.add(tablePath);
      currentTable = parts;
      tables.push({ path: parts.join('.'), parts, start: offset, end: text.length });
      offset += rawLine.length;
      continue;
    }
    if (content.startsWith('[')) throw new Error(`Unsupported or malformed TOML table in ${path} at line ${actualLine}; refusing to edit it.`);
    const assignment = /^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-])(?:[^=]*?))\s*=(.*)$/.exec(content);
    if (!assignment) throw new Error(`Unsupported or malformed TOML assignment in ${path} at line ${actualLine}; refusing to edit it.`);
    const parts = keyParts(assignment[1]!);
    if (!parts) throw new Error(`Unsupported TOML key in ${path} at line ${actualLine}; refusing to edit it.`);
    const fullKey = JSON.stringify([...currentTable, ...parts]);
    if (hasValuePathConflict(values, fullKey) || hasDescendantPath(explicitTables, fullKey)) throw new Error(`Duplicate TOML key or scalar/table collision in ${path} at line ${actualLine}.`);
    const valueStart = content.indexOf('=') + 1;
    const valueEnd = parseTomlValue(content, valueStart, path, actualLine);
    if (content.slice(valueEnd).trim()) throw new Error(`Trailing or malformed TOML value in ${path} at line ${actualLine}; refusing to edit it.`);
    values.add(fullKey);
    offset += rawLine.length;
  }
  return { tables };
}

export function validateCodexToml(text: string, path = 'Codex TOML'): void {
  parseCodexToml(text, path);
}

function appendSettings(existing: string | undefined): string {
  const text = existing ?? '';
  validateCodexToml(text, 'config.toml');
  const rootHas = (key: string) => {
    let inTable = false;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (/^\[/.test(trimmed)) { inTable = true; continue; }
      if (!inTable) {
        const assignment = /^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-])(?:[^=]*?))\s*=/.exec(trimmed);
        const parts = assignment && keyParts(assignment[1]!);
        if (parts?.length === 1 && parts[0] === key) return true;
      }
    }
    return false;
  };
  const blocks: string[] = [];
  if (!rootHas('sandbox_mode')) blocks.push('sandbox_mode = "read-only"');
  if (!rootHas('approval_policy')) blocks.push('approval_policy = "on-request"');
  if (!blocks.length) return text;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const separator = (prefix: string) => !prefix ? '' : prefix.endsWith(`${newline}${newline}`) ? '' : prefix.endsWith(newline) ? newline : `${newline}${newline}`;
  const firstTable = parseCodexToml(text, 'config.toml').tables[0]?.start;
  if (firstTable !== undefined) {
    const prefix = text.slice(0, firstTable);
    return `${prefix}${separator(prefix)}${blocks.join(`${newline}${newline}`)}${newline}${newline}${text.slice(firstTable)}`;
  }
  return `${text}${separator(text)}${blocks.join(`${newline}${newline}`)}${newline}`;
}

export function compileCodexAgent(role: NativeRole, model: string, reasoning: string, description: string, instructions: string): string {
  if (!roleId(role) || !model.trim() || !(CODEX_REASONING_EFFORTS as readonly string[]).includes(reasoning)) throw new Error(`Invalid Codex agent assignment: ${role}`);
  return `name = ${quote(role)}\ndescription = ${quote(description)}\ndeveloper_instructions = ${quote(instructions)}\nmodel = ${quote(model.trim())}\nmodel_reasoning_effort = ${quote(reasoning)}\n`;
}

export function compileCodexMergeRule(): string {
  return '# BEGIN advanced-harness managed merge rules\n# Denies identifiable direct CLI forms only; indirect/API routes are not blocked.\nprefix_rule(pattern = ["gh", "pr", "merge"], decision = "forbidden")\nprefix_rule(pattern = ["gh.exe", "pr", "merge"], decision = "forbidden")\n# END advanced-harness managed merge rules\n';
}

function hasActiveCodexMergeRule(text: string, executable: 'gh' | 'gh.exe'): boolean {
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

  const expected: Array<[Token['kind'], string]> = [
    ['identifier', 'prefix_rule'], ['punctuation', '('], ['identifier', 'pattern'], ['punctuation', '='],
    ['punctuation', '['], ['string', executable], ['punctuation', ','], ['string', 'pr'],
    ['punctuation', ','], ['string', 'merge'], ['punctuation', ']'], ['punctuation', ','],
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
    const targetTable = parseCodexToml(result, 'config.toml').tables.find(table => table.parts.length === 2 && table.parts[0] === 'mcp_servers' && table.parts[1] === id);
    if (!targetTable) throw new Error(`Selected MCP server "${id}" is not already configured. Supply its real configuration through the host; no endpoint or command was invented.`);
    const { start, end } = targetTable;
    const section = result.slice(start, end);
    const newline = section.includes('\r\n') ? '\r\n' : '\n';
    const appendLine = (text: string, assignment: string) => {
      const suffix = /(?:\r?\n[ \t]*)*$/.exec(text)?.[0] ?? '';
      const body = text.slice(0, text.length - suffix.length);
      return `${body}${body && !body.endsWith('\n') ? newline : ''}${assignment}${newline}${suffix}`;
    };
    const enabled = /^\s*(?:enabled|"enabled"|'enabled')\s*=\s*(true|false)\b/im.exec(section);
    let updatedSection = enabled
      ? enabled[1]!.toLowerCase() === 'true'
        ? `${section.slice(0, enabled.index + enabled[0].lastIndexOf(enabled[1]!))}false${section.slice(enabled.index + enabled[0].lastIndexOf(enabled[1]!) + enabled[1]!.length)}`
        : section
      : appendLine(section, 'enabled = false');
    const tools = selectedTools[id] ?? [];
    if (tools.length) {
      const encoded = `disabled_tools = [${tools.map(quote).join(', ')}]`;
      const existingTools = /^[ \t]*(?:disabled_tools|"disabled_tools"|'disabled_tools')\s*=\s*\[([^\]]*)\]/m.exec(updatedSection);
      if (existingTools) {
        const remainder = existingTools[1]!.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/[\s,]/g, '');
        if (remainder) throw new Error(`Unsupported disabled_tools value in Codex MCP server ${id}; refusing to discard existing data.`);
        const oldNames = [...existingTools[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse(`"${m[1]}"`) as string);
        const merged = [...new Set([...oldNames, ...tools])];
        updatedSection = updatedSection.replace(existingTools[0], `disabled_tools = [${merged.map(quote).join(', ')}]`);
      } else updatedSection = appendLine(updatedSection, encoded);
    }
    result = result.slice(0, start) + updatedSection + result.slice(end);
  }
  validateCodexToml(result, 'updated config.toml');
  return result;
}

export async function installCodex(options: {
  scope: 'project' | 'global'; project?: string | undefined; home: string; recoveryDirectory?: string | undefined;
  agentsDirectory?: string | undefined; commandsDirectory?: string | undefined; ask: Ask; output(message: string): void; error(message: string): void;
  save?: typeof saveInstallation;
}): Promise<number> {
  const { scope, project, home, ask, output } = options;
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
  const selectedAnswer = (await ask('Existing Codex MCP server ID(s) to mark disabled pending route validation (comma-separated; - clears tracking)', previousSelected.join(', '))).trim();
  const selected = selectedAnswer === '-' ? [] : selectedAnswer ? selectedAnswer.split(',').map(x => x.trim()).filter(Boolean) : previousSelected;
  const selectedTools: Record<string, string[]> = {};
  for (const id of selected) {
    if (!validMcpId(id)) throw new Error(`Invalid Codex MCP server ID: ${id}`);
    const priorTools = stateValue.disabledTools && typeof stateValue.disabledTools === 'object' ? (stateValue.disabledTools as Record<string, unknown>)[id] : undefined;
    const defaults = Array.isArray(priorTools) ? priorTools.filter((name): name is string => typeof name === 'string') : [];
    const raw = (await ask(`Exact tool names on ${id} to add to disabled_tools (comma-separated; - clears tracking only)`, defaults.join(', '))).trim();
    selectedTools[id] = raw === '-' ? [] : raw ? raw.split(',').map(name => name.trim()).filter(Boolean) : defaults;
  }
  const configAfter = tomlConfigText(existing, selected, selectedTools);
  const definitions = loadRoleDefinitions(options.agentsDirectory ?? fileURLToPath(new URL('../agents/', import.meta.url)));
  const files: PlannedFile[] = [{ path: configPath, content: configAfter, before: configBefore, kind: 'config' }];
  for (const role of nativeRoles) {
    const roleFile = join(base, 'agents', `${role}.toml`);
    const currentRole = existsSync(roleFile) ? readFileSync(roleFile, 'utf8') : '';
    const modelDefault = /^model\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(currentRole)?.[1];
    const effortDefault = /^model_reasoning_effort\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(currentRole)?.[1];
    const decodeString = (value: string | undefined) => { try { return value ? JSON.parse(value) as string : ''; } catch { return ''; } };
    const modelSuggestion = decodeString(modelDefault);
    let model = '';
    while (!model || model === '-' || /[\r\n\0]/.test(model)) {
      model = ((await ask(`${role}: explicitly assigned Codex model ID (required)`, modelSuggestion)).trim() || modelSuggestion);
      if (!model || model === '-' || /[\r\n\0]/.test(model)) output(`Enter a valid explicit model ID for ${role}; no guessed fallback is used.`);
    }
    const effortSuggestion = decodeString(effortDefault);
    let reasoning = '';
    while (!(CODEX_REASONING_EFFORTS as readonly string[]).includes(reasoning)) {
      reasoning = ((await ask(`${role}: reasoning effort (low, medium, high)`, effortSuggestion)).trim() || effortSuggestion);
      if (!(CODEX_REASONING_EFFORTS as readonly string[]).includes(reasoning)) output(`Enter one of the supported reasoning efforts: ${CODEX_REASONING_EFFORTS.join(', ')}.`);
    }
    const target = join(base, 'agents', `${role}.toml`);
    assertSafeFilesystemPath(target, 'file');
    files.push({ path: target, content: compileCodexAgent(role, model, reasoning, definitions[role].description, definitions[role].instructions), before: existsSync(target) ? readFileSync(target, 'utf8') : undefined, kind: 'role' });
  }
  const rulesPath = join(base, 'rules', 'advanced-harness.rules');
  assertSafeFilesystemPath(rulesPath, 'file');
  const rulesBefore = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : undefined;
  const rulesContent = mergeCodexRules(rulesBefore);
  files.push({ path: rulesPath, content: rulesContent, before: rulesBefore, kind: 'rules' });
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
  for (const file of files) {
    assertSafeFilesystemPath(file.path, 'file');
    if (file.before !== undefined && file.before !== file.content && file.kind === 'role') {
      const prior = priorFiles.find(entry => canonicalPath(entry.path) === canonicalPath(file.path));
      const owned = prior?.after && !('absent' in prior.after) && ('content' in prior.after ? prior.after.content === file.before : prior.after.digest === digest(file.before));
      if (!owned && !/^(y|yes)$/i.test((await ask(`Overwrite customized/unowned Codex agent ${file.path}?`, 'no')).trim())) {
        output(`Preserving customized Codex agent: ${file.path}`); continue;
      }
    }
    selectedFiles.push(file);
  }
  const omittedRoles = nativeRoles.filter(role => !selectedFiles.some(file => file.kind === 'role' && file.path === join(base, 'agents', `${role}.toml`)));
  if (omittedRoles.length) output(`Install will remain incomplete because existing role profiles were preserved: ${omittedRoles.join(', ')}.`);
  output(`Codex ${scope} deployment preview (${selectedFiles.length} files):`);
  for (const file of selectedFiles) output(`  ${file.path}: ${file.before === file.content ? 'current' : file.before === undefined ? 'new' : 'update'}`);
  output('Shared baseline adds read-only sandbox and on-request approval only when absent. Codex runtime behavior and universal write gating are not verified. MCP selections remain disabled pending validation. Direct gh pr merge rules are not universal indirect/API protection.');
  if ((await ask('Type install to apply these changes', 'cancel')) !== 'install') { output('Cancelled. No files, backups, or receipts were written.'); return 0; }
  for (const file of selectedFiles) {
    if (file.before === file.content) continue;
    assertSafeFilesystemPath(file.path, 'file');
    const latest = existsSync(file.path) ? readFileSync(file.path, 'utf8') : undefined;
    if (latest !== file.before) throw new Error(`File changed while confirmation was open: ${file.path}. Rerun; no file was overwritten.`);
  }
  const changed = selectedFiles.filter(file => file.before !== file.content);
  const nextEvidence: ManagedFileEvidence[] = changed.map(file => ({ path: file.path, kind: file.kind === 'skill' ? 'skills' as const : file.kind === 'role' ? 'instructions' as const : file.kind as 'config' | 'rules', before: file.before === undefined ? { absent: true as const } : file.kind === 'config' ? { digest: digest(file.before) } : { content: file.before }, after: file.kind === 'config' ? { digest: digest(file.content) } : { content: file.content } }));
  const combinedEvidence = structuredClone(priorFiles);
  for (const item of nextEvidence) {
    const old = combinedEvidence.find(evidence => canonicalPath(evidence.path) === canonicalPath(item.path));
    if (old) old.after = item.after; else combinedEvidence.push(item);
  }
  const nextState = JSON.stringify({ ...stateValue, host: 'codex', selectedMcpServers: selected, disabledTools: selectedTools, managed: combinedEvidence.map(item => ({ path: item.path, after: item.after })) }, null, 2) + '\n';
  if (changed.length === 0 && nextState === stateBefore) { output('Codex configuration is already current; no files, backups, or receipts written.'); return 0; }
  const receipt = createSuccessorReceipt(snapshot, stateBefore, nextState, {}, undefined, { host: 'codex', managedFiles: combinedEvidence });
  const pending = writePendingSuccessor(snapshot, receipt);
  const backups: string[] = [];
  let completed = false;
  const attempted: PlannedFile[] = [];
  let stateAttempted = false;
  try {
    revalidatePendingSuccessor(pending);
    for (const file of changed) {
      assertSafeFilesystemPath(file.path, 'file');
      if ((existsSync(file.path) ? readFileSync(file.path, 'utf8') : undefined) !== file.before) throw new Error(`Codex target changed during install: ${file.path}`);
    }
    for (const file of changed) {
      mkdirSync(dirname(file.path), { recursive: true });
      attempted.push(file);
      const backup = save(file.path, file.before, file.content, backupParent);
      if (backup) backups.push(backup);
    }
    stateAttempted = true;
    const stateBackup = save(statePath, stateBefore, nextState, backupParent);
    if (stateBackup) backups.push(stateBackup);
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
    if (stateAttempted) restored = restore(statePath, stateBefore, nextState) && restored;
    for (const file of [...attempted].reverse()) restored = restore(file.path, file.before, file.content) && restored;
    if (restored) {
      try { recoverFailedSuccessor(pending, stateBefore); }
      catch (cleanupError) { options.error(`Codex rollback verified, but pending recovery evidence could not be removed: ${pending.path}; ${String(cleanupError)}`); }
    } else options.error(`Codex rollback was incomplete or encountered divergent content; pending recovery evidence retained at ${pending.path}. Review affected files and backups: ${backups.join(', ') || '(none)'}.`);
    throw error;
  }
  output(`Codex artifacts written with cumulative receipt ${pending.path}. Backups: ${backups.length}.`);
  if (!completed) throw new Error('Codex install did not finalize its receipt.');
  output('Inspect Codex Desktop on Windows/macOS and run harness:doctor for static checks. Runtime/approval behavior remains unverified.');
  return omittedRoles.length ? 1 : 0;
}

export function codexConfigPath(scope: 'project' | 'global', project: string | undefined, home: string): string {
  return resolve(scope === 'project' ? join(project ?? '', '.codex', 'config.toml') : join(home, '.codex', 'config.toml'));
}

export async function diagnoseCodex(options: { project?: string | undefined; home: string; globalDirectory?: string | undefined }): Promise<{ ok: boolean; issues: string[]; notes: string[] }> {
  const roots = [ ...(options.project ? [join(options.project, '.codex')] : []), options.globalDirectory ?? join(options.home, '.codex') ];
  const issues: string[] = [], notes: string[] = [];
  let found = false;
  for (const root of [...new Set(roots.map(path => resolve(path)))]) {
    const config = join(root, 'config.toml');
    if (!existsSync(config)) continue;
    found = true;
    let configText: string;
    try { assertSafeFilesystemPath(config, 'file'); configText = readFileSync(config, 'utf8'); validateCodexToml(configText, config); }
    catch (error) { issues.push(error instanceof Error ? error.message : String(error)); continue; }
    const rootText = configText.split(/^\s*\[/m, 1)[0] ?? '';
    if (!/^sandbox_mode\s*=\s*"(?:read-only|workspace-write|danger-full-access)"/m.test(rootText)) issues.push(`Codex shared sandbox_mode is missing or unsupported: ${config}`);
    if (!/^approval_policy\s*=\s*"(?:on-request|never|granular)"/m.test(rootText) && !/^approval_policy\s*=\s*\{/m.test(rootText)) issues.push(`Codex shared approval_policy is missing or unsupported: ${config}`);
    for (const role of nativeRoles) {
      const path = join(root, 'agents', `${role}.toml`);
      if (!existsSync(path)) { issues.push(`Missing Codex agent definition: ${path}`); continue; }
      try {
        assertSafeFilesystemPath(path, 'file');
        const text = readFileSync(path, 'utf8'); validateCodexToml(text, path);
        const stringValue = (key: string) => {
          const match = new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, 'm').exec(text);
          return match ? JSON.parse(match[1]!) as string : undefined;
        };
        for (const key of ['name', 'description', 'developer_instructions', 'model', 'model_reasoning_effort']) if (!stringValue(key)) issues.push(`Codex agent ${role} lacks required explicit ${key}: ${path}`);
        if (stringValue('name') !== role) issues.push(`Codex agent name does not match expected role ${role}: ${path}`);
        if (!(CODEX_REASONING_EFFORTS as readonly string[]).includes(stringValue('model_reasoning_effort') ?? '')) issues.push(`Codex agent ${role} has unsupported model_reasoning_effort: ${path}`);
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
          const table = parseCodexToml(configText, config).tables.find(item => item.parts.length === 2 && item.parts[0] === 'mcp_servers' && item.parts[1] === id);
          const section = table ? configText.slice(table.start, table.end) : '';
           if (!/^[ \t]*(?:enabled|"enabled"|'enabled')\s*=\s*false\b/m.test(section)) issues.push(`Selected Codex MCP server ${id} is not disabled pending validation.`);
          const expectedTools = state.disabledTools?.[id];
          if (Array.isArray(expectedTools)) {
             const match = /^[ \t]*(?:disabled_tools|"disabled_tools"|'disabled_tools')\s*=\s*\[([^\]]*)\]/m.exec(section);
            const actual = match ? [...match[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(item => JSON.parse(`"${item[1]}"`) as string) : [];
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
      if (!hasActiveCodexMergeRule(rulesText, 'gh') || !hasActiveCodexMergeRule(rulesText, 'gh.exe')) issues.push(`Codex direct gh pr merge rules are missing or malformed: ${rules}`);
    }
  }
  if (!found) issues.push('Codex configuration is not installed in inspected project/global scope.');
  notes.push('Static TOML/artifact checks only. Codex Desktop load, model availability, MCP connectivity, and approval behavior are not runtime-verified.');
  notes.push('Shared permission settings are inherited; role files cannot override parent sandbox/approval/MCP settings.');
  notes.push('Direct gh pr merge rule does not block indirect scripts or API routes.');
  return { ok: issues.length === 0, issues, notes };
}
