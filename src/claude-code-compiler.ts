import { stringify as stringifyYaml } from 'yaml';
import { nativeRoles, type NativeRole } from './native-role-types.ts';
import type { Capability, CapabilityPolicy, CapabilityRule } from './capability-policy.ts';
import type { RoleDefinition } from './role-definitions.ts';
import type { WorkflowCommand } from './workflow-commands.ts';
import { HOST_MODEL_PRESETS, type HostRolePreset } from './host-registry.ts';

/**
 * Pure Claude Code compilation. Every mapping here is fail-closed: a capability is granted
 * only when the source policy grants it for the whole role, and anything that cannot be
 * represented exactly is withheld and reported. Nothing here proves runtime enforcement.
 */

export const claudeManagedTools = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'Agent'] as const;
export const claudeChildRoles: readonly NativeRole[] = ['operator', 'external', 'researcher', 'planner', 'implementer', 'reviewer', 'qa'];

export const claudeMarkers = {
  start: '<!-- advanced-harness:lead:start -->',
  end: '<!-- advanced-harness:lead:end -->',
  reference: '@AGENTS.md',
} as const;

/** Project-level deny rules apply to every session and subagent, so they are safe to share. */
export const claudeSettingsDeny = ['Bash(gh pr merge)', 'Bash(gh pr merge *)', 'Bash(gh.exe pr merge)', 'Bash(gh.exe pr merge *)'] as const;
/** Prompt (never allow) for reads of environment files, matching the source *.env / *.env.* ask rules. */
export const claudeSettingsAsk = ['Read(./.env)', 'Read(./.env.*)', 'Read(**/.env)', 'Read(**/.env.*)'] as const;

const mergePattern = /^gh(?:\.exe)? pr merge(?: \*)?$/;

export interface ClaudeRoleMapping {
  role: NativeRole;
  tools: string[];
  disallowedTools: string[];
  /** Exact or stricter translations, for disclosure only. */
  mapped: string[];
  /** Source rules with no verified Claude equivalent; the affected tool or identity is withheld. */
  unsupported: string[];
}

const capabilityTools: Partial<Record<Capability, readonly string[]>> = {
  'file.read': ['Read'],
  'file.find': ['Glob'],
  'file.search': ['Grep'],
  'file.edit': ['Edit', 'Write'],
  'shell.run': ['Bash'],
  'web.fetch': ['WebFetch'],
  'web.search': ['WebSearch'],
  'user.question': ['AskUserQuestion'],
};

const unmappedCapabilities: readonly Capability[] = ['code-mode.execute', 'mcp.tool'];

function isGranted(effect: string): boolean {
  return effect === 'allow' || effect === 'ask';
}

/** Ordered-last-match over whole-capability rules gives the base decision for the role. */
function baseEffect(rules: readonly CapabilityRule[], capability: Capability): 'allow' | 'ask' | 'deny' {
  let effect: 'allow' | 'ask' | 'deny' = 'deny';
  for (const rule of rules) {
    if ((rule.capability === 'all' || rule.capability === capability) && rule.resource.kind === 'all') effect = rule.effect;
  }
  return effect;
}

