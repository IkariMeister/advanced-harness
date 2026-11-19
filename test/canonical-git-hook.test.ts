import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  // 4. Simulate an older attributed hook script, run update -> refreshed after 'update' confirmation
  const hookDir = resolveCanonicalHookDir(canonical)!;
  const preCommitPath = join(hookDir, canonicalHookNames[0]);
  const originalScript = readFileSync(preCommitPath, 'utf8');
  const olderScript = '#!/bin/sh\necho older-harness-version\n';
  writeFileSync(preCommitPath, olderScript);
  const statePath = join(hookDir, '.state.json');
  const hookState = JSON.parse(readFileSync(statePath, 'utf8'));
  hookState.managedFiles['pre-commit'] = createHash('sha256').update(olderScript, 'utf8').digest('hex');
  writeFileSync(statePath, JSON.stringify(hookState, null, 2) + '\n');
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

test('F-1: non-managed hooks (e.g. commit-msg) are forwarded and cleaned up on uninstall', t => {
  const { root, canonical, worktree } = repoWithRemoteAndWorktree(t);
  const marker = join(root, 'commit-msg-ran.txt');
  const defaultCommitMsg = join(canonical, '.git', 'hooks', 'commit-msg');
  writeFileSync(
    defaultCommitMsg,
    `#!/bin/sh\necho "commit-msg" >> "${marker.replace(/\\/g, '/')}"\nexit 0\n`
  );
  if (process.platform !== 'win32') chmodSync(defaultCommitMsg, 0o755);

  const plan = planCanonicalHookInstall(canonical, 'opencode');
  assert.equal(plan.status, 'change');
  applyCanonicalHook(plan);
  assert.equal(existsSync(join(resolveCanonicalHookDir(canonical)!, 'commit-msg')), true);

  writeFileSync(join(worktree, 'msg.txt'), 'msg\n');
  git(worktree, 'add', 'msg.txt');
  assert.equal(gitResult(worktree, 'commit', '-m', 'check commit-msg').ok, true);
  assert.equal(existsSync(marker), true, 'forwarded commit-msg hook ran in linked worktree');

  applyCanonicalHook(planCanonicalHookRemoval(canonical, 'opencode'));
  assert.equal(isCanonicalHookInstalled(canonical), false);
  assert.equal(existsSync(defaultCommitMsg), true, 'original .git/hooks/commit-msg preserved');
});

test('F-2: inherited non-local core.hooksPath is chained and resumes on uninstall', t => {
  const { root, canonical, worktree } = repoWithRemoteAndWorktree(t);
  const globalHooks = join(root, 'global-hooks');
  mkdirSync(globalHooks, { recursive: true });
  const marker = join(root, 'global-hook-ran.txt');
  const globalPreCommit = join(globalHooks, 'pre-commit');
  writeFileSync(
    globalPreCommit,
    `#!/bin/sh\necho "global" >> "${marker.replace(/\\/g, '/')}"\nexit 0\n`
  );
  if (process.platform !== 'win32') chmodSync(globalPreCommit, 0o755);

  const globalConfig = join(root, 'global.gitconfig');
  writeFileSync(globalConfig, `[core]\n\thooksPath = ${globalHooks.replace(/\\/g, '/')}\n`);

  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  t.after(() => {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
  });

  const plan = planCanonicalHookInstall(canonical, 'opencode');
  assert.equal(plan.status, 'change');
  assert.equal(plan.previousLocalHooksPath, undefined);
  assert.equal(plan.previousEffectiveHooksPath, globalHooks.replace(/\\/g, '/'));
  applyCanonicalHook(plan);

  writeFileSync(join(worktree, 'g.txt'), 'g\n');
  git(worktree, 'add', 'g.txt');
  assert.equal(gitResult(worktree, 'commit', '-m', 'wt with global hook').ok, true);
  assert.equal(existsSync(marker), true, 'inherited global core.hooksPath ran');

  applyCanonicalHook(planCanonicalHookRemoval(canonical, 'opencode'));
  assert.equal(gitResult(canonical, 'config', '--local', '--get', 'core.hooksPath').ok, false);
  assert.equal(git(canonical, 'config', '--get', 'core.hooksPath'), globalHooks.replace(/\\/g, '/'));
});

