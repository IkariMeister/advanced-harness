import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePermissions, type PermissionRule } from "../src/permission-reconciliation.ts";
import { isOpenCodeGuardrailRule, openCodeGuardrailRules } from "../src/security-guardrails.ts";
const r = (action: string, resource: string, effect: PermissionRule["effect"]): PermissionRule => ({ action, resource, effect });

test("only inserted/prior evidenced rules receive shared provenance; obsolete defaults to keep", () => {
  const managed = r("shell", "gh *", "ask"), coincidental = r("shell", "git *", "ask");
  const result = reconcilePermissions({ existing: [coincidental, managed], prior: [{ rule: managed, sources: ["old"] }], desired: [{ rule: managed, sources: ["new"] }], });
  assert.deepEqual(result.provenance, [{ rule: managed, sources: ["new", "old"] }]);
  const kept = reconcilePermissions({ existing: [managed], prior: [{ rule: managed, sources: ["old"] }], desired: [], retiringSources: ['old'] });
  assert.deepEqual(kept.preview.retainedObsolete, [{ rule: managed, sources: [] }]);
  assert.deepEqual(kept.preview.removals, []);
  const removed = reconcilePermissions({ existing: [managed], prior: [{ rule: managed, sources: ["old"] }], desired: [], retiringSources: ['old'], removeObsolete: [managed] });
  assert.deepEqual(removed.rules, []);
});

test("deny/ask matching later rule prevents broad allow; restrictions stay ordered", () => {
  const restriction = r("shell", "gh pr merge *", "deny");
  const result = reconcilePermissions({ existing: [restriction], desired: [{ rule: r("shell", "gh *", "allow"), sources: ["integration"] }] });
  assert.equal(result.preview.conflicts.length, 1);
  assert.deepEqual(result.rules, [restriction]);
});

test("GH ASK fallback inserts before scoped constraints and merge denial remains last", () => {
  const scoped = r("shell", "gh pr create *", "allow"), deny = r("shell", "gh pr merge *", "deny");
  const result = reconcilePermissions({ existing: [scoped, deny], desired: [{ rule: r("shell", "gh *", "ask"), sources: ["integration"] }] });
  assert.deepEqual(result.rules, [r("shell", "gh *", "ask"), scoped, deny]);
});

test("edited, moved, and indistinguishable prior rules fail closed for removal", () => {
  const a = r("shell", "a *", "ask"), b = r("shell", "b *", "ask");
  for (const existing of [[r("shell", "a *", "deny")], [b, a], [a, a]]) {
    const result = reconcilePermissions({ existing, previousOrder: [a, b], prior: [{ rule: a, sources: ["x"] }], desired: [], retiringSources: ['x'], removeObsolete: [a] });
    assert.ok(result.preview.conflicts.length);
    assert.deepEqual(result.preview.removals, []);
  }
});

test('retiring one shared source retains the other and cannot remove its rule', () => {
  const rule = r('shell', 'gh *', 'ask');
  const input = { existing: [rule], prior: [{ rule, sources: ['native', 'github'] }], desired: [], retiringSources: ['github'] };
  assert.deepEqual(reconcilePermissions(input).provenance, [{ rule, sources: ['native'] }]);
  assert.ok(reconcilePermissions({ ...input, removeObsolete: [rule] }).preview.conflicts.length);
});

test('fresh policy can refine its own defaults, with final merge denies', () => {
  const policy = [r('*', '*', 'deny'), r('shell', '*', 'ask'), r('shell', 'gh pr create *', 'allow'), r('shell', 'gh pr merge *', 'deny')];
  const result = reconcilePermissions({ existing: [], initialInstall: true, desired: policy.map(rule => ({ rule, sources: ['native'] })) });
  assert.deepEqual(result.rules, policy);
  assert.deepEqual(result.preview.conflicts, []);
  assert.equal(result.provenance.length, policy.length);
});

test('wildcard action restrictions follow GH fallbacks and conflicts roll back all additions', () => {
  const deny = r('*', 'gh pr merge *', 'deny');
  const fallback = r('shell', 'gh *', 'ask');
  assert.deepEqual(reconcilePermissions({ existing: [deny], desired: [{ rule: fallback, sources: ['github'] }] }).rules, [fallback, deny]);
  const result = reconcilePermissions({ existing: [deny], desired: [{ rule: r('read', '*', 'allow'), sources: ['native'] }, { rule: r('shell', 'gh *', 'allow'), sources: ['github'] }] });
  assert.deepEqual(result.rules, [deny]);
  assert.deepEqual(result.preview.additions, []);
});

test("unknown matching rules are not ownership evidence", () => {
  const rule = r("shell", "exact", "ask");
  const result = reconcilePermissions({ existing: [rule], desired: [{ rule, sources: ["native"] }] });
  assert.deepEqual(result.provenance, []);
});

test('ambiguous action globs cannot bypass a user restriction', () => {
  const restriction = r('service_*', '*', 'deny');
  const result = reconcilePermissions({ existing: [restriction], desired: [{ rule: r('service_publish', '*', 'allow'), sources: ['integration'] }] });
  assert.ok(result.preview.conflicts.length);
  assert.deepEqual(result.rules, [restriction]);
});

test('duplicate contradictory identities fail closed without additions or mutation', () => {
  const duplicate = r('read', 'src/*', 'deny');
  const existing = [duplicate, { ...duplicate }];
  const before = structuredClone(existing);
  const result = reconcilePermissions({ existing, desired: [{ rule: r('read', 'src/*', 'allow'), sources: ['native'] }] });
  assert.ok(result.preview.conflicts.some(conflict => conflict.code === 'identity'));
  assert.deepEqual(result.rules, before);
  assert.deepEqual(result.preview.additions, []);
  assert.deepEqual(existing, before);
});

