import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { makeTempRoot } from './temp-directory.ts';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { saveInstallation } from '../src/native-installer.ts';
import { effectiveReceiptHost } from '../src/installation-receipt.ts';
import { discoverReceiptChain, readReceiptForRestore } from '../src/receipt-lineage.ts';
import { runUninstallFlow } from '../src/uninstall-cli-flow.ts';
import { selectUninstallTarget, uninstallPruneRoot } from '../src/uninstall-target.ts';
import type { HostId } from '../src/host-registry.ts';

type Fixture = { root: string; project: string; home: string; recovery: string; output: string[]; errors: string[]; prompts: string[] };

function fixture(t: { after(fn: () => void): void }): Fixture {
  const root = makeTempRoot('uninstall-host-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project);
  mkdirSync(home);
  return { root, project, home, recovery: join(root, 'recovery'), output: [], errors: [], prompts: [] };
}

// Answers every install prompt affirmatively; the uninstall prompt is driven separately.
const installDeps = (f: Fixture) => ({
  ask: async (question: string, suggested?: string) => (question.startsWith('Type yes') || question.startsWith('Overwrite') ? 'yes' : (suggested ?? '')),
  output: (message: string) => { f.output.push(message); },
  error: (message: string) => { f.errors.push(message); },
  home: f.home,
  recoveryDirectory: f.recovery,
});

async function install(f: Fixture, host: 'claude-code' | 'antigravity', scope: 'project' | 'global') {
  const status = await runInstallerFlow({ host, scope, ...(scope === 'project' ? { project: f.project } : {}) }, installDeps(f));
  assert.equal(status, 0, f.errors.join('\n'));
}

// Mirrors scripts/uninstall-native-harness.ts after target selection: receipt discovery, review, confirmation, save.
async function uninstall(f: Fixture, host: HostId, args: { scope?: string; project?: string; config?: string }, answer: string) {
  const target = selectUninstallTarget({ host, ...args, home: f.home, cwd: f.root });
  const targetAbsent = host !== 'opencode' && !existsSync(target);
  const current = targetAbsent ? '' : readFileSync(target, 'utf8');
  const snapshotChain = discoverReceiptChain(f.recovery, target, host);
  if (!snapshotChain.head) throw new Error('No active installation receipt was found for this target and host.');
  const receipt = readReceiptForRestore(join(snapshotChain.directory, snapshotChain.head.file), target);
  assert.equal(effectiveReceiptHost(receipt), host);
  return runUninstallFlow({
    receipt, current, backupParent: f.recovery, host, pruneRoot: uninstallPruneRoot(host, target, f.home),
    confirm: async question => { f.prompts.push(question); return answer; },
    output: message => { f.output.push(message); },
    error: message => { f.errors.push(message); },
    save: updated => {
      if (targetAbsent) throw new Error('Target was absent at review; refusing to create it during uninstall.');
      saveInstallation(target, current, updated, f.recovery);
    },
  });
}

/** Every file (content) and directory (marker) under a directory, keyed by relative path. */
function snapshot(directory: string): Map<string, string> {
  const entries = new Map<string, string>();
  const walk = (current: string) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const rel = relative(directory, path).split(sep).join('/');
      if (entry.isDirectory()) { entries.set(`${rel}/`, 'dir'); walk(path); }
      else entries.set(rel, readFileSync(path, 'utf8'));
    }
  };
  walk(directory);
  return entries;
}

const filesUnder = (directory: string) => [...snapshot(directory).keys()].filter(key => !key.endsWith('/'));

test('Claude Code uninstall removes the footprint and restores pre-existing CLAUDE.md and settings.json', async t => {
  const f = fixture(t);
  const claudeMd = '# Team memory\n\nKeep this.\n';
  const settings = '{\n  "model": "sonnet"\n}\n';
  writeFileSync(join(f.project, 'CLAUDE.md'), claudeMd);
  mkdirSync(join(f.project, '.claude'));
  writeFileSync(join(f.project, '.claude', 'settings.json'), settings);
  await install(f, 'claude-code', 'project');

  assert.equal(await uninstall(f, 'claude-code', { scope: 'project', project: f.project }, 'uninstall'), 0, f.errors.join('\n'));
  assert.ok(f.prompts.some(question => question.startsWith('Type uninstall to continue')));
  assert.equal(readFileSync(join(f.project, 'CLAUDE.md'), 'utf8'), claudeMd);
  assert.equal(readFileSync(join(f.project, '.claude', 'settings.json'), 'utf8'), settings);
  assert.equal(existsSync(join(f.project, '.claude', 'agents')), false, 'agents directory pruned');
  assert.equal(existsSync(join(f.project, '.claude', 'commands')), false, 'commands directory pruned');
  assert.ok(f.output.some(line => line.startsWith('Removed empty installer directory:')));
});

