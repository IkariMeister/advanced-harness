import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeRoles, type Ask, type NativeRole } from './native-installer.ts';
import { installAntigravity, diagnoseAntigravity } from './antigravity-adapter.ts';
import { installClaudeCode, diagnoseClaudeCode } from './claude-code-adapter.ts';

export const supportedHosts = ['opencode', 'claude-code', 'antigravity', 'codex', 'cursor'] as const;
export type HostId = typeof supportedHosts[number];

export function isSupportedHost(value: unknown): value is HostId {
  return typeof value === 'string' && (supportedHosts as readonly string[]).includes(value);
}

export function parseHostSelection(raw: string): HostId[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Host selection cannot be empty. Supported hosts: ${supportedHosts.join(', ')}, all`);
  }
  if (trimmed === 'all') {
    return [...supportedHosts];
  }
  const parts = trimmed.split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) {
    throw new Error(`Host selection cannot be empty. Supported hosts: ${supportedHosts.join(', ')}, all`);
  }
  for (const part of parts) {
    if (!isSupportedHost(part)) {
      throw new Error(`Unsupported host: "${part}". Supported hosts: ${supportedHosts.join(', ')}, or all`);
    }
  }
  // Return in canonical supportedHosts order, deduplicated
  const selected = new Set(parts as HostId[]);
  return supportedHosts.filter(host => selected.has(host));
}

export async function askHostSelection(ask: Ask, suggested = 'opencode'): Promise<HostId[]> {
  while (true) {
    const answer = (await ask(`Select host(s) (${supportedHosts.join(', ')}, comma-separated, or all)`, suggested)).trim();
    const candidate = answer || suggested;
    try {
      return parseHostSelection(candidate);
    } catch {
      // Loop on error to allow user to re-enter
    }
  }
}

export interface HostRolePreset {
  model: string;
  variant?: string;
  reasoningTier?: 'low' | 'medium' | 'high';
  tier?: 'standard' | 'high-reasoning' | 'fast' | 'inherit' | 'pro' | 'flash' | 'flash_lite' | 'opus' | 'sonnet' | 'haiku';
  notes?: string;
}

export const HOST_MODEL_PRESETS: Record<HostId, Record<NativeRole, HostRolePreset>> = {
  opencode: {
    lead: { model: 'openai/gpt-6-astra', variant: 'medium', reasoningTier: 'medium' },
    operator: { model: 'openai/gpt-5.3-codex-spark', variant: 'low', reasoningTier: 'low' },
    external: { model: 'openai/gpt-5.3-codex-spark', variant: 'low', reasoningTier: 'low' },
    researcher: { model: 'openai/gpt-6-luna', variant: 'medium', reasoningTier: 'medium' },
    planner: { model: 'openai/gpt-6.1-sol', variant: 'medium', reasoningTier: 'medium' },
    implementer: { model: 'openai/gpt-6-luna', variant: 'low', reasoningTier: 'low' },
    reviewer: { model: 'openai/gpt-6.1-sol', variant: 'low', reasoningTier: 'low' },
    qa: { model: 'openai/gpt-6-luna', variant: 'low', reasoningTier: 'low' },
  },
  'claude-code': {
    lead: { model: 'sonnet', tier: 'sonnet', notes: 'Lead orchestrator coordinating via marked CLAUDE.md block' },
    operator: { model: 'haiku', tier: 'haiku', notes: 'Fast local Git, worktree and memory operations' },
    external: { model: 'haiku', tier: 'haiku', notes: 'MCP tools, remote git, GitHub CLI' },
    researcher: { model: 'sonnet', tier: 'sonnet', notes: 'Codebase exploration with read-only tools' },
    planner: { model: 'opus', tier: 'opus', notes: 'Deep architecture and implementation planning' },
    implementer: { model: 'sonnet', tier: 'sonnet', notes: 'Source and test implementation' },
    reviewer: { model: 'opus', tier: 'opus', notes: 'High-precision code and test review' },
    qa: { model: 'sonnet', tier: 'sonnet', notes: 'Runtime and test verification' },
  },
  antigravity: {
    lead: { model: 'inherit', tier: 'inherit', notes: 'Session model / primary orchestrator' },
    operator: { model: 'flash_lite', tier: 'flash_lite', notes: 'Lightweight operational subagent' },
    external: { model: 'flash_lite', tier: 'flash_lite', notes: 'External MCP & remote service subagent' },
    researcher: { model: 'flash', tier: 'flash', notes: 'Fast codebase exploration subagent' },
    planner: { model: 'pro', tier: 'pro', notes: 'High-reasoning planning subagent' },
    implementer: { model: 'flash', tier: 'flash', notes: 'Fast code writing subagent' },
    reviewer: { model: 'pro', tier: 'pro', notes: 'High-reasoning code verification subagent' },
    qa: { model: 'flash', tier: 'flash', notes: 'Runtime QA subagent' },
  },
  codex: {
    lead: { model: 'openai/gpt-6-astra', reasoningTier: 'medium' },
    operator: { model: 'openai/gpt-5.3-codex-spark', reasoningTier: 'low' },
    external: { model: 'openai/gpt-5.3-codex-spark', reasoningTier: 'low' },
    researcher: { model: 'openai/gpt-6-luna', reasoningTier: 'medium' },
    planner: { model: 'openai/gpt-6.1-sol', reasoningTier: 'medium' },
    implementer: { model: 'openai/gpt-6-luna', reasoningTier: 'low' },
    reviewer: { model: 'openai/gpt-6.1-sol', reasoningTier: 'low' },
    qa: { model: 'openai/gpt-6-luna', reasoningTier: 'low' },
  },
  cursor: {
    lead: { model: 'standard', tier: 'standard', notes: 'In-session Lead orchestration phase' },
    operator: { model: 'fast', tier: 'fast', notes: 'In-session Operator phase' },
    external: { model: 'fast', tier: 'fast', notes: 'In-session External phase' },
    researcher: { model: 'standard', tier: 'standard', notes: 'In-session Researcher phase' },
    planner: { model: 'high-reasoning', tier: 'high-reasoning', notes: 'In-session Planner phase' },
    implementer: { model: 'standard', tier: 'standard', notes: 'In-session Implementer phase' },
    reviewer: { model: 'high-reasoning', tier: 'high-reasoning', notes: 'In-session Reviewer phase' },
    qa: { model: 'standard', tier: 'standard', notes: 'In-session QA phase' },
  },
};

export interface HostCapabilityProfile {
  host: HostId;
  displayName: string;
  isolationModel: 'native-subagents' | 'lead-driven-subagents' | 'cli-profile-exec' | 'in-session-phases' | 'not-deployed';
  permissionModel: 'native-allow-ask-deny' | 'settings-permissions-and-disallowed-tools' | 'hooks-and-subagent-tool-groups' | 'execpolicy-and-sandbox' | 'command-allowlist-and-prompt-phases' | 'not-deployed';
  configLocations: {
    project: string[];
    global: string[];
  };
  ghPrMergeGuard: string;
  disclosures: string[];
}

export const HOST_CAPABILITIES: Record<HostId, HostCapabilityProfile> = {
  opencode: {
    host: 'opencode',
    displayName: 'OpenCode V2',
    isolationModel: 'native-subagents',
    permissionModel: 'native-allow-ask-deny',
    configLocations: {
      project: ['.opencode/opencode.json', '.opencode/opencode.jsonc', 'opencode.json', 'opencode.jsonc'],
      global: ['opencode.json', 'opencode.jsonc'],
    },
    ghPrMergeGuard: 'Explicit deny rule in agents.*.permissions matching gh pr merge / gh.exe pr merge',
    disclosures: [
      'Executes 8 native inline roles (1 primary Lead + 7 subagents).',
      'Permissions enforced natively by OpenCode runtime (allow, ask, deny).',
      'Permission dialogs authorize tool operations, not conversational plans.',
    ],
  },
  'claude-code': {
    host: 'claude-code',
    displayName: 'Claude Code',
    isolationModel: 'native-subagents',
    permissionModel: 'settings-permissions-and-disallowed-tools',
    configLocations: {
      project: ['CLAUDE.md', '.claude/agents', '.claude/commands', '.claude/settings.json'],
      global: ['~/.claude/settings.json', '~/.claude.json'],
    },
    ghPrMergeGuard: 'Project .claude/settings.json denies Bash(gh pr merge) and gh.exe variants; prefix patterns are a workflow guardrail, not a sandbox.',
    disclosures: [
      'Lead is the project default agent (.claude/settings.json agent: lead) and delegates only to 7 child subagents in .claude/agents via Agent(...) tool scoping.',
      'Per-role tools use tools/disallowedTools allowlists. Operator, Implementer, Reviewer, and QA have no Bash tool because per-role Bash scoping cannot be expressed exactly.',
      'MCP aliases (jira, github, figma, stitch) and OpenCode Code Mode have no verified Claude identity; no .mcp.json is written and External has no MCP tools.',
      'Claude permission evaluation is deny > ask > allow; source ordered-last-match exceptions are downgraded to Claude prompts, never to allows.',
      'Project scope only. Claude Code runtime discovery, agent selection, and model aliases are not verified by this harness.',
    ],
  },
  antigravity: {
    host: 'antigravity',
    displayName: 'Google Antigravity',
    isolationModel: 'lead-driven-subagents',
    permissionModel: 'hooks-and-subagent-tool-groups',
    configLocations: {
      project: ['.agents/rules', '.agents/skills', '.agents/scripts/antigravity-merge-guard.mjs', '.agents/hooks.json', '.agents/mcp_config.json'],
      global: ['~/.gemini/config/rules', '~/.gemini/config/skills', '~/.gemini/config/scripts/antigravity-merge-guard.mjs', '~/.gemini/config/hooks.json', '~/.gemini/config/mcp_config.json'],
    },
    ghPrMergeGuard: 'PreToolUse lifecycle hook (scripts/antigravity-merge-guard.mjs) inspects run_command calls and blocks gh pr merge / gh.exe pr merge with deny',
    disclosures: [
      'Lead orchestrates 7 child roles dynamically via define_subagent/invoke_subagent rules.',
      'Role/tool-group ownership (External MCP, Implementer writes) is instruction-level enforced via Lead rules.',
      'PreToolUse hook guards direct run_command calls; command patterns are workflow conventions, not a sandbox against indirect scripts, aliases, or separate processes.',
    ],
  },
  codex: {
    host: 'codex',
    displayName: 'OpenAI Codex',
    isolationModel: 'not-deployed',
    permissionModel: 'not-deployed',
    configLocations: {
      project: ['.codex/config.toml'],
      global: ['~/.codex/config.toml'],
    },
    ghPrMergeGuard: 'No Codex merge guard is deployed; native integration is tracked in issue #45.',
    disclosures: [
      'Workflow artifacts can be compiled as .agents/skills/<name>/SKILL.md; artifacts are not installed by this harness.',
      'Codex skill invocation is not treated as parameter binding; caller-bound workflow artifacts are invocation-specific.',
      'Native role profiles, permissions, MCP configuration, and runtime behavior are not deployed; integration is tracked in issue #45.',
    ],
  },
  cursor: {
    host: 'cursor',
    displayName: 'Cursor IDE',
    isolationModel: 'not-deployed',
    permissionModel: 'not-deployed',
    configLocations: {
      project: ['.cursor/rules', '.cursor/skills', '.cursor/mcp.json'],
      global: ['~/.cursor/mcp.json'],
    },
    ghPrMergeGuard: 'No Cursor merge guard is deployed; native integration is tracked in issue #46.',
    disclosures: [
      'Workflow artifacts can be compiled as .cursor/skills/<name>/SKILL.md with manual-only invocation metadata; artifacts are not installed.',
      'Native roles, permissions, MCP configuration, and runtime behavior are not deployed; integration is tracked in issue #46.',
    ],
  },
};

export function detectInstalledHosts(
  project: string | undefined,
  home = homedir(),
  xdgConfigHome?: string,
  env: NodeJS.ProcessEnv = process.env
): HostId[] {
  const detected = new Set<HostId>();
  const globalOpenCode = resolve(join(xdgConfigHome ?? env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode'));

  // 1. OpenCode detection
  if (
    existsSync(join(globalOpenCode, 'opencode.json')) ||
    existsSync(join(globalOpenCode, 'opencode.jsonc')) ||
    (project && (
      existsSync(join(project, '.opencode')) ||
      existsSync(join(project, 'opencode.json')) ||
      existsSync(join(project, 'opencode.jsonc'))
    ))
  ) {
    detected.add('opencode');
  }

  // 2. Claude Code detection
  if (
    existsSync(join(home, '.claude')) ||
    existsSync(join(home, '.claude.json')) ||
    (project && (
      existsSync(join(project, 'CLAUDE.md')) ||
      existsSync(join(project, '.claude')) ||
      existsSync(join(project, '.mcp.json'))
    ))
  ) {
    detected.add('claude-code');
  }

  // 3. Antigravity detection
  if (
    existsSync(join(home, '.gemini', 'config')) ||
    existsSync(join(home, '.gemini', 'antigravity')) ||
    (project && (
      existsSync(join(project, '.agents')) ||
      existsSync(join(project, 'mcp_config.json')) ||
      existsSync(join(project, 'hooks.json'))
    ))
  ) {
    detected.add('antigravity');
  }

  // 4. Codex detection
  if (
    existsSync(join(home, '.codex')) ||
    (project && existsSync(join(project, '.codex')))
  ) {
    detected.add('codex');
  }

  // 5. Cursor detection
  if (
    existsSync(join(home, '.cursor')) ||
    (project && existsSync(join(project, '.cursor')))
  ) {
    detected.add('cursor');
  }

  if (detected.size === 0) {
    return ['opencode'];
  }

  return supportedHosts.filter(host => detected.has(host));
}

export interface HostAdapterInstallOptions {
  project?: string | undefined;
  global?: boolean | undefined;
  scope: 'project' | 'global';
  ask?: Ask;
  output?: (msg: string) => void;
  error?: (msg: string) => void;
  home?: string | undefined;
  recoveryDirectory?: string | undefined;
  agentsDirectory?: string | undefined;
  commandsDirectory?: string | undefined;
}

export interface HostAdapterUpdateOptions {
  project?: string | undefined;
  global?: boolean | undefined;
  scope: 'project' | 'global';
  ask?: Ask;
  output?: (msg: string) => void;
  error?: (msg: string) => void;
  home?: string | undefined;
  recoveryDirectory?: string | undefined;
  agentsDirectory?: string | undefined;
  commandsDirectory?: string | undefined;
}

export interface HostAdapterDoctorOptions {
  project?: string | undefined;
  global?: boolean | undefined;
  home?: string | undefined;
  globalDirectory?: string | undefined;
}

export interface HostAdapter {
  host: HostId;
  install(options: HostAdapterInstallOptions): Promise<void | number>;
  update?(options: HostAdapterUpdateOptions): Promise<void | number>;
  doctor?(options: HostAdapterDoctorOptions): Promise<{ ok: boolean; issues: string[]; notes: string[] }>;
}

const registeredAdapters = new Map<HostId, HostAdapter>();

export function registerHostAdapter(adapter: HostAdapter): void {
  registeredAdapters.set(adapter.host, adapter);
}

// Install and update share one Claude Code path; HostAdapterUpdateOptions has the same fields.
async function installClaudeCodeFromOptions(options: HostAdapterInstallOptions): Promise<number> {
  const ask: Ask = options.ask ?? (async (_q, s) => s ?? '');
  const output = options.output ?? ((msg: string) => console.log(msg));
  const error = options.error ?? ((msg: string) => console.error(msg));
  return await installClaudeCode({
    scope: options.scope,
    project: options.project,
    home: options.home,
    recoveryDirectory: options.recoveryDirectory,
    agentsDirectory: options.agentsDirectory,
    commandsDirectory: options.commandsDirectory,
    ask,
    output,
    error,
  });
}

// Built-in registration for Claude Code host adapter (project scope only)
registerHostAdapter({
  host: 'claude-code',
  install: installClaudeCodeFromOptions,
  update: installClaudeCodeFromOptions,
  async doctor(options) {
    return await diagnoseClaudeCode({
      project: options.project,
      agentsDirectory: undefined,
      commandsDirectory: undefined,
    });
  },
});

// Built-in registration for Antigravity host adapter
registerHostAdapter({
  host: 'antigravity',
  async install(options) {
    const ask: Ask = options.ask ?? (async (_q, s) => s ?? '');
    const output = options.output ?? ((msg: string) => console.log(msg));
    const error = options.error ?? ((msg: string) => console.error(msg));
    return await installAntigravity({
      scope: options.scope,
      project: options.project,
      home: options.home,
      recoveryDirectory: options.recoveryDirectory,
      agentsDirectory: options.agentsDirectory,
      commandsDirectory: options.commandsDirectory,
      ask,
      output,
      error,
    });
  },
  async update(options) {
    const ask: Ask = options.ask ?? (async (_q, s) => s ?? '');
    const output = options.output ?? ((msg: string) => console.log(msg));
    const error = options.error ?? ((msg: string) => console.error(msg));
    return await installAntigravity({
      scope: options.scope,
      project: options.project,
      home: options.home,
      recoveryDirectory: options.recoveryDirectory,
      agentsDirectory: options.agentsDirectory,
      commandsDirectory: options.commandsDirectory,
      ask,
      output,
      error,
    });
  },
  async doctor(options) {
    return await diagnoseAntigravity({
      project: options.project,
      home: options.home,
      globalDirectory: options.globalDirectory,
    });
  },
});

export function getHostAdapter(host: HostId): HostAdapter | undefined {
  return registeredAdapters.get(host);
}

export function clearRegisteredAdapters(): void {
  registeredAdapters.clear();
}
