import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeRoles, type Ask, type NativeRole } from './native-installer.ts';

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
  isolationModel: 'native-subagents' | 'cli-profile-exec' | 'in-session-phases';
  permissionModel: 'native-allow-ask-deny' | 'settings-permissions-and-disallowed-tools' | 'hooks-and-subagent-tool-groups' | 'execpolicy-and-sandbox' | 'command-allowlist-and-prompt-phases';
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
      project: ['CLAUDE.md', '.claude/agents', '.claude/commands', '.claude/settings.json', '.mcp.json'],
      global: ['~/.claude/settings.json', '~/.claude.json'],
    },
    ghPrMergeGuard: 'Deny rule in .claude/settings.json (permissions.deny) and role disallowedTools',
    disclosures: [
      'Lead coordinates via marked orchestration block in CLAUDE.md.',
      '7 specialized child roles defined in .claude/agents/*.md with role-scoped tools / disallowedTools.',
      'Tool permissions configured in .claude/settings.json (gh pr merge denied).',
    ],
  },
  antigravity: {
    host: 'antigravity',
    displayName: 'Google Antigravity',
    isolationModel: 'native-subagents',
    permissionModel: 'hooks-and-subagent-tool-groups',
    configLocations: {
      project: ['.agents/rules', '.agents/skills', 'mcp_config.json', 'hooks.json'],
      global: ['~/.gemini/antigravity/mcp_config.json', '~/.gemini/antigravity/hooks.json'],
    },
    ghPrMergeGuard: 'Pre-tool hook in hooks.json rejecting gh pr merge commands',
    disclosures: [
      'Lead coordinates child roles via define_subagent and invoke_subagent APIs.',
      'Subagent tool groups (enable_write_tools, enable_mcp_tools, Workspace mode) enforce role ownership.',
      'Workflow commands exposed as native skills in .agents/skills/<cmd>/SKILL.md.',
    ],
  },
  codex: {
    host: 'codex',
    displayName: 'OpenAI Codex',
    isolationModel: 'cli-profile-exec',
    permissionModel: 'execpolicy-and-sandbox',
    configLocations: {
      project: ['.codex/config.toml'],
      global: ['~/.codex/config.toml'],
    },
    ghPrMergeGuard: 'execpolicy deny rule for gh pr merge in .codex/config.toml',
    disclosures: [
      'Named role profiles defined in .codex/config.toml ([profiles.<role>]).',
      'Execution supported via codex exec --profile <role> or session checkpoints.',
      'Human-approval boundaries enforced by execpolicy and sandbox settings.',
    ],
  },
  cursor: {
    host: 'cursor',
    displayName: 'Cursor IDE',
    isolationModel: 'in-session-phases',
    permissionModel: 'command-allowlist-and-prompt-phases',
    configLocations: {
      project: ['.cursor/rules', '.cursor/commands', '.cursor/mcp.json'],
      global: ['~/.cursor/mcp.json'],
    },
    ghPrMergeGuard: 'Command allowlist / terminal guard in .cursor/settings and rule prompts',
    disclosures: [
      'Cursor executes workflow roles as structured in-session phases rather than isolated subagent processes.',
      'Rules defined in .cursor/rules/*.mdc with alwaysApply for Lead coordination.',
      'Workflow commands emitted in .cursor/commands/*.md.',
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

export interface HostAdapter {
  host: HostId;
  install(options: { project?: string | undefined; global?: boolean | undefined; scope: 'project' | 'global' }): Promise<void>;
  update?(options: { project?: string | undefined; global?: boolean | undefined; scope: 'project' | 'global' }): Promise<void>;
  doctor?(options: { project?: string | undefined; global?: boolean | undefined }): Promise<{ ok: boolean; issues: string[]; notes: string[] }>;
}

const registeredAdapters = new Map<HostId, HostAdapter>();

export function registerHostAdapter(adapter: HostAdapter): void {
  registeredAdapters.set(adapter.host, adapter);
}

export function getHostAdapter(host: HostId): HostAdapter | undefined {
  return registeredAdapters.get(host);
}

export function clearRegisteredAdapters(): void {
  registeredAdapters.clear();
}