test('F-3: foreign or modified files in hook directory are rejected on install and preserved on uninstall', t => {
  const { canonical } = repoWithRemoteAndWorktree(t);
  const hookDir = resolveCanonicalHookDir(canonical)!;
  mkdirSync(hookDir, { recursive: true });
  const foreignFile = join(hookDir, 'custom-note.txt');
  writeFileSync(foreignFile, 'keep me\n');

  const blocked = planCanonicalHookInstall(canonical, 'opencode');
  assert.equal(blocked.status, 'unavailable');
  assert.match(blocked.reason, /Unowned files exist/);
  assert.equal(readFileSync(foreignFile, 'utf8'), 'keep me\n');

  rmSync(foreignFile);
  applyCanonicalHook(planCanonicalHookInstall(canonical, 'opencode'));

  // Modify a managed hook and add a foreign file; uninstall must preserve both
  const preCommit = join(hookDir, 'pre-commit');
  writeFileSync(preCommit, '#!/bin/sh\necho custom\n');
  writeFileSync(foreignFile, 'foreign\n');
  const removePlan = planCanonicalHookRemoval(canonical, 'opencode');
  assert.equal(removePlan.status, 'change');
  applyCanonicalHook(removePlan);
  assert.equal(existsSync(preCommit), true, 'user-modified hook preserved');
  assert.equal(existsSync(foreignFile), true, 'foreign file preserved');
  assert.match(removePlan.warning ?? '', /preserved foreign\/modified files/);
});

test('F-4: interleaved planning and apply rejects stale state without overwriting another owner', t => {
  const { canonical } = repoWithRemoteAndWorktree(t);
  const planA = planCanonicalHookInstall(canonical, 'opencode');
  const planB = planCanonicalHookInstall(canonical, 'claude-code');
  assert.equal(applyCanonicalHook(planB), true);
  assert.throws(() => applyCanonicalHook(planA), /changed after preview/);
  const state = JSON.parse(readFileSync(join(resolveCanonicalHookDir(canonical)!, '.state.json'), 'utf8'));
  assert.deepEqual(state.owners, ['claude-code']);
});

