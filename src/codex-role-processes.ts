import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nativeRoles, type NativeRole } from './native-role-types.ts';
import type { RoleDefinition } from './role-definitions.ts';

// Codex per-role process isolation (#45). Codex custom agents inherit the parent's sandbox, approval
// and MCP settings, so each child role runs as its own `codex exec -p harness-<role>` process and Lead
// (the Desktop session) only launches them, one host-permitted escalation per launch.

export type CodexChildRole = Exclude<NativeRole, 'lead'>;
export const codexChildRoles = nativeRoles.filter((role): role is CodexChildRole => role !== 'lead');

export interface CodexRolePolicy {
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  network: boolean;
  mcp: boolean;
}

const quote = (text: string): string => JSON.stringify(text);

/**
 * Derived from each role's source policy, not chosen per host. A role that edits files or has web or MCP
 * access, and whose shell does not deny `git *`, gets danger-full-access (Operator, External): their contracts
 * need local Git and remote access that the workspace-write profile does not grant. A role that edits files but
 * denies `git *` (Implementer) keeps workspace-write. Every other role is read-only with MCP off.
 */
export function codexRolePolicies(definitions: Record<NativeRole, RoleDefinition>): Record<CodexChildRole, CodexRolePolicy> {
  return Object.fromEntries(codexChildRoles.map(role => {
    const rules = definitions[role].deployment.opencode.policy.rules;
    const grants = (capability: string) => rules.some(rule => rule.capability === capability && rule.effect !== 'deny');
    const remote = grants('web.fetch') || grants('mcp.tool');
    const edits = rules.filter(rule => rule.capability === 'file.edit' && rule.resource.kind === 'all').at(-1)?.effect;
    const writesFiles = edits !== undefined && edits !== 'deny';
    const denysGit = rules.some(rule => rule.capability === 'shell.run' && rule.resource.kind === 'native-pattern' && rule.resource.value === 'git *' && rule.effect === 'deny');
    const sandbox = !(writesFiles || remote) ? 'read-only' : denysGit ? 'workspace-write' : 'danger-full-access';
    return [role, { sandbox, network: remote, mcp: grants('mcp.tool') }];
  })) as Record<CodexChildRole, CodexRolePolicy>;
}

export const codexProfileName = (role: CodexChildRole) => `harness-${role}`;

export function compileCodexRoleProfile(role: CodexChildRole, policy: CodexRolePolicy, model: string, reasoning: string, instructions: string): string {
  const lines = [
    `# Advanced Harness role profile for ${role}; generated, re-applied by the role launcher on every run.`,
    ...(policy.mcp ? ['# advanced-harness: mcp=allowed'] : []),
    ...(policy.sandbox === 'danger-full-access' ? ['# danger-full-access: network is not restricted under this sandbox mode, so network_access below has no effect.'] : []),
    `sandbox_mode = ${quote(policy.sandbox)}`,
    // Children are non-interactive; the human host-permission point is Lead's launch of this process.
    'approval_policy = "never"',
    `model = ${quote(model.trim())}`,
    `model_reasoning_effort = ${quote(reasoning)}`,
    `developer_instructions = ${quote(instructions.trim())}`,
    '',
    '[sandbox_workspace_write]',
    `network_access = ${policy.network}`,
  ];
  return `${lines.join('\n')}\n`;
}

/** Strict JSON Schema for `codex exec --output-schema`: the four-state status contract (BH-035). */
export function compileCodexRoleStatusSchema(): string {
  return `${JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['status', 'summary', 'details'],
    properties: {
      status: { type: 'string', enum: ['Working', 'Checking', 'Ready', 'Needs your decision'] },
      summary: { type: 'string', description: 'One or two sentences for Lead.' },
      details: { type: 'string', description: 'Evidence, findings, changed files, or the decision needed.' },
    },
  }, null, 2)}\n`;
}

export const codexLeadMarkers = { start: '<!-- BEGIN advanced-harness Codex Lead -->', end: '<!-- END advanced-harness Codex Lead -->' } as const;

export function compileCodexLeadBlock(policies: Record<CodexChildRole, CodexRolePolicy>, launcherPath: string, leadInstructions: string): string {
  const launch = `node ${quote(launcherPath)} <role> --cd "<worktree or project>" --task "<task>"`;
  const lines = [
    '## Advanced Harness Lead (Codex, one process per role)',
    '',
    'You are Lead. You do not edit files, run project commands, or use MCP tools yourself, and you never use in-process subagents (`spawn_agent`).',
    'Delegate each role task by running the role launcher, and ask to run it outside the sandbox: the human grants host permission for every launch at the Codex Desktop prompt, and that prompt is the checkpoint for the role\'s work.',
    '',
    `- New task: \`${launch}\``,
    `- Follow-up in the same role thread: add \`--resume <threadId>\` from the previous launch's output.`,
    '- Put the whole task in `--task` so the human sees it in the host permission prompt. One role and one task per launch.',
    '- The launcher prints JSON with `status` (Working, Checking, Ready, Needs your decision), `summary`, `details` and `threadId`. Treat anything else as Needs your decision.',
    '',
    '| Role | Sandbox | Network | MCP |',
    '| :--- | :--- | :--- | :--- |',
    ...codexChildRoles.map(role => `| \`${role}\` | ${policies[role].sandbox} | ${policies[role].sandbox === 'danger-full-access' ? 'unrestricted' : policies[role].network ? 'yes' : 'no'} | ${policies[role].mcp ? 'selected servers' : 'off'} |`),
    '',
    '`operator` has network access under danger-full-access, but it must still not push, pull, clone or use `gh`. Do not ask it to.',
    '',
    'Role settings come from `~/.codex/harness-<role>.config.toml` and are re-applied on every launch and resume. Do not pass your own `-c`, `-s` or `-p` flags and do not call `codex exec` directly.',
    '',
    '### Lead role instructions',
    '',
    leadInstructions.trim(),
  ];
  return lines.join('\n');
}

