import { realpathSync } from 'node:fs';
import { contextData } from '../project-context.ts';
import { locateProjectContext, validateProfile } from '../project-setup.ts';
import { collectChangeset } from './changeset.ts';
import { baseContextCheck, changesetCheck, pathPolicyCheck, policyIntegrityCheck, secretScanCheck, validateSecretExceptions, worktreeBoundaryCheck, type SecretException } from './checks.ts';
import { applySeverity, builtInPreflightPolicy, effectiveForbiddenGlobs, loadProjectPreflightPolicy, policyCheck, PreflightPolicyError, type ProjectPreflightPolicy, type Severity } from './policy.ts';
import { isConfigurableBuiltIn, isTrustedPolicyDependent, validateSensitivePathGlobs } from './path-policy.ts';
import { scanAddedText } from './secret-scanner.ts';
import { TRUSTED_REF } from './trusted-context.ts';
import type { CheckResult, CheckStatus, Changeset, PreflightCheck, PreflightExitCode, PreflightResult } from './types.ts';

export class UnresolvedBaseError extends Error { override name = 'UnresolvedBaseError'; }
export type BaseResolution = { ref: string; source: 'option' | 'project-context' } | { error: UnresolvedBaseError };

/** `--base` wins; otherwise the project context `baseBranch`. There is no hardcoded fallback. */
export function resolveBase(worktree: string, option: string | undefined): BaseResolution {
  if (option) return { ref: option, source: 'option' };
  try {
    const { original } = locateProjectContext(worktree);
    const data = contextData(original, 'project');
    if (data === undefined) return { error: new UnresolvedBaseError('No base ref: pass --base or record baseBranch in project context.') };
    return { ref: validateProfile(data).baseBranch, source: 'project-context' };
  } catch (error) {
    return { error: new UnresolvedBaseError(`Project context could not be read: ${error instanceof Error ? error.message : String(error)}`) };
  }
}

export type PreflightOptions = { worktree: string; base?: string | undefined; task?: string | undefined; checks?: readonly PreflightCheck[]; sensitivePathGlobs?: readonly string[]; secretExceptions?: readonly SecretException[]; secretScanner?: typeof scanAddedText };
type ExecuteChecksOptions = { worktree: string; changeset: Changeset; checks: readonly PreflightCheck[]; task?: string | undefined; policy?: ProjectPreflightPolicy | undefined; unavailableReason?: string | undefined };
export type DefaultCheckOptions = { policy?: ProjectPreflightPolicy | undefined; sensitivePathGlobs?: readonly string[]; secretExceptions?: readonly SecretException[]; secretScanner?: typeof scanAddedText };

/**
 * Built-in checks for the effective policy, in id order of registration. Disabled configurable checks are dropped,
 * and the fixed `policy` row is appended. The forbidden-path globs come from the policy unless overridden.
 */
export function createDefaultChecks(options: DefaultCheckOptions = {}): readonly PreflightCheck[] {
  const policy = options.policy ?? builtInPreflightPolicy();
  const pathPolicy = pathPolicyCheck(options.sensitivePathGlobs ?? effectiveForbiddenGlobs(policy.forbiddenGlobMode, policy.sensitivePathGlobs));
  const secretScan = secretScanCheck(options.secretExceptions ?? policy.secretExceptions, options.secretScanner);
  const disabled = new Set(policy.disabled);
  const builtIns = [changesetCheck, baseContextCheck, policyIntegrityCheck, worktreeBoundaryCheck, pathPolicy, secretScan];
  return [...builtIns.filter(check => !(isConfigurableBuiltIn(check) && disabled.has(check.id))), policyCheck(policy)];
}
export const defaultChecks = createDefaultChecks();

function inconclusiveAll(checks: readonly PreflightCheck[], reason: string): PreflightResult {
  const list = checks.length ? checks : [{ id: 'preflight' } as PreflightCheck];
  const results = list.map((check) => ({ id: check.id, status: 'inconclusive' as const, evidence: [reason] }));
  return { approved: false, blocking: [], warnings: [], metrics: {}, checks: results };
}

