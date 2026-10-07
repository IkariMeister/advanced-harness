import { createHash } from 'node:crypto';
import { z } from 'zod';

export const roles = ['lead', 'operator', 'external', 'researcher', 'planner', 'implementer', 'reviewer', 'qa'] as const;
export type Role = typeof roles[number];
export const checks = ['review', 'build', 'lint', 'unit-test', 'screenshot-test', 'qa'] as const;
export type Check = typeof checks[number];
export const actions = ['read-context', 'edit-code', ...checks, 'push', 'open-pr', 'sync-ticket', 'local-git-read', 'save-memory'] as const;
export type Action = typeof actions[number];
export const gates = ['plan', 'implementation', 'feedback', ...checks] as const;
export type Gate = typeof gates[number];
export const owners: Readonly<Record<Action, Role>> = Object.freeze({
  'read-context': 'researcher', 'edit-code': 'implementer', review: 'reviewer',
  build: 'reviewer', lint: 'reviewer', 'unit-test': 'reviewer', 'screenshot-test': 'reviewer',
  qa: 'qa', push: 'external', 'open-pr': 'external', 'sync-ticket': 'external',
  'local-git-read': 'operator', 'save-memory': 'operator',
});

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative();
export const requestSchema = z.strictObject({
  id, action: z.enum(actions), input: z.json(), findings: z.array(id).default([]),
});
export type Request = z.input<typeof requestSchema>;
export type ParsedRequest = z.output<typeof requestSchema>;
export const resultSchema = z.strictObject({
  status: z.enum(['passed', 'failed']), summary: z.string().min(1),
});
export type Result = z.infer<typeof resultSchema>;
export const findingSchema = z.strictObject({
  id, revision: revision.positive(), text: z.string().min(1),
  decision: z.enum(['pending', 'accepted', 'discarded', 'fixed']),
});
export const decisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('approve-plan'), target: digest }),
  z.strictObject({ kind: z.literal('approve-implementation'), target: digest }),
  z.strictObject({ kind: z.literal('override'), target: digest, gate: z.enum(gates), reason: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal('findings'), target: digest, entries: z.array(z.strictObject({
    id, revision: revision.positive(), decision: z.enum(['accepted', 'discarded']),
  })).min(1) }),
  z.strictObject({ kind: z.literal('resume'), target: digest }),
  z.strictObject({ kind: z.literal('reconcile'), target: digest, operation: id,
    outcome: z.enum(['completed', 'not-completed']), reason: z.string().trim().min(1) }),
]);
export type HumanDecision = z.infer<typeof decisionSchema>;

const operationSchema = z.strictObject({
  request: requestSchema, requestHash: digest, target: digest,
  status: z.enum(['pending', 'completed', 'uncertain', 'not-completed']),
  result: resultSchema.nullable(),
});
export const stateSchema = z.strictObject({
  schema: z.literal(1), project: z.string().min(1), feature: id,
  owner: z.strictObject({ token: z.string(), pid: z.number().int().positive() }).nullable(),
  plan: z.strictObject({ revision, text: z.string(), digest }),
  code: z.strictObject({ revision, digest }),
  planApproval: digest.nullable(), implementationApproval: digest.nullable(),
  checks: z.record(z.enum(checks), z.strictObject({ target: digest, result: resultSchema }).nullable()),
  findings: z.array(findingSchema), verificationStarted: z.boolean(),
  overrides: z.array(z.strictObject({ target: digest, gate: z.enum(gates), reason: z.string() })),
  paused: z.string().nullable(),
  operations: z.record(id, operationSchema),
  audit: z.array(z.strictObject({ at: z.string(), event: z.string(), detail: z.string() })),
});
export type State = z.infer<typeof stateSchema>;

export class GateError extends Error {
  constructor(message: string) { super(message); this.name = 'GateError'; }
}
export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new GateError(message);
}
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function target(state: State): string {
  return hash({ plan: state.plan, code: state.code, findings: state.findings });
}
export function verificationTarget(state: State): string {
  return hash({ plan: state.plan, code: state.code });
}
export function planTarget(state: State): string { return hash(state.plan); }
export function audit(state: State, event: string, detail: string): void {
  state.audit.push({ at: new Date().toISOString(), event, detail });
}
export function emptyState(project: string, feature: string, snapshot: string): State {
  return stateSchema.parse({
    schema: 1, project, feature, owner: null,
    plan: { revision: 0, text: '', digest: hash('') }, code: { revision: 0, digest: snapshot },
    planApproval: null, implementationApproval: null,
    checks: Object.fromEntries(checks.map(check => [check, null])), findings: [],
    verificationStarted: false, overrides: [], paused: null, operations: {}, audit: [],
  });
}
