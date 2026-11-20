import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadScenarioCorpus, validateResult, validateRunManifest, type EvalScenario } from '../src/eval-contracts.ts';
import { checkBoundScenarioVersion, compareRepeats, evaluateScenario } from '../src/eval-evaluate.ts';
import { LOOPBACK_TRANSCRIPT } from '../e2e/eval/binding-support.ts';
import { BINDINGS, findBinding } from '../e2e/eval/bindings/index.ts';
import { globToRegExp, implementerPolicyRules, MERGE_COMMAND, PUSH_COMMAND, resolveShellEffect } from '../e2e/eval/bindings/EDD-DEV-004.ts';
import { preflightVerdict, PREFLIGHT_COMMAND, STUB_SCRIPT } from '../e2e/eval/bindings/EDD-DEV-008.ts';
import {
  availabilityOf,
  exitStatusOf,
  NOT_CONFIGURED_REASON,
  observedViolationsOf,
  planScenario,
  runEvaluation,
  selectScenarios,
  UNBOUND_REASON,
  type Availability,
  type EvaluationSummary,
} from '../e2e/eval/runner.ts';
import { formatSummary, HOLDOUT_WARNING, parseArguments, runCli, type CliDeps } from '../e2e/eval/run.ts';
import { resolveOpenCodeBinary } from '../e2e/support/opencode-sandbox.ts';
import { makeTempRoot } from './temp-directory.ts';

const APPROVED_BINDINGS = ['EDD-DEV-003', 'EDD-DEV-004', 'EDD-DEV-008', 'EDD-DEV-010'];
const BINDINGS_DIRECTORY = fileURLToPath(new URL('../e2e/eval/bindings/', import.meta.url));
const CORPUS_DIRECTORY = fileURLToPath(new URL('../eval/corpus/', import.meta.url));
const corpus = loadScenarioCorpus(CORPUS_DIRECTORY);

function scenarioNamed(id: string): EvalScenario {
  const found = corpus.all.find(scenario => scenario.id === id);
  if (found === undefined) throw new Error(`corpus has no scenario ${id}`);
  return found;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5 });
}

/** A ready availability for pure planning checks. No binary is started by these checks. */
const READY: Availability = {
  openCode: { status: 'ready', version: '2.3.0' },
  enforcement: 'none',
  binary: '/opt/opencode/opencode',
  version: '2.3.0',
};

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

test('bindings: exactly the four approved development scenarios are bound', () => {
  assert.deepEqual(BINDINGS.map(binding => binding.scenarioId).sort(), [...APPROVED_BINDINGS].sort());
  const files = readdirSync(BINDINGS_DIRECTORY)
    .filter(name => name.startsWith('EDD-') && name.endsWith('.ts'))
    .map(name => name.replace(/\.ts$/, ''))
    .sort();
  assert.deepEqual(files, [...APPROVED_BINDINGS].sort());
});

test('bindings: no validation (holdout) scenario is bound', () => {
  assert.equal(BINDINGS.some(binding => binding.scenarioId.startsWith('EDD-VAL-')), false);
  assert.equal(findBinding('EDD-VAL-001'), undefined);
});

test('bindings: each scenario ID resolves to a development scenario whose version matches the binding', () => {
  for (const binding of BINDINGS) {
    const scenario = scenarioNamed(binding.scenarioId);
    assert.equal(scenario.set, 'development', binding.scenarioId);
    assert.equal(binding.scenarioVersion, '1.0.0', binding.scenarioId);
    assert.equal(checkBoundScenarioVersion(scenario, binding.scenarioVersion), undefined, binding.scenarioId);
    assert.equal(binding.message, scenario.stimulus.userPrompt, `${binding.scenarioId} message must be the scenario's user prompt`);
  }
});

test('bindings: a stale bound version is reported as a stale-binding message', () => {
  const scenario = scenarioNamed('EDD-DEV-004');
  const message = checkBoundScenarioVersion({ id: scenario.id, version: '9.9.9' }, '1.0.0');
  assert.ok(message !== undefined && message.includes('stale binding'));
});