export function mapClaudeRolePolicy(role: NativeRole, policy: CapabilityPolicy): ClaudeRoleMapping {
  const rules = policy.rules;
  const granted = new Set<string>();
  const mapped: string[] = [];
  const unsupported: string[] = [];
  const deniedPatterns = new Map<Capability, string[]>();
  const unrepresentedGrants = new Map<Capability, string[]>();
  const addPatternValue = (target: Map<Capability, string[]>, capability: Capability, value: string) => {
    target.set(capability, [...(target.get(capability) ?? []), value]);
  };

  for (const capability of Object.keys(capabilityTools) as Capability[]) {
    const tools = capabilityTools[capability]!;
    const base = baseEffect(rules, capability);
    const patterns = rules.filter(rule => rule.capability === capability && rule.resource.kind === 'native-pattern');
    let withheld = false;
    for (const pattern of patterns) {
      const value = pattern.resource.kind === 'native-pattern' ? pattern.resource.value : '';
      if (capability === 'shell.run' && pattern.effect === 'deny' && mergePattern.test(value)) {
        mapped.push(`${role}: shell "${value}" deny is enforced by project settings (${claudeSettingsDeny.join(', ')}).`);
        continue;
      }
      if (capability === 'file.read' && pattern.effect === 'ask' && /^\*\.env(\.\*)?$/.test(value)) {
        mapped.push(`${role}: read "${value}" ask is enforced by project settings (prompt on Read).`);
        continue;
      }
      if (pattern.effect === 'deny') {
        if (isGranted(base)) {
          withheld = true;
          addPatternValue(deniedPatterns, capability, value);
        }
        continue;
      }
      // An allow or ask exception: Claude prompts for the whole tool, which is never looser than the source.
      if (isGranted(base)) {
        mapped.push(`${role}: ${capability} ${pattern.effect} "${value}" downgraded to Claude default prompt (stricter).`);
      } else {
        withheld = true;
        addPatternValue(unrepresentedGrants, capability, value);
      }
    }
    if (isGranted(base) && !withheld) for (const tool of tools) granted.add(tool);
  }
  for (const [capability, values] of deniedPatterns) {
    unsupported.push(`${role}: ${capability} deny patterns (${values.join(', ')}) cannot be scoped per role in Claude Code; ${capabilityTools[capability]!.join('/')} withheld.`);
  }
  for (const [capability, values] of unrepresentedGrants) {
    unsupported.push(`${role}: ${capability} exception patterns (${values.join(', ')}) have no base grant and cannot be represented; ${capabilityTools[capability]!.join('/')} withheld.`);
  }

  if (rules.some(rule => rule.capability === 'directory.external' && rule.effect !== 'deny')) {
    mapped.push(`${role}: directory.external ask has no Claude binding; Claude default external-path prompting applies (unverified).`);
  }

  for (const capability of unmappedCapabilities) {
    if (rules.some(rule => rule.capability === capability && rule.effect !== 'deny')) {
      unsupported.push(`${role}: ${capability} has no verified Claude tool identity; not mapped (no MCP or Code Mode access is granted).`);
    }
  }

  const delegates = rules
    .filter(rule => rule.capability === 'agent.delegate' && rule.effect === 'allow' && rule.resource.kind === 'native-pattern')
    .map(rule => rule.resource.kind === 'native-pattern' ? rule.resource.value : '')
    .filter(value => (claudeChildRoles as readonly string[]).includes(value));
  const uniqueDelegates = [...new Set(delegates)];
  const delegateSpec = uniqueDelegates.length ? `Agent(${uniqueDelegates.join(', ')})` : undefined;
  const delegateOnlyRules = rules.filter(rule => rule.capability === 'agent.delegate' && rule.effect !== 'deny' && !(rule.resource.kind === 'native-pattern' && (claudeChildRoles as readonly string[]).includes(rule.resource.value)));
  if (delegateOnlyRules.length) unsupported.push(`${role}: agent.delegate rules naming non-child targets are not mapped.`);

  const ordered = claudeManagedTools.filter(tool => tool !== 'Agent' && granted.has(tool));
  const tools = [...ordered, ...(delegateSpec ? [delegateSpec] : [])];
  const allowedNames = new Set(tools.map(tool => tool.replace(/\(.*$/, '')));
  const disallowedTools = claudeManagedTools.filter(tool => !allowedNames.has(tool));
  return { role, tools, disallowedTools, mapped, unsupported };
}

export function compileClaudeSubagentFile(
  role: NativeRole,
  definition: RoleDefinition,
  mapping: ClaudeRoleMapping,
  preset: HostRolePreset = HOST_MODEL_PRESETS['claude-code'][role]
): string {
  const frontmatter: Record<string, unknown> = {
    name: role,
    description: definition.description,
    tools: mapping.tools.join(', '),
  };
  if (mapping.disallowedTools.length) frontmatter.disallowedTools = mapping.disallowedTools.join(', ');
  frontmatter.model = preset.model;
  const preface = role === 'lead'
    ? 'Lead for this Claude Code project. Delegate only to the named child agents and follow the project AGENTS.md.'
    : 'Generated advanced-harness subagent. Tool availability is limited to the frontmatter tools list; tools not listed are unavailable by design.';
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${preface}\n\n${definition.instructions.trim()}\n`;
}

export function compileClaudeCommandFile(command: WorkflowCommand): string {
  return `---\n${stringifyYaml({ description: command.description }, { lineWidth: 0 }).trimEnd()}\n---\n${command.body}`;
}

export function compileClaudeLeadBlock(mappings: Record<NativeRole, ClaudeRoleMapping>): string {
  const lines = [
    '## Advanced Harness Lead orchestration',
    '',
    'This project session runs as Lead (`.claude/agents/lead.md`). Lead coordinates only these child subagents:',
    '',
    '| Agent | Model | Scope |',
    '| :--- | :--- | :--- |',
    ...claudeChildRoles.map(role => `| \`${role}\` | \`${HOST_MODEL_PRESETS['claude-code'][role].model}\` | ${mappings[role].tools.join(', ') || 'no tools'} |`),
    '',
    '- Present the latest plan and wait for explicit human approval in this conversation before implementation or publishing delegation.',
    '- Never merge pull requests. `gh pr merge` is denied in `.claude/settings.json`.',
    '- Do not substitute agents or models silently. Ask the human when a required child capability is missing.',
    '- Not mapped to Claude Code (withheld, not verified): MCP service aliases (Jira, GitHub, Figma, Stitch), Code Mode, and per-role shell scoping. Operator, Implementer, Reviewer, and QA have no Bash tool.',
    '- Claude Code runtime behavior (agent discovery, `agent: lead`, `Agent(...)` delegation, model aliases) is not runtime-verified by this harness.',
  ];
  return lines.join('\n');
}

