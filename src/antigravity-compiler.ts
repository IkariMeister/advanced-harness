import { HOST_MODEL_PRESETS, type HostRolePreset } from './host-registry.ts';
import type { NativeRole } from './native-role-types.ts';
import type { RoleDefinition } from './role-definitions.ts';
import type { WorkflowCommandId } from './workflow-commands.ts';

export interface AntigravitySubagentSpec {
  name: NativeRole;
  description: string;
  model: 'inherit' | 'flash_lite' | 'flash' | 'pro';
  roleTitle: string;
  enableWriteTools: boolean;
  enableMCPTools: boolean;
  workspace: 'inherit' | 'branch' | 'share';
  instructionSummary: string;
}

export interface AntigravityRuleArtifact {
  path: string;
  content: string;
}

export interface AntigravityHookConfig {
  [hookName: string]: {
    enabled?: boolean;
    PreToolUse?: Array<{
      matcher: string;
      hooks: Array<{
        type?: string;
        command: string;
        timeout?: number;
      }>;
    }>;
    [event: string]: unknown;
  };
}

export interface AntigravityMcpConfig {
  mcpServers: Record<string, {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    disabled?: boolean;
  }>;
}

export interface AntigravityCompilationResult {
  rules: AntigravityRuleArtifact[];
  hooks: AntigravityHookConfig;
  mcp: AntigravityMcpConfig;
  diagnostics: string[];
}

/**
 * Maps child roles to native Antigravity subagent tool groups and workspace isolation.
 */
export function compileAntigravitySubagentSpec(
  role: NativeRole,
  definition: RoleDefinition,
  preset?: HostRolePreset
): AntigravitySubagentSpec {
  const modelTier = (preset?.tier ?? 'flash') as AntigravitySubagentSpec['model'];

  switch (role) {
    case 'operator':
      return {
        name: 'operator',
        description: definition.description,
        model: (preset?.tier ?? 'flash_lite') as AntigravitySubagentSpec['model'],
        roleTitle: 'Harness Git & Memory Operator',
        enableWriteTools: true, // Needs write to manage local worktrees and shared MEMORY.md
        enableMCPTools: false,
        workspace: 'inherit',
        instructionSummary: 'Owns local Git, worktree lifecycle, and shared MEMORY.md updates. Does not edit app source.',
      };
    case 'external':
      return {
        name: 'external',
        description: definition.description,
        model: (preset?.tier ?? 'flash_lite') as AntigravitySubagentSpec['model'],
        roleTitle: 'Harness Remote & Service Integrator',
        enableWriteTools: false, // Does not edit application code
        enableMCPTools: true,  // Exclusively owns MCP and remote services
        workspace: 'inherit',
        instructionSummary: 'Exclusively owns MCP tools, remote Git pushing, and GitHub CLI operations. Does not merge PRs.',
      };
    case 'researcher':
      return {
        name: 'researcher',
        description: definition.description,
        model: (preset?.tier ?? 'flash') as AntigravitySubagentSpec['model'],
        roleTitle: 'Codebase Researcher',
        enableWriteTools: false, // Read-only exploration
        enableMCPTools: false,
        workspace: 'inherit',
        instructionSummary: 'Explores codebase, reads files, and surveys architecture with read-only tools.',
      };
    case 'planner':
      return {
        name: 'planner',
        description: definition.description,
        model: (preset?.tier ?? 'pro') as AntigravitySubagentSpec['model'],
        roleTitle: 'Solution Architect & Planner',
        enableWriteTools: false, // Architectural planning only
        enableMCPTools: false,
        workspace: 'inherit',
        instructionSummary: 'Develops scoped implementation plans, test strategies, and risk assessments. Does not implement.',
      };
    case 'implementer':
      return {
        name: 'implementer',
        description: definition.description,
        model: (preset?.tier ?? 'flash') as AntigravitySubagentSpec['model'],
        roleTitle: 'Software Implementer',
        enableWriteTools: true, // Writes code and unit tests
        enableMCPTools: false,
        workspace: 'inherit',
        instructionSummary: 'Implements approved changes and unit tests. Does not touch remote Git or MCP.',
      };
    case 'reviewer':
      return {
        name: 'reviewer',
        description: definition.description,
        model: (preset?.tier ?? 'pro') as AntigravitySubagentSpec['model'],
        roleTitle: 'Code Reviewer & Quality Gate',
        enableWriteTools: false, // Reports findings, does not silently fix
        enableMCPTools: false,
        workspace: 'inherit',
        instructionSummary: 'Runs lint/build/unit checks and reports code quality findings. Does not modify app code.',
      };
    case 'qa':
      return {
        name: 'qa',
        description: definition.description,
        model: (preset?.tier ?? 'flash') as AntigravitySubagentSpec['model'],
        roleTitle: 'QA & Verification Specialist',
        enableWriteTools: false, // Reports verification results
        enableMCPTools: false,
        workspace: 'inherit',
        instructionSummary: 'Runs runtime/E2E verifications, Roborazzi, and device checks. Reports pass/fail findings.',
      };
    case 'lead':
    default:
      return {
        name: 'lead',
        description: definition.description,
        model: 'inherit',
        roleTitle: 'Lead Orchestrator',
        enableWriteTools: true,
        enableMCPTools: true,
        workspace: 'inherit',
        instructionSummary: 'Coordinates child subagents, presents plans to human, and gates consequential actions.',
      };
  }
}