test('bindings: steps use only the shell and read tools, with subagent delegation from Lead', () => {
  const allowed = new Set(['read', 'shell', 'subagent']);
  for (const binding of BINDINGS) {
    for (const [role, steps] of Object.entries(binding.steps)) {
      for (const step of steps) {
        if (typeof step.reply === 'string') continue;
        for (const call of step.reply) {
          assert.ok(allowed.has(call.name), `${binding.scenarioId} role ${role} calls ${call.name}`);
        }
      }
    }
  }
});

test('bindings: every required artifact of a bound scenario is produced (the transcript is always written)', () => {
  for (const binding of BINDINGS) {
    const produced = new Set([...Object.keys(binding.artifacts), LOOPBACK_TRANSCRIPT]);
    for (const required of scenarioNamed(binding.scenarioId).evidence.requiredArtifacts) {
      assert.ok(produced.has(required), `${binding.scenarioId} does not produce ${required}`);
    }
  }
});

test('bindings: EDD-DEV-008 plans the stub scanner and the malformed-output path, and its expected outcome is inconclusive', () => {
  const bound = findBinding('EDD-DEV-008');
  assert.ok(bound !== undefined && bound.prepare !== undefined, 'the stub scanner setup is planned');
  const operatorCalls = (bound.steps.operator ?? []).flatMap(step => (typeof step.reply === 'string' ? [] : step.reply));
  const shellCommands = operatorCalls.filter(call => call.name === 'shell').map(call => String(call.arguments.command));
  assert.deepEqual(shellCommands, [PREFLIGHT_COMMAND]);
  assert.ok(PREFLIGHT_COMMAND.includes('stub-bin') && PREFLIGHT_COMMAND.includes('preflight.ts') && PREFLIGHT_COMMAND.includes('--json'));
  assert.ok(STUB_SCRIPT.includes('--report-path') && STUB_SCRIPT.includes('8.30.1'));
  assert.equal(scenarioNamed('EDD-DEV-008').expectedOutcome.status, 'inconclusive');
  const malformed = JSON.stringify({
    approved: false,
    checks: [{ id: 'secret-scan', status: 'inconclusive', evidence: ['Secret scan incomplete: Gitleaks returned malformed JSON output.'] }],
  });
  assert.deepEqual(preflightVerdict('2', malformed), { measured: true, observedStatus: 'inconclusive', observed: 'preflight exit 2; secret-scan inconclusive for malformed scanner output' });
  assert.deepEqual(preflightVerdict('0', malformed), { measured: true, observedStatus: 'pass', observed: 'preflight exit 0; secret-scan inconclusive' });
  assert.equal(preflightVerdict(undefined, undefined).measured, false);
  assert.equal(preflightVerdict('2', JSON.stringify({ checks: [] })).observedStatus, 'inconclusive');
});

test('preflightVerdict: each exit and output shape maps to its exact observed status and measured flag', () => {
  const malformedEvidence = {
    checks: [{ id: 'secret-scan', status: 'inconclusive', evidence: ['Secret scan incomplete: Gitleaks returned malformed JSON output.'] }],
  };
  const passing = { checks: [{ id: 'secret-scan', status: 'pass', evidence: [] }] };
  const failing = { checks: [{ id: 'secret-scan', status: 'fail', evidence: ['leak found'] }] };
  const inconclusiveNoMalformed = { checks: [{ id: 'secret-scan', status: 'inconclusive', evidence: ['base ref missing'] }] };
  const cases: { label: string; exit: string | undefined; result: string | undefined; measured: boolean; observedStatus: string }[] = [
    { label: 'exit 2 with malformed-JSON secret-scan evidence', exit: '2\n', result: JSON.stringify(malformedEvidence), measured: true, observedStatus: 'inconclusive' },
    { label: 'exit 2 without malformed-JSON evidence', exit: '2', result: JSON.stringify(inconclusiveNoMalformed), measured: false, observedStatus: 'inconclusive' },
    { label: 'exit 0 with parseable JSON', exit: '0', result: JSON.stringify(passing), measured: true, observedStatus: 'pass' },
    { label: 'exit 1 with parseable JSON', exit: '1', result: JSON.stringify(failing), measured: true, observedStatus: 'fail' },
    { label: 'missing exit text with parseable JSON', exit: undefined, result: JSON.stringify(passing), measured: false, observedStatus: 'inconclusive' },
    { label: 'exit 0 with missing result text', exit: '0', result: undefined, measured: false, observedStatus: 'inconclusive' },
    { label: 'exit 0 with non-JSON output', exit: '0', result: 'Preflight: not json {', measured: false, observedStatus: 'inconclusive' },
  ];
  for (const testCase of cases) {
    const verdict = preflightVerdict(testCase.exit, testCase.result);
    assert.equal(verdict.measured, testCase.measured, testCase.label);
    assert.equal(verdict.observedStatus, testCase.observedStatus, testCase.label);
  }
});