export function mergeClaudeMemory(existing: string | undefined, block: string): string {
  const { start, end, reference } = claudeMarkers;
  const fullBlock = `${start}\n${block.trimEnd()}\n${end}`;
  if (existing === undefined || existing.trim() === '') return `${fullBlock}\n\n${reference}\n`;
  const starts = existing.split(start).length - 1;
  const ends = existing.split(end).length - 1;
  if (starts !== ends || starts > 1) throw new Error('CLAUDE.md has malformed or duplicate advanced-harness Lead markers; resolve them manually. No files were changed.');
  let text: string;
  if (starts === 1) {
    const from = existing.indexOf(start), to = existing.indexOf(end);
    if (to < from) throw new Error('CLAUDE.md advanced-harness Lead markers are out of order; resolve them manually. No files were changed.');
    text = existing.slice(0, from) + fullBlock + existing.slice(to + end.length);
  } else {
    text = `${existing.replace(/\s+$/, '')}\n\n${fullBlock}\n`;
  }
  if (!text.split(/\r?\n/).some(line => line.trim() === reference)) text = `${text.replace(/\s+$/, '')}\n\n${reference}\n`;
  return text;
}

/** Trimmed text between the Lead markers, or undefined when the markers are absent or out of order. */
export function extractClaudeLeadBlock(text: string): string | undefined {
  const { start, end } = claudeMarkers;
  const from = text.indexOf(start);
  if (from < 0) return undefined;
  const to = text.indexOf(end, from + start.length);
  if (to < 0) return undefined;
  return text.slice(from + start.length, to).trim();
}

function unionStrings(current: unknown, additions: readonly string[]): string[] {
  const existing = Array.isArray(current) ? current.map(String) : [];
  return [...existing, ...additions.filter(item => !existing.includes(item))];
}

export function mergeClaudeSettings(existing: string | undefined): string {
  let parsed: unknown = {};
  if (existing !== undefined && existing.trim() !== '') {
    try { parsed = JSON.parse(existing); } catch { throw new Error('.claude/settings.json is not strict JSON; resolve it manually. No files were changed.'); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('.claude/settings.json root must be a JSON object. No files were changed.');
  const settings = parsed as Record<string, unknown>;
  if (settings.agent !== undefined && settings.agent !== 'lead') throw new Error('.claude/settings.json already selects a different default agent; resolve it intentionally. No files were changed.');
  settings.agent = 'lead';
  const permissions = settings.permissions === undefined ? {} : settings.permissions;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) throw new Error('.claude/settings.json permissions must be a JSON object. No files were changed.');
  const rules = permissions as Record<string, unknown>;
  rules.deny = unionStrings(rules.deny, claudeSettingsDeny);
  rules.ask = unionStrings(rules.ask, claudeSettingsAsk);
  settings.permissions = rules;
  return JSON.stringify(settings, null, 2) + '\n';
}

export function mappingsFor(definitions: Record<NativeRole, RoleDefinition>): Record<NativeRole, ClaudeRoleMapping> {
  return Object.fromEntries(nativeRoles.map(role => [role, mapClaudeRolePolicy(role, definitions[role].deployment.opencode.policy)])) as Record<NativeRole, ClaudeRoleMapping>;
}

export function claudeDisclosures(mappings: Record<NativeRole, ClaudeRoleMapping>): string[] {
  const unsupported = nativeRoles.flatMap(role => mappings[role].unsupported);
  return [...new Set(unsupported)];
}
