import { HOST_MODEL_PRESETS, type HostRolePreset } from './host-registry.ts';
import type { NativeRole } from './native-role-types.ts';
import type { RoleDefinition } from './role-definitions.ts';
import type { WorkflowCommand, WorkflowCommandId } from './workflow-commands.ts';

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
        enableWriteTools: true, // Antigravity bundles run_command with write tools; needed for gh and git push
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
        enableWriteTools: true, // Antigravity bundles run_command with write tools; needed for lint/build/unit checks
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
        enableWriteTools: true, // Antigravity bundles run_command with write tools; needed for runtime/E2E checks
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
    '| Role | Model Tier | Write Tools (edits + `run_command`) | MCP Tools | Workspace | Role Description |',
    '| :--- | :--- | :--- | :--- | :--- | :--- |',
  ];

  for (const s of specs) {
    lines.push(`| **${s.name}** | \`${s.model}\` | ${s.enableWriteTools ? 'true' : 'false'} | ${s.enableMCPTools ? 'true' : 'false'} | \`${s.workspace}\` | ${s.instructionSummary} |`);
  }

  lines.push('');
  lines.push('## Subagent Definition Lifecycle');
  lines.push('- Define each child role at most once per session. Before calling `define_subagent`, reuse any existing definition for that role.');
  lines.push('- If `define_subagent` reports that the agent already exists, do not retry it; invoke the existing child with `invoke_subagent`.');
  lines.push('- If an existing definition does not match the table above (for example, it was created under an older version of this rule), do not work around it. Stop and ask the human to start a fresh session.');
  lines.push('');
  lines.push('## Subagent Execution Constraints');
  lines.push('- **Write Tools:** In Antigravity, write tools include both file editing and `run_command`. External, Reviewer, and QA have write tools enabled only so they can run commands; they must never use file-edit tools on application, test, or configuration source.');
  lines.push('- **External:** The ONLY subagent permitted to access MCP tools, GitHub CLI (`gh`), or remote Git pushing.');
  lines.push('- **Operator:** Owns local Git branches, worktrees, and shared `MEMORY.md`. Does not edit application code.');
  lines.push('- **Shared locations:** Task worktrees go under `worktreeDirectory` and shared memory is the file at `memoryPath`, both read from the Advanced Harness `project` (or interim `paths`) settings section in `AGENTS.md` or the context file it links. They are outside the workspace by design: never search the workspace for `MEMORY.md` or create one there. If a location is missing or unreadable, stop and ask the human to run `harness:update` or `harness:setup`.');
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
 * Builds the merge-guard hook command. Antigravity on Windows passes hook command
 * arguments to Node without stripping quotes, so a quoted path resolves as
 * `<cwd>\"<path>"` and every run_command fails (#94). On Windows the path is
 * therefore left unquoted, and a path containing whitespace cannot be expressed
 * safely. Other platforms keep the quoted form, which is unaffected.
 */
export function antigravityMergeGuardCommand(guardScriptPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') {
    return `node "${guardScriptPath}"`;
  }
  if (/\s/.test(guardScriptPath)) {
    throw new Error(
      `Antigravity merge-guard path contains whitespace: ${guardScriptPath}. ` +
      'Antigravity on Windows does not accept a quoted hook path, so the guard would block every run_command. ' +
      'Install from a location whose path has no spaces.'
    );
  }
  return `node ${guardScriptPath}`;
}

/**
 * Compiles hooks.json with the pre-tool merge guard.
 */
export function compileAntigravityHooks(
  guardScriptPath: string = 'scripts/antigravity-merge-guard.mjs',
  platform: NodeJS.Platform = process.platform
): AntigravityHookConfig {
  return buildAntigravityGuardHooks(antigravityMergeGuardCommand(guardScriptPath, platform));
}

/**
 * The quoted hook command written by earlier harness versions; treated as owned on update.
 */
