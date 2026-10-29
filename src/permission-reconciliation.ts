/** Pure reconciliation for OpenCode's ordered, last-match permission rules. */
export interface PermissionRule { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' }
export interface PermissionRequirement { rule: PermissionRule; sources: readonly string[] }
export interface AttributedRule { rule: PermissionRule; sources: readonly string[] }
export interface PermissionConflict { code: string; message: string }
export interface ReconciliationPreview {
  additions: PermissionRule[];
  removals: PermissionRule[];
  retainedObsolete: AttributedRule[];
  order: PermissionRule[];
  conflicts: PermissionConflict[];
}
export interface ReconciliationResult { rules: PermissionRule[]; provenance: AttributedRule[]; preview: ReconciliationPreview }
export interface ReconcileOptions {
  existing: readonly PermissionRule[];
  desired: readonly PermissionRequirement[];
  prior?: readonly AttributedRule[];
  /** Full previously saved order; required to detect movement relative to unowned rules. */
  previousOrder?: readonly PermissionRule[];
  /** Only these source identities are being replaced; other requirements remain active. */
  retiringSources?: readonly string[];
  removeObsolete?: readonly PermissionRule[];
  initialInstall?: boolean;
}

const identity = (r: PermissionRule) => JSON.stringify([r.action, r.resource]);
const same = (a: PermissionRule, b: PermissionRule) => identity(a) === identity(b) && a.effect === b.effect;
function covers(a: PermissionRule, b: PermissionRule): boolean {
  if (a.action !== '*' && a.action !== b.action) return false;
  return a.resource === '*' || a.resource === b.resource || a.resource.endsWith('*')
    && !/[*?\[\]{}]/.test(a.resource.slice(0, -1)) && b.resource.startsWith(a.resource.slice(0, -1));
}
const valid = (r: PermissionRule) => r && typeof r.action === 'string' && typeof r.resource === 'string'
  && ['allow', 'ask', 'deny'].includes(r.effect) && Object.keys(r).every(k => ['action', 'resource', 'effect'].includes(k));

function overlap(a: PermissionRule, b: PermissionRule): boolean | 'unknown' {
  const action = patternOverlap(a.action, b.action), resource = patternOverlap(a.resource, b.resource);
  if (action === false || resource === false) return false;
  return action === 'unknown' || resource === 'unknown' ? 'unknown' : true;
}
function patternOverlap(a: string, b: string): boolean | 'unknown' {
  if (a === b || a === '*' || b === '*') return true;
  const prefix = (s: string) => s.endsWith('*') && !/[*?\[\]{}]/.test(s.slice(0, -1)) ? s.slice(0, -1) : undefined;
  const x = prefix(a), y = prefix(b);
  if (x !== undefined && y !== undefined) return x.startsWith(y) || y.startsWith(x);
  if (x !== undefined && !/[*?\[\]{}]/.test(b)) return b.startsWith(x);
  if (y !== undefined && !/[*?\[\]{}]/.test(a)) return a.startsWith(y);
  return /[*?\[\]{}]/.test(a + b) ? 'unknown' : false;
}

export function reconcilePermissions(options: ReconcileOptions): ReconciliationResult {
  let rules = options.existing.map(r => ({ ...r }));
  const prior = options.prior ?? [];
  const conflicts: PermissionConflict[] = [];
  const conflict = (code: string, message: string) => conflicts.push({ code, message });
  const additions: PermissionRule[] = [], removals: PermissionRule[] = [];
  const retainedObsolete: AttributedRule[] = [];
  const owned = new Map<string, Set<string>>();
  if (options.initialInstall && rules.length) conflict('initial-install', 'Initial installation requires an empty permission list.');
  if (![...rules, ...options.desired.map(d => d.rule), ...prior.map(p => p.rule)].every(valid)) {
    conflict('invalid-rule', 'Unsupported permission rule shape.');
    return { rules, provenance: [...prior], preview: { additions: [], removals: [], retainedObsolete: [], order: rules, conflicts } };
  }
  for (const rule of rules) if (rules.some(other => identity(other) === identity(rule) && other.effect !== rule.effect)) conflict('identity', 'Contradictory existing permission identity.');
  let last = -1;
  for (const p of prior) {
    const matches = rules.flatMap((r, i) => same(r, p.rule) ? [i] : []);
    const at = matches[0] ?? -1;
    if (matches.length !== 1 || at <= last || owned.has(identity(p.rule))) conflict('invalid-prior', 'Prior rule is missing, duplicated, edited, or reordered.');
    last = at;
    owned.set(identity(p.rule), new Set(p.sources.filter(s => !options.retiringSources?.includes(s))));
  }
  if (options.previousOrder) {
    // All surviving old identities must remain uniquely identifiable and in order.
    let position = -1;
    for (const old of options.previousOrder) {
      const matches = rules.flatMap((r, i) => same(r, old) ? [i] : []);
      if (!matches.length) continue;
      const at = matches[0]!;
      if (matches.length !== 1 || at <= position) conflict('invalid-order', 'Previously saved permission order is ambiguous or changed.');
      position = at;
    }
  }
  for (const req of options.desired) {
    if (!req.sources.length || req.sources.some(s => !s.trim())) conflict('source', 'Requirements need nonempty source identities.');
    const matches = rules.filter(r => identity(r) === identity(req.rule));
    if (matches.some(r => r.effect !== req.rule.effect) || matches.length > 1) {
      conflict('identity', `Conflicting existing permission rule ${req.rule.action} ${req.rule.resource}.`);
      continue;
    }
    if (matches.length) {
      if (req.rule.effect === 'deny' && req.rule.action === 'shell' && /^gh(?:\.exe)? pr merge(?: \*)?$/.test(req.rule.resource) && rules.slice(rules.indexOf(matches[0]!) + 1).some(r => r.effect !== 'deny' && overlap(req.rule, r) !== false)) conflict('last-match', 'Existing required merge denial is overridden by a later rule.');
      req.sources.forEach(s => owned.get(identity(req.rule))?.add(s));
      continue; // A coincidental match never becomes owned.
    }
    let insertAt = rules.length;
    for (let index = 0; index < rules.length; index++) {
      const r = rules[index]!;
      // A single new policy batch has an explicitly reviewed internal order.
      if (additions.some(a => same(a, r))) continue;
      const relation = overlap(req.rule, r);
      if (relation === 'unknown' && r.effect !== req.rule.effect) conflict('overlap', 'Cannot establish safe permission overlap.');
      if (relation !== true || r.effect === req.rule.effect) continue;
      if (rules.slice(index + 1).some(later => covers(later, req.rule))) continue;
      // Only attributable native universal defaults can be refined by later setup.
      if (r.action === '*' && r.resource === '*' && prior.some(p => same(p.rule, r) && p.sources.some(s => s.startsWith('native:')))) continue;
      const fallback = req.rule.effect === 'ask' && (req.rule.resource === '*' && r.resource !== '*' || req.rule.resource.endsWith(' *')
        && r.resource.startsWith(req.rule.resource.slice(0, -1)));
      if (fallback) insertAt = Math.min(insertAt, index);
      else if (req.rule.effect !== 'deny' && r.effect === 'deny' || req.rule.effect === 'allow' && r.effect === 'ask' && !covers(r, req.rule)) {
        conflict('last-match', `Cannot override existing restriction ${r.action} ${r.resource}.`);
      }
    }
    rules.splice(insertAt, 0, { ...req.rule });
    additions.push({ ...req.rule });
    owned.set(identity(req.rule), new Set(req.sources));
  }
  for (const p of prior) {
    if (owned.get(identity(p.rule))?.size) continue;
    if (options.removeObsolete?.some(r => same(r, p.rule))) {
      rules = rules.filter(r => !same(r, p.rule));
      removals.push({ ...p.rule });
      owned.delete(identity(p.rule));
    } else retainedObsolete.push({ rule: { ...p.rule }, sources: [] });
  }
  for (const rule of options.removeObsolete ?? []) {
    if (!prior.some(p => same(p.rule, rule)) || owned.get(identity(rule))?.size) conflict('removal', 'Removal requires obsolete, attributable evidence with no active sources.');
  }
  // Conflicts are transactional: no partially applicable plan escapes to writers.
  if (conflicts.length) return { rules: options.existing.map(r => ({ ...r })), provenance: prior.map(p => ({ rule: { ...p.rule }, sources: [...p.sources] })), preview: { additions: [], removals: [], retainedObsolete: [], order: [...options.existing], conflicts } };
  const provenance = rules.filter(r => owned.has(identity(r))).map(rule => ({ rule: { ...rule }, sources: [...owned.get(identity(rule))!].sort() }));
  return { rules, provenance, preview: { additions, removals, retainedObsolete, order: [...rules], conflicts } };
}
