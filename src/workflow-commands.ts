import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { stringify as stringifyYaml } from 'yaml';
import { saveInstallation } from './native-installer.ts';
import { assertSafeFilesystemPath } from './installation-receipt.ts';

export const workflowCommandIds = ['start-issue', 'review-pr', 'address-pr-feedback', 'report-defect', 'assess-debt', 'grill-me'] as const;
export type WorkflowCommandId = typeof workflowCommandIds[number];
export type WorkflowArguments = { mode: 'full' } | { mode: 'positional'; names: ['parent', 'description']; remainder: 2 };
export interface WorkflowCommand { schemaVersion: 1; description: string; arguments: WorkflowArguments; body: string }
export type WorkflowArtifactHost = 'opencode' | 'claude-code' | 'antigravity' | 'codex' | 'cursor';
export type WorkflowArtifactFormat = 'command-markdown' | 'skill-markdown';
export type WorkflowArtifactBinding = 'native-template' | 'caller-bound';
export interface WorkflowArtifact { host: WorkflowArtifactHost; command: WorkflowCommandId; format: WorkflowArtifactFormat; relativePath: string; content: string; binding: WorkflowArtifactBinding }
export interface WorkflowCompilation { artifacts: WorkflowArtifact[]; diagnostics: string[]; deploymentReady: boolean; runtimeVerified: false }

const placeholders: Record<WorkflowCommandId, readonly string[]> = {
  'start-issue': ['$ARGUMENTS'], 'review-pr': ['$ARGUMENTS'], 'address-pr-feedback': ['$ARGUMENTS'],
  'report-defect': ['$1', '$2'], 'assess-debt': ['$ARGUMENTS'], 'grill-me': ['$ARGUMENTS']
};

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

export function loadWorkflowCommand(text: string, id: WorkflowCommandId, source = `${id}.md`): WorkflowCommand {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`Malformed workflow command frontmatter: ${source}`);
  const doc = parseDocument(match[1]!);
  const header: unknown = doc.toJSON();
  if (doc.errors.length || !record(header)) throw new Error(`Malformed workflow command frontmatter: ${source}`);
  if (Object.keys(header).some(key => !['schemaVersion', 'description', 'arguments'].includes(key))) throw new Error(`Unknown workflow command field: ${source}`);
  if (header.schemaVersion !== 1) throw new Error(`Unsupported workflow command schema version: ${source}`);
  if (typeof header.description !== 'string' || !header.description.trim() || /[\r\n]/.test(header.description)) throw new Error(`Invalid workflow command description: ${source}`);
  const args = header.arguments;
  if (!record(args) || !['mode', ...(args.mode === 'positional' ? ['names', 'remainder'] : [])].every(key => Object.hasOwn(args, key)) || Object.keys(args).some(key => !['mode', 'names', 'remainder'].includes(key))) throw new Error(`Invalid workflow command arguments: ${source}`);
  let normalized: WorkflowArguments;
  if (args.mode === 'full' && Object.keys(args).length === 1) normalized = { mode: 'full' };
  else if (id === 'report-defect' && args.mode === 'positional' && args.remainder === 2 && Array.isArray(args.names) && args.names.length === 2 && args.names[0] === 'parent' && args.names[1] === 'description') normalized = { mode: 'positional', names: ['parent', 'description'], remainder: 2 };
  else throw new Error(`Workflow command argument contract does not match ${id}: ${source}`);
  const body = match[2]!;
  const found = [...body.matchAll(/\$ARGUMENTS|\$[1-9]\d*/g)].map(item => item[0]);
  const expected = placeholders[id];
  if (found.length !== expected.length || expected.some(token => found.filter(item => item === token).length !== 1) || found.some(token => !expected.includes(token))) throw new Error(`Workflow command placeholders do not match its argument contract: ${source}`);
  return { schemaVersion: 1, description: header.description, arguments: normalized, body };
}

