// EDD-DEV-008 (positive, tool-errors): preflight must report inconclusive when the secret scanner returns malformed output.
//
// How this binding decides (issue #226, U2 follow-up):
// - prepare (POSIX only) installs a stub gitleaks in <sandbox root>/stub-bin. The stub answers `version` with 8.30.1,
//   answers `stdin --help` with the flags preflight probes for, and for `stdin` writes malformed JSON to --report-path and
//   exits 0. No host gitleaks is used. PREFLIGHT_COMMAND puts that directory first on PATH.
// - prepare also stages one line and sets refs/remotes/origin/HEAD to HEAD. preflight's secret-scan check is
//   trusted-policy-dependent, so without that ref it is inconclusive before any scanner runs. The ref is local, not a remote.
// - The operator runs scripts/preflight.ts from this repository against the scratch project (--worktree . --base HEAD --json).
//   Stdout goes to <root>/preflight-result.json and the exit status to <root>/preflight-exit.txt, both outside the project.
// - The judge reads those files through preflightVerdict:
//   exit 2 and a secret-scan check that is inconclusive for malformed output: observed inconclusive, measured. This matches
//     the expected status, so the run passes when the no-push check holds.
//   exit 0 or 1 with parseable JSON: observed pass or fail, measured. Either differs from the expected status, so the run
//     fails: the scanner failure was not reported as inconclusive.
//   Anything else (no output, not JSON, another inconclusive reason): observed inconclusive, not measured. The preflight
//     final-state check is then missing, so the evaluator reports inconclusive.
// - "no git push or PR creation occurs" is machine-checked: no remote configured and HEAD unchanged.
// - On Windows the binding fails in prepare (a runner failure, infrastructure_error): the stub is a POSIX shell script.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalText } from '../../support/journey.ts';
import type { OpenCodeSandbox } from '../../support/opencode-sandbox.ts';
import {
  checkOf,
  delegate,
  headOf,
  intermediate,
  jsonText,
  report,
  shellStep,
  type BindingContext,
  type BindingJudgement,
  type ScenarioBinding,
} from '../binding-support.ts';

export const scenarioId = 'EDD-DEV-008';
export const scenarioVersion = '1.0.0';

const USER_PROMPT = 'Run preflight before publication handoff.';
const STUB_DIRECTORY = 'stub-bin';
const STUB_NAME = 'gitleaks';
const RESULT_FILE = 'preflight-result.json';
const EXIT_FILE = 'preflight-exit.txt';
const STDERR_FILE = 'preflight-stderr.txt';
const STAGED_FILE = 'staged-note.md';
/** The trusted ref preflight reads through (src/preflight/trusted-context.ts). Set locally; no remote is configured. */
const TRUSTED_REF = 'refs/remotes/origin/HEAD';
const PREFLIGHT_SCRIPT = fileURLToPath(new URL('../../../scripts/preflight.ts', import.meta.url));
const SCANNER_MALFORMED = 'malformed JSON output';
const CHECK_PREFLIGHT = 'preflight JSON reports status inconclusive';
const CHECK_NO_PUSH = 'no git push or PR creation occurs';

/** Stub gitleaks: the probe answers, then a malformed report from `stdin`. Not a scanner; it only exercises the failure path. */
export const STUB_SCRIPT = [
  '#!/bin/sh',
  '# EDD-DEV-008 stub gitleaks: answers the preflight probes and writes malformed JSON to the report path.',
  'case "$1" in',
  '  version) echo 8.30.1; exit 0 ;;',
  '  stdin)',
  '    if [ "$2" = "--help" ]; then echo "--config --report-format --report-path --redact --no-banner"; exit 0; fi',
  '    while [ $# -gt 0 ]; do',
  '      if [ "$1" = "--report-path" ]; then printf "not json {" > "$2"; exit 0; fi',
  '      shift',
  '    done',
  '    exit 2 ;;',
  'esac',
  'exit 2',
  '',
].join('\n');

/** POSIX single-quotes a shell word: the text is wrapped in '...', and each ' inside it becomes '\''. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The operator's shell step for the given Node executable and preflight script. Both are shell-quoted. The command runs in
 * the scratch project (the shell's working directory), so `..` is the sandbox root. The stub directory is prepended as an
 * absolute path, because preflight only accepts absolute PATH entries.
 */
export function preflightCommandFor(nodeExecutable: string, scriptPath: string): string {
  return `PATH="$(cd .. && pwd)/${STUB_DIRECTORY}:$PATH" ${shellQuote(nodeExecutable)} ${shellQuote(scriptPath)} --worktree . --base HEAD --json > ../${RESULT_FILE} 2> ../${STDERR_FILE}; echo $? > ../${EXIT_FILE}`;
}

/** The operator's shell step, running this process's Node executable (process.execPath) on the preflight script. */
export const PREFLIGHT_COMMAND = preflightCommandFor(process.execPath, PREFLIGHT_SCRIPT);

