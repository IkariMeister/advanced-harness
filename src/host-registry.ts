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
  isolationModel: 'native-subagents' | 'cli-profile-exec' | 'in-session-phases' | 'not-deployed';
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
    isolationModel: 'not-deployed',
    permissionModel: 'not-deployed',
    configLocations: {
      project: ['CLAUDE.md', '.claude/agents', '.claude/commands', '.claude/settings.json', '.mcp.json'],
      global: ['~/.claude/settings.json', '~/.claude.json'],
    },
    ghPrMergeGuard: 'No Claude Code merge guard is deployed; static source-policy preflight reports blockers and integration is tracked in issue #43.',
    disclosures: [
      'Planned Lead coordination via a marked orchestration block in CLAUDE.md is not deployed by this harness.',
      'Workflow artifact compilation can emit documented command Markdown; no native role files or permission scope are deployed by this harness.',
      'Claude Code permission priority is deny > ask > allow; source ordered-last-match behavior is not assumed equivalent.',
      'Subagent disallowedTools Bash(pattern) removes Bash rather than proving equivalent resource-pattern scoping.',
      'Installer/update block Claude selection pending native integration issue #43; source-policy preflight is diagnostic only and no runtime enforcement is claimed.',
    ],
  },
  antigravity: {
    host: 'antigravity',
    displayName: 'Google Antigravity',
    isolationModel: 'not-deployed',
    permissionModel: 'not-deployed',
    configLocations: {
      project: ['.agents/rules', '.agents/skills', 'mcp_config.json', 'hooks.json'],
      global: ['~/.gemini/antigravity/mcp_config.json', '~/.gemini/antigravity/hooks.json'],
    },
    ghPrMergeGuard: 'No Antigravity merge guard is deployed; native integration is tracked in issue #44.',
    disclosures: [
      'Workflow artifacts can be compiled as .agents/skills/<name>/SKILL.md; artifacts are not installed by this harness.',
      'Native roles, permissions, hooks, MCP configuration, and runtime behavior are not deployed; integration is tracked in issue #44.',
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