/** The managed Lead block body, or why it cannot be read: markers missing, duplicated, or out of order. */
export function extractCodexLeadBlock(text: string): { block: string } | { problem: string } {
  const { start, end } = codexLeadMarkers;
  const starts = text.split(start).length - 1, ends = text.split(end).length - 1;
  if (!starts && !ends) return { problem: 'is missing' };
  if (starts !== 1 || ends !== 1) return { problem: `has ${starts} start and ${ends} end markers (expected one of each)` };
  const from = text.indexOf(start), to = text.indexOf(end);
  if (to < from) return { problem: 'has its end marker before its start marker' };
  return { block: text.slice(from + start.length, to).replace(/\r\n/g, '\n').trim() };
}

/** Replaces or appends the managed Lead block in ~/.codex/AGENTS.md; other content is preserved. */
export function mergeCodexLeadBlock(existing: string | undefined, block: string): string {
  const { start, end } = codexLeadMarkers;
  const full = `${start}\n${block.trimEnd()}\n${end}\n`;
  if (existing === undefined || existing.trim() === '') return full;
  const starts = existing.split(start).length - 1, ends = existing.split(end).length - 1;
  if (starts !== ends || starts > 1) throw new Error('~/.codex/AGENTS.md has malformed or duplicate advanced-harness Lead markers; resolve them manually. No files were changed.');
  if (starts === 1) {
    const from = existing.indexOf(start), to = existing.indexOf(end);
    if (to < from) throw new Error('~/.codex/AGENTS.md advanced-harness Lead markers are out of order; resolve them manually. No files were changed.');
    const after = existing.slice(to + end.length).replace(/^\r?\n/, '');
    return existing.slice(0, from) + full + after;
  }
  return `${existing.replace(/\s+$/, '')}\n\n${full}`;
}

/**
 * What uninstall needs to take the Lead block back out of ~/.codex/AGENTS.md. The file is the user's as
 * well as the harness's, so it is tracked as this one block, never restored or compared as a whole file.
 */
export type CodexLeadBlockRecord = {
  /** AGENTS.md did not exist before the first install, so uninstall may remove it once nothing else is in it. */
  created: boolean;
  /** Whitespace that ended the file where the block was added; merging replaces it with a separator. */
  trailing: string;
  /** Digest of the block the harness last wrote; a different block was edited and is not the harness's to remove. */
  digest: string;
};

const leadBlockDigest = (block: string) => createHash('sha256').update(block).digest('hex');

/** Records the block just written. `prior` keeps what the first install saw, which later updates cannot know. */
export function codexLeadBlockRecord(before: string | undefined, after: string, prior?: CodexLeadBlockRecord): CodexLeadBlockRecord {
  const extracted = extractCodexLeadBlock(after);
  if ('problem' in extracted) throw new Error(`The merged Lead block ${extracted.problem}.`);
  const from = before?.indexOf(codexLeadMarkers.start) ?? -1;
  const preceding = before === undefined ? '' : from < 0 ? before : before.slice(0, from);
  return {
    created: prior ? prior.created : before === undefined,
    trailing: prior ? prior.trailing : /\s*$/.exec(preceding)?.[0] ?? '',
    digest: leadBlockDigest(extracted.block),
  };
}

/**
 * Takes the harness's Lead block out of the current AGENTS.md and leaves everything else as it is. A block
 * that is malformed or edited since install is not removed: `kept` says why, for the user to review.
 */
export function removeCodexLeadBlock(text: string, record: CodexLeadBlockRecord): { text: string; kept?: string; found: boolean } {
  const extracted = extractCodexLeadBlock(text);
  if ('problem' in extracted) {
    return extracted.problem === 'is missing' ? { text, found: false } : { text, kept: extracted.problem, found: true };
  }
  if (leadBlockDigest(extracted.block) !== record.digest) return { text, kept: 'was edited since install', found: true };
  const { start, end } = codexLeadMarkers;
  const head = text.slice(0, text.indexOf(start));
  const tail = text.slice(text.indexOf(end) + end.length).replace(/^\r?\n/, '');
  const body = head.replace(/\s+$/, '');
  if (!tail.trim()) return { text: body + record.trailing, found: true };
  return { text: body ? head + tail : tail.replace(/^(?:\r?\n)+/, ''), found: true };
}

/** The launcher source shipped verbatim to $CODEX_HOME/advanced-harness/codex-role.mjs. */
export function codexRoleLauncherSource(): string {
  return readFileSync(fileURLToPath(new URL('./codex-role-launcher.mjs', import.meta.url)), 'utf8');
}