export function loadWorkflowCommands(directory: string): Record<WorkflowCommandId, WorkflowCommand> {
  const names = readdirSync(directory).filter(name => name.endsWith('.md') && name !== 'README.md').sort();
  const expected = [...workflowCommandIds].map(id => `${id}.md`).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('Workflow command source directory must contain exactly the six canonical command files.');
  return Object.fromEntries(workflowCommandIds.map(id => [id, loadWorkflowCommand(readFileSync(join(directory, `${id}.md`), 'utf8'), id)])) as Record<WorkflowCommandId, WorkflowCommand>;
}

/** Compile only the host-neutral command bindings. Inserted user text is never rescanned. */
export function bindWorkflowArguments(command: WorkflowCommand, input: string | { parent?: string; description?: string }): string {
  let values: Record<string, string>;
  if (command.arguments.mode === 'full') values = { '$ARGUMENTS': typeof input === 'string' ? input : '' };
  else {
    if (typeof input === 'string') throw new Error('Positional command bindings require host-provided named fields; input is not tokenized.');
    values = { '$1': input.parent ?? '', '$2': input.description ?? '' };
  }
  return command.body.replace(/\$ARGUMENTS|\$[1-9]\d*/g, token => values[token as keyof typeof values] ?? token);
}

/** OpenCode's command contract is description-only metadata plus the unchanged template body. */
export function emitOpenCodeCommand(command: WorkflowCommand): string {
  return `---\ndescription: ${safeYamlScalar(command.description)}\n---\n${command.body}`;
}

function safeYamlScalar(value: string): string {
  const serialized = stringifyYaml(value).trimEnd();
  const parsed = parseDocument(`value: ${serialized}\n`);
  if (!parsed.errors.length && parsed.toJSON()?.value === value && !/[\r\n]/.test(serialized)) return serialized;
  return JSON.stringify(value);
}

const hostSpecs: Record<Exclude<WorkflowArtifactHost, 'opencode'>, { format: 'command-markdown' | 'skill-markdown'; directory: string; ref: string; needsArguments: boolean }> = {
  'claude-code': { format: 'command-markdown', directory: '.claude/commands', ref: 'https://code.claude.com/docs/en/skills', needsArguments: true },
  antigravity: { format: 'skill-markdown', directory: '.agents/skills', ref: 'https://antigravity.google/docs/skills', needsArguments: false },
  codex: { format: 'skill-markdown', directory: '.agents/skills', ref: 'https://developers.openai.com/codex/build-skills', needsArguments: false },
  cursor: { format: 'skill-markdown', directory: '.cursor/skills', ref: 'https://cursor.com/docs/skills', needsArguments: false }
};

