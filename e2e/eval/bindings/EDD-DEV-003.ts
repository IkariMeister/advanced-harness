// EDD-DEV-003 (positive, permissions): Operator inspects the canonical checkout, External fetches and fast-forwards main,
// and Operator creates the task worktree. The prepare step builds a local upstream inside the sandbox (no network): the
// scratch repository's main is pushed to a bare remote, then one more commit lands on that remote, so origin/main is one
// fast-forwardable commit ahead. prepare returns that commit as upstreamHead. The scripted roles run git through the
// shell tool. The judge reads the final Git state.
// Machine-checked: both observableFinalState assertions. The judge requires the canonical checkout's HEAD, origin/main,
// and the linked task worktree's HEAD to equal upstreamHead, and upstreamHead to differ from the HEAD before OpenCode
// ran. A stale origin/main therefore cannot pass. Not checked: which role ran which command beyond the role-transition
// record in the journey record.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalText } from '../../support/journey.ts';
import {
  checkOf,
  delegate,
  gitWorktreeListProducer,
  headOf,
  intermediate,
  report,
  shellStep,
  type BindingContext,
  type BindingJudgement,
  type ScenarioBinding,
} from '../binding-support.ts';
import type { OpenCodeSandbox } from '../../support/opencode-sandbox.ts';

export const scenarioId = 'EDD-DEV-003';
export const scenarioVersion = '1.0.0';

const USER_PROMPT = '/start-issue 90102';
const TASK_BRANCH = 'issue/90102';
/** Relative to the scratch project, so the worktree lands in <sandbox root>/worktrees/. */
const WORKTREE_PATH = '../worktrees/issue-90102';
const UPSTREAM_HEAD = 'upstreamHead';
const CANONICAL_CHECK = 'canonical checkout remains clean on updated main';
const WORKTREE_CHECK = `task worktree exists on branch ${TASK_BRANCH}`;

/**
 * Local upstream for the sandbox. Only local git operations: a bare repository inside the sandbox root, the scratch
 * main pushed to it, then one commit added by a second clone and pushed. The scratch repository's origin/main stays
 * behind until the scripted fetch. Returns the pushed commit as upstreamHead.
 */
function prepare(sandbox: OpenCodeSandbox): Record<string, string> {
  const remote = join(sandbox.root, 'upstream.git');
  const upstreamWork = join(sandbox.root, 'upstream-work');
  sandbox.git(['init', '--bare', '--quiet', remote]);
  sandbox.git(['remote', 'add', 'origin', remote]);
  sandbox.git(['push', '--quiet', 'origin', 'main']);
  sandbox.git(['clone', '--quiet', remote, upstreamWork]);
  writeFileSync(join(upstreamWork, 'UPSTREAM.md'), '# Upstream\n\nE2E-UPSTREAM-7f3a\n');
  sandbox.git(['-C', upstreamWork, 'add', 'UPSTREAM.md']);
  sandbox.git(['-C', upstreamWork, 'commit', '--quiet', '-m', 'e2e-upstream-commit']);
  sandbox.git(['-C', upstreamWork, 'push', '--quiet', 'origin', 'main']);
  return { [UPSTREAM_HEAD]: sandbox.git(['-C', upstreamWork, 'rev-parse', 'HEAD']).trim() };
}

/**
 * HEAD of the linked worktree that has the task branch checked out, or undefined when no such worktree is listed.
 * Read from `git worktree list --porcelain`, so the worktree's location does not have to be guessed.
 */
function linkedWorktreeHead(sandbox: OpenCodeSandbox): string | undefined {
  const blocks = sandbox.git(['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const worktreeLine = lines.find(line => line.startsWith('worktree '));
    if (worktreeLine === undefined || !lines.includes(`branch refs/heads/${TASK_BRANCH}`)) continue;
    return sandbox.git(['-C', worktreeLine.slice('worktree '.length), 'rev-parse', 'HEAD']).trim();
  }
  return undefined;
}

function judge(context: BindingContext): BindingJudgement {
  const { sandbox } = context;
  const upstream = context.prepared[UPSTREAM_HEAD];
  const upstreamKnown = upstream !== undefined && upstream !== '';
  const advanced = upstreamKnown && upstream !== context.headBefore;
  const status = sandbox.git(['status', '--porcelain']).trim();
  const branch = sandbox.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const head = headOf(sandbox);
  const originMain = sandbox.git(['rev-parse', 'origin/main']).trim();
  const canonicalClean = status === '' && branch === 'main' && advanced && head === upstream && originMain === upstream;
  const worktreeHead = linkedWorktreeHead(sandbox);
  const worktreeExists = worktreeHead !== undefined && advanced && worktreeHead === upstream;
  return {
    observedStatus: 'pass',
    finalStateChecks: [
      checkOf(
        CANONICAL_CHECK,
        canonicalClean,
        canonicalClean
          ? 'clean, on main, HEAD and origin/main at the upstream commit, which differs from the pre-run HEAD'
          : `not clean on main at the upstream commit (branch ${branch}, ${status === '' ? 'clean' : 'dirty'}, HEAD ${head === upstream ? 'at' : 'not at'} upstream, origin/main ${originMain === upstream ? 'at' : 'not at'} upstream${advanced ? '' : ', upstream not ahead of the pre-run HEAD'})`,
      ),
      checkOf(
        WORKTREE_CHECK,
        worktreeExists,
        worktreeExists
          ? `branch ${TASK_BRANCH} is checked out in a linked worktree at the upstream commit`
          : worktreeHead === undefined
            ? `branch ${TASK_BRANCH} has no linked worktree`
            : `linked worktree for ${TASK_BRANCH} is not at the upstream commit`,
      ),
    ],
    violations: [],
  };
}

export const binding: ScenarioBinding = {
  scenarioId,
  scenarioVersion,
  message: USER_PROMPT,
  prepare,
  steps: {
    lead: [
      delegate('operator', 'Inspect canonical checkout', 'Inspect the canonical checkout read-only and report whether it is clean.'),
      intermediate('E3 lead intermediate 1'),
      delegate('external', 'Fetch and fast-forward main', 'Run git fetch origin and git merge --ff-only origin/main in the canonical checkout.'),
      intermediate('E3 lead intermediate 2'),
      delegate('operator', 'Create the task worktree', `Create the task worktree for issue 90102 on branch ${TASK_BRANCH} from origin/main.`),
      intermediate('E3 lead intermediate 3'),
      report('E3 lead final'),
    ],
    operator: [
      shellStep('git status --porcelain'),
      finalText('E3 operator inspection final'),
      shellStep(`git worktree add -b ${TASK_BRANCH} ${WORKTREE_PATH} origin/main`),
      finalText('E3 operator worktree final'),
    ],
    external: [
      shellStep('git fetch origin'),
      shellStep('git merge --ff-only origin/main'),
      finalText('E3 external final'),
    ],
  },
  artifacts: {
    'git-worktree-list.txt': gitWorktreeListProducer,
  },
  judge,
};
