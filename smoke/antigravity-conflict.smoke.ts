// SMK-AGC: Antigravity install/update stop on conflicting or malformed merged config with a
// one-line actionable error (issue #91): absolute path, resolution, non-zero exit, no writes.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSandbox, tree, type RunResult, type Sandbox } from './support/sandbox.ts';
import { antigravityInstall, ask, setupSteps } from './support/steps.ts';

const foreignGuard = { matcher: 'run_command', command: 'node scripts/antigravity-merge-guard.mjs' };

// The failure is reported once on stderr, never as an uncaught error with a stack trace.
function assertActionableFailure(result: RunResult, file: string, resolution: RegExp): void {
  assert.equal(result.code, 1, result.transcript);
  const lines = result.stderr.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, result.stderr);
  assert.ok(lines[0]!.includes(file), `names ${file}: ${lines[0]}`);
  assert.match(lines[0]!, resolution);
  assert.match(lines[0]!, /No files were changed\.$/);
  assert.doesNotMatch(result.transcript, /^\s+at /m);
  assert.doesNotMatch(result.transcript, /^Error:/m);
}

describe('SMK-AGC project scope (pre-seeded unowned config)', () => {
  let box: Sandbox;
  const args = () => ['--host', 'antigravity', '--scope', 'project', '--project', box.project];
  const hooksPath = () => join(box.project, '.agents', 'hooks.json');
  const mcpPath = () => join(box.project, '.agents', 'mcp_config.json');
  before(() => {
    box = createSandbox('antigravity-conflict-project');
    mkdirSync(join(box.project, '.agents'), { recursive: true });
  });
  after(() => box.dispose());

  for (const script of ['install-native-harness.ts', 'update-native-harness.ts']) {
    it(`SMK-AGC-01 ${script} reports a conflicting gh-pr-merge-guard hook without writing`, async () => {
      writeFileSync(hooksPath(), JSON.stringify({ 'gh-pr-merge-guard': foreignGuard }, null, 2) + '\n');
      const pristine = tree(box.project);
      const result = await box.run(script, args());
      assertActionableFailure(result, hooksPath(), /latest Antigravity install receipt .* or remove the "gh-pr-merge-guard" key, then re-run/);
      assert.deepEqual(tree(box.project), pristine);
      assert.equal(existsSync(box.recoveryDirectory), false);
    });

    // The harness owns no MCP servers yet, so the reachable mcp_config.json failure is an invalid shape.
    it(`SMK-AGC-02 ${script} reports an invalid mcp_config.json without writing`, async () => {
      writeFileSync(hooksPath(), '{}\n');
      writeFileSync(mcpPath(), '{ "mcpServers": [] }\n');
      const pristine = tree(box.project);
      const result = await box.run(script, args());
      assertActionableFailure(result, mcpPath(), /"mcpServers" property must be a JSON object\. Fix the JSON or move the file aside, then re-run/);
      assert.deepEqual(tree(box.project), pristine);
      assert.equal(existsSync(box.recoveryDirectory), false);
    });

    it(`SMK-AGC-03 ${script} reports malformed hooks.json without writing`, async () => {
      writeFileSync(hooksPath(), '{ broken json');
      const pristine = tree(box.project);
      const result = await box.run(script, args());
      assertActionableFailure(result, hooksPath(), /Malformed existing hooks\.json: .* Fix the JSON or move the file aside, then re-run/);
      assert.deepEqual(tree(box.project), pristine);
      assert.equal(existsSync(box.recoveryDirectory), false);
    });
  }
});

describe('SMK-AGC global scope (hooks.json edited after a global install, as reported)', () => {
  let box: Sandbox;
  const args = ['--host', 'antigravity', '--scope', 'global'];
  const configDir = () => join(box.home, '.gemini', 'config');
  before(async () => {
    box = createSandbox('antigravity-conflict-global');
    const installed = await box.run('install-native-harness.ts', args, { steps: antigravityInstall('yes') });
    assert.equal(installed.code, 0, installed.transcript);
    const hooksPath = join(configDir(), 'hooks.json');
    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
    hooks['gh-pr-merge-guard'] = { ...hooks['gh-pr-merge-guard'], command: foreignGuard.command };
    writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + '\n');
  });
  after(() => box.dispose());

  for (const script of ['install-native-harness.ts', 'update-native-harness.ts']) {
    it(`SMK-AGC-04 ${script} reports the conflict with no writes, backups, or receipts`, async () => {
      const config = tree(configDir());
      const recovery = tree(box.recoveryDirectory);
      const result = await box.run(script, args);
      assertActionableFailure(result, join(configDir(), 'hooks.json'), new RegExp(`latest Antigravity install receipt under ${box.recoveryDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, or remove the "gh-pr-merge-guard" key`));
      assert.deepEqual(tree(configDir()), config);
      assert.deepEqual(tree(box.recoveryDirectory), recovery);
    });
  }
});

describe('SMK-AGC project update with existing project settings', () => {
  let box: Sandbox;
  const hooksPath = () => join(box.project, '.agents', 'hooks.json');
  before(async () => {
    box = createSandbox('antigravity-conflict-settings');
    const setup = await box.run('setup-native-project.ts', ['--scope', 'project', '--project', box.project], { steps: setupSteps('./gradlew assembleDebug', 'save') });
    assert.equal(setup.code, 0, setup.transcript);
    mkdirSync(join(box.project, '.agents'), { recursive: true });
    writeFileSync(hooksPath(), JSON.stringify({ 'gh-pr-merge-guard': foreignGuard }, null, 2) + '\n');
  });
  after(() => box.dispose());

  it('SMK-AGC-05 a hooks conflict stops update before shared-location changes can be confirmed', async () => {
    const before = tree(box.root);
    // Answers that would move the worktree parent and confirm writing it, if the update ever asked.
    const locationSteps = [
      ask('Parent directory for future worktrees', join(box.root, 'moved-worktrees')),
      ask('Shared MEMORY.md path'),
      ask('Type paths to apply', 'paths'),
    ];
    const result = await box.run('update-native-harness.ts', ['--host', 'antigravity', '--scope', 'project', '--project', box.project], { steps: locationSteps });
    assertActionableFailure(result, hooksPath(), /or remove the "gh-pr-merge-guard" key, then re-run/);
    assert.equal(result.unansweredSteps.length, locationSteps.length, 'no shared-location prompt was shown');
    assert.doesNotMatch(result.stdout, /Shared-location changes|Backup \(keep private\)|Created: /);
    assert.deepEqual(tree(box.root), before);
  });
});
