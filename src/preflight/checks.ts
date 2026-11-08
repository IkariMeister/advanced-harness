import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { locateProjectContext } from '../project-setup.ts';
import type { ChangeOrigin, PreflightCheck } from './types.ts';

function gitTop(worktree: string): string {
  const res = spawnSync('git', ['-C', worktree, '--literal-pathspecs', 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (res.error) throw new Error(`git rev-parse could not be started: ${res.error.message}`);
  if (res.status !== 0) throw new Error(res.stderr.trim() || `git rev-parse exit ${res.status}`);
  return res.stdout.trim();
}

/**
 * Checks that the project context file was not modified when the base ref was derived
 * from project context. Fails closed (blocks) on unverified changes when --base is omitted.
 */
export const baseContextCheck: PreflightCheck = {
  id: 'base-context',
  run({ worktree, changeset }) {
    let contextRelToTop: string;
    try {
      const top = gitTop(worktree);
      const { target } = locateProjectContext(worktree);
      contextRelToTop = relative(resolve(top), target).replaceAll('\\', '/');
    } catch (error) {
      return { status: 'inconclusive', evidence: [`Project context resolution failed: ${error instanceof Error ? error.message : String(error)}`] };
    }

    // Check if the project context file was modified, renamed, or deleted in the changeset
    const modified = changeset.entries.some((entry) => {
      const p = entry.path.replaceAll('\\', '/');
      const op = entry.oldPath?.replaceAll('\\', '/');
      return p === contextRelToTop || op === contextRelToTop;
    });

    if (changeset.baseSource === 'option') {
      return {
        status: 'pass',
        evidence: [
          `Base ref '${changeset.base}' explicitly provided via option`,
          modified ? `Project context file (${contextRelToTop}) modified, but overridden by explicit --base` : `Project context file (${contextRelToTop}) unmodified`,
        ],
      };
    }

    // baseSource is 'project-context': must not be modified in the changeset
    if (modified) {
      return {
        status: 'block',
        evidence: [
          `Project context (${contextRelToTop}) was modified in this changeset; pass explicit --base <ref> for authoritative base ref.`,
        ],
      };
    }

    return {
      status: 'pass',
      evidence: [`Project context (${contextRelToTop}) unmodified; using baseBranch from project context`],
    };
  },
};

/** Built-in check: reports the collected changeset. Guardrail checks (BH-067..071) plug in alongside it. */
export const changesetCheck: PreflightCheck = {
  id: 'changeset',
  run({ changeset }) {
    const counts: Record<ChangeOrigin, number> = { committed: 0, staged: 0, unstaged: 0, untracked: 0 };
    for (const entry of changeset.entries) counts[entry.origin] += 1;
    return {
      status: 'pass',
      evidence: [
        `Base ${changeset.base} (merge-base ${changeset.mergeBase.slice(0, 12)}), HEAD ${changeset.head.slice(0, 12)}`,
        `${changeset.entries.length} change(s): ${counts.committed} committed, ${counts.staged} staged, ${counts.unstaged} unstaged, ${counts.untracked} untracked`,
      ],
      metrics: { files: changeset.entries.length, ...counts },
    };
  },
};