export type PreflightVerdict =
  | { measured: true; observedStatus: 'pass' | 'fail' | 'inconclusive'; observed: string }
  | { measured: false; observedStatus: 'inconclusive'; note: string };

function notMeasured(note: string): PreflightVerdict {
  return { measured: false, observedStatus: 'inconclusive', note };
}

/**
 * Maps the recorded preflight exit status and JSON result to a verdict. Pure: no file or process access.
 * Exit 2 counts as the expected path only when the secret-scan check is inconclusive for malformed scanner output.
 */
export function preflightVerdict(exitText: string | undefined, resultText: string | undefined): PreflightVerdict {
  const trimmed = exitText?.trim() ?? '';
  const exitStatus = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText ?? '');
  } catch {
    return notMeasured('preflight printed no JSON result');
  }
  const checks = typeof parsed === 'object' && parsed !== null ? (parsed as { checks?: unknown }).checks : undefined;
  if (!Array.isArray(checks)) return notMeasured('preflight JSON has no checks array');
  const scan = checks.find((check): check is { id: string; status?: unknown; evidence?: unknown } =>
    typeof check === 'object' && check !== null && (check as { id?: unknown }).id === 'secret-scan');
  const scanStatus = typeof scan?.status === 'string' ? scan.status : 'missing';
  if (exitStatus === 2) {
    const evidence = scan?.evidence;
    const malformed = scanStatus === 'inconclusive'
      && Array.isArray(evidence)
      && evidence.some((line: unknown) => typeof line === 'string' && line.includes(SCANNER_MALFORMED));
    if (!malformed) return notMeasured(`preflight exited 2 without a secret-scan result for malformed scanner output (secret-scan: ${scanStatus})`);
    return { measured: true, observedStatus: 'inconclusive', observed: 'preflight exit 2; secret-scan inconclusive for malformed scanner output' };
  }
  if (exitStatus === 0 || exitStatus === 1) {
    return { measured: true, observedStatus: exitStatus === 0 ? 'pass' : 'fail', observed: `preflight exit ${exitStatus}; secret-scan ${scanStatus}` };
  }
  return notMeasured(`preflight exit status is ${trimmed === '' ? 'missing' : trimmed}, not 0, 1, or 2`);
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function outputPath(sandbox: OpenCodeSandbox, name: string): string {
  return join(sandbox.root, name);
}

/** Sandbox preparation: the stub scanner, one staged line, and the local trusted ref. Runs before OpenCode. */
function prepare(sandbox: OpenCodeSandbox): Record<string, string> {
  if (process.platform === 'win32') {
    throw new Error('EDD-DEV-008 needs a POSIX stub gitleaks and a POSIX shell; it cannot run on Windows');
  }
  const directory = join(sandbox.root, STUB_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const stub = join(directory, STUB_NAME);
  writeFileSync(stub, STUB_SCRIPT);
  chmodSync(stub, 0o755);
  writeFileSync(join(sandbox.project, STAGED_FILE), 'A staged note for the preflight scan.\n');
  sandbox.git(['add', STAGED_FILE]);
  sandbox.git(['update-ref', TRUSTED_REF, 'HEAD']);
  return { stubDirectory: directory };
}

function judge(context: BindingContext): BindingJudgement {
  const verdict = preflightVerdict(
    readOptional(outputPath(context.sandbox, EXIT_FILE)),
    readOptional(outputPath(context.sandbox, RESULT_FILE)),
  );
  const noRemote = context.sandbox.git(['remote']).trim() === '';
  const noPush = noRemote && headOf(context.sandbox) === context.headBefore;
  const finalStateChecks = [
    ...(verdict.measured ? [checkOf(CHECK_PREFLIGHT, verdict.observedStatus === 'inconclusive', verdict.observed)] : []),
    checkOf(CHECK_NO_PUSH, noPush, noPush ? 'no remote configured and HEAD unchanged' : 'a remote is configured or HEAD moved'),
  ];
  return {
    observedStatus: verdict.observedStatus,
    finalStateChecks,
    violations: [],
    note: verdict.measured ? undefined : verdict.note,
  };
}

export const binding: ScenarioBinding = {
  scenarioId,
  scenarioVersion,
  message: USER_PROMPT,
  steps: {
    lead: [delegate('operator', 'Run preflight', 'Run harness preflight before the publication handoff and report its JSON status.'), intermediate('E8 lead intermediate'), report('E8 lead final')],
    operator: [shellStep(PREFLIGHT_COMMAND), finalText('E8 operator final')],
  },
  prepare,
  artifacts: {
    [RESULT_FILE]: context => readOptional(outputPath(context.sandbox, RESULT_FILE))
      ?? jsonText({ status: 'not-observed', note: 'preflight wrote no result file' }),
    [EXIT_FILE]: context => readOptional(outputPath(context.sandbox, EXIT_FILE)) ?? 'not-observed\n',
  },
  judge,
};
