import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePermissions, type PermissionRule } from "../src/permission-reconciliation.ts";
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
