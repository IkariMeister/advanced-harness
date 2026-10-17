import { nativeRoles, type NativeRole } from './native-installer.ts';

export type ToolOwnershipRule = {
  role: NativeRole;
  domain: string;
  allowedCapabilities: readonly string[];
  deniedCapabilities: readonly string[];
  escalationTarget: string;
  approvalRequired: boolean;
};

export const ROLE_TOOL_OWNERSHIP: Record<NativeRole, ToolOwnershipRule> = {
  lead: {
    role: 'lead',
    domain: 'Coordination, plan approval, and task status',
    allowedCapabilities: ['subagent delegation', 'read', 'memory inspect'],
    deniedCapabilities: ['remote git push', 'gh pr merge', 'unauthorized source edits'],
    escalationTarget: 'human',
    approvalRequired: true
  },
  operator: {
    role: 'operator',
    domain: 'Local Git, worktrees, and shared memory',
    allowedCapabilities: ['local git (worktree, branch, status, diff)', 'shared memory write'],
    deniedCapabilities: ['remote git push', 'gh pr merge', 'service API writes'],
    escalationTarget: 'lead',
    approvalRequired: true
  },
  external: {
    role: 'external',
    domain: 'Remote Git, GitHub CLI, MCP services, Jira, design tools',
    allowedCapabilities: ['git push (scoped)', 'gh pr/issue/workflow (scoped)', 'execute (code mode)', 'mcp tools'],
    deniedCapabilities: ['gh pr merge (always DENY)', 'local source implementation', 'unapproved writes'],
    escalationTarget: 'lead',
    approvalRequired: true
  },
  researcher: {
    role: 'researcher',
    domain: 'Codebase inspection and local context discovery',
    allowedCapabilities: ['read', 'glob', 'grep'],
    deniedCapabilities: ['file write', 'git mutations', 'remote operations', 'websearch', 'webfetch'],
    escalationTarget: 'lead',
    approvalRequired: false
  },
  planner: {
    role: 'planner',
    domain: 'Implementation plan formulation and revision',
    allowedCapabilities: ['read', 'glob', 'grep'],
    deniedCapabilities: ['file write/edit', 'git mutations', 'service calls'],
    escalationTarget: 'lead',
    approvalRequired: true
  },
  implementer: {
    role: 'implementer',
    domain: 'Source and test implementation within approved scope',
    allowedCapabilities: ['edit', 'write', 'read', 'local test execution'],
    deniedCapabilities: ['remote git push', 'gh pr merge', 'scope expansion without approval'],
    escalationTarget: 'lead',
    approvalRequired: true
  },
  reviewer: {
    role: 'reviewer',
    domain: 'Code review, Gradle build/lint/unit tests, Roborazzi verification',
    allowedCapabilities: ['read', 'shell (test/build/lint runner)', 'glob', 'grep'],
    deniedCapabilities: ['source modification', 'remote git push', 'gh pr merge'],
    escalationTarget: 'lead',
    approvalRequired: false
  },
  qa: {
    role: 'qa',
    domain: 'Runtime, design, device, and E2E verification',
    allowedCapabilities: ['read', 'shell (test/device runner)', 'screenshot/video inspection'],
    deniedCapabilities: ['source modification', 'remote git push', 'gh pr merge'],
    escalationTarget: 'lead',
    approvalRequired: false
  }
};

export type ToolOwnershipViolation = {
  role: NativeRole;
  requestedAction: string;
  reason: string;
  escalateTo: string;
};

