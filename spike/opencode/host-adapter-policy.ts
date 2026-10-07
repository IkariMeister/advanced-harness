export const hostAgentRoles = ['lead', 'operator', 'external', 'researcher', 'planner', 'implementer', 'reviewer', 'qa'] as const;
export type HostAgentRole = typeof hostAgentRoles[number];

export const hostToolNames = {
  status: 'harness_status',
  action: 'harness_action',
  proposePlan: 'harness_propose_plan',
  reportFinding: 'harness_report_finding',
} as const;

const always = [hostToolNames.status] as const;
const allowed: Readonly<Record<HostAgentRole, readonly string[]>> = Object.freeze({
  lead: [...always, 'subagent'],
  operator: [...always, hostToolNames.action],
  external: [...always, hostToolNames.action, hostToolNames.reportFinding],
  researcher: [...always, hostToolNames.action],
  planner: [...always, hostToolNames.proposePlan],
  implementer: [...always, hostToolNames.action],
  reviewer: [...always, hostToolNames.action, hostToolNames.reportFinding],
  qa: [...always, hostToolNames.action, hostToolNames.reportFinding],
});

export function isHostAgentRole(agent: string): agent is HostAgentRole {
  return (hostAgentRoles as readonly string[]).includes(agent);
}

export function filterHostTools(agent: string, tools: Record<string, unknown>): void {
  const keep = new Set(isHostAgentRole(agent) ? allowed[agent] : always);
  for (const name of Object.keys(tools)) if (!keep.has(name)) delete tools[name];
}