const REPORTABLE_STATUSES: readonly CheckStatus[] = ['pass', 'warn', 'block', 'inconclusive'];

/**
 * Applies the trusted severity only to a built-in configurable instance. The severity is read as an own property,
 * and the adjusted status is validated again, so a bad value can never reach the result as a status.
 */
function adjustedStatus(check: PreflightCheck, reported: CheckStatus, policy: ProjectPreflightPolicy | undefined): CheckStatus {
  if (!isConfigurableBuiltIn(check)) return reported;
  const severities: Partial<Record<string, Severity>> = policy?.severity ?? {};
  const severity = Object.hasOwn(severities, check.id) ? severities[check.id] : undefined;
  const adjusted = applySeverity(reported, severity);
  return REPORTABLE_STATUSES.includes(adjusted) ? adjusted : 'inconclusive';
}

async function executeChecks({ worktree, changeset, checks, task, policy, unavailableReason }: ExecuteChecksOptions): Promise<PreflightResult> {
  if (!checks.length) return inconclusiveAll(checks, 'No checks configured to run.');
  const ordered = [...checks].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const seen = new Set<string>();
  for (const check of ordered) {
    if (seen.has(check.id)) return inconclusiveAll(ordered, `Duplicate preflight check id: ${check.id}`);
    seen.add(check.id);
  }
  const results: CheckResult[] = [];
  const blocking: string[] = [];
  const warnings: string[] = [];
  const metrics: Record<string, number> = {};
  for (const check of ordered) {
    if (unavailableReason && isTrustedPolicyDependent(check)) {
      results.push({ id: check.id, status: 'inconclusive', evidence: [unavailableReason] });
      continue;
    }
    try {
      const outcome = await check.run({ worktree, changeset, task, gitlinkAcknowledgements: policy?.gitlinkAcknowledgements, trustedPolicyCommit: policy?.trustedCommit });
      const reported = ['pass', 'warn', 'block', 'inconclusive'].includes(outcome.status) ? outcome.status : 'inconclusive';
      // Severity applies only to built-in configurable instances, never to a custom check that reuses an ID or a marker.
      const status = adjustedStatus(check, reported, policy);
      results.push({ id: check.id, status, evidence: [...outcome.evidence, ...(reported === outcome.status ? [] : [`Invalid check status returned: ${String(outcome.status)}`])] });
      for (const [key, value] of Object.entries(outcome.metrics ?? {})) metrics[`${check.id}.${key}`] = value;
      if (status === 'block') blocking.push(...outcome.evidence.map(line => `${check.id}: ${line}`));
      if (status === 'warn') warnings.push(...outcome.evidence.map(line => `${check.id}: ${line}`));
    } catch (error) {
      results.push({ id: check.id, status: 'inconclusive', evidence: [`Check failed: ${error instanceof Error ? error.message : String(error)}`] });
    }
  }
  return { approved: results.length > 0 && results.every(result => result.status === 'pass' || result.status === 'warn'), blocking, warnings, metrics, checks: results };
}

/** Programmatic overrides replace only the value they name; the trusted file was still read and validated. */
function withProgrammaticOverrides(policy: ProjectPreflightPolicy, options: PreflightOptions): ProjectPreflightPolicy {
  return {
    ...policy,
    ...(options.sensitivePathGlobs === undefined ? {} : { sensitivePathGlobs: [...options.sensitivePathGlobs], forbiddenGlobMode: 'replace' as const }),
    ...(options.secretExceptions === undefined ? {} : { secretExceptions: [...options.secretExceptions] }),
  };
}

