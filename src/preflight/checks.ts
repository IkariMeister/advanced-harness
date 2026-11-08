import type { ChangeOrigin, PreflightCheck } from './types.ts';

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
