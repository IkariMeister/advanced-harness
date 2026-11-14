import { realpathSync } from 'node:fs';
import { contextData } from '../project-context.ts';
import { locateProjectContext, validateProfile } from '../project-setup.ts';
import { collectChangeset } from './changeset.ts';
import { baseContextCheck, changesetCheck, pathPolicyCheck, policyIntegrityCheck, secretScanCheck, TEST_CHANGE_CHECK_ID, testChangeCheck, validateSecretExceptions, worktreeBoundaryCheck, type SecretException } from './checks.ts';
import { acceptanceCriteriaCheck, displayText } from './criteria.ts';
import { applySeverity, builtInPreflightPolicy, effectiveForbiddenGlobs, loadProjectPreflightPolicy, policyCheck, PreflightPolicyError, type ProjectPreflightPolicy, type Severity } from './policy.ts';
import { isConfigurableBuiltIn, isTrustedPolicyDependent, validateSensitivePathGlobs } from './path-policy.ts';
import { scanAddedText } from './secret-scanner.ts';
import { TRUSTED_REF } from './trusted-context.ts';
import type { AcceptanceCriteriaInput, BypassEntry, CheckResult, CheckStatus, Changeset, PreflightCheck, PreflightExitCode, PreflightResult } from './types.ts';

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

/** `criteria` is the parsed `--criteria` file; `justifyNoTests` is the `--justify-no-tests` text, which must be nonblank when defined. Neither can approve. */
export type PreflightOptions = { worktree: string; base?: string | undefined; task?: string | undefined; checks?: readonly PreflightCheck[]; sensitivePathGlobs?: readonly string[]; secretExceptions?: readonly SecretException[]; secretScanner?: typeof scanAddedText; criteria?: AcceptanceCriteriaInput | undefined; justifyNoTests?: string | undefined };
type TaskInputs = { criteria?: AcceptanceCriteriaInput | undefined; justifyNoTests?: string | undefined };
type ExecuteChecksOptions = TaskInputs & { worktree: string; changeset: Changeset; checks: readonly PreflightCheck[]; custom: boolean; task?: string | undefined; policy?: ProjectPreflightPolicy | undefined; unavailableReason?: string | undefined };
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
  const testChange = testChangeCheck(policy.prodGlobs, policy.testGlobs);
  const builtIns = [changesetCheck, baseContextCheck, policyIntegrityCheck, worktreeBoundaryCheck, pathPolicy, secretScan, testChange, acceptanceCriteriaCheck];
  return [...builtIns.filter(check => !(isConfigurableBuiltIn(check) && disabled.has(check.id))), policyCheck(policy)];
}
export const defaultChecks = createDefaultChecks();

/** The fixed policy result ID. A caller-supplied check may not use it. */
const POLICY_CHECK_ID = 'policy';
const RESERVED_POLICY_ID_REASON = `Preflight check id "${POLICY_CHECK_ID}" is reserved for the built-in policy result.`;

/**
 * Every listed check is inconclusive with the same reason, as an early return or a duplicate-ID failure needs.
 * The fixed policy row is reported exactly once, whether or not the listed checks already include it.
 */
