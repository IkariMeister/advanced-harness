// Scenario bindings (U2, issue #226). A binding ties one development scenario to a scripted OpenCode journey, the
// sandbox preparation it needs, the artifacts it keeps, and a judge that turns the finished run into observed facts.
// The runner (e2e/eval/runner.ts) executes bindings. This module starts no process: producers only read the sandbox
// and the journey record. Loopback steps are scripted turns, so a verdict depends on how the fixture is written.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExpectedOutcomeStatus } from '../../src/eval-contracts.ts';
import type { ObservedFinalStateCheck, ObservedViolation } from '../../src/eval-evaluate.ts';
import { callTool, finalText, type JourneyRun } from '../support/journey.ts';
import type { ScriptStep } from '../support/loopback-model.ts';
import type { OpenCodeSandbox } from '../support/opencode-sandbox.ts';

/** The artifact the runner always writes: the journey record of the run, as serialised. */
export const LOOPBACK_TRANSCRIPT = 'loopback-transcript.json';
export const SHELL_TOOL = 'shell';
export const SUBAGENT_TOOL = 'subagent';
/** Present in the tool result of a child delegation the parent has not heard back from (observed on OpenCode 2.3.0). */
export const INTERMEDIATE_MARKER = 'working in the background';
/** A child report arrives as a user message whose opening tag carries state="completed". */
export const REPORT_COMPLETED = 'state="completed"';

/** Read-only view of one finished run, given to producers and judges. */
export interface BindingContext {
  readonly sandbox: OpenCodeSandbox;
  readonly run: JourneyRun;
  /** Values the binding's prepare step returned, for example checksums taken before OpenCode ran. */
  readonly prepared: Readonly<Record<string, string>>;
  /** HEAD of the scratch repository before OpenCode ran. */
  readonly headBefore: string;
}

export interface BindingJudgement {
  readonly observedStatus: ExpectedOutcomeStatus;
  /** One entry per observableFinalState assertion the binding can machine-check. Undeclared names are a contract error. */
  readonly finalStateChecks: readonly ObservedFinalStateCheck[];
  /** Forbidden actions observed in a completed run. Any entry makes the outcome fail. */
  readonly violations: readonly ObservedViolation[];
  /** Why the verdict is inconclusive, when the binding knows. Recorded in the result's evidence. */
  readonly note?: string | undefined;
}

export interface ScenarioBinding {
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  /** The user message given to OpenCode. Copied from the scenario's stimulus.userPrompt. */
  readonly message: string;
  /** Scripted turns per role id, consumed in order. */
  readonly steps: Readonly<Record<string, readonly ScriptStep[]>>;
  /** Sandbox preparation before OpenCode runs. Returns named values the judge can read back. */
  readonly prepare?: ((sandbox: OpenCodeSandbox) => Readonly<Record<string, string>>) | undefined;
  /** Artifact file name to producer. Names are written under artifacts/ in the repeat directory. */
  readonly artifacts: Readonly<Record<string, (context: BindingContext) => string>>;
  readonly judge: (context: BindingContext) => BindingJudgement;
}

/** Lead's delegation to a child role. The subagent tool must be offered to Lead. */
export function delegate(agent: string, description: string, prompt: string): ScriptStep {
  return callTool(SUBAGENT_TOOL, { agent, description, prompt }, { toolsOffered: [SUBAGENT_TOOL] });
}

/** A scripted shell tool call. */
export function shellStep(command: string): ScriptStep {
  return callTool(SHELL_TOOL, { command }, { toolsOffered: [SHELL_TOOL] });
}

/** Lead's turn while a child is still working: final text that expects the background marker. */
export function intermediate(text: string): ScriptStep {
  return finalText(text, { toolResultsInclude: [INTERMEDIATE_MARKER] });
}

/** Lead's final turn after a child report: expects a completed report to be the latest user message. */
export function report(text: string): ScriptStep {
  return finalText(text, { latestUserIncludes: [REPORT_COMPLETED] });
}

/** Shell command strings the record shows for one role, in order. A null role means every role. */
export function shellCommandsOf(run: JourneyRun, role: string | null): string[] {
  return run.record.toolCalls
    .filter(call => call.tool === SHELL_TOOL && (role === null || call.role === role))
    .map(call => (typeof call.args.command === 'string' ? call.args.command : ''));
}

export function checkOf(assertion: string, passed: boolean, observed: string): ObservedFinalStateCheck {
  return { assertion, passed, observed };
}

/** SHA-256 of a file's bytes, as lower-case hex. */
export function checksumOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function projectFile(sandbox: OpenCodeSandbox, name: string): string {
  return join(sandbox.project, name);
}

/** HEAD of the scratch repository. Commit hashes differ between runs, so they are never written into observed text. */
export function headOf(sandbox: OpenCodeSandbox): string {
  return sandbox.git(['rev-parse', 'HEAD']).trim();
}

/** True when the scratch repository has no remote and no remote-tracking refs. */
export function noRemoteState(sandbox: OpenCodeSandbox): boolean {
  return sandbox.git(['remote']).trim() === '' && sandbox.git(['for-each-ref', 'refs/remotes']).trim() === '';
}

export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export const toolEventsProducer = (context: BindingContext): string => jsonText(context.run.record.toolCalls);
export const gitStatusProducer = (context: BindingContext): string => context.sandbox.git(['status', '--porcelain']);
export const gitDiffProducer = (context: BindingContext): string => context.sandbox.git(['diff']);
export const gitWorktreeListProducer = (context: BindingContext): string => context.sandbox.git(['worktree', 'list']);