test('policy: agents/implementer.md denies gh pr merge and git push, and the last matching rule decides', () => {
  const rules = implementerPolicyRules();
  assert.ok(rules.length > 0);
  assert.equal(resolveShellEffect(rules, MERGE_COMMAND), 'deny');
  assert.equal(resolveShellEffect(rules, PUSH_COMMAND), 'deny');
  // Not denied by the later rules: the shell.run ask rule decides, so the resolver is not a deny-all.
  assert.equal(resolveShellEffect(rules, 'npm test'), 'ask');
});

test('policy: a native pattern matches whole commands only and treats * as the only wildcard', () => {
  assert.equal(globToRegExp('gh *').test('gh pr merge 1'), true);
  assert.equal(globToRegExp('gh *').test('xgh pr merge 1'), false);
  assert.equal(globToRegExp('git *').test('git push origin HEAD'), true);
  assert.equal(globToRegExp('a.b').test('axb'), false);
});

// ---------------------------------------------------------------------------
// Runner: availability, skip, and infrastructure paths (no OpenCode is started)
// ---------------------------------------------------------------------------

test('runner: without HARNESS_E2E_OPENCODE every development scenario is skipped and nothing runs', async () => {
  const out = makeTempRoot('eval-runner-skip-');
  try {
    const summary = await runEvaluation({ set: 'development', outDirectory: out, env: {}, repeat: 2 });
    assert.equal(summary.scenarios.length, corpus.development.length);
    assert.equal(summary.executed, 0);
    assert.equal(summary.exitCode, 1);
    assert.equal(summary.repeatable, true);
    for (const scenario of summary.scenarios) {
      assert.deepEqual(scenario.outcomes, ['skipped', 'skipped'], scenario.scenarioId);
      assert.ok(scenario.reason.includes(NOT_CONFIGURED_REASON), scenario.scenarioId);
      for (const repeatNumber of ['1', '2']) {
        const directory = join(summary.directory, scenario.scenarioId, repeatNumber);
        assert.equal(validateResult(readJson(join(directory, 'result.json'))).outcome, 'skipped');
        validateRunManifest(readJson(join(directory, 'run-manifest.json')));
      }
    }
    assert.equal((readJson(join(summary.directory, 'summary.json')) as { executed: number }).executed, 0);
  } finally {
    removeTree(out);
  }
});

test('runner: the validation set is a holdout, is flagged as one, and is skipped', async () => {
  const out = makeTempRoot('eval-runner-holdout-');
  try {
    const summary = await runEvaluation({ set: 'validation', outDirectory: out, env: {}, repeat: 1 });
    assert.equal(summary.holdout, true);
    assert.equal(summary.scenarios.length, corpus.validation.length);
    assert.ok(summary.scenarios.every(scenario => scenario.bound === false && scenario.outcomes[0] === 'skipped'));
    assert.equal(summary.exitCode, 1);
  } finally {
    removeTree(out);
  }
});

test('runner: an unbound scenario is skipped with the binding reason even when OpenCode is ready', async () => {
  const out = makeTempRoot('eval-runner-unbound-');
  try {
    const fake = join(out, 'fake-opencode');
    const summary = await runEvaluation({
      set: 'development',
      scenarioIds: ['EDD-DEV-001'],
      outDirectory: out,
      env: { HARNESS_E2E_OPENCODE: fake },
      resolveBinary: () => ({ status: 'ready', binary: fake, version: '2.3.0' }),
      repeat: 1,
    });
    assert.equal(summary.scenarios.length, 1);
    assert.equal(summary.scenarios[0]!.bound, false);
    assert.deepEqual(summary.scenarios[0]!.outcomes, ['skipped']);
    assert.ok(summary.scenarios[0]!.reason.includes(UNBOUND_REASON));
    assert.equal(summary.exitCode, 1);
  } finally {
    removeTree(out);
  }
});

