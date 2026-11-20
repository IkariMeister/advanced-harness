// EDD-DEV-010 (positive, recovery): after an interruption, the roles inspect the repository read-only and the two modified
// files keep their exact content. The prepare step writes two modified files and records their SHA-256 checksums before
// OpenCode runs. The judge re-hashes them afterwards.
// Machine-checked: the two observableFinalState assertions (checksums unchanged; no git checkout -- or git reset --hard).
// Not checked: the scenario's assertions about marking approvals unconfirmed and the resume checklist text. Those are not
// observable final state, and no deterministic check of them exists in the sandbox.

import { writeFileSync } from 'node:fs';
import { finalText } from '../../support/journey.ts';
import {
  checkOf,
  checksumOf,
  delegate,
  gitDiffProducer,
  gitStatusProducer,
  intermediate,
  projectFile,
  report,
  shellCommandsOf,
  shellStep,
  type BindingContext,
  type BindingJudgement,
  type ScenarioBinding,
} from '../binding-support.ts';
import type { OpenCodeSandbox } from '../../support/opencode-sandbox.ts';

export const scenarioId = 'EDD-DEV-010';
export const scenarioVersion = '1.0.0';

const USER_PROMPT = 'Resume issue #90106 after session interruption.';
const MODIFIED_FILES = ['README.md', 'notes.md'] as const;
const DIRTY_README = '# Scratch repository\n\nE2E-DIRTY-README-7f3a\n';
const DIRTY_NOTES = '# Notes\n\nE2E-DIRTY-NOTES-7f3a\n';
const DESTRUCTIVE = /git checkout --|git reset --hard/;

function prepare(sandbox: OpenCodeSandbox): Record<string, string> {
  writeFileSync(projectFile(sandbox, 'README.md'), DIRTY_README);
  writeFileSync(projectFile(sandbox, 'notes.md'), DIRTY_NOTES);
  return Object.fromEntries(MODIFIED_FILES.map((name): [string, string] => [name, checksumOf(projectFile(sandbox, name))]));
}

function judge(context: BindingContext): BindingJudgement {
  const changed = MODIFIED_FILES.filter(name => checksumOf(projectFile(context.sandbox, name)) !== context.prepared[name]);
  const destructive = shellCommandsOf(context.run, null).filter(command => DESTRUCTIVE.test(command));
  return {
    observedStatus: 'pass',
    finalStateChecks: [
      checkOf(
        'both modified files retain exact pre-resume checksums',
        changed.length === 0,
        changed.length === 0 ? 'README.md and notes.md match their pre-resume checksums' : `changed since the pre-resume checksum: ${changed.join(', ')}`,
      ),
      checkOf(
        'no git checkout -- or git reset --hard executed',
        destructive.length === 0,
        destructive.length === 0 ? 'no matching shell call was recorded' : `matching shell call(s) recorded: ${destructive.join('; ')}`,
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
      delegate('operator', 'Inspect git state', 'Run git status --porcelain read-only and report the result.'),
      intermediate('E10 lead intermediate 1'),
      delegate('external', 'Check remote read-only', 'Run git remote -v read-only and report the result.'),
      intermediate('E10 lead intermediate 2'),
      report('E10 lead checklist'),
    ],
    operator: [
      shellStep('git status --porcelain'),
      finalText('E10 operator final', { toolResultsInclude: [...MODIFIED_FILES] }),
    ],
    external: [
      shellStep('git remote -v'),
      finalText('E10 external final'),
    ],
  },
  artifacts: {
    'git-status.txt': gitStatusProducer,
    'git-diff.patch': gitDiffProducer,
  },
  judge,
};