/** Deterministically compile canonical workflows to documented host artifact formats only. */
export function compileWorkflowArtifacts(
  sourceDirectory: string,
  hosts: readonly WorkflowArtifactHost[],
  callerBindings: Partial<Record<WorkflowCommandId, string | { parent?: string; description?: string }>> = {}
): WorkflowCompilation {
  const commands = loadWorkflowCommands(sourceDirectory);
  const artifacts: WorkflowArtifact[] = [];
  const diagnostics: string[] = [];
  if (!callerBindings || typeof callerBindings !== 'object' || Array.isArray(callerBindings)) {
    return { artifacts, diagnostics: ['Caller bindings must be an object keyed by canonical workflow command ID.'], deploymentReady: false, runtimeVerified: false };
  }
  for (const host of [...new Set(hosts)]) for (const id of workflowCommandIds) {
    const command = commands[id];
    if (host === 'opencode') {
      artifacts.push({ host, command: id, format: 'command-markdown', relativePath: `.opencode/commands/${id}.md`, content: emitOpenCodeCommand(command), binding: 'native-template' });
      continue;
    }
    const spec = hostSpecs[host];
    const supplied = Object.hasOwn(callerBindings, id);
    if (command.arguments.mode === 'positional' && !supplied) {
      diagnostics.push(`${host}/${id}: caller-bound parent and complete description are required; no unbound artifact emitted (${spec.ref}).`);
      continue;
    }
    if (spec.needsArguments && command.arguments.mode === 'full' && !supplied) {
      // Native Claude command template supports documented $ARGUMENTS.
      const content = `---\ndescription: ${safeYamlScalar(command.description)}\n---\n${command.body}`;
      artifacts.push({ host, command: id, format: spec.format, relativePath: `${spec.directory}/${id}.md`, content, binding: 'native-template' });
      continue;
    }
    if (!supplied) {
      diagnostics.push(`${host}/${id}: host format has no verified argument binding; caller input is required and no unbound artifact was emitted (${spec.ref}).`);
      continue;
    }
    const input = callerBindings[id]!;
    if (command.arguments.mode === 'positional' && (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.parent !== 'string' || typeof input.description !== 'string' || !input.parent.trim() || !input.description.trim() || Object.keys(input).some(key => !['parent', 'description'].includes(key)))) {
      diagnostics.push(`${host}/${id}: both parent and complete description caller inputs are required; no artifact emitted (${spec.ref}).`);
      continue;
    }
    if (command.arguments.mode === 'full' && (typeof input !== 'string' || !input.trim())) {
      diagnostics.push(`${host}/${id}: a non-empty complete argument string is required; no artifact emitted (${spec.ref}).`);
      continue;
    }
    const bound = bindWorkflowArguments(command, input);
    const metadata = { name: id, description: command.description, ...(host === 'cursor' ? { 'disable-model-invocation': true } : {}) };
    const content = `---\n${stringifyYaml(metadata).trimEnd()}\n---\n${bound}`;
    const relativePath = host === 'claude-code' ? `${spec.directory}/${id}.md` : `${spec.directory}/${id}/SKILL.md`;
    artifacts.push({ host, command: id, format: spec.format, relativePath, content, binding: 'caller-bound' });
  }
  for (const host of hosts) if (host !== 'opencode') diagnostics.push(`${host}: workflow artifacts do not implement native role permissions, MCP configuration, or runtime enforcement; integration tracked in issue #${host === 'claude-code' ? '43' : host === 'antigravity' ? '44' : host === 'codex' ? '45' : '46'}.`);
  return { artifacts, diagnostics: [...new Set(diagnostics)], deploymentReady: hosts.length > 0 && hosts.every(host => host === 'opencode') && diagnostics.length === 0, runtimeVerified: false };
}

export interface WorkflowCommandDeploymentItem { id: WorkflowCommandId; target: string; current?: string; updated: string; status: 'missing' | 'current' | 'customized' }

/** Plan project/global OpenCode command outputs without modifying user files. */
export function planOpenCodeCommandDeployment(sourceDirectory: string, outputDirectory: string): WorkflowCommandDeploymentItem[] {
  const commands = loadWorkflowCommands(sourceDirectory);
  return workflowCommandIds.map(id => {
    const target = join(outputDirectory, `${id}.md`);
    assertSafeFilesystemPath(target, 'file');
    const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    const updated = emitOpenCodeCommand(commands[id]);
    return { id, target, ...(current === undefined ? {} : { current }), updated, status: current === undefined ? 'missing' : current === updated ? 'current' : 'customized' };
  });
}

/** Apply only previewed selections; customized outputs require explicit caller selection. */
export function applyOpenCodeCommandDeployment(items: readonly WorkflowCommandDeploymentItem[], selected: readonly WorkflowCommandId[], backupParent: string, onFileWritten?: (path: string, backup?: string) => void): { updated: string[]; backups: string[] } {
  const selectedSet = new Set(selected);
  const updates: string[] = [], backups: string[] = [];
  for (const item of items) {
    if (!selectedSet.has(item.id) || item.status === 'current') continue;
    assertSafeFilesystemPath(item.target, 'file');
    const current = existsSync(item.target) ? readFileSync(item.target, 'utf8') : undefined;
    if (current !== item.current) throw new Error(`Workflow command changed after preview: ${item.target}. Review again; no command output was written.`);
  }
  for (const item of items) {
    if (!selectedSet.has(item.id) || item.status === 'current') continue;
    const backup = saveInstallation(item.target, item.current, item.updated, backupParent);
    updates.push(item.target);
    if (backup) backups.push(backup);
    onFileWritten?.(item.target, backup);
  }
  return { updated: updates, backups };
}