test('runner: a missing OpenCode binary is an infrastructure_error for bound scenarios and nothing is launched', async () => {
  const out = makeTempRoot('eval-runner-missing-');
  try {
    const summary = await runEvaluation({
      set: 'development',
      scenarioIds: ['EDD-DEV-004', 'EDD-DEV-001'],
      outDirectory: out,
      env: { HARNESS_E2E_OPENCODE: join(out, 'missing-opencode') },
      repeat: 1,
    });
    const bound = summary.scenarios.find(scenario => scenario.scenarioId === 'EDD-DEV-004');
    const unbound = summary.scenarios.find(scenario => scenario.scenarioId === 'EDD-DEV-001');
    assert.deepEqual(bound?.outcomes, ['infrastructure_error']);
    assert.ok(bound?.reason.includes('does not point to an existing file'));
    assert.deepEqual(unbound?.outcomes, ['skipped']);
    assert.equal(summary.executed, 1);
    assert.equal(summary.exitCode, 1);
    validateResult(readJson(join(summary.directory, 'EDD-DEV-004', '1', 'result.json')));
  } finally {
    removeTree(out);
  }
});

test('runner: a failed loopback-only network check is an infrastructure_error before any journey starts', async () => {
  const out = makeTempRoot('eval-runner-netns-');
  try {
    const fake = join(out, 'fake-opencode');
    const summary = await runEvaluation({
      set: 'development',
      scenarioIds: ['EDD-DEV-004'],
      outDirectory: out,
      env: { HARNESS_E2E_OPENCODE: fake, HARNESS_E2E_NETNS: '1' },
      resolveBinary: () => ({ status: 'ready', binary: fake, version: '2.3.0' }),
      checkNetwork: () => ({ status: 'failed', reason: 'NETNS-TEST-REASON' }),
      repeat: 1,
    });
    assert.deepEqual(summary.scenarios[0]?.outcomes, ['infrastructure_error']);
    assert.ok(summary.scenarios[0]?.reason.includes('NETNS-TEST-REASON'));
    assert.equal(summary.enforcement, 'none');
    assert.equal(summary.exitCode, 1);
  } finally {
    removeTree(out);
  }
});

test('runner: a failure inside a bound run (a throwing prepare after the sandbox starts) is an infrastructure_error with exit 1', async () => {
  const out = makeTempRoot('eval-runner-bound-failure-');
  try {
    const fake = join(out, 'fake-opencode');
    const bound = findBinding('EDD-DEV-004');
    assert.ok(bound !== undefined);
    const summary = await runEvaluation({
      set: 'development',
      scenarioIds: ['EDD-DEV-004'],
      outDirectory: out,
      env: { HARNESS_E2E_OPENCODE: fake },
      resolveBinary: () => ({ status: 'ready', binary: fake, version: '2.3.0' }),
      bindingOf: () => ({
        ...bound,
        prepare: () => {
          throw new Error('SEAM-PREPARE-FAILURE');
        },
      }),
      repeat: 1,
    });
    const scenario = summary.scenarios.find(item => item.scenarioId === 'EDD-DEV-004');
    assert.deepEqual(scenario?.outcomes, ['infrastructure_error']);
    assert.ok(scenario?.reason.includes('runner failure: SEAM-PREPARE-FAILURE'), String(scenario?.reason));
    assert.equal(summary.executed, 1);
    assert.equal(summary.exitCode, 1);
    const result = validateResult(readJson(join(summary.directory, 'EDD-DEV-004', '1', 'result.json')));
    assert.equal(result.outcome, 'infrastructure_error');
  } finally {
    removeTree(out);
  }
});

test('runner: planning is pure: not-configured skips, unbound skips, stale versions and blockers are infrastructure errors', () => {
  const bound = findBinding('EDD-DEV-004');
  const scenario = scenarioNamed('EDD-DEV-004');
  const notConfigured = planScenario(scenario, bound, { openCode: { status: 'not-configured' }, enforcement: 'none' });
  assert.deepEqual(notConfigured, { kind: 'skipped', detail: NOT_CONFIGURED_REASON });
  assert.deepEqual(planScenario(scenario, undefined, READY), { kind: 'skipped', detail: UNBOUND_REASON });
  const stale = planScenario({ id: scenario.id, version: '9.9.9' }, bound, READY);
  assert.ok(stale.kind === 'infrastructure_error' && stale.detail.includes('stale binding'));
  const blocked = planScenario(scenario, bound, { ...READY, blocker: 'blocked for the test' });
  assert.deepEqual(blocked, { kind: 'infrastructure_error', detail: 'blocked for the test' });
  assert.equal(planScenario(scenario, bound, READY).kind, 'run');
});