test('Claude Code uninstall of a fresh install removes every created file and directory it can prove', async t => {
  const f = fixture(t);
  await install(f, 'claude-code', 'project');
  assert.equal(await uninstall(f, 'claude-code', { scope: 'project', project: f.project }, 'uninstall'), 0, f.errors.join('\n'));
  assert.deepEqual(filesUnder(f.project), [], 'no installer files remain');
  assert.equal(existsSync(join(f.project, '.claude', 'agents')), false);
  assert.equal(existsSync(join(f.project, '.claude', 'commands')), false);
});

test('user-added files inside installer directories survive uninstall and keep their directory', async t => {
  const f = fixture(t);
  await install(f, 'claude-code', 'project');
  writeFileSync(join(f.project, '.claude', 'agents', 'custom.md'), 'user agent\n');
  assert.equal(await uninstall(f, 'claude-code', { scope: 'project', project: f.project }, 'uninstall'), 0, f.errors.join('\n'));
  assert.equal(readFileSync(join(f.project, '.claude', 'agents', 'custom.md'), 'utf8'), 'user agent\n');
  assert.equal(existsSync(join(f.project, '.claude', 'agents', 'lead.md')), false, 'managed agent removed');
});

test('Antigravity project uninstall removes the footprint and restores AGENTS.md', async t => {
  const f = fixture(t);
  const agents = '# Smoke Project\n\nPre-existing instructions.\n';
  writeFileSync(join(f.project, 'AGENTS.md'), agents);
  await install(f, 'antigravity', 'project');
  assert.ok(existsSync(join(f.project, '.agents', 'hooks.json')));

  assert.equal(await uninstall(f, 'antigravity', { scope: 'project', project: f.project }, 'uninstall'), 0, f.errors.join('\n'));
  assert.equal(readFileSync(join(f.project, 'AGENTS.md'), 'utf8'), agents);
  for (const path of ['.agents/hooks.json', '.agents/mcp_config.json', '.agents/rules', '.agents/skills', '.agents/scripts']) {
    assert.equal(existsSync(join(f.project, path)), false, path);
  }
  assert.deepEqual(filesUnder(f.project), ['AGENTS.md']);
});

test('Antigravity global uninstall removes the global footprint without touching the project', async t => {
  const f = fixture(t);
  await install(f, 'antigravity', 'global');
  const globalConfig = join(f.home, '.gemini', 'config');
  assert.ok(existsSync(join(globalConfig, 'hooks.json')));

  assert.equal(await uninstall(f, 'antigravity', { scope: 'global' }, 'uninstall'), 0, f.errors.join('\n'));
  assert.equal(existsSync(join(globalConfig, 'hooks.json')), false);
  assert.equal(existsSync(join(globalConfig, 'rules')), false);
  assert.equal(existsSync(join(globalConfig, 'scripts')), false);
  assert.equal(existsSync(globalConfig), true, 'the global config root itself is never pruned');
  assert.deepEqual(filesUnder(f.project), []);
});

test('cancel at the uninstall prompt makes no writes, backups, or directory removals', async t => {
  for (const answer of ['', 'no', 'Uninstall']) {
    const f = fixture(t);
    await install(f, 'claude-code', 'project');
    const before = snapshot(f.root);
    assert.equal(await uninstall(f, 'claude-code', { scope: 'project', project: f.project }, answer), 0, answer);
    assert.ok(f.output.some(line => /Cancelled; no configuration writes made\./.test(line)), answer);
    assert.deepEqual(snapshot(f.root), before, `answer "${answer}" changed the tree`);
  }
});