export function checkToolOwnership(
  role: NativeRole,
  action: string,
  resource: string
): { allowed: boolean; violation?: ToolOwnershipViolation } {
  const normAction = action.toLowerCase().trim();
  const normResource = resource.toLowerCase().trim();

  const command = parseOwnedCommand(normResource);

  // Unsupported command syntax is not evidence that an owned operation is safe.
  if ((normAction === 'shell' || normAction === 'execute') && command === 'unknown') {
    return ownershipViolation(role, action, resource, 'Unsupported command syntax; operation ownership cannot be verified.', 'lead');
  }

  // gh pr merge is DENY for all roles without exception
  if ((normAction === 'shell' || normAction === 'execute') && command === 'gh-merge') {
    return {
      allowed: false,
      violation: {
        role,
        requestedAction: `${action} ${resource}`,
        reason: 'Merging pull requests is human-only; gh pr merge is strictly denied for all agents.',
        escalateTo: 'human'
      }
    };
  }

  // Remote git push belongs strictly to external
  if ((normAction === 'shell' || normAction === 'execute') && command === 'git-push') {
    if (role !== 'external') {
      return {
        allowed: false,
        violation: {
          role,
          requestedAction: `${action} ${resource}`,
          reason: `Remote git push is owned exclusively by external; ${role} cannot push.`,
          escalateTo: 'external'
        }
      };
    }
  }

  // GitHub CLI operations belong to external
  if ((normAction === 'shell' || normAction === 'execute') && command === 'gh-other') {
    if (role !== 'external') {
      return {
        allowed: false,
        violation: {
          role,
          requestedAction: `${action} ${resource}`,
          reason: `GitHub CLI commands belong to external; ${role} cannot invoke gh.`,
          escalateTo: 'external'
        }
      };
    }
  }

  // Only explicitly identified context/memory files are editable by workflow owners.
  if (normAction === 'edit' || normAction === 'write') {
    const contextPath = /^(?:agents\.md|memory\.md|(?:memory|context)\/[^/\\]+\.md)$/i.test(normResource);
    const allowed = role === 'implementer' || (role === 'lead' && /^agents\.md$/i.test(normResource)) || (role === 'operator' && /^(?:memory\.md|memory\/[^/\\]+\.md)$/i.test(normResource));
    if (!allowed || (role !== 'implementer' && !contextPath)) {
      return {
        allowed: false,
        violation: {
          role,
          requestedAction: `${action} ${resource}`,
          reason: `File edits are owned by implementer (or operator for memory); ${role} cannot edit source files.`,
          escalateTo: 'implementer'
        }
      };
    }
  }

  return { allowed: true };
}

function ownershipViolation(role: NativeRole, action: string, resource: string, reason: string, escalateTo: string) {
  return { allowed: false, violation: { role, requestedAction: `${action} ${resource}`, reason, escalateTo } };
}

function parseOwnedCommand(resource: string): 'git-push' | 'gh-merge' | 'gh-other' | 'other' | 'unknown' {
  if (/[;&|`$<>\n\r]/.test(resource) || /(^|\s)(?:sudo|env|command)\s/.test(resource)) return 'unknown';
  const tokens: string[] = [];
  const pattern = /"([^"\\]*)"|'([^'\\]*)'|([^\s"']+)/gy;
  let cursor = 0;
  while (cursor < resource.length) {
    while (/\s/.test(resource[cursor] ?? '') && cursor < resource.length) cursor++;
    if (cursor >= resource.length) break;
    pattern.lastIndex = cursor;
    const match = pattern.exec(resource);
    if (!match || match.index !== cursor) return 'unknown';
    const token = match[1] ?? match[2] ?? match[3];
    if (token === undefined || !token.length) return 'unknown';
    tokens.push(token);
    cursor = pattern.lastIndex;
    if (cursor < resource.length && !/\s/.test(resource[cursor]!)) return 'unknown';
  }
  if (tokens.length === 0) return 'other';
  const first = tokens[0]!.replace(/^['"]|['"]$/g, '').toLowerCase();
  if (/^(?:git|git\.exe)$/.test(first)) {
    if (tokens[1]?.toLowerCase() === 'push') return 'git-push';
    if (tokens[1]?.toLowerCase().startsWith('pu') || tokens[1]?.toLowerCase().startsWith('push')) return 'unknown';
    if (tokens[1]?.toLowerCase() === '-c' || tokens[1]?.startsWith('-')) return 'unknown';
    return 'other';
  }
  if (/^(?:gh|gh\.exe)$/.test(first)) {
    if (tokens[1]?.toLowerCase() === 'pr' && tokens[2]?.toLowerCase() === 'merge') return 'gh-merge';
    if (tokens[1]?.toLowerCase() === 'pr' && tokens[2]?.toLowerCase().startsWith('mer')) return 'unknown';
    if (tokens[1]?.toLowerCase().startsWith('pr') && tokens[1]?.toLowerCase() !== 'pr') return 'unknown';
    if (tokens[1]?.startsWith('-') || tokens[2]?.startsWith('-')) return 'unknown';
    return 'gh-other';
  }
  if (/^(?:\.|\/|[a-z]:\\)/i.test(first)) return 'unknown';
  return 'other';
}

export function validateRoleToolMatrix(): { role: NativeRole; rule: ToolOwnershipRule }[] {
  return nativeRoles.map(role => ({
    role,
    rule: ROLE_TOOL_OWNERSHIP[role]
  }));
}