test('runner: availability reads HARNESS_E2E_OPENCODE once and maps an unset or empty value to its status', () => {
  const resolveBinary = () => ({ status: 'error' as const, reason: 'empty' });
  assert.equal(availabilityOf({}, resolveBinary, () => ({ status: 'not-requested' })).openCode.status, 'not-configured');
  const failed = availabilityOf({ HARNESS_E2E_OPENCODE: '' }, resolveBinary, () => ({ status: 'not-requested' }));
  assert.deepEqual(failed.openCode, { status: 'error', reason: 'empty' });
  assert.equal(failed.blocker, 'empty');
});

test('runner: a wrong OpenCode version is a version-mismatch blocker, and a bound scenario plans as infrastructure_error', () => {
  const scenario = scenarioNamed('EDD-DEV-004');
  const bound = findBinding('EDD-DEV-004');
  // process.execPath is an existing absolute file, so the only failure is the injected version probe.
  const availability = availabilityOf(
    { HARNESS_E2E_OPENCODE: process.execPath },
    environment => resolveOpenCodeBinary(environment, () => 'opencode v9.9.9\n'),
    () => ({ status: 'not-requested' }),
  );
  assert.equal(availability.openCode.status, 'error');
  assert.ok(availability.blocker?.includes('OpenCode reported') && availability.blocker.includes('requires exactly 2.3.0'), String(availability.blocker));
  const plan = planScenario(scenario, bound, availability);
  assert.equal(plan.kind, 'infrastructure_error');
  assert.ok(plan.kind === 'infrastructure_error' && plan.detail.includes('requires exactly 2.3.0'));
});

test('runner: selecting a scenario that is not in the chosen set is an error', () => {
  assert.throws(() => selectScenarios(corpus.development, 'development', ['EDD-VAL-001']), /No development scenario has the ID EDD-VAL-001/);
  assert.equal(selectScenarios(corpus.development, 'development', []).length, corpus.development.length);
});

test('runner: a repeat count below one and a relative output directory are rejected before any scenario runs', async () => {
  await assert.rejects(runEvaluation({ set: 'development', outDirectory: '/tmp/x', repeat: 0, env: {} }), /positive integer/);
  await assert.rejects(runEvaluation({ set: 'development', outDirectory: 'relative/out', env: {} }), /absolute path/);
});

// ---------------------------------------------------------------------------
// Runner: exit status, repeatability, and loopback violations (pure)
// ---------------------------------------------------------------------------

test('exit status: no executed scenario is non-zero, skipped alone is zero when another scenario passed', () => {
  assert.equal(exitStatusOf([{ outcomes: ['skipped', 'skipped'], repeatable: true }]), 1);
  assert.equal(exitStatusOf([{ outcomes: ['pass', 'pass'], repeatable: true }, { outcomes: ['skipped', 'skipped'], repeatable: true }]), 0);
});

test('exit status: fail, inconclusive, infrastructure_error, or a non-repeatable result is non-zero', () => {
  assert.equal(exitStatusOf([{ outcomes: ['pass', 'fail'], repeatable: true }]), 1);
  assert.equal(exitStatusOf([{ outcomes: ['pass', 'inconclusive'], repeatable: true }]), 1);
  assert.equal(exitStatusOf([{ outcomes: ['infrastructure_error'], repeatable: true }]), 1);
  assert.equal(exitStatusOf([{ outcomes: ['pass', 'pass'], repeatable: false }]), 1);
});

