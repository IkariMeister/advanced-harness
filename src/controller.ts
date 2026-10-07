import { z } from 'zod';
import { Store } from './store.ts';
import {
  audit, checks, decisionSchema, findingSchema, hash, owners, planTarget,
  requestSchema, requireThat, resultSchema, roles, target, verificationTarget,
  type Action, type Check, type Gate, type ParsedRequest, type Result, type Role, type State,
} from './protocol.ts';

export type Handler = Readonly<{
  input: z.ZodType;
  execute: (input: unknown) => Promise<Result>;
}>;
export type Options = {
  database: string; worktree: string; project: string; feature: string;
  /** Trusted host computes a digest of the complete verification inputs, including dirty files. */
  snapshot: () => string;
  handlers: Partial<Record<Action, Handler>>;
};

function idle(state: State): void {
  requireThat(!Object.values(state.operations).some(op => op.status === 'pending'), 'An action is still running');
}
function active(state: State): void {
  idle(state);
  requireThat(!state.paused, state.paused ?? 'Paused');
  requireThat(!Object.values(state.operations).some(op => op.status === 'uncertain'), 'Reconcile uncertain operations first');
}
function overridden(state: State, gate: Gate): boolean {
  return state.overrides.some(item => item.gate === gate && item.target === target(state));
}
function approvedPlan(state: State): void {
  requireThat(state.plan.revision > 0, 'A concrete plan is required');
  requireThat(state.planApproval === planTarget(state) || overridden(state, 'plan'), 'Plan approval required');
}
function completeChecks(state: State): void {
  for (const check of checks) {
    const record = state.checks[check];
    requireThat((record?.target === verificationTarget(state) && record.result.status === 'passed') || overridden(state, check), `${check} must pass or be explicitly waived`);
  }
}
function resolvedFeedback(state: State): void {
  requireThat(state.findings.every(f => f.decision === 'discarded' || f.decision === 'fixed') || overridden(state, 'feedback'), 'Findings require human decisions and approved fixes');
}
function invalidate(state: State): void {
  state.implementationApproval = null;
  for (const check of checks) state.checks[check] = null;
  state.overrides = [];
}

