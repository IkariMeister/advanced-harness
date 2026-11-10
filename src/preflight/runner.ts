import { realpathSync } from 'node:fs';
import { contextData } from '../project-context.ts';
import { locateProjectContext, validateProfile } from '../project-setup.ts';
import { collectChangeset } from './changeset.ts';
import { baseContextCheck, changesetCheck, secretScanCheck, type SecretException } from './checks.ts';
import { pathPolicyCheck } from './path-policy.ts';
import { applySeverity, loadEffectivePolicy, POLICY_CHECK_ID, policyOutcome, type EffectivePolicy } from './policy.ts';
import type { CheckResult, CheckStatus, Changeset, PreflightCheck, PreflightExitCode, PreflightResult } from './types.ts';

export type BaseResolution = { ref: string; source: 'option' | 'project-context' } | { error: string };

/** `--base` wins; otherwise the project context `baseBranch`. There is no hardcoded fallback. */
export function resolveBase(worktree: string, option: string | undefined): BaseResolution {
  if (option) return { ref: option, source: 'option' };
  try {
    const { original } = locateProjectContext(worktree);
    const data = contextData(original, 'project');
    if (data === undefined) return { error: 'No base ref: pass --base or record baseBranch in project context.' };
    return { ref: validateProfile(data).baseBranch, source: 'project-context' };
  } catch (error) {
    return { error: `Project context could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export const defaultChecks: readonly PreflightCheck[] = [changesetCheck, baseContextCheck, pathPolicyCheck(), secretScanCheck()];

export type PreflightOptions = { worktree: string; base?: string | undefined; checks?: readonly PreflightCheck[]; secretExceptions?: readonly SecretException[] };

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Every listed id, and always the built-in `policy` row, is inconclusive with the same reason. Used when nothing
 * can run safely, so the result keeps its `policy` row on every early return.
 */
function inconclusiveIds(ids: readonly string[], reason: string): PreflightResult {
  const list = [...new Set([...(ids.length ? ids : ['preflight']), POLICY_CHECK_ID])].sort();
  return { approved: false, blocking: [], warnings: [], metrics: {}, checks: list.map((id) => ({ id, status: 'inconclusive' as const, evidence: [reason] })) };
}

/**
 * Runs checks in `id` order. The policy is loaded from the trusted ref after the changeset; a load error makes
 * every check inconclusive. Disabled checks are skipped and listed by the built-in `policy` result. Severity
 * overrides apply after each check's run. A thrown check or failed tool call is `inconclusive`, never a pass.
 */
export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const rawChecks = options.checks ?? [changesetCheck, baseContextCheck, pathPolicyCheck(), secretScanCheck(options.secretExceptions)];
  if (!rawChecks.length) {
    return inconclusiveIds([], 'No checks configured to run.');
  }

  const checks = [...rawChecks].sort(byId);
  // `policy` names the built-in result; a registered check with that id would collide with it.
  if (checks.some((check) => check.id === POLICY_CHECK_ID)) {
    return inconclusiveIds(checks.map((item) => item.id), `Preflight check id "${POLICY_CHECK_ID}" is reserved for the built-in policy result.`);
  }
  const ids = new Set<string>();
  for (const check of checks) {
    if (ids.has(check.id)) {
      return inconclusiveIds(checks.map((item) => item.id), `Duplicate preflight check id: ${check.id}`);
    }
    ids.add(check.id);
  }
  let worktree: string;
  try { worktree = realpathSync(options.worktree); } catch { return inconclusiveIds(checks.map((check) => check.id), `Worktree not found: ${options.worktree}`); }
  const base = resolveBase(worktree, options.base);
  if ('error' in base) return inconclusiveIds(checks.map((check) => check.id), base.error);
  let changeset: Changeset;
  try { changeset = collectChangeset(worktree, base.ref, base.source); } catch (error) {
    return inconclusiveIds(checks.map((check) => check.id), `Changeset unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  let policy: EffectivePolicy;
  try {
    policy = loadEffectivePolicy({ worktree, top: changeset.top, checks });
  } catch (error) {
    const reason = `Preflight policy could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
    return inconclusiveIds([...checks.map((check) => check.id), POLICY_CHECK_ID].sort(), reason);
  }

  const results: CheckResult[] = [];
  const blocking: string[] = [];
  const warnings: string[] = [];
  const metrics: Record<string, number> = {};
  const record = (id: string, status: CheckStatus, evidence: string[]) => {
    results.push({ id, status, evidence });
    if (status === 'block') blocking.push(...evidence.map((line) => `${id}: ${line}`));
    if (status === 'warn') warnings.push(...evidence.map((line) => `${id}: ${line}`));
  };

  const disabled = new Set(policy.disabled);
  for (const check of checks) {
    if (disabled.has(check.id)) continue;
    try {
      const outcome = await check.run({ worktree, changeset, policy });
      const validStatuses: CheckStatus[] = ['pass', 'warn', 'block', 'inconclusive'];
      const status: CheckStatus = validStatuses.includes(outcome.status) ? outcome.status : 'inconclusive';
      const evidence = [...outcome.evidence];
      if (status !== outcome.status) {
        evidence.push(`Invalid check status returned: ${String(outcome.status)}`);
      }
      const adjusted = applySeverity({ status, evidence, ...(outcome.metrics ? { metrics: outcome.metrics } : {}) }, policy.severity[check.id]);
      record(check.id, adjusted.status, adjusted.evidence);
      for (const [key, value] of Object.entries(adjusted.metrics ?? {})) metrics[`${check.id}.${key}`] = value;
    } catch (error) {
      record(check.id, 'inconclusive', [`Check failed: ${error instanceof Error ? error.message : String(error)}`]);
    }
  }

  const built = policyOutcome(policy);
  record(POLICY_CHECK_ID, built.status, built.evidence);
  results.sort(byId);
  const approved = results.length > 0 && results.every((result) => result.status === 'pass' || result.status === 'warn');
  return { approved, blocking, warnings, metrics, checks: results };
}

export function exitCodeFor(result: PreflightResult): PreflightExitCode {
  if (result.checks.some((check) => check.status === 'inconclusive')) return 2;
  if (result.checks.some((check) => check.status === 'block')) return 1;
  return 0;
}

export function formatHuman(result: PreflightResult): string {
  const verdict = { 0: 'PASS', 1: 'BLOCKED', 2: 'INCONCLUSIVE' }[exitCodeFor(result)];
  const lines = [`Preflight: ${verdict} (evidence only; a human approves publication)`];
  for (const check of result.checks) {
    lines.push(`  [${check.status}] ${check.id}`);
    for (const line of check.evidence) lines.push(`      ${line}`);
  }
  const metrics = Object.entries(result.metrics);
  if (metrics.length) lines.push('Metrics:', ...metrics.map(([key, value]) => `  ${key}: ${value}`));
  return lines.join('\n');
}
