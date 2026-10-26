# Experimental Antigravity model-inheritance handoff

**Status:** documentation-only experimental workflow. This is not a supported
per-role exact-model assignment feature and does not fulfill or close issue #70.

Antigravity's [subagents documentation](https://antigravity.google/docs/subagents/)
describes model tiers including `inherit`, `flash`, and `pro`. The exact-model
binding semantics for `inherit` are unknown: this guide does not establish that a
child uses the precise model selected by its parent. No supported catalog or
programmatic model-switch mechanism has been verified for this workflow.

The UI labels Claude Opus 5.5, Claude Sonnet 5.5, and Gemini 4 Argon are
user-observed examples only—not discovered provider IDs, entitlement evidence, or
recommendations. Per-role model preferences below express instructional intent;
they are not enforced configuration.

## Preconditions

- Use an isolated Antigravity project/session appropriate for a disposable manual
  smoke. Keep tools/tasks read-only and do not perform application writes.
- The human must be able to select the intended model in the main/Lead UI and
  understand that availability, entitlement, and exact child binding are not
  established by this guide.
- Do not use this procedure to change compiler/installer defaults or claim native
  exact-model selection support.

## Manual handoff

1. Before starting a child, finish or stop all other child work. There must be no
   active or background children; if child activity is uncertain, stop and resolve
   it before proceeding. Do not reuse a child created under a different model tier.
2. Record the Lead's currently selected model so it can be restored. In the
   main/Lead UI, manually select the desired model. Ask the human to confirm
   readiness in the conversation; do not infer readiness from a model response.
3. If the human cancels, the UI selection is unavailable, or anything is
   uncertain, do not spawn. Restore the recorded Lead model; if restoration cannot
   be confirmed, stop and report the unresolved selection. Cancellation does not
   undo any inference already started.
4. Spawn one fresh `model: inherit` child for a bounded, harmless, no-tools task.
   Let it complete before any next handoff. Do not run handoffs concurrently. On
   spawn or task failure, restore the recorded Lead model; if restoration cannot
   be confirmed, stop and report the unresolved selection.
5. After completion, manually restore the recorded Lead model in the UI. If the
   workflow is interrupted, restore it as soon as safely possible; if restoration
   cannot be confirmed in any case, stop and report the unresolved selection.

## Expected result and evidence

The workflow smoke succeeds only if the human-selected UI model is changed,
readiness is confirmed, the fresh child completes its harmless task, and the Lead
model is restored. On cancellation, failure, or interruption, restore the recorded
Lead model where safely possible; report an unconfirmed restoration as unresolved.
This demonstrates only that the manual sequence was performed; it does **not** prove
which model served the child.

Actual child-model attribution requires host runtime metadata or a documented
contract that binds the child to the selected exact model. A child saying which
model it is, or response style, is not attribution evidence. If such metadata or a
contract is unavailable, report model attribution as **unverified**. Do not perform
inference/live testing under this documentation scope; that requires separate
explicit authorization and an isolated context.

## Scope and open work

Issue #70 remains open: independent acceptance still requires supported explicit
per-agent model assignment, live catalog discovery where exposed, and honest
availability-versus-entitlement reporting. This experimental procedure neither
satisfies that acceptance nor waives it. Any phase-2 product changes require a
separate plan approval after feasibility review.