test('a file edited after install blocks uninstall with no writes', async t => {
  const f = fixture(t);
  await install(f, 'claude-code', 'project');
  writeFileSync(join(f.project, 'CLAUDE.md'), `${readFileSync(join(f.project, 'CLAUDE.md'), 'utf8')}\nHand edit.\n`);
  const before = snapshot(f.root);
  assert.equal(await uninstall(f, 'claude-code', { scope: 'project', project: f.project }, 'uninstall'), 1);
  assert.ok(f.errors.some(line => /Uninstall blocked by concurrent edits to: .*CLAUDE\.md \(concurrently modified\)/.test(line)), f.errors.join('\n'));
  assert.equal(f.prompts.length, 0, 'blocked before confirmation');
  assert.deepEqual(snapshot(f.root), before);
});

test('an absent settings.json is not recreated by uninstall; the rest of the footprint is still removed', async t => {
  const f = fixture(t);
  await install(f, 'claude-code', 'project');
  rmSync(join(f.project, '.claude', 'settings.json'));
  assert.equal(await uninstall(f, 'claude-code', { scope: 'project', project: f.project }, 'uninstall'), 0, f.errors.join('\n'));
  assert.equal(existsSync(join(f.project, '.claude', 'settings.json')), false, 'uninstall did not recreate the target');
  assert.deepEqual(filesUnder(f.project), [], 'agents, commands, and CLAUDE.md are removed');
});

test('an absent settings.json that held user content before install is blocked with no writes', async t => {
  const f = fixture(t);
  mkdirSync(join(f.project, '.claude'));
  writeFileSync(join(f.project, '.claude', 'settings.json'), '{\n  "model": "sonnet"\n}\n');
  await install(f, 'claude-code', 'project');
  rmSync(join(f.project, '.claude', 'settings.json'));
  const before = snapshot(f.root);
  assert.equal(await uninstall(f, 'claude-code', { scope: 'project', project: f.project }, 'uninstall'), 1);
  assert.ok(f.errors.some(line => /concurrent edits to: .*settings\.json/.test(line)), f.errors.join('\n'));
  assert.deepEqual(snapshot(f.root), before, 'no writes and no target recreated');
});

test('target selection rejects unsupported combinations before any file is touched', t => {
  const f = fixture(t);
  const base = { home: f.home, cwd: f.root };
  assert.throws(() => selectUninstallTarget({ ...base, host: 'claude-code', scope: 'global' }), /Claude Code harness is project-scoped/);
  assert.throws(() => selectUninstallTarget({ ...base, host: 'claude-code', scope: 'project' }), /--project is required/);
  assert.throws(() => selectUninstallTarget({ ...base, host: 'claude-code', scope: 'project', project: f.project, config: 'opencode.json' }), /--config is supported only with --host opencode/);
  assert.throws(() => selectUninstallTarget({ ...base, host: 'antigravity', scope: 'global', project: f.project }), /--project cannot be combined with --scope global/);
  assert.throws(() => selectUninstallTarget({ ...base, host: 'antigravity', scope: 'project', project: f.project, config: 'opencode.json' }), /--config is supported only with --host opencode/);
  assert.equal(selectUninstallTarget({ ...base, host: 'claude-code', scope: 'project', project: f.project }), join(f.project, '.claude', 'settings.json'));
  assert.equal(selectUninstallTarget({ ...base, host: 'antigravity', scope: 'project', project: f.project }), join(f.project, '.agents', 'hooks.json'));
  assert.equal(selectUninstallTarget({ ...base, host: 'antigravity', scope: 'global' }), join(f.home, '.gemini', 'config', 'hooks.json'));
});

test('a Claude Code receipt is not discovered for an Antigravity uninstall of the same project', async t => {
  const f = fixture(t);
  await install(f, 'claude-code', 'project');
  await assert.rejects(uninstall(f, 'antigravity', { scope: 'project', project: f.project }, 'uninstall'), /No active installation receipt/);
  assert.equal(existsSync(join(f.project, '.claude', 'settings.json')), true);
});

test('uninstall then reinstall restores a working footprint', async t => {
  const f = fixture(t);
  await install(f, 'claude-code', 'project');
  assert.equal(await uninstall(f, 'claude-code', { scope: 'project', project: f.project }, 'uninstall'), 0, f.errors.join('\n'));
  await install(f, 'claude-code', 'project');
  assert.ok(existsSync(join(f.project, '.claude', 'agents', 'lead.md')));
});
