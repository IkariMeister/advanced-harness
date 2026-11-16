import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRoot } from './temp-directory.ts';
import {
  applyCanonicalHook,
  canonicalHookNames,
  isCanonicalHookInstalled,
  planCanonicalHookInstall,
  planCanonicalHookRemoval,
  resolveCanonicalHookDir,
} from '../src/canonical-git-hook.ts';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import { runUninstallFlow } from '../src/uninstall-cli-flow.ts';
import { discoverReceiptChain, readReceiptForRestore } from '../src/receipt-lineage.ts';
import { saveInstallation } from '../src/native-installer.ts';

const git = (cwd: string, ...args: string[]) => execFileSync(
  'git',
  ['-c', 'user.name=Harness Test', '-c', 'user.email=harness@example.invalid', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
).trim();

function gitResult(cwd: string, ...args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=Harness Test', '-c', 'user.email=harness@example.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return {
    ok: res.status === 0,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
  };
}

function repoWithRemoteAndWorktree(t: { after(fn: () => void): void }) {
  const root = makeTempRoot('harness-canonical-hook-');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const origin = join(root, 'origin.git');
  git(root, 'init', '--bare', '--initial-branch=main', '--quiet', origin);

  const canonical = join(root, 'canonical');
  git(root, 'clone', '--quiet', origin, canonical);
  git(canonical, 'checkout', '--quiet', '-b', 'main');
  writeFileSync(join(canonical, 'README.md'), 'init\n');
  git(canonical, 'add', 'README.md');
  git(canonical, 'commit', '--quiet', '-m', 'init');
  git(canonical, 'push', '--quiet', '-u', 'origin', 'main');

  // Create a feature branch in a separate clone to push a commit to origin/main
  const updater = join(root, 'updater');
  git(root, 'clone', '--quiet', origin, updater);
  writeFileSync(join(updater, 'remote.txt'), 'from remote\n');
  git(updater, 'add', 'remote.txt');
  git(updater, 'commit', '--quiet', '-m', 'remote update');
  git(updater, 'push', '--quiet', 'origin', 'HEAD:main');

  // Create a side branch with its own commit for non-ff merge / rebase tests
  git(canonical, 'checkout', '--quiet', '-b', 'side');
  writeFileSync(join(canonical, 'side.txt'), 'side\n');
  git(canonical, 'add', 'side.txt');
  git(canonical, 'commit', '--quiet', '-m', 'side commit');
  git(canonical, 'checkout', '--quiet', 'main');

  const worktree = join(root, 'worktree-issue');
  git(canonical, 'worktree', 'add', '--quiet', '-b', 'issue/1', worktree);

  return { root, origin, canonical, worktree };
}

test('canonical hook blocks commit, non-ff merge, and rebase in canonical checkout while allowing ff-only and linked worktrees', t => {
  const { canonical, worktree } = repoWithRemoteAndWorktree(t);

  const plan = planCanonicalHookInstall(canonical, 'opencode');
  assert.equal(plan.status, 'change');
  assert.equal(applyCanonicalHook(plan), true);
  assert.equal(isCanonicalHookInstalled(canonical), true);

  // 1. Canonical checkout blocks commit
  writeFileSync(join(canonical, 'dirty.txt'), 'nope\n');
  git(canonical, 'add', 'dirty.txt');
  const commitRes = gitResult(canonical, 'commit', '-m', 'should fail');
  assert.equal(commitRes.ok, false);
  assert.match(commitRes.stderr, /commits are blocked in the canonical checkout/);
  git(canonical, 'reset', '--quiet', 'HEAD', 'dirty.txt');
  rmSync(join(canonical, 'dirty.txt'));

  // 2. Canonical checkout allows fast-forward update from origin/main
  git(canonical, 'fetch', '--quiet', 'origin');
  const ffRes = gitResult(canonical, 'merge', '--ff-only', 'origin/main');
  assert.equal(ffRes.ok, true, ffRes.stderr);

  // 3. Canonical checkout blocks non-fast-forward merge (--no-ff)
  const nonFfRes = gitResult(canonical, 'merge', '--no-ff', 'side', '-m', 'merge side');
  assert.equal(nonFfRes.ok, false);
  assert.match(nonFfRes.stderr, /non-fast-forward merges are blocked in the canonical checkout/);
  git(canonical, 'merge', '--abort');

  // 4. Canonical checkout blocks rebase
  const rebaseRes = gitResult(canonical, 'rebase', 'side');
  assert.equal(rebaseRes.ok, false);
  assert.match(rebaseRes.stderr, /rebases are blocked in the canonical checkout/);

  // 5. Canonical checkout post-checkout warns on branch switch (and file checkout does not)
  const fileCheckout = gitResult(canonical, 'checkout', '--', 'README.md');
  assert.equal(fileCheckout.ok, true);
  assert.doesNotMatch(fileCheckout.stderr, /branch switches in the canonical checkout/);

  const switchRes = gitResult(canonical, 'checkout', 'side');
  assert.equal(switchRes.ok, true);
  assert.match(switchRes.stderr, /branch switches in the canonical checkout violate ADR-004/);
  git(canonical, 'checkout', '--quiet', 'main');

  // 6. Linked worktree allows commit, non-ff merge, and rebase
  writeFileSync(join(worktree, 'feature.txt'), 'allowed\n');
  git(worktree, 'add', 'feature.txt');
  const wtCommit = gitResult(worktree, 'commit', '-m', 'worktree commit');
  assert.equal(wtCommit.ok, true, wtCommit.stderr);

  const wtMerge = gitResult(worktree, 'merge', '--no-ff', 'side', '-m', 'worktree merge');
  assert.equal(wtMerge.ok, true, wtMerge.stderr);

  const wtRebase = gitResult(worktree, 'rebase', 'main');
  assert.equal(wtRebase.ok, true, wtRebase.stderr);
});

test('canonical hook chains to pre-existing core.hooksPath and restores it on uninstall', t => {
  const { root, canonical, worktree } = repoWithRemoteAndWorktree(t);
  const customHooks = join(root, 'custom-hooks');
  mkdirSync(customHooks, { recursive: true });
  const marker = join(root, 'chained-ran.txt');
  const customPreCommit = join(customHooks, 'pre-commit');
  writeFileSync(
    customPreCommit,
    `#!/bin/sh\necho "ran" >> "${marker.replace(/\\/g, '/')}"\nexit 0\n`
  );
  if (process.platform !== 'win32') chmodSync(customPreCommit, 0o755);
  git(canonical, 'config', '--local', 'core.hooksPath', customHooks.replace(/\\/g, '/'));

  const plan = planCanonicalHookInstall(canonical, 'opencode');
  assert.equal(plan.status, 'change');
  assert.equal(plan.action, 'install');
  assert.equal(plan.previousLocalHooksPath, customHooks.replace(/\\/g, '/'));
  applyCanonicalHook(plan);

  // Linked worktree commit should chain to customHooks/pre-commit and succeed
  writeFileSync(join(worktree, 'a.txt'), 'a\n');
  git(worktree, 'add', 'a.txt');
  assert.equal(gitResult(worktree, 'commit', '-m', 'wt commit').ok, true);
  assert.equal(existsSync(marker), true, 'chained custom pre-commit ran');

  // Uninstall restores customHooks
  const removePlan = planCanonicalHookRemoval(canonical, 'opencode');
  assert.equal(removePlan.status, 'change');
  assert.equal(removePlan.action, 'remove');
  applyCanonicalHook(removePlan);
  assert.equal(git(canonical, 'config', '--local', '--get', 'core.hooksPath'), customHooks.replace(/\\/g, '/'));
  assert.equal(existsSync(resolveCanonicalHookDir(canonical)!), false);
});

test('multi-host ownership releases one owner without removing the hook until the last owner uninstalls', t => {
  const { canonical } = repoWithRemoteAndWorktree(t);
  applyCanonicalHook(planCanonicalHookInstall(canonical, 'opencode'));
  applyCanonicalHook(planCanonicalHookInstall(canonical, 'claude-code'));
  assert.equal(planCanonicalHookInstall(canonical, 'claude-code').status, 'current');

  const releaseOpenCode = planCanonicalHookRemoval(canonical, 'opencode');
  assert.equal(releaseOpenCode.status === 'change' && releaseOpenCode.action, 'release');
  applyCanonicalHook(releaseOpenCode);
  assert.equal(isCanonicalHookInstalled(canonical), true);

  const removeClaude = planCanonicalHookRemoval(canonical, 'claude-code');
  assert.equal(removeClaude.status === 'change' && removeClaude.action, 'remove');
  applyCanonicalHook(removeClaude);
  assert.equal(isCanonicalHookInstalled(canonical), false);
  assert.equal(gitResult(canonical, 'config', '--local', '--get', 'core.hooksPath').ok, false);
});

test('concurrent core.hooksPath edit after preview blocks apply, and uninstall does not clobber user-changed hooksPath', t => {
  const { canonical } = repoWithRemoteAndWorktree(t);
  const preview = planCanonicalHookInstall(canonical, 'opencode');
  git(canonical, 'config', '--local', 'core.hooksPath', '.custom-hooks');
  assert.throws(() => applyCanonicalHook(preview), /changed after preview/);
  assert.equal(isCanonicalHookInstalled(canonical), false);

  // Install cleanly, then user changes core.hooksPath; uninstall leaves user's path intact
  git(canonical, 'config', '--local', '--unset', 'core.hooksPath');
  applyCanonicalHook(planCanonicalHookInstall(canonical, 'opencode'));
  git(canonical, 'config', '--local', 'core.hooksPath', '.user-hooks');
  const removePlan = planCanonicalHookRemoval(canonical, 'opencode');
  assert.equal(removePlan.status === 'change' && removePlan.restoreHooksPath, false);
  applyCanonicalHook(removePlan);
  assert.equal(git(canonical, 'config', '--local', '--get', 'core.hooksPath'), '.user-hooks');
});

test('OpenCode install, update, and uninstall flows respect opt-in consent and cancellation leaves zero writes or backups', async t => {
  const { root, canonical } = repoWithRemoteAndWorktree(t);
  const recovery = join(root, 'recovery');
  const runOpenCodeInstall = (hookAnswer: string, confirmAnswer: string) => runInstallerFlow(
    { scope: 'project', project: canonical, host: 'opencode' },
    {
      ask: async question => {
        if (question.includes(': model ID')) return 'local/model#low';
        if (question.includes(': reasoning variant')) return 'low';
        if (question.startsWith('Install opt-in local Git hook')) return hookAnswer;
        if (question.startsWith('Type install')) return confirmAnswer;
        return 'no';
      },
      output: () => {},
      error: line => assert.fail(line),
      home: root,
      recoveryDirectory: recovery,
      verify: async () => ({ ok: true, checks: [] }) as never,
      printReport: () => {},
    }
  );

  // 1. Accept hook opt-in, then cancel final confirmation -> no writes, no config, no backups
  assert.equal(await runOpenCodeInstall('yes', 'cancel'), 0);
  assert.equal(isCanonicalHookInstalled(canonical), false);
  assert.equal(gitResult(canonical, 'config', '--local', '--get', 'core.hooksPath').ok, false);
  assert.equal(existsSync(recovery), false);

  // 2. Decline hook opt-in + confirm install -> OpenCode installed, hook NOT installed
  assert.equal(await runOpenCodeInstall('no', 'install'), 0);
  assert.equal(isCanonicalHookInstalled(canonical), false);
  assert.equal(gitResult(canonical, 'config', '--local', '--get', 'core.hooksPath').ok, false);

  // 3. Re-install with hook opt-in 'yes' + confirm -> hook installed
  assert.equal(await runOpenCodeInstall('yes', 'install'), 0);
  assert.equal(isCanonicalHookInstalled(canonical), true);

  // 4. Corrupt one hook script, run update -> refreshed after 'update' confirmation
  const hookDir = resolveCanonicalHookDir(canonical)!;
  const preCommitPath = join(hookDir, canonicalHookNames[0]);
  const originalScript = readFileSync(preCommitPath, 'utf8');
  writeFileSync(preCommitPath, '#!/bin/sh\necho stale\n');
  assert.equal(await runUpdateFlow(
    { scope: 'project', project: canonical, host: 'opencode' },
    {
      ask: async question => question.startsWith('Type update') ? 'update' : 'no',
      output: () => {},
      error: line => assert.fail(line),
      home: root,
      recoveryDirectory: recovery,
      sharedLocations: async () => undefined as never,
      verify: async () => ({ ok: true, checks: [] }) as never,
      printReport: () => {},
    }
  ), 0);
  assert.equal(readFileSync(preCommitPath, 'utf8'), originalScript);

  // 5. Uninstall cancel leaves hook installed; confirm 'uninstall' removes hook and unsets core.hooksPath
  const target = join(canonical, 'opencode.jsonc');
  const snapshot = discoverReceiptChain(recovery, target, 'opencode');
  const receipt = readReceiptForRestore(join(snapshot.directory, snapshot.head!.file), target);
  const runUninstall = (confirm: string) => runUninstallFlow({
    receipt,
    current: readFileSync(target, 'utf8'),
    host: 'opencode',
    excludeRoot: canonical,
    backupParent: recovery,
    pruneRoot: canonical,
    confirm: async () => confirm,
    output: () => {},
    error: line => assert.fail(line),
    save: updated => { saveInstallation(target, readFileSync(target, 'utf8'), updated, recovery); },
  });

  assert.equal(await runUninstall(''), 0);
  assert.equal(isCanonicalHookInstalled(canonical), true);

  assert.equal(await runUninstall('uninstall'), 0);
  assert.equal(isCanonicalHookInstalled(canonical), false);
  assert.equal(gitResult(canonical, 'config', '--local', '--get', 'core.hooksPath').ok, false);
});

test('Claude Code and Antigravity project installs handle opt-in hook and cancellation', async t => {
  const { root, canonical } = repoWithRemoteAndWorktree(t);
  const recovery = join(root, 'recovery');
  const agentsDirectory = fileURLToPath(new URL('../agents/', import.meta.url));
  const commandsDirectory = fileURLToPath(new URL('../commands/', import.meta.url));

  // Claude Code cancel leaves no hook or recovery
  assert.equal(await runInstallerFlow(
    { scope: 'project', project: canonical, host: 'claude-code' },
    {
      ask: async question => question.startsWith('Install opt-in local Git hook') ? 'yes' : question.startsWith('Type yes') ? 'no' : '',
      output: () => {},
      error: line => assert.fail(line),
      home: root,
      recoveryDirectory: recovery,
      agentsDirectory,
      commandsDirectory,
    }
  ), 1);
  assert.equal(isCanonicalHookInstalled(canonical), false);
  assert.equal(existsSync(recovery), false);

  // Claude Code confirm installs hook
  assert.equal(await runInstallerFlow(
    { scope: 'project', project: canonical, host: 'claude-code' },
    {
      ask: async question => question.startsWith('Install opt-in local Git hook') ? 'yes' : question.startsWith('Type yes') ? 'yes' : '',
      output: () => {},
      error: line => assert.fail(line),
      home: root,
      recoveryDirectory: recovery,
      agentsDirectory,
      commandsDirectory,
    }
  ), 0);
  assert.equal(isCanonicalHookInstalled(canonical), true);

  // Antigravity adds itself as second owner
  assert.equal(await runInstallerFlow(
    { scope: 'project', project: canonical, host: 'antigravity' },
    {
      ask: async (question, suggested) => question.trimStart().startsWith('Type yes to install the Antigravity') ? 'yes' : (suggested ?? 'yes'),
      output: () => {},
      error: line => assert.fail(line),
      home: root,
      recoveryDirectory: recovery,
      agentsDirectory,
      commandsDirectory,
    }
  ), 0);
  const state = JSON.parse(readFileSync(join(resolveCanonicalHookDir(canonical)!, '.state.json'), 'utf8'));
  assert.deepEqual(state.owners, ['antigravity', 'claude-code']);
  assert.ok(readdirSync(recovery).length > 0);
});