/**
 * Compiles the Lead rule (.agents/rules/advanced-harness-lead.md)
 * Contains the orchestration contract, human approval gates, and the table of 7 subagents
 * to be registered via define_subagent.
 */
export function compileLeadOrchestrationRule(
  roles: Record<NativeRole, RoleDefinition>,
  presets: Record<NativeRole, HostRolePreset> = HOST_MODEL_PRESETS.antigravity
): AntigravityRuleArtifact {
  const childRoles: NativeRole[] = ['operator', 'external', 'researcher', 'planner', 'implementer', 'reviewer', 'qa'];
  const specs = childRoles.map(r => compileAntigravitySubagentSpec(r, roles[r], presets[r]));

  const lines: string[] = [
    '# Advanced Harness Lead Orchestrator Rule',
    '',
    'This rule governs the Lead agent when running in Google Antigravity.',
    '',
    '## Human Approval and Workflow Gates',
    '1. **Conversational Approval:** Lead presents plans, findings, and publishing checkpoints to the user and waits for explicit human approval before delegating to Implementer or External.',
    '2. **No Merging:** Merging pull requests is strictly human-only. External may push and open PRs upon final human approval, but never merges.',
    '3. **Child Subagent Delegation:** Lead coordinates the 7 specialized child roles using Antigravity\'s `define_subagent` and `invoke_subagent` APIs. Lead must configure child subagents with the exact parameters listed in the table below.',
    '',
    '## Subagent Role Registration Table',
    'When invoking child roles, call `define_subagent` (or use existing definitions) matching these parameters:',
    '',
    '| Role | Model Tier | Write Tools | MCP Tools | Workspace | Role Description |',
    '| :--- | :--- | :--- | :--- | :--- | :--- |',
  ];

  for (const s of specs) {
    lines.push(`| **${s.name}** | \`${s.model}\` | ${s.enableWriteTools ? 'true' : 'false'} | ${s.enableMCPTools ? 'true' : 'false'} | \`${s.workspace}\` | ${s.instructionSummary} |`);
  }

  lines.push('');
  lines.push('## Subagent Execution Constraints');
  lines.push('- **External:** The ONLY subagent permitted to access MCP tools, GitHub CLI (`gh`), or remote Git pushing.');
  lines.push('- **Operator:** Owns local Git branches, worktrees, and shared `MEMORY.md`. Does not edit application code.');
  lines.push('- **Implementer:** The ONLY subagent permitted to write application and test source code.');
  lines.push('- **Reviewer / QA:** Execute test and build commands to report findings; never modify application source directly.');
  lines.push('- **Precedence:** Current Human Decision > `AGENTS.md` > `MEMORY.md`.');
  lines.push('');

  const content = lines.join('\n');
  const byteLength = Buffer.byteLength(content, 'utf8');

  if (byteLength > 24000) {
    throw new Error(`Compiled Antigravity Lead rule exceeds 24,000 bytes (${byteLength} bytes).`);
  }

  return {
    path: '.agents/rules/advanced-harness-lead.md',
    content,
  };
}

/**
 * Compiles hooks.json with the pre-tool merge guard.
 */
export function compileAntigravityHooks(guardScriptPath: string = 'scripts/antigravity-merge-guard.mjs'): AntigravityHookConfig {
  return {
    'gh-pr-merge-guard': {
      enabled: true,
      PreToolUse: [
        {
          matcher: 'run_command',
          hooks: [
            {
              type: 'command',
              command: `node "${guardScriptPath}"`,
              timeout: 10,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Compiles mcp_config.json from project/global integration selections.
 */
export function compileAntigravityMcpConfig(
  servers: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; disabled?: boolean }> = {}
): AntigravityMcpConfig {
  const mcpServers: AntigravityMcpConfig['mcpServers'] = {};

  for (const [id, s] of Object.entries(servers)) {
    mcpServers[id] = {
      ...(s.command ? { command: s.command } : {}),
      ...(s.args ? { args: s.args } : {}),
      ...(s.env ? { env: s.env } : {}),
      ...(s.url ? { url: s.url } : {}),
      disabled: s.disabled ?? false,
    };
  }

  return { mcpServers };
}
