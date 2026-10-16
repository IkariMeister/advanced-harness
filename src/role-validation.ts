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
    allowedCapabilities: ['read', 'glob', 'grep', 'websearch', 'webfetch'],
    deniedCapabilities: ['file write', 'git mutations', 'remote operations'],
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

  // gh pr merge is DENY for all roles without exception
  if ((normAction === 'shell' || normAction === 'execute') && /gh(?:\.exe)?\s+pr\s+merge\b/i.test(normResource)) {
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
  if ((normAction === 'shell' || normAction === 'execute') && /^(?:git\s+push\b|git\.exe\s+push\b)/i.test(normResource)) {
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
  if ((normAction === 'shell' || normAction === 'execute') && /^(?:gh\b|gh\.exe\b)/i.test(normResource)) {
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

  // Source editing belongs strictly to implementer (and lead for project AGENTS instructions)
  if (normAction === 'edit' || normAction === 'write') {
    if (role !== 'implementer' && role !== 'lead' && role !== 'operator') {
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

export function validateRoleToolMatrix(): { role: NativeRole; rule: ToolOwnershipRule }[] {
  return nativeRoles.map(role => ({
    role,
    rule: ROLE_TOOL_OWNERSHIP[role]
  }));
}
