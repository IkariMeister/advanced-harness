export const nativeRoles = ['lead', 'operator', 'external', 'researcher', 'planner', 'implementer', 'reviewer', 'qa'] as const;
export type NativeRole = typeof nativeRoles[number];

export function modelReference(value: unknown): string | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const model = value as Record<string, unknown>;
    if (typeof model.providerID === 'string' && typeof model.model === 'string') {
      const variant = typeof model.variant === 'string' && model.variant ? `#${model.variant}` : '';
      value = `${model.providerID}/${model.model}${variant}`;
    }
  }
  if (typeof value !== 'string' || !/^[^\s/#]+\/[^\s#]+(?:#[^\s/#]+)?$/.test(value)) return undefined;
  return value;
}