function compileLegacyAntigravityHooks(guardScriptPath: string): AntigravityHookConfig {
  return buildAntigravityGuardHooks(`node "${guardScriptPath}"`);
}

function buildAntigravityGuardHooks(command: string): AntigravityHookConfig {
  return {
    'gh-pr-merge-guard': {
      enabled: true,
      PreToolUse: [
        {
          matcher: 'run_command',
          hooks: [
            {
              type: 'command',
              command,
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

/**
 * Compiles a reusable Antigravity workflow skill (SKILL.md) that accepts context
 * from the user's current invocation prompt and asks when required parameters are missing.
 */
export function compileAntigravitySkill(
  id: WorkflowCommandId,
  command: WorkflowCommand,
  scope: 'project' | 'global' = 'project'
): { relativePath: string; content: string } {
  let body = command.body;

  if (command.arguments.mode === 'full') {
    body = body.replace(
      /\$ARGUMENTS/g,
      '<provided in the user\'s current chat invocation prompt; if missing or ambiguous, stop and ask the user before taking action>'
    );
  } else if (id === 'report-defect') {
    body = body.replace(
      /\$1/g,
      '<parent issue key/URL from the user\'s current chat invocation prompt; if missing or ambiguous, stop and ask the user before taking action>'
    );
    body = body.replace(
      /\$2/g,
      '<defect description from the user\'s current chat invocation prompt; if missing or ambiguous, stop and ask the user before taking action>'
    );
  }

  const frontmatter = [
    '---',
    `name: ${id}`,
    `description: ${command.description}`,
    '---',
  ].join('\n');

  const content = `${frontmatter}\n${body.startsWith('\n') ? body.slice(1) : body}`;
  const relativePath = scope === 'project'
    ? `.agents/skills/${id}/SKILL.md`
    : `skills/${id}/SKILL.md`;

  return { relativePath, content };
}

/**
 * Deep equality comparison for JSON-compatible values independent of object key order.
 */
export function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.hasOwn(b as Record<string, unknown>, key)) return false;
    if (!isDeepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }

  return true;
}

/**
 * Merges hooks.json while strictly preserving all unrelated hooks and top-level properties.
 * Rejects ambiguous conflicts or malformed JSON before writing.
 */
export function mergeAntigravityHooksConfig(
  existingText: string | undefined,
  guardScriptPath: string,
  priorOwnedContent?: string,
  platform: NodeJS.Platform = process.platform
): AntigravityHookConfig {
  const desiredHook = compileAntigravityHooks(guardScriptPath, platform);

  if (existingText === undefined || !existingText.trim()) {
    return desiredHook;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(existingText);
  } catch (err) {
    throw new Error(`Malformed existing hooks.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid hooks.json: top-level value must be a JSON object.');
  }

  const existing = parsed as Record<string, unknown>;

  // Check if gh-pr-merge-guard already exists and conflicts
  if (Object.hasOwn(existing, 'gh-pr-merge-guard')) {
    const existingHook = existing['gh-pr-merge-guard'];
    const matchesDesired = isDeepEqual(existingHook, desiredHook['gh-pr-merge-guard']);

    let priorOwnedGuard: unknown;
    if (priorOwnedContent !== undefined && priorOwnedContent.trim()) {
      try {
        const priorParsed = JSON.parse(priorOwnedContent);
        if (priorParsed && typeof priorParsed === 'object' && !Array.isArray(priorParsed)) {
          priorOwnedGuard = (priorParsed as Record<string, unknown>)['gh-pr-merge-guard'];
        }
      } catch {
        // Ignore unparseable prior evidence
      }
    }
    const matchesPrior = priorOwnedGuard !== undefined && isDeepEqual(existingHook, priorOwnedGuard);
    const matchesLegacy = isDeepEqual(existingHook, compileLegacyAntigravityHooks(guardScriptPath)['gh-pr-merge-guard']);

    if (!matchesDesired && !matchesPrior && !matchesLegacy) {
      throw new Error('Conflicting unowned "gh-pr-merge-guard" definition in existing hooks.json; resolve conflict before installation.');
    }
  }

  // Preserve all existing keys and set gh-pr-merge-guard
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(existing)) {
    if (k !== 'gh-pr-merge-guard') {
      result[k] = v;
    }
  }
  result['gh-pr-merge-guard'] = desiredHook['gh-pr-merge-guard'];

  return result as AntigravityHookConfig;
}

/**
 * Merges mcp_config.json while strictly preserving all unrelated servers and top-level properties.
 * Rejects ambiguous conflicts or malformed JSON before writing.
 */
export function mergeAntigravityMcpConfig(
  existingText: string | undefined,
  desiredServers: AntigravityMcpConfig['mcpServers'] = {},
  priorOwnedContent?: string
): AntigravityMcpConfig {
  if (existingText === undefined || !existingText.trim()) {
    return compileAntigravityMcpConfig(desiredServers);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(existingText);
  } catch (err) {
    throw new Error(`Malformed existing mcp_config.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid mcp_config.json: top-level value must be a JSON object.');
  }

  const existing = parsed as Record<string, unknown>;
  let existingServers: Record<string, unknown> = {};

  if (Object.hasOwn(existing, 'mcpServers')) {
    if (!existing.mcpServers || typeof existing.mcpServers !== 'object' || Array.isArray(existing.mcpServers)) {
      throw new Error('Invalid mcp_config.json: "mcpServers" property must be a JSON object.');
    }
    existingServers = { ...(existing.mcpServers as Record<string, unknown>) };
  }

  let priorOwnedServers: Record<string, unknown> | undefined;
  if (priorOwnedContent !== undefined && priorOwnedContent.trim()) {
    try {
      const priorParsed = JSON.parse(priorOwnedContent);
      if (priorParsed && typeof priorParsed === 'object' && !Array.isArray(priorParsed) &&
          priorParsed.mcpServers && typeof priorParsed.mcpServers === 'object' && !Array.isArray(priorParsed.mcpServers)) {
        priorOwnedServers = priorParsed.mcpServers as Record<string, unknown>;
      }
    } catch {
      // Ignore unparseable prior evidence
    }
  }

  for (const [id, desired] of Object.entries(desiredServers)) {
    if (Object.hasOwn(existingServers, id)) {
      const current = existingServers[id];
      const matchesDesired = isDeepEqual(current, desired);
      const matchesPrior = priorOwnedServers !== undefined && Object.hasOwn(priorOwnedServers, id) && isDeepEqual(current, priorOwnedServers[id]);
      if (!matchesDesired && !matchesPrior) {
        throw new Error(`Conflicting unowned MCP server "${id}" in existing mcp_config.json; resolve conflict before installation.`);
      }
    }
    existingServers[id] = desired;
  }

  return {
    ...existing,
    mcpServers: existingServers as AntigravityMcpConfig['mcpServers'],
  };
}

/**
 * Returns the source code for the standalone executable antigravity-merge-guard.mjs
 */
export function getAntigravityMergeGuardMjsSource(): string {
  return `#!/usr/bin/env node

/**
 * Antigravity PreToolUse Lifecycle Hook: gh pr merge guard
 *
 * Reads PreToolUse JSON payload from stdin.
 * If the tool is run_command and attempts gh pr merge (or gh.exe pr merge),
 * responds with a hard DENY decision.
 * Otherwise responds with ALLOW.
 */

import { readFileSync } from 'node:fs';

export function splitCommandSegments(commandLine) {
  const segments = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '\\n' || ch === '\\r' || ch === ';') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        continue;
      }
      if (ch === '&' && commandLine[i + 1] === '&') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        i++;
        continue;
      }
      if (ch === '|' && commandLine[i + 1] === '|') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        i++;
        continue;
      }
      if (ch === '|') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

export function tokenizeCommand(segment) {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let tokenHasContent = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      tokenHasContent = true;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      tokenHasContent = true;
      continue;
    }

    if (!inSingle && !inDouble && /\\s/.test(ch)) {
      if (tokenHasContent || current.length > 0) {
        tokens.push(current);
        current = '';
        tokenHasContent = false;
      }
      continue;
    }

    if (inDouble && ch === '\\\\' && i + 1 < segment.length) {
      const next = segment[i + 1];
      if (next === '"' || next === '\\\\') {
        current += next;
        i++;
        tokenHasContent = true;
        continue;
      }
    }

    if (!inSingle && !inDouble && ch === '\\\\' && i + 1 < segment.length) {
      const next = segment[i + 1];
      if (/\\s|['"]/.test(next)) {
        current += next;
        i++;
        tokenHasContent = true;
        continue;
      }
    }

    current += ch;
    tokenHasContent = true;
  }

  if (tokenHasContent || current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function isGhExecutable(token) {
  const normalized = token.toLowerCase().replace(/\\\\/g, '/');
  const base = normalized.split('/').pop() || '';
  return base === 'gh' || base === 'gh.exe';
}

export function isGhPrMergeCommand(commandLine) {
  if (!commandLine || typeof commandLine !== 'string') {
    return false;
  }

  const segments = splitCommandSegments(commandLine);

  for (const segment of segments) {
    let tokens = tokenizeCommand(segment);
    if (!tokens.length) continue;

    if (tokens[0].startsWith('(')) {
      tokens[0] = tokens[0].slice(1);
      if (!tokens[0]) tokens.shift();
    }
    if (tokens.length && tokens[tokens.length - 1].endsWith(')')) {
      tokens[tokens.length - 1] = tokens[tokens.length - 1].slice(0, -1);
      if (!tokens[tokens.length - 1]) tokens.pop();
    }
    if (!tokens.length) continue;

    let startIdx = 0;
    while (startIdx < tokens.length) {
      const t = tokens[startIdx];
      if (t === '&' || t === '.') {
        startIdx++;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        startIdx++;
        continue;
      }
      const lower = t.toLowerCase();
      if (['env', 'command', 'nohup', 'exec'].includes(lower)) {
        startIdx++;
        continue;
      }
      break;
    }

    if (startIdx >= tokens.length) continue;

    const exeToken = tokens[startIdx];
    if (!isGhExecutable(exeToken)) {
      continue;
    }

    const verbs = [];
    let skipNext = false;

    for (let i = startIdx + 1; i < tokens.length; i++) {
      const tok = tokens[i];

      if (skipNext) {
        skipNext = false;
        continue;
      }

      if (['-R', '--repo', '-h', '--hostname'].includes(tok)) {
        skipNext = true;
        continue;
      }

      if (tok.startsWith('-')) {
        continue;
      }

      verbs.push(tok.toLowerCase());
    }

    if (verbs.length >= 2 && verbs[0] === 'pr' && verbs[1] === 'merge') {
      return true;
    }
  }

  return false;
}

export function evaluatePreToolUse(payload) {
  const toolName = payload?.toolCall?.name;
  const cmd = payload?.toolCall?.args?.CommandLine;

  if (toolName === 'run_command' && typeof cmd === 'string') {
    if (isGhPrMergeCommand(cmd)) {
      return {
        decision: 'deny',
        reason: 'Direct merge via "gh pr merge" is denied by policy. A human must merge on GitHub.',
      };
    }
  }

  return { decision: 'allow' };
}

// CLI execution when run directly
try {
  const input = readFileSync(0, 'utf8');
  const payload = JSON.parse(input);
  const result = evaluatePreToolUse(payload);
  process.stdout.write(JSON.stringify(result) + '\\n');
} catch {
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\\n');
}
`;
}
