import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const canonicalPath = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

type CodexTomlTable = { path: string; start: number; end: number };
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
  const parts = text.split('.').map(part => part.trim());
  return parts.length && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)) ? parts : undefined;
}

function hasValuePathConflict(paths: Iterable<string>, candidate: string): boolean {
  for (const path of paths) if (path === candidate || path.startsWith(`${candidate}.`) || candidate.startsWith(`${path}.`)) return true;
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
      while (/[A-Za-z0-9_.-]/.test(source[index] ?? '')) index++;
      const parts = keyParts(source.slice(start, index));
      if (!parts) return fail();
      const key = parts.join('.');
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
  let currentTable = '';
  let offset = 0;
  let lineNumber = 0;
  const lines = text.split(/(?<=\n)/);
  for (const rawLine of lines) {
    lineNumber++;
    const raw = rawLine.replace(/[\r\n]+$/, '');
    const content = stripTomlComment(raw).trim();
    const actualLine = lineNumber;
    if (!content) { offset += rawLine.length; continue; }
    const tableMatch = /^\[\s*([A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)\s*\]$/.exec(content);
    if (tableMatch) {
      const parts = keyParts(tableMatch[1]!);
      if (!parts) throw new Error(`Unsupported TOML table in ${path} at line ${actualLine}; refusing to edit it.`);
      const tablePath = parts.join('.');
      if (explicitTables.has(tablePath) || [...explicitTables].some(existing => existing.startsWith(`${tablePath}.`))) throw new Error(`Duplicate or out-of-order TOML table in ${path} at line ${actualLine}.`);
      if ([...values].some(value => value === tablePath || value.startsWith(`${tablePath}.`) || tablePath.startsWith(`${value}.`))) throw new Error(`TOML scalar/table collision in ${path} at line ${actualLine}.`);
      if (tables.length) tables[tables.length - 1]!.end = offset;
      explicitTables.add(tablePath);
      currentTable = tablePath;
      tables.push({ path: tablePath, start: offset, end: text.length });
      offset += rawLine.length;
      continue;
    }
    if (content.startsWith('[')) throw new Error(`Unsupported or malformed TOML table in ${path} at line ${actualLine}; refusing to edit it.`);
    const assignment = /^([A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)\s*=(.*)$/.exec(content);
    if (!assignment) throw new Error(`Unsupported or malformed TOML assignment in ${path} at line ${actualLine}; refusing to edit it.`);
    const parts = keyParts(assignment[1]!);
    if (!parts) throw new Error(`Unsupported TOML key in ${path} at line ${actualLine}; refusing to edit it.`);
    const fullKey = [currentTable, ...parts].filter(Boolean).join('.');
    if (hasValuePathConflict(values, fullKey) || [...explicitTables].some(table => table === fullKey || table.startsWith(`${fullKey}.`))) throw new Error(`Duplicate TOML key or scalar/table collision in ${path} at line ${actualLine}.`);
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
      if (!inTable && new RegExp(`^${key}\\s*=`).test(trimmed)) return true;
    }
    return false;
  };
  const blocks: string[] = [];
  if (!rootHas('sandbox_mode')) blocks.push('sandbox_mode = "read-only"');
  if (!rootHas('approval_policy')) blocks.push('approval_policy = "on-request"');
  if (!blocks.length) return text;
  const firstTable = text.search(/^\s*\[/m);
  if (firstTable >= 0) return `${text.slice(0, firstTable).trimEnd()}${text.slice(0, firstTable).trim() ? '\n\n' : ''}${blocks.join('\n\n')}\n\n${text.slice(firstTable)}`;
  return `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${blocks.join('\n\n')}\n`;
}

export function compileCodexAgent(role: NativeRole, model: string, reasoning: string, description: string, instructions: string): string {
  if (!roleId(role) || !model.trim() || !['low', 'medium', 'high'].includes(reasoning)) throw new Error(`Invalid Codex agent assignment: ${role}`);
  return `name = ${quote(role)}\ndescription = ${quote(description)}\ndeveloper_instructions = ${quote(instructions)}\nmodel = ${quote(model.trim())}\nmodel_reasoning_effort = ${quote(reasoning)}\n`;
}

export function compileCodexMergeRule(): string {
  return '# BEGIN advanced-harness managed merge rules\n# Denies identifiable direct CLI forms only; indirect/API routes are not blocked.\nprefix_rule(pattern = ["gh", "pr", "merge"], decision = "forbidden")\nprefix_rule(pattern = ["gh.exe", "pr", "merge"], decision = "forbidden")\n# END advanced-harness managed merge rules\n';
}

function mergeCodexRules(existing: string | undefined): string {
  const desired = compileCodexMergeRule();
  if (!existing) return desired;
  const begin = '# BEGIN advanced-harness managed merge rules';
  const end = '# END advanced-harness managed merge rules';
  const start = existing.indexOf(begin), finish = existing.indexOf(end);
  if (start >= 0 || finish >= 0) {
    if (start < 0 || finish < start) throw new Error('Malformed managed Codex rules block; resolve it before updating.');
    return existing.slice(0, start) + desired.trimEnd() + existing.slice(finish + end.length);
  }
  if (existing.includes('pattern = ["gh", "pr", "merge"]') || existing.includes('pattern = ["gh.exe", "pr", "merge"]')) return existing;
  return `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${desired}`;
}

function tomlConfigText(existing: string, selectedServerIds: string[], selectedTools: Record<string, string[]>): string {
  let result = appendSettings(existing);
  for (const id of selectedServerIds) {
    if (!roleId(id)) throw new Error(`Invalid Codex MCP server ID: ${id}`);
    const tablePath = `mcp_servers.${id}`;
    const targetTable = parseCodexToml(result, 'config.toml').tables.find(table => table.path === tablePath);
    if (!targetTable) throw new Error(`Selected MCP server "${id}" is not already configured. Supply its real configuration through the host; no endpoint or command was invented.`);
    const { start, end } = targetTable;
    const section = result.slice(start, end);
    let updatedSection = /^\s*enabled\s*=/m.test(section)
      ? section.replace(/^(\s*enabled\s*=\s*)true\b/gim, '$1false')
      : section.trimEnd() + '\nenabled = false\n';
    const tools = selectedTools[id] ?? [];
    if (tools.length) {
      const encoded = `disabled_tools = [${tools.map(quote).join(', ')}]`;
      const existingTools = /^\s*disabled_tools\s*=\s*\[([^\]]*)\]/m.exec(updatedSection);
      if (existingTools) {
        const remainder = existingTools[1]!.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/[\s,]/g, '');
        if (remainder) throw new Error(`Unsupported disabled_tools value in Codex MCP server ${id}; refusing to discard existing data.`);
        const oldNames = [...existingTools[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse(`"${m[1]}"`) as string);
        const merged = [...new Set([...oldNames, ...tools])];
        updatedSection = updatedSection.replace(existingTools[0], `disabled_tools = [${merged.map(quote).join(', ')}]`);
      } else updatedSection = updatedSection.trimEnd() + `\n${encoded}\n`;
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
  const selected = (await ask('Existing Codex MCP server ID(s) to mark disabled pending route validation (comma-separated; blank for none)', '')).trim().split(',').map(x => x.trim()).filter(Boolean);
  const selectedTools: Record<string, string[]> = {};
  for (const id of selected) {
    if (!roleId(id)) throw new Error(`Invalid Codex MCP server ID: ${id}`);
    const raw = (await ask(`Exact tool names on ${id} to add to disabled_tools (comma-separated; no names are guessed)`, '')).trim();
    selectedTools[id] = raw ? raw.split(',').map(name => name.trim()).filter(Boolean) : [];
  }
  const configAfter = tomlConfigText(existing, selected, selectedTools);
  const definitions = loadRoleDefinitions(options.agentsDirectory ?? fileURLToPath(new URL('../agents/', import.meta.url)));
  const files: PlannedFile[] = [{ path: configPath, content: configAfter, before: configBefore, kind: 'config' }];
  for (const role of nativeRoles) {
    const model = (await ask(`${role}: explicitly assigned Codex model ID (required)`, '')).trim();
    if (!model || /[\r\n\0]/.test(model)) throw new Error(`A valid explicit model ID is required for ${role}; no guessed fallback is used.`);
    const reasoning = (await ask(`${role}: reasoning effort (low, medium, high)`, '')).trim();
    if (!['low', 'medium', 'high'].includes(reasoning)) throw new Error(`Explicit reasoning effort low/medium/high is required for ${role}.`);
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
    const content = `---\nname: ${id}\ndescription: ${commands[id].description}\n---\n${body}`;
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
  try {
    revalidatePendingSuccessor(pending);
    for (const file of changed) {
      assertSafeFilesystemPath(file.path, 'file');
      if ((existsSync(file.path) ? readFileSync(file.path, 'utf8') : undefined) !== file.before) throw new Error(`Codex target changed during install: ${file.path}`);
    }
    for (const file of changed) {
      mkdirSync(dirname(file.path), { recursive: true });
      const backup = save(file.path, file.before, file.content, backupParent);
      if (backup) backups.push(backup);
    }
    const stateBackup = save(statePath, stateBefore, nextState, backupParent);
    if (stateBackup) backups.push(stateBackup);
    finalizeSuccessor(pending, nextState);
    completed = true;
  } catch (error) {
    if (!changed.some(file => existsSync(file.path) && readFileSync(file.path, 'utf8') === file.content) && (existsSync(statePath) ? readFileSync(statePath, 'utf8') : undefined) === stateBefore) recoverFailedSuccessor(pending, stateBefore);
    else options.error(`Codex files may have been partially written; pending recovery evidence retained at ${pending.path}.`);
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
        if (!['low', 'medium', 'high'].includes(stringValue('model_reasoning_effort') ?? '')) issues.push(`Codex agent ${role} has unsupported model_reasoning_effort: ${path}`);
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
        if (!state || typeof state !== 'object' || !Array.isArray(state.selectedMcpServers)) { issues.push(`Invalid Codex harness state manifest: ${statePath}`); continue; }
        if (Array.isArray(state.selectedMcpServers)) for (const id of state.selectedMcpServers) {
          if (typeof id !== 'string' || !roleId(id)) { issues.push(`Invalid MCP identity in Codex state manifest: ${statePath}`); continue; }
          const table = parseCodexToml(configText, config).tables.find(item => item.path === `mcp_servers.${id}`);
          const section = table ? configText.slice(table.start, table.end) : '';
          if (!/^enabled\s*=\s*false\b/m.test(section)) issues.push(`Selected Codex MCP server ${id} is not disabled pending validation.`);
          const expectedTools = state.disabledTools?.[id];
          if (Array.isArray(expectedTools)) {
            const match = /^disabled_tools\s*=\s*\[([^\]]*)\]/m.exec(section);
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
      if (!rulesText.includes('prefix_rule(pattern = ["gh", "pr", "merge"], decision = "forbidden")') || !rulesText.includes('prefix_rule(pattern = ["gh.exe", "pr", "merge"], decision = "forbidden")')) issues.push(`Codex direct gh pr merge rules are missing or malformed: ${rules}`);
    }
  }
  if (!found) issues.push('Codex configuration is not installed in inspected project/global scope.');
  notes.push('Static TOML/artifact checks only. Codex Desktop load, model availability, MCP connectivity, and approval behavior are not runtime-verified.');
  notes.push('Shared permission settings are inherited; role files cannot override parent sandbox/approval/MCP settings.');
  notes.push('Direct gh pr merge rule does not block indirect scripts or API routes.');
  return { ok: issues.length === 0, issues, notes };
}