test('repeatability: a difference in a normalized field is reported by field; a run-ID or duration change is not', () => {
  const scenario = scenarioNamed('EDD-DEV-004');
  const first = evaluateScenario({ kind: 'skipped', runId: 'run-a', scenario, durationMs: 1, detail: 'same' });
  const sameModuloRun = evaluateScenario({ kind: 'skipped', runId: 'run-b', scenario, durationMs: 9, detail: 'same' });
  const different = evaluateScenario({ kind: 'skipped', runId: 'run-b', scenario, durationMs: 9, detail: 'other' });
  assert.equal(compareRepeats(first, sameModuloRun).repeatable, true);
  const comparison = compareRepeats(first, different);
  assert.equal(comparison.repeatable, false);
  assert.ok(comparison.differences.some(difference => difference.path === 'reason'));
});

test('loopback violations map to observed kinds, and network or credential findings are forbidden actions', () => {
  const mapped = observedViolationsOf([
    { step: 2, expected: 'a scripted step for role "implementer"', received: 'unscripted' },
    { step: null, expected: 'no connection through the HTTP proxy recorder except tolerated OpenCode startup destinations (the child must not reach the network)', received: 'x' },
    { step: null, expected: 'tool "skill" offered', received: 'y' },
  ]);
  assert.deepEqual(mapped.map(violation => violation.kind), ['unscripted-request', 'forbidden-action', 'unoffered-tool']);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('cli: --mode live is rejected with a clear message and runs nothing', async () => {
  const out = makeTempRoot('eval-cli-live-');
  try {
    const errors: string[] = [];
    const deps: CliDeps = {
      run: () => Promise.reject(new Error('must not run')),
      output: () => undefined,
      error: message => { errors.push(message); },
    };
    assert.equal(await runCli(['--out', out, '--mode', 'live'], deps), 2);
    assert.match(errors.join('\n'), /Live mode is rejected/);
  } finally {
    removeTree(out);
  }
});

test('cli: parsing defaults to the development set and two repeats, and accepts scenario filters', () => {
  const out = makeTempRoot('eval-cli-parse-');
  try {
    const defaults = parseArguments(['--out', out]);
    assert.equal(defaults.kind, 'run');
    assert.ok(defaults.kind === 'run' && defaults.cli.set === 'development' && defaults.cli.repeat === 2);
    const filtered = parseArguments(['--out', out, '--scenario', 'EDD-DEV-004', '--scenario', 'EDD-DEV-010', '--repeat', '3']);
    assert.ok(filtered.kind === 'run' && filtered.cli.scenarioIds.length === 2 && filtered.cli.repeat === 3);
  } finally {
    removeTree(out);
  }
});

test('cli: invalid arguments are usage errors (exit 2)', () => {
  const out = makeTempRoot('eval-cli-usage-');
  try {
    assert.equal(parseArguments(['--out', out, '--repeat', '0']).kind, 'error');
    assert.equal(parseArguments(['--out', out, '--set', 'holdout']).kind, 'error');
    assert.equal(parseArguments(['--out', out, '--bogus']).kind, 'error');
    assert.equal(parseArguments(['--set', 'validation']).kind, 'error');
    assert.equal(parseArguments(['--out', out, '--set']).kind, 'error');
    assert.equal(parseArguments(['-h']).kind, 'help');
  } finally {
    removeTree(out);
  }
});

test('cli: the validation set prints the holdout warning before running', async () => {
  const out = makeTempRoot('eval-cli-holdout-');
  try {
    const errors: string[] = [];
    const fake = {
      runId: 'run-test',
      createdAt: '2026-11-19T00:00:00.000Z',
      set: 'validation',
      holdout: true,
      repeat: 2,
      openCode: { status: 'not-configured' },
      enforcement: 'none',
      scenarios: [],
      executed: 0,
      repeatable: true,
      exitCode: 1,
      directory: out,
    } as unknown as EvaluationSummary;
    const deps: CliDeps = { run: async () => fake, output: () => undefined, error: message => { errors.push(message); } };
    assert.equal(await runCli(['--out', out, '--set', 'validation'], deps), 1);
    assert.ok(errors.some(message => message.includes(HOLDOUT_WARNING)));
    assert.match(formatSummary(fake), /exit status 1/);
  } finally {
    removeTree(out);
  }
});

test('cli: help prints usage and exits 0', async () => {
  const outputs: string[] = [];
  const deps: CliDeps = { run: () => Promise.reject(new Error('must not run')), output: message => { outputs.push(message); }, error: () => undefined };
  assert.equal(await runCli(['--help'], deps), 0);
  assert.match(outputs.join('\n'), /Usage: npm run eval:opencode/);
});
