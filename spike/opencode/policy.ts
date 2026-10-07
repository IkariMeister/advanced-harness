export const roleNames = ['lead', 'operator', 'external', 'researcher', 'planner', 'implementer', 'reviewer', 'qa'] as const;
export type HarnessRole = typeof roleNames[number];
export const harnessToolNames = {
  status: 'harness_demo_status',
  propose: 'harness_demo_propose',
  apply: 'harness_demo_apply',
} as const;

const allowed: Readonly<Record<HarnessRole, readonly string[]>> = Object.freeze({
  lead: [harnessToolNames.status, 'subagent'],
  operator: [harnessToolNames.status],
  external: [harnessToolNames.status],
  researcher: [harnessToolNames.status, 'read', 'glob', 'grep'],
  planner: [harnessToolNames.status, harnessToolNames.propose, 'read', 'glob', 'grep'],
  implementer: [harnessToolNames.status, harnessToolNames.apply],
  reviewer: [harnessToolNames.status, 'read', 'glob', 'grep'],
  qa: [harnessToolNames.status],
});
const actionOwners: Readonly<Record<string, readonly HarnessRole[]>> = Object.freeze({
  [harnessToolNames.status]: roleNames,
  [harnessToolNames.propose]: ['planner'],
  [harnessToolNames.apply]: ['implementer'],
});

export function isHarnessRole(agent: string): agent is HarnessRole {
  return (roleNames as readonly string[]).includes(agent);
}

/** Restrict the actual per-model-call tool catalog; never rely on prompt instructions alone. */
export function filterToolCatalog(agent: string, tools: Record<string, unknown>): void {
  const keep = new Set(isHarnessRole(agent) ? allowed[agent] : [harnessToolNames.status]);
  for (const name of Object.keys(tools)) if (!keep.has(name)) delete tools[name];
}

export function roleMayUseAction(agent: string | undefined, action: string): boolean {
  const owners = actionOwners[action];
  if (!owners) return !action.startsWith('harness_');
  if (!agent || !isHarnessRole(agent)) return false;
  return owners.includes(agent);
}