/** Construct only in a trusted host. Give agents individual ports, never this controller. */
export function createController(options: Options) {
  const snapshot = () => z.string().regex(/^[a-f0-9]{64}$/).parse(options.snapshot());
  const store = new Store({ ...options, snapshot: snapshot() });
  // Copy registrations so callers cannot swap executors after approval.
  const handlers = Object.fromEntries(Object.entries(options.handlers).map(([key, value]) => [key, Object.freeze({ ...value })])) as Options['handlers'];

  function sync(): void {
    const digest = snapshot();
    store.update(state => {
      idle(state);
      if (digest !== state.code.digest) {
        state.code = { revision: state.code.revision + 1, digest };
        invalidate(state);
        state.paused = 'Untracked checkout change; human-confirmed resume required';
        audit(state, 'checkout-changed', digest);
      }
    });
  }

  function status() {
    sync();
    const state = store.view();
    const { owner: _owner, ...view } = state;
    return { ...view, target: target(state), planTarget: planTarget(state) };
  }

  function decide(input: unknown): void {
    const decision = decisionSchema.parse(input);
    sync();
    store.update(state => {
      idle(state);
      requireThat(decision.target === target(state), 'Stale confirmation; review the current revision');
      if (decision.kind === 'reconcile') {
        const op = Object.hasOwn(state.operations, decision.operation) ? state.operations[decision.operation] : undefined;
        requireThat(op?.status === 'uncertain', 'Operation does not require reconciliation');
        op.status = decision.outcome;
        op.result = decision.outcome === 'completed' ? { status: 'passed', summary: `Human reconciled: ${decision.reason}` } : null;
        // Reconciliation acknowledges the side effect; it never manufactures verification evidence.
        audit(state, 'reconciled', `${decision.operation}: ${decision.outcome}: ${decision.reason}`);
        return;
      }
      if (decision.kind === 'resume') {
        requireThat(state.paused, 'Workflow is not paused');
        requireThat(!Object.values(state.operations).some(op => op.status === 'uncertain'), 'Reconcile uncertain operations first');
        state.paused = null;
        audit(state, 'resumed', decision.target);
        return;
      }
      active(state);
      switch (decision.kind) {
        case 'approve-plan':
          requireThat(state.plan.revision > 0, 'A concrete plan is required');
          state.planApproval = planTarget(state);
          break;
        case 'approve-implementation':
          approvedPlan(state);
          resolvedFeedback(state);
          completeChecks(state);
          state.implementationApproval = target(state);
          break;
        case 'override':
          state.overrides = state.overrides.filter(o => !(o.gate === decision.gate && o.target === decision.target));
          state.overrides.push({ target: decision.target, gate: decision.gate, reason: decision.reason });
          break;
        case 'findings': {
          requireThat(new Set(decision.entries.map(e => e.id)).size === decision.entries.length, 'Duplicate finding in batch');
          const selected = decision.entries.map(entry => {
            const finding = state.findings.find(f => f.id === entry.id);
            requireThat(finding?.revision === entry.revision && finding.decision === 'pending', 'Stale or already decided finding');
            return { finding, entry };
          });
          for (const { finding, entry } of selected) finding.decision = entry.decision;
          state.implementationApproval = null;
          break;
        }
      }
      audit(state, decision.kind, JSON.stringify(decision));
    });
  }

  function authorize(state: State, role: Role, request: ParsedRequest): void {
    active(state);
    requireThat(owners[request.action] === role, 'Action belongs to a different agent');
    if (request.action === 'edit-code' || checks.includes(request.action as Check) || request.action === 'push' || request.action === 'open-pr') approvedPlan(state);
    if (request.action === 'edit-code') {
      requireThat(new Set(request.findings).size === request.findings.length, 'Duplicate fix finding');
      for (const id of request.findings) requireThat(state.findings.some(f => f.id === id && f.decision === 'accepted'), 'Fix must reference an accepted finding');
      if (state.verificationStarted) requireThat(request.findings.length > 0 || overridden(state, 'feedback'), 'Post-review edits require accepted findings or a scoped feedback override');
    } else requireThat(request.findings.length === 0, 'Only edits may consume accepted findings');
    if (request.action === 'push' || request.action === 'open-pr') {
      resolvedFeedback(state);
      completeChecks(state);
      requireThat(state.implementationApproval === target(state) || overridden(state, 'implementation'), 'Implementation approval required');
      if (request.action === 'open-pr') requireThat(Object.values(state.operations).some(op => op.request.action === 'push' && op.status === 'completed' && op.result?.status === 'passed' && op.target === target(state)), 'Push the approved revision before opening the PR');
    }
  }

  async function execute(role: Role, input: unknown): Promise<{ replayed: boolean; result: Result }> {
    const request = requestSchema.parse(input);
    requireThat(owners[request.action] === role, 'Action belongs to a different agent');
    const handler = handlers[request.action];
    requireThat(handler, 'No trusted executor registered for this action');
    const payload = handler.input.parse(structuredClone(request.input));
    sync();
    const started = store.update(state => {
      active(state);
      const previous = Object.hasOwn(state.operations, request.id) ? state.operations[request.id] : undefined;
      if (previous) {
        requireThat(previous.requestHash === hash(request), 'Operation ID reused with different input');
        requireThat(previous.status === 'completed' && previous.result, 'Operation cannot be replayed; use reconciliation and a new ID');
        return { replayed: true as const, result: previous.result };
      }
      authorize(state, role, request);
      if (checks.includes(request.action as Check)) state.verificationStarted = true;
      // Re-running a check must not preserve an earlier approval/result if it fails.
      if (checks.includes(request.action as Check)) {
        state.checks[request.action as Check] = null;
        state.implementationApproval = null;
      }
      state.operations[request.id] = { request, requestHash: hash(request), target: target(state), status: 'pending', result: null };
      audit(state, 'action-started', `${role}: ${request.id}: ${request.action}`);
      return { replayed: false as const, digest: state.code.digest, verification: verificationTarget(state) };
    });
    if (started.replayed) return started;
    try {
      requireThat(snapshot() === started.digest, 'Checkout changed immediately before execution');
      const result = resultSchema.parse(await handler.execute(payload));
      const digest = snapshot();
      store.update(state => {
        const operation = state.operations[request.id]!;
        requireThat(operation.status === 'pending', 'Pending operation lost');
        const changed = digest !== state.code.digest;
        if (changed) {
          state.code = { revision: state.code.revision + 1, digest };
          invalidate(state);
        }
        if (request.action !== 'edit-code' && changed) {
          operation.status = 'uncertain';
          state.paused = 'Checkout changed during a non-edit action; reconcile and ask the human';
          audit(state, 'unexpected-change', request.id);
          return;
        }
        operation.status = 'completed';
        operation.result = result;
        if (checks.includes(request.action as Check)) state.checks[request.action as Check] = { target: started.verification, result };
        if (request.action === 'edit-code' && result.status === 'passed') {
          for (const finding of state.findings) if (request.findings.includes(finding.id)) finding.decision = 'fixed';
          state.implementationApproval = null;
        }
        if (result.status === 'failed' && ['edit-code', 'push', 'open-pr', 'sync-ticket'].includes(request.action)) state.paused = `${request.action} failed; ask the human before continuing`;
        audit(state, 'action-completed', `${request.id}: ${result.status}`);
      });
      requireThat(!store.view().paused, store.view().paused ?? 'Workflow paused');
      return { replayed: false, result };
    } catch (error) {
      store.update(state => {
        const operation = state.operations[request.id]!;
        if (operation.status === 'pending') {
          operation.status = 'uncertain';
          state.paused = 'Action outcome uncertain; human reconciliation required';
          audit(state, 'action-uncertain', request.id);
        }
      });
      throw error;
    }
  }

  function bindAgent(role: Role) {
    requireThat(roles.includes(role), 'Unknown agent');
    return Object.freeze({
      status,
      execute: (request: unknown) => execute(role, request),
      proposePlan(text: string) {
        requireThat(role === 'planner', 'Only Planner can propose a plan');
        z.string().trim().min(1).parse(text);
        sync();
        store.update(state => {
          active(state);
          state.plan = { revision: state.plan.revision + 1, text, digest: hash(text) };
          state.planApproval = null;
          invalidate(state);
          audit(state, 'plan-proposed', planTarget(state));
        });
      },
      reportFinding(input: unknown) {
        requireThat(['reviewer', 'qa', 'external'].includes(role), 'Only reviewers, QA, or the external owner report feedback');
        const entry = findingSchema.pick({ id: true, text: true }).parse(input);
        sync();
        store.update(state => {
          active(state);
          const previous = state.findings.find(f => f.id === entry.id);
          const replacement = { ...entry, revision: (previous?.revision ?? 0) + 1, decision: 'pending' as const };
          state.findings = state.findings.filter(f => f.id !== entry.id);
          state.findings.push(replacement);
          state.implementationApproval = null;
          audit(state, 'finding-reported', JSON.stringify(replacement));
        });
      },
    });
  }

  return Object.freeze({
    bindAgent,
    human: Object.freeze({ status, decide }),
    close: () => store.close(),
  });
}
