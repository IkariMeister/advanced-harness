import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nativeRoles, type NativeRole } from './native-role-types.ts';
import type { RoleDefinition } from './role-definitions.ts';

// Codex per-role process isolation (#45). Codex custom agents inherit the parent's sandbox, approval
// and MCP settings, so each child role runs as its own `codex exec -p harness-<role>` process and Lead
// (the Desktop session) only launches them, one approved escalation per launch.

export type CodexChildRole = Exclude<NativeRole, 'lead'>;
export const codexChildRoles = nativeRoles.filter((role): role is CodexChildRole => role !== 'lead');

export interface CodexRolePolicy {
  sandbox: 'read-only' | 'workspace-write';
  network: boolean;
  mcp: boolean;
}

const quote = (text: string): string => JSON.stringify(text);

/**
 * Derived from each role's source policy, not chosen per host: file edits (allow/ask) need
 * workspace-write; web or MCP access (External) also needs network and .git writes for push/gh.
 * Every other role is read-only with MCP off.
 */
export function codexRolePolicies(definitions: Record<NativeRole, RoleDefinition>): Record<CodexChildRole, CodexRolePolicy> {
  return Object.fromEntries(codexChildRoles.map(role => {
    const rules = definitions[role].deployment.opencode.policy.rules;
    const grants = (capability: string) => rules.some(rule => rule.capability === capability && rule.effect !== 'deny');
    const remote = grants('web.fetch') || grants('mcp.tool');
    const edits = rules.filter(rule => rule.capability === 'file.edit' && rule.resource.kind === 'all').at(-1)?.effect;
    const sandbox = remote || (edits !== undefined && edits !== 'deny') ? 'workspace-write' : 'read-only';
    return [role, { sandbox, network: remote, mcp: grants('mcp.tool') }];
  })) as Record<CodexChildRole, CodexRolePolicy>;
}

export const codexProfileName = (role: CodexChildRole) => `harness-${role}`;

export function compileCodexRoleProfile(role: CodexChildRole, policy: CodexRolePolicy, model: string, reasoning: string, instructions: string): string {
  const lines = [
    `# Advanced Harness role profile for ${role}; generated, re-applied by the role launcher on every run.`,
    ...(policy.mcp ? ['# advanced-harness: mcp=allowed'] : []),
    `sandbox_mode = ${quote(policy.sandbox)}`,
    // Children are non-interactive; the human approval point is Lead's launch of this process.
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
    'Delegate each role task by running the role launcher, and ask to run it outside the sandbox: the human approves every launch, and that approval is the checkpoint for the role\'s work.',
    '',
    `- New task: \`${launch}\``,
    `- Follow-up in the same role thread: add \`--resume <threadId>\` from the previous launch's output.`,
    '- Put the whole task in `--task` so the human sees it in the approval prompt. One role and one task per launch.',
    '- The launcher prints JSON with `status` (Working, Checking, Ready, Needs your decision), `summary`, `details` and `threadId`. Treat anything else as Needs your decision.',
    '',
    '| Role | Sandbox | Network | MCP |',
    '| :--- | :--- | :--- | :--- |',
    ...codexChildRoles.map(role => `| \`${role}\` | ${policies[role].sandbox} | ${policies[role].network ? 'yes' : 'no'} | ${policies[role].mcp ? 'selected servers' : 'off'} |`),
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

/** The launcher source shipped verbatim to $CODEX_HOME/advanced-harness/codex-role.mjs. */
export function codexRoleLauncherSource(): string {
  return readFileSync(fileURLToPath(new URL('./codex-role-launcher.mjs', import.meta.url)), 'utf8');
}