test('F-5: config read/unset errors propagate and preserve hook files when unset fails', t => {
  const { canonical } = repoWithRemoteAndWorktree(t);
  applyCanonicalHook(planCanonicalHookInstall(canonical, 'opencode'));

  const failingRunner = (exe: string, args: string[], opts?: { cwd?: string }) => {
    if (exe === 'git' && args[0] === 'config' && args.includes('--unset')) {
      throw Object.assign(new Error('simulated unset failure'), { status: 5 });
    }
    if (exe === 'git' && args[0] === 'config' && args.includes('--get') && args.includes('extensions.worktreeConfig')) {
      return '';
    }
    return execFileSync(exe, args, { cwd: opts?.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  };

  const removePlan = planCanonicalHookRemoval(canonical, 'opencode', failingRunner);
  assert.equal(removePlan.status, 'change');
  assert.throws(() => applyCanonicalHook(removePlan, failingRunner), /simulated unset failure/);
  assert.equal(isCanonicalHookInstalled(canonical), true, 'hook state preserved on failed unset');
  assert.equal(existsSync(join(resolveCanonicalHookDir(canonical)!, 'pre-commit')), true);

  const badReadRunner = (exe: string, args: string[]) => {
    if (exe === 'git' && args[0] === 'config') {
      throw Object.assign(new Error('corrupt config'), { status: 128 });
    }
    return execFileSync(exe, args, { cwd: canonical, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  };
  const readBlocked = planCanonicalHookInstall(canonical, 'claude-code', badReadRunner);
  assert.equal(readBlocked.status, 'unavailable');
  assert.match(readBlocked.reason, /corrupt config/);
});

test('F-7: nested subdirectory, linked worktree, and worktreeConfig precedence are handled', t => {
  const { canonical, worktree } = repoWithRemoteAndWorktree(t);
  const nested = join(canonical, 'packages', 'app');
  mkdirSync(nested, { recursive: true });

  // Installing from a nested subdirectory resolves relative to repo top-level
  const plan = planCanonicalHookInstall(nested, 'opencode');
  assert.equal(plan.status, 'change');
  applyCanonicalHook(plan);
  assert.equal(planCanonicalHookInstall(worktree, 'opencode').status, 'current', 'linked worktree sees current hook');

  // Worktree-scoped core.hooksPath overrides --local and is rejected safely from any worktree (R2-F4)
  git(canonical, 'config', '--local', 'extensions.worktreeConfig', 'true');
  git(worktree, 'config', '--worktree', 'core.hooksPath', '.wt-hooks');
  const blockedFromWorktree = planCanonicalHookInstall(worktree, 'claude-code');
  assert.equal(blockedFromWorktree.status, 'unavailable');
  assert.match(blockedFromWorktree.reason, /worktree-scoped core\.hooksPath/);
  const blockedFromCanonical = planCanonicalHookInstall(canonical, 'claude-code');
  assert.equal(blockedFromCanonical.status, 'unavailable');
  assert.match(blockedFromCanonical.reason, /worktree-scoped core\.hooksPath/);
});

test('R2-F1: symlinked hook in .git/hooks is refused without writing', t => {
  const { root, canonical } = repoWithRemoteAndWorktree(t);
  const target = join(root, 'external-hook.sh');
  writeFileSync(target, '#!/bin/sh\nexit 0\n');
  const symlinkPath = join(canonical, '.git', 'hooks', 'commit-msg');
  try {
    symlinkSync(target, symlinkPath);
  } catch {
    t.skip('file symlinks are not available');
    return;
  }
  const plan = planCanonicalHookInstall(canonical, 'opencode');
  assert.equal(plan.status, 'unavailable');
  assert.match(plan.reason, /Refusing symlinked hook/);
});

test('R2-F2: partial write failure rolls back hookDir and finishCanonicalHook propagates non-zero CLI exit', async t => {
  const { root, canonical } = repoWithRemoteAndWorktree(t);
  const plan = planCanonicalHookInstall(canonical, 'opencode');
  assert.equal(plan.status, 'change');

  const failingConfigRunner = (exe: string, args: string[], opts?: { cwd?: string }) => {
    if (exe === 'git' && args[0] === 'config' && args.includes('--local') && args.includes('core.hooksPath') && !args.includes('--get')) {
      throw new Error('simulated config write failure');
    }
    return execFileSync(exe, args, { cwd: opts?.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  };

  assert.throws(() => applyCanonicalHook(plan, failingConfigRunner), /simulated config write failure/);
  assert.equal(existsSync(resolveCanonicalHookDir(canonical)!), false, 'rolled back newly created hookDir on failure');

  // Also verify CLI flow returns exit code 1 when finishCanonicalHook fails (e.g., stale lock)
  const lockPath = `${resolveCanonicalHookDir(canonical)!}.harness.lock`;
  writeFileSync(lockPath, JSON.stringify({ pid: 99999, createdAt: '2026-11-16T00:00:00Z' }));
  const errors: string[] = [];
  const exitCode = await runInstallerFlow(
    { scope: 'project', project: canonical, host: 'opencode' },
    {
      ask: async question => {
        if (question.includes(': model ID')) return 'local/model#low';
        if (question.includes(': reasoning variant')) return 'low';
        if (question.startsWith('Install opt-in local Git hook')) return 'yes';
        if (question.startsWith('Type install')) return 'install';
        return 'no';
      },
      output: () => {},
      error: line => errors.push(line),
      home: root,
      recoveryDirectory: join(root, 'recovery'),
      verify: async () => ({ ok: true, checks: [] }) as never,
      printReport: () => {},
    }
  );
  assert.equal(exitCode, 1);
  assert.ok(errors.some(e => e.includes('PID 99999')));
  rmSync(lockPath);
});

test('R2-F3: update cancellation with real pending shared-location changes writes zero files or backups', async t => {
  const { root, canonical } = repoWithRemoteAndWorktree(t);
  const recovery = join(root, 'recovery');

  // Install OpenCode first
  assert.equal(await runInstallerFlow(
    { scope: 'project', project: canonical, host: 'opencode' },
    {
      ask: async question => {
        if (question.includes(': model ID')) return 'local/model#low';
        if (question.includes(': reasoning variant')) return 'low';
        if (question.startsWith('Install opt-in local Git hook')) return 'no';
        if (question.startsWith('Type install')) return 'install';
        return 'no';
      },
      output: () => {},
      error: line => assert.fail(line),
      home: root,
      recoveryDirectory: recovery,
      verify: async () => ({ ok: true, checks: [] }) as never,
      printReport: () => {},
    }
  ), 0);

  // Seed AGENTS.md with valid project settings pointing to a missing worktree/memory path so
  // real prepareSharedLocationStep has pending creations and prompts "Type paths".
  const wtDir = join(root, 'pending-worktrees');
  const memFile = join(root, 'pending-memory', 'MEMORY.md');
  const agentsContent = [
    '# Project',
    '',
    '<!-- advanced-harness:project:start -->',
    '```json',
    JSON.stringify({
      version: 1,
      baseBranch: 'main',
      shell: 'bash',
      checks: {
        build: { status: 'unconfigured' },
        lint: { status: 'unconfigured' },
        unit: { status: 'unconfigured' },
        roborazzi: { status: 'unconfigured' },
        runtime: { status: 'unconfigured' },
        e2e: { status: 'unconfigured' },
      },
      device: { preference: 'ask' },
      worktreeDirectory: wtDir,
      memoryPath: memFile,
    }, null, 2),
    '```',
    '<!-- advanced-harness:project:end -->',
    '',
  ].join('\n');
  writeFileSync(join(canonical, 'AGENTS.md'), agentsContent);
  const receiptsBefore = readdirSync(recovery).length;

  const code = await runUpdateFlow(
    { scope: 'project', project: canonical, host: 'opencode' },
    {
      ask: async question => {
        if (question.startsWith('Type paths to apply')) return 'paths';
        if (question.startsWith('Type update')) return 'cancel';
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

  assert.equal(code, 0);
  assert.equal(existsSync(wtDir), false, 'deferred worktreeDirectory not created on cancel');
  assert.equal(existsSync(memFile), false, 'deferred MEMORY.md not created on cancel');
  assert.equal(readFileSync(join(canonical, 'AGENTS.md'), 'utf8'), agentsContent);
  assert.equal(readdirSync(recovery).length, receiptsBefore, 'no backup or receipt created on cancel');
});

test('R2-F6: non-executable hook script on POSIX is not classified as current', t => {
  if (process.platform === 'win32') {
    t.skip('POSIX executable mode bits do not apply on Windows');
    return;
  }
  const { canonical } = repoWithRemoteAndWorktree(t);
  applyCanonicalHook(planCanonicalHookInstall(canonical, 'opencode'));
  const preCommit = join(resolveCanonicalHookDir(canonical)!, 'pre-commit');
  chmodSync(preCommit, 0o644);
  const plan = planCanonicalHookInstall(canonical, 'opencode');
  assert.equal(plan.status, 'unavailable');
  assert.match(plan.reason, /lost executable permission/);
});

test('R2-F7: stale lockfile reports conservative diagnostics without auto-deleting and recovers after manual removal', t => {
  const { canonical } = repoWithRemoteAndWorktree(t);
  const plan = planCanonicalHookInstall(canonical, 'opencode');
  assert.equal(plan.status, 'change');
  const lockPath = `${resolveCanonicalHookDir(canonical)!}.harness.lock`;
  writeFileSync(lockPath, JSON.stringify({ pid: 42424, createdAt: '2026-11-16T12:00:00.000Z' }));

  assert.throws(
    () => applyCanonicalHook(plan),
    /PID 42424, started 2026-11-16T12:00:00\.000Z.*remove .* manually and rerun/
  );
  assert.equal(existsSync(lockPath), true, 'lockfile preserved without auto-deletion');

  rmSync(lockPath);
  assert.equal(applyCanonicalHook(plan), true);
  assert.equal(isCanonicalHookInstalled(canonical), true);
});