/** Runs checks in `id` order. A thrown check or failed tool call is `inconclusive`, never a pass. */
export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  if (options.checks !== undefined && (options.sensitivePathGlobs !== undefined || options.secretExceptions !== undefined || options.secretScanner !== undefined)) return inconclusiveAll(options.checks, 'Custom checks cannot be combined with preflight policy overrides.');
  let worktree: string;
  try { worktree = realpathSync(options.worktree); } catch { return inconclusiveAll(options.checks ?? defaultChecks, `Worktree not found: ${options.worktree}`); }
  const base = resolveBase(worktree, options.base);
  if ('error' in base) return inconclusiveAll(options.checks ?? defaultChecks, base.error.message);
  let changeset: Changeset;
  try { changeset = collectChangeset(worktree, base.ref, base.source); } catch (error) {
    return inconclusiveAll(options.checks ?? defaultChecks, `Changeset unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let policy: ProjectPreflightPolicy;
  try {
    policy = loadProjectPreflightPolicy(changeset.top, TRUSTED_REF, { forbiddenPathGlobs: options.sensitivePathGlobs !== undefined, secretExceptions: options.secretExceptions !== undefined });
  } catch (error) {
    if (error instanceof PreflightPolicyError && error.code === 'base-unavailable') {
      const reason = `Trusted preflight policy ref ${TRUSTED_REF} is unavailable; restore it with \`git remote set-head origin --auto\`. Passing --base selects the changeset comparison only; it does not replace trusted policy.`;
      return executeChecks({ worktree, changeset, checks: options.checks ?? defaultChecks, task: options.task, unavailableReason: reason });
    }
    if (error instanceof PreflightPolicyError && error.code === 'git-failure') {
      const reason = `Trusted preflight policy ref ${TRUSTED_REF} could not be read: ${error.message}`;
      return executeChecks({ worktree, changeset, checks: options.checks ?? defaultChecks, task: options.task, unavailableReason: reason });
    }
    const detail = error instanceof PreflightPolicyError ? error.message : 'validation failed.';
    return executeChecks({ worktree, changeset, checks: options.checks ?? defaultChecks, task: options.task, unavailableReason: `Project preflight policy is invalid: ${detail}` });
  }
  const effective = withProgrammaticOverrides(policy, options);
  let rawChecks: readonly PreflightCheck[];
  try {
    if (options.sensitivePathGlobs !== undefined) validateSensitivePathGlobs(options.sensitivePathGlobs);
    validateSecretExceptions(effective.secretExceptions);
    rawChecks = options.checks ?? createDefaultChecks({
      policy: effective,
      ...(options.secretScanner === undefined ? {} : { secretScanner: options.secretScanner }),
    });
  } catch (error) {
    return inconclusiveAll(options.checks ?? defaultChecks, `Preflight policy is invalid: ${error instanceof Error ? error.message : 'validation failed.'}`);
  }
  return executeChecks({ worktree, changeset, checks: rawChecks, task: options.task, policy: effective });
}

export function exitCodeFor(result: PreflightResult): PreflightExitCode {
  if (result.checks.some((check) => check.status === 'inconclusive')) return 2;
  if (result.checks.some((check) => check.status === 'block')) return 1;
  return 0;
}

export function formatHuman(result: PreflightResult): string {
  const verdict = { 0: (result.metrics['secret-scan.acknowledgedPaths'] ?? 0) > 0 ? 'PASS (ACKNOWLEDGED INCOMPLETE COVERAGE)' : 'PASS', 1: 'BLOCKED', 2: 'INCONCLUSIVE' }[exitCodeFor(result)];
  const lines = [`Preflight: ${verdict} (evidence only; a human approves publication)`];
  for (const check of result.checks) {
    lines.push(`  [${check.status}] ${check.id}`);
    for (const line of check.evidence) lines.push(`      ${line}`);
  }
  const metrics = Object.entries(result.metrics);
  if (metrics.length) lines.push('Metrics:', ...metrics.map(([key, value]) => `  ${key}: ${value}`));
  return lines.join('\n');
}
