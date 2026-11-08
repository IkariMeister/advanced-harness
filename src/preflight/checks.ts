import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { contextData } from '../project-context.ts';
import { locateProjectContext, validateProfile } from '../project-setup.ts';
import type { ChangeOrigin, PreflightCheck } from './types.ts';

/** Warns if the project context baseBranch was changed compared to the merge-base. */
export const baseContextCheck: PreflightCheck = {
  id: 'base-context',
  run({ worktree, changeset }) {
    let contextRel: string;
    let targetAbs: string;
    try {
      const { target } = locateProjectContext(worktree);
      targetAbs = target;
      contextRel = relative(resolve(worktree), target).replaceAll('\\', '/');
    } catch (error) {
      return { status: 'inconclusive', evidence: [`Project context resolution failed: ${error instanceof Error ? error.message : String(error)}`] };
    }

    const modified = changeset.entries.some((entry) => entry.path.replaceAll('\\', '/') === contextRel);
    if (!modified) {
      return { status: 'pass', evidence: [`Base context unmodified (${contextRel})`] };
    }

    try {
      const res = spawnSync('git', ['-C', worktree, '--literal-pathspecs', 'cat-file', '-e', `${changeset.mergeBase}:${contextRel}`]);
      if (res.status !== 0) {
        // Did not exist in merge-base (newly added context file in task branch)
        return { status: 'pass', evidence: [`Project context newly added in task branch (${contextRel})`] };
      }
      const showRes = spawnSync('git', ['-C', worktree, '--literal-pathspecs', 'cat-file', 'blob', `${changeset.mergeBase}:${contextRel}`], { encoding: 'utf8' });
      if (showRes.status !== 0) throw new Error(showRes.stderr.trim() || `git exit ${showRes.status}`);
      const oldText = showRes.stdout;
      const oldProfile = validateProfile(contextData(oldText, 'project'));
      const oldBaseBranch = oldProfile.baseBranch;

      const newText = readFileSync(targetAbs, 'utf8');
      const newProfile = validateProfile(contextData(newText, 'project'));
      const newBaseBranch = newProfile.baseBranch;

      if (oldBaseBranch !== newBaseBranch) {
        return {
          status: 'warn',
          evidence: [`Project context baseBranch was changed from '${oldBaseBranch}' to '${newBaseBranch}' in this worktree`],
        };
      }
      return { status: 'pass', evidence: [`Project context modified (${contextRel}) but baseBranch '${oldBaseBranch}' unchanged`] };
    } catch (error) {
      return {
        status: 'warn',
        evidence: [`Project context modified (${contextRel}) and merge-base comparison was inconclusive: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
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
