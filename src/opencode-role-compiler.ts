import type { NativeDefinition } from './native-installer.ts';
import type { NativeRole } from './native-role-types.ts';
import type { RoleDefinition } from './role-definitions.ts';
import { lowerOpenCodePolicy, type CapabilityDiagnostic } from './capability-policy.ts';

/** Compile explicit OpenCode-specific role deployment data into the persisted V2 agent shape. */
export function compileOpenCodeRole(definition: RoleDefinition): { definition?: NativeDefinition; diagnostics: CapabilityDiagnostic[] } {
  const deployment = definition.deployment.opencode;
  const lowered = lowerOpenCodePolicy(definition.id, deployment.policy);
  const diagnostics = [...definition.diagnostics, ...lowered.diagnostics];
  if (diagnostics.length || !lowered.permissions) return { diagnostics };
  return { definition: {
    description: definition.description,
    mode: definition.orchestration,
    model: deployment.model,
    permissions: lowered.permissions,
    system: definition.instructions
  }, diagnostics };
}

export function compileOpenCodeRoles(definitions: Record<NativeRole, RoleDefinition>): { definitions?: Record<NativeRole, NativeDefinition>; diagnostics: CapabilityDiagnostic[] } {
  const compiled = Object.fromEntries(Object.entries(definitions).map(([role, definition]) => [role, compileOpenCodeRole(definition)])) as Record<NativeRole, ReturnType<typeof compileOpenCodeRole>>;
  const diagnostics = Object.values(compiled).flatMap(result => result.diagnostics);
  if (diagnostics.length || Object.values(compiled).some(result => !result.definition)) return { diagnostics };
  return { definitions: Object.fromEntries(Object.entries(compiled).map(([role, result]) => [role, result.definition])) as Record<NativeRole, NativeDefinition>, diagnostics };
}