test('native skill rules insert before security guardrails while integration rules keep append order and post-guardrail custom denies conflict', () => {
  const base = [r('*', '*', 'deny'), r('read', '*', 'allow'), r('edit', '*', 'allow')];
  const guardrails = openCodeGuardrailRules(base);
  const existing = [...base, ...guardrails];
  const skillAllow = r('skill', 'harness-procedure-documentation-impact', 'allow');
  const desired = [...base, skillAllow, ...guardrails].map(rule => ({ rule, sources: ['native:implementer'] }));
  const updated = reconcilePermissions({
    existing,
    prior: existing.map(rule => ({ rule, sources: ['native:implementer'] })),
    previousOrder: existing,
    desired,
    retiringSources: ['native:implementer'],
  });
  assert.deepEqual(updated.preview.conflicts, []);
  assert.deepEqual(updated.preview.additions, [skillAllow]);
  const guards = updated.rules.map(isOpenCodeGuardrailRule);
  assert.ok(guards.indexOf(true) >= 0 && guards.slice(guards.indexOf(true)).every(Boolean), 'guardrails stay contiguous at the end');
  assert.ok(updated.rules.findIndex(rule => rule.action === 'skill') < guards.indexOf(true), 'native skill rule inserts before guardrails');

  const integrationRule = r('shell', 'gh pr view', 'allow');
  const withIntegration = reconcilePermissions({
    existing,
    prior: existing.map(rule => ({ rule, sources: ['native:external'] })),
    previousOrder: existing,
    desired: [{ rule: integrationRule, sources: ['integration:gh'] }],
  });
  assert.deepEqual(withIntegration.preview.conflicts, []);
  assert.deepEqual(withIntegration.rules.at(-1), integrationRule);

  const customDenyAfterGuardrails = r('skill', '*', 'deny');
  const blocked = reconcilePermissions({
    existing: [...existing, customDenyAfterGuardrails],
    prior: existing.map(rule => ({ rule, sources: ['native:implementer'] })),
    previousOrder: [...existing, customDenyAfterGuardrails],
    desired,
    retiringSources: ['native:implementer'],
  });
  assert.ok(blocked.preview.conflicts.some(conflict => conflict.code === 'last-match'));
  assert.deepEqual(blocked.rules, [...existing, customDenyAfterGuardrails]);
});

test('native non-guardrail rules conflict when inserted before overlapping post-guardrail rules unless broad ask fallback', () => {
  const base = [r('*', '*', 'deny'), r('read', '*', 'allow'), r('shell', '*', 'ask')];
  const guardrails = openCodeGuardrailRules(base);
  const existing = [...base, ...guardrails];
  const prior = existing.map(rule => ({ rule, sources: ['native:external'] }));

  for (const postGuardrail of [r('skill', '*', 'allow'), r('skill', '*', 'ask')]) {
    const denyBefore = reconcilePermissions({
      existing: [...existing, postGuardrail],
      prior,
      previousOrder: [...existing, postGuardrail],
      desired: [{ rule: r('skill', 'harness-procedure-unit-tests', 'deny'), sources: ['native:external'] }],
    });
    assert.ok(denyBefore.preview.conflicts.some(conflict => conflict.code === 'last-match'), `deny vs post-guardrail ${postGuardrail.effect}`);
    assert.deepEqual(denyBefore.rules, [...existing, postGuardrail]);
  }

  for (const postGuardrail of [r('skill', '*', 'allow'), r('skill', '*', 'deny')]) {
    const askBefore = reconcilePermissions({
      existing: [...existing, postGuardrail],
      prior,
      previousOrder: [...existing, postGuardrail],
      desired: [{ rule: r('skill', 'harness-procedure-unit-tests', 'ask'), sources: ['native:external'] }],
    });
    assert.ok(askBefore.preview.conflicts.some(conflict => conflict.code === 'last-match'), `non-fallback ask vs post-guardrail ${postGuardrail.effect}`);
    assert.deepEqual(askBefore.rules, [...existing, postGuardrail]);
  }

  const postCoveringAsk = r('skill', '*', 'ask');
  const allowBeforeAsk = reconcilePermissions({
    existing: [...existing, postCoveringAsk],
    prior,
    previousOrder: [...existing, postCoveringAsk],
    desired: [{ rule: r('skill', 'harness-procedure-unit-tests', 'allow'), sources: ['native:external'] }],
  });
  assert.ok(allowBeforeAsk.preview.conflicts.some(conflict => conflict.code === 'last-match'), 'allow vs post-guardrail covering ask');
  assert.deepEqual(allowBeforeAsk.rules, [...existing, postCoveringAsk]);

  const postNarrowAllow = r('shell', 'gh pr view', 'allow');
  const broadFallback = r('shell', 'gh *', 'ask');
  const fallbackBeforeAllow = reconcilePermissions({
    existing: [...existing, postNarrowAllow],
    prior,
    previousOrder: [...existing, postNarrowAllow],
    desired: [{ rule: broadFallback, sources: ['native:external'] }],
  });
  assert.deepEqual(fallbackBeforeAllow.preview.conflicts, []);
  const firstGuard = fallbackBeforeAllow.rules.findIndex(isOpenCodeGuardrailRule);
  assert.ok(fallbackBeforeAllow.rules.findIndex(rule => rule.action === 'shell' && rule.resource === 'gh *' && rule.effect === 'ask') < firstGuard);
  assert.deepEqual(fallbackBeforeAllow.rules.at(-1), postNarrowAllow);
});
