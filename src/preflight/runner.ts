import { realpathSync } from 'node:fs';
import { contextData } from '../project-context.ts';
import { locateProjectContext, validateProfile } from '../project-setup.ts';
import { collectChangeset } from './changeset.ts';
import { baseContextCheck, changesetCheck, worktreeBoundaryCheck } from './checks.ts';
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

export const defaultChecks: readonly PreflightCheck[] = [changesetCheck, baseContextCheck, worktreeBoundaryCheck];

export type PreflightOptions = {
  worktree: string;
  base?: string | undefined;
  task?: string | undefined;
  checks?: readonly PreflightCheck[];
};

function inconclusiveAll(checks: readonly PreflightCheck[], reason: string): PreflightResult {
  const list = checks.length ? checks : [{ id: 'preflight' } as PreflightCheck];
  const results = list.map((check) => ({ id: check.id, status: 'inconclusive' as const, evidence: [reason] }));
  return { approved: false, blocking: [], warnings: [], metrics: {}, checks: results };
}

/** Runs checks in `id` order. A thrown check or failed tool call is `inconclusive`, never a pass. */
export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const rawChecks = options.checks ?? defaultChecks;
  if (!rawChecks.length) {
    return inconclusiveAll([], 'No checks configured to run.');
  }

  const checks = [...rawChecks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Set<string>();
  for (const check of checks) {
    if (ids.has(check.id)) {
      return inconclusiveAll(checks, `Duplicate preflight check id: ${check.id}`);
    }
    ids.add(check.id);
  }
  let worktree: string;
  try { worktree = realpathSync(options.worktree); } catch { return inconclusiveAll(checks, `Worktree not found: ${options.worktree}`); }
  const base = resolveBase(worktree, options.base);
  if ('error' in base) return inconclusiveAll(checks, base.error);
  let changeset: Changeset;
  try { changeset = collectChangeset(worktree, base.ref, base.source); } catch (error) {
    return inconclusiveAll(checks, `Changeset unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const results: CheckResult[] = [];
  const blocking: string[] = [];
  const warnings: string[] = [];
  const metrics: Record<string, number> = {};
  for (const check of checks) {
    try {
      const outcome = await check.run({ worktree, changeset, task: options.task });
      const validStatuses: CheckStatus[] = ['pass', 'warn', 'block', 'inconclusive'];
      const status: CheckStatus = validStatuses.includes(outcome.status) ? outcome.status : 'inconclusive';
      const evidence = [...outcome.evidence];
      if (status !== outcome.status) {
        evidence.push(`Invalid check status returned: ${String(outcome.status)}`);
      }
      results.push({ id: check.id, status, evidence });
      for (const [key, value] of Object.entries(outcome.metrics ?? {})) metrics[`${check.id}.${key}`] = value;
      if (status === 'block') blocking.push(...evidence.map((line) => `${check.id}: ${line}`));
      if (status === 'warn') warnings.push(...evidence.map((line) => `${check.id}: ${line}`));
    } catch (error) {
      results.push({ id: check.id, status: 'inconclusive', evidence: [`Check failed: ${error instanceof Error ? error.message : String(error)}`] });
    }
  }
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
