import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentIpcDispatch, agentIpcEndpoint } from '../spike/opencode/host-ipc-client.ts';
import { fixtureApprovedContent, fixtureHostPaths } from '../src/fixture-host.ts';

test('separate headless host binds roles and cannot approve its fixture action', async t => {
  const project = mkdtempSync(join(tmpdir(), 'advanced-harness-process-host-'));
  mkdirSync(join(project, 'fixture'));
  writeFileSync(join(project, 'fixture', 'greeting.txt'), 'UNCHANGED\n');
  writeFileSync(join(project, '.harness-test-fixture.json'), JSON.stringify({ schema: 1, kind: 'advanced-harness-agent-test' }));
  const paths = fixtureHostPaths(project);
  const runner = fileURLToPath(new URL('../examples/fixture-host-runner.ts', import.meta.url));
  const child = spawn(process.execPath, [runner, project, '--headless'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
    }
    rmSync(project, { recursive: true, force: true });
    rmSync(paths.state, { recursive: true, force: true });
  });

  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Host readiness timeout\nstdout=${stdout}\nstderr=${stderr}`)), 10_000);
    const inspect = () => {
      if (stdout.includes('HARNESS_FIXTURE_HOST_READY')) { clearTimeout(timeout); resolveReady(); }
      else if (child.exitCode !== null) { clearTimeout(timeout); reject(new Error(`Host exited ${child.exitCode}\n${stderr}`)); }
      else setTimeout(inspect, 20);
    };
    inspect();
  });

  const planner = agentIpcEndpoint(paths.ipc, 'planner');
  const implementer = agentIpcEndpoint(paths.ipc, 'implementer');
  const external = agentIpcEndpoint(paths.ipc, 'external');
  await agentIpcDispatch(planner, 'harness.propose-plan', 'Replace only the marked disposable greeting.');
  const action = { id: 'process-edit', action: 'edit-code', input: { file: 'greeting.txt', content: fixtureApprovedContent }, findings: [] };
  await assert.rejects(agentIpcDispatch(implementer, 'harness.action', action), /Plan approval required/);
  await assert.rejects(agentIpcDispatch(external, 'harness.action', { ...action, id: 'wrong-role' }), /different agent/);
  await assert.rejects(agentIpcDispatch(planner, 'harness.decide', {}), /unavailable/);
  assert.equal(await import('node:fs').then(fs => fs.readFileSync(join(project, 'fixture', 'greeting.txt'), 'utf8')), 'UNCHANGED\n');
});