function inconclusiveAll(checks: readonly PreflightCheck[], reason: string): PreflightResult {
  const ids = [...checks.map((check) => check.id).filter((id) => id !== POLICY_CHECK_ID), POLICY_CHECK_ID];
  const results = ids.map((id) => ({ id, status: 'inconclusive' as const, evidence: [reason] }));
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

async function executeChecks({ worktree, changeset, checks: callerChecks, custom, task, policy, unavailableReason, criteria, justifyNoTests }: ExecuteChecksOptions): Promise<PreflightResult> {
  if (!callerChecks.length) return inconclusiveAll(callerChecks, 'No checks configured to run.');
  // Caller-supplied checks get the fixed policy row appended here. Built-in defaults already include it.
  if (custom && callerChecks.some((check) => check.id === POLICY_CHECK_ID)) return inconclusiveAll(callerChecks, RESERVED_POLICY_ID_REASON);
  const checks = custom ? [...callerChecks, policyCheck(policy ?? builtInPreflightPolicy())] : callerChecks;
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
  let bypassApplied = false;
  for (const check of ordered) {
    if (unavailableReason && isTrustedPolicyDependent(check)) {
      results.push({ id: check.id, status: 'inconclusive', evidence: [unavailableReason] });
      continue;
    }
    try {
      const outcome = await check.run({ worktree, changeset, task, gitlinkAcknowledgements: policy?.gitlinkAcknowledgements, trustedPolicyCommit: policy?.trustedCommit, criteria, justifyNoTests });
      const reported = ['pass', 'warn', 'block', 'inconclusive'].includes(outcome.status) ? outcome.status : 'inconclusive';
      // Severity applies only to built-in configurable instances, never to a custom check that reuses an ID or a marker.
      let status: CheckStatus = adjustedStatus(check, reported, policy);
      // A justified bypass applies after severity, so it downgrades a block however severity produced it. Only the built-in test-change instance is bypassable.
      if (status === 'block' && justifyNoTests !== undefined && check.id === TEST_CHANGE_CHECK_ID && isConfigurableBuiltIn(check)) {
        status = 'warn';
        bypassApplied = true;
      }
      results.push({ id: check.id, status, evidence: [...outcome.evidence, ...(reported === outcome.status ? [] : [`Invalid check status returned: ${String(outcome.status)}`])] });
      for (const [key, value] of Object.entries(outcome.metrics ?? {})) metrics[`${check.id}.${key}`] = value;
      if (status === 'block') blocking.push(...outcome.evidence.map(line => `${check.id}: ${line}`));
      if (status === 'warn') warnings.push(...outcome.evidence.map(line => `${check.id}: ${line}`));
    } catch (error) {
      results.push({ id: check.id, status: 'inconclusive', evidence: [`Check failed: ${error instanceof Error ? error.message : String(error)}`] });
    }
  }
  const bypass: BypassEntry[] | undefined = justifyNoTests === undefined ? undefined : [{ check: TEST_CHANGE_CHECK_ID, justification: justifyNoTests, applied: bypassApplied }];
  return { approved: results.length > 0 && results.every(result => result.status === 'pass' || result.status === 'warn'), blocking, warnings, metrics, checks: results, ...(bypass === undefined ? {} : { bypass }) };
}

/** Programmatic overrides replace only the value they name; the trusted file was still read and validated. */
function withProgrammaticOverrides(policy: ProjectPreflightPolicy, options: PreflightOptions): ProjectPreflightPolicy {
  return {
    ...policy,
    ...(options.sensitivePathGlobs === undefined ? {} : { sensitivePathGlobs: [...options.sensitivePathGlobs], forbiddenGlobMode: 'replace' as const }),
    ...(options.secretExceptions === undefined ? {} : { secretExceptions: [...options.secretExceptions] }),
  };
}

/**
 * A defined justification must be a nonblank string. A blank one would downgrade a block with no stated reason, so the
 * runner refuses it before any check runs. The text itself is never trimmed; it is recorded exactly as supplied.
 */
const BLANK_JUSTIFICATION_REASON = 'justifyNoTests must be a nonblank string; a blank justification cannot downgrade a block, so no checks were run.';

/** Runs checks in `id` order. A thrown check or failed tool call is `inconclusive`, never a pass. */
export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  if (options.checks !== undefined && (options.sensitivePathGlobs !== undefined || options.secretExceptions !== undefined || options.secretScanner !== undefined)) return inconclusiveAll(options.checks, 'Custom checks cannot be combined with preflight policy overrides.');
  if (options.justifyNoTests !== undefined && (typeof options.justifyNoTests !== 'string' || options.justifyNoTests.trim() === '')) return inconclusiveAll(options.checks ?? defaultChecks, BLANK_JUSTIFICATION_REASON);
  const taskInputs: TaskInputs = { criteria: options.criteria, justifyNoTests: options.justifyNoTests };
  let worktree: string;
  try { worktree = realpathSync(options.worktree); } catch { return inconclusiveAll(options.checks ?? defaultChecks, `Worktree not found: ${options.worktree}`); }
  const base = resolveBase(worktree, options.base);
  if ('error' in base) return inconclusiveAll(options.checks ?? defaultChecks, base.error.message);
  let changeset: Changeset;
  try { changeset = collectChangeset(worktree, base.ref, base.source); } catch (error) {
    return inconclusiveAll(options.checks ?? defaultChecks, `Changeset unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const custom = options.checks !== undefined;
  let policy: ProjectPreflightPolicy;
  try {
    policy = loadProjectPreflightPolicy(changeset.top, TRUSTED_REF, { forbiddenPathGlobs: options.sensitivePathGlobs !== undefined, secretExceptions: options.secretExceptions !== undefined });
  } catch (error) {
    if (error instanceof PreflightPolicyError && error.code === 'base-unavailable') {
      const reason = `Trusted preflight policy ref ${TRUSTED_REF} is unavailable; restore it with \`git remote set-head origin --auto\`. Passing --base selects the changeset comparison only; it does not replace trusted policy.`;
      return executeChecks({ worktree, changeset, checks: options.checks ?? defaultChecks, custom, task: options.task, ...taskInputs, unavailableReason: reason });
    }
    if (error instanceof PreflightPolicyError && error.code === 'git-failure') {
      const reason = `Trusted preflight policy ref ${TRUSTED_REF} could not be read: ${error.message}`;
      return executeChecks({ worktree, changeset, checks: options.checks ?? defaultChecks, custom, task: options.task, ...taskInputs, unavailableReason: reason });
    }
    const detail = error instanceof PreflightPolicyError ? error.message : 'validation failed.';
    return executeChecks({ worktree, changeset, checks: options.checks ?? defaultChecks, custom, task: options.task, ...taskInputs, unavailableReason: `Project preflight policy is invalid: ${detail}` });
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
  return executeChecks({ worktree, changeset, checks: rawChecks, custom, task: options.task, ...taskInputs, policy: effective });
}

export function exitCodeFor(result: PreflightResult): PreflightExitCode {
  if (result.checks.some((check) => check.status === 'inconclusive')) return 2;
  if (result.checks.some((check) => check.status === 'block')) return 1;
  return 0;
}

export function formatHuman(result: PreflightResult): string {
  const bypassApplied = (result.bypass ?? []).some(entry => entry.applied);
  const passLabel = (result.metrics['secret-scan.acknowledgedPaths'] ?? 0) > 0 ? 'PASS (ACKNOWLEDGED INCOMPLETE COVERAGE)' : bypassApplied ? 'PASS (JUSTIFIED BYPASS)' : 'PASS';
  const verdict = { 0: passLabel, 1: 'BLOCKED', 2: 'INCONCLUSIVE' }[exitCodeFor(result)];
  const lines = [`Preflight: ${verdict} (evidence only; a human approves publication)`];
  for (const check of result.checks) {
    lines.push(`  [${check.status}] ${check.id}`);
    for (const line of check.evidence) lines.push(`      ${line}`);
  }
  for (const entry of result.bypass ?? []) {
    const effect = entry.applied ? `${entry.check} block changed to warn` : `${entry.check} bypass not applied (no built-in block to change)`;
    lines.push(`Justified bypass (not approval): ${effect}. Justification: ${displayText(entry.justification)}`);
  }
  const metrics = Object.entries(result.metrics);
  if (metrics.length) lines.push('Metrics:', ...metrics.map(([key, value]) => `  ${key}: ${value}`));
  return lines.join('\n');
}
