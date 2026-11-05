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

test('a whole-file managed artifact edited after install still blocks uninstall with no writes', async t => {
  const f = fixture(t);
  await install(f, 'claude-code', 'project');
  writeFileSync(join(f.project, '.claude', 'agents', 'lead.md'), 'Hand edit.\n');
  const before = snapshot(f.root);
  assert.equal(await uninstall(f, 'claude-code', { scope: 'project', project: f.project }, 'uninstall'), 1);
  assert.ok(f.errors.some(line => /Uninstall blocked by concurrent edits to: .*lead\.md \(concurrently modified\)/.test(line)), f.errors.join('\n'));
  assert.equal(f.prompts.length, 0, 'blocked before confirmation');
  assert.deepEqual(snapshot(f.root), before);
});

const projectArgs = (f: Fixture) => ({ scope: 'project', project: f.project });
const leadStart = '<!-- advanced-harness:lead:start -->';
const leadEnd = '<!-- advanced-harness:lead:end -->';
const backupCount = (f: Fixture) => f.output.filter(line => line.startsWith('Private backup:')).length;

test('edits to an installer-created CLAUDE.md survive; only the block and its reference are removed', async t => {
  const f = fixture(t);
  await install(f, 'claude-code', 'project');
  const path = join(f.project, 'CLAUDE.md');
  writeFileSync(path, `# Mine\n\n${readFileSync(path, 'utf8')}\nTail note.\n`);
  assert.equal(await uninstall(f, 'claude-code', projectArgs(f), 'uninstall'), 0, f.errors.join('\n'));
  assert.equal(readFileSync(path, 'utf8'), '# Mine\n\nTail note.\n');
  assert.ok(f.output.some(line => /CLAUDE\.md: remove harness block; keep your edits/.test(line)), 'previewed before confirmation');
  assert.ok(f.output.some(line => /Managed file restored: .*CLAUDE\.md \(harness block removed; other content kept\)/.test(line)), f.output.join('\n'));
  assert.equal(existsSync(join(f.project, '.claude', 'agents', 'lead.md')), false, 'the rest of the footprint is removed');
});

test('edits to a pre-existing CLAUDE.md survive, and a reference the user already had is kept', async t => {
  const f = fixture(t);
  const path = join(f.project, 'CLAUDE.md');
  writeFileSync(path, '# Team\n\n@AGENTS.md\n');
  await install(f, 'claude-code', 'project');
  const installed = readFileSync(path, 'utf8');
  writeFileSync(path, installed.replace('# Team', '# Team (renamed)'));
  assert.equal(await uninstall(f, 'claude-code', projectArgs(f), 'uninstall'), 0, f.errors.join('\n'));
  assert.equal(readFileSync(path, 'utf8'), '# Team (renamed)\n\n@AGENTS.md\n');
  assert.ok(backupCount(f) > 0, 'the edited file is backed up before the block is removed');
});

test('a global CLAUDE.md keeps user edits when only the block is removed', async t => {
  const f = fixture(t);
  await install(f, 'claude-code', 'global');
  const path = join(f.home, '.claude', 'CLAUDE.md');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\nGlobal note.\n`);
  assert.equal(await uninstall(f, 'claude-code', { scope: 'global' }, 'uninstall'), 0, f.errors.join('\n'));
  assert.equal(readFileSync(path, 'utf8'), 'Global note.\n');
});

test('Antigravity keeps AGENTS.md edits outside the model-preference block', async t => {
  const f = fixture(t);
  const path = join(f.project, 'AGENTS.md');
  writeFileSync(path, '# Project\n\nOriginal.\n');
  await install(f, 'antigravity', 'project');
  const installed = readFileSync(path, 'utf8');
  assert.match(installed, /advanced-harness:model-preferences:start/);
  const setupSection = '<!-- advanced-harness:project:start -->\nsetup section\n<!-- advanced-harness:project:end -->\n';
  writeFileSync(path, `${installed.replace('Original.', 'Edited.')}\n${setupSection}`);
  assert.equal(await uninstall(f, 'antigravity', projectArgs(f), 'uninstall'), 0, f.errors.join('\n'));
  assert.equal(readFileSync(path, 'utf8'), `# Project\n\nEdited.\n\n${setupSection}`);
});

test('an edited, missing, duplicated, or reordered harness block blocks uninstall with no writes', async t => {
  const breakBlock: Record<string, (text: string) => string> = {
    edited: text => text.replace(leadEnd, `changed\n${leadEnd}`),
    missing: () => '# Only my notes\n',
    duplicated: text => `${text}\n${leadStart}\nagain\n${leadEnd}\n`,
    'without an end marker': text => text.replace(leadEnd, ''),
    'out of order': text => text.replace(leadStart, '@@').replace(leadEnd, leadStart).replace('@@', leadEnd),
  };
  for (const [name, mutate] of Object.entries(breakBlock)) {
    const f = fixture(t);
    await install(f, 'claude-code', 'project');
    const path = join(f.project, 'CLAUDE.md');
    writeFileSync(path, mutate(readFileSync(path, 'utf8')));
    const before = snapshot(f.root);
    assert.equal(await uninstall(f, 'claude-code', projectArgs(f), 'uninstall'), 1, name);
    assert.ok(f.errors.some(line => /CLAUDE\.md \(harness block edited or missing\)/.test(line)), `${name}: ${f.errors.join('\n')}`);
    assert.equal(f.prompts.length, 0, `${name}: blocked before confirmation`);
    assert.deepEqual(snapshot(f.root), before, `${name}: no writes or backups`);
  }
});

test('cancelling a block-only removal makes no writes, backups, or directory removals', async t => {
  for (const answer of ['', 'no', 'Uninstall']) {
    const f = fixture(t);
    await install(f, 'claude-code', 'project');
    const path = join(f.project, 'CLAUDE.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nHand edit.\n`);
    const before = snapshot(f.root);
    assert.equal(await uninstall(f, 'claude-code', projectArgs(f), answer), 0, answer);
    assert.ok(f.output.some(line => /Cancelled; no configuration writes made\./.test(line)), answer);
    assert.deepEqual(snapshot(f.root), before, `answer "${answer}" changed the tree`);
  }
});

test('a block edited while the uninstall prompt is open blocks with no writes', async t => {
  const f = fixture(t);
  await install(f, 'claude-code', 'project');
  const path = join(f.project, 'CLAUDE.md');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\nHand edit.\n`);
  const target = selectUninstallTarget({ host: 'claude-code', ...projectArgs(f), home: f.home, cwd: f.root });
  const chain = discoverReceiptChain(f.recovery, target, 'claude-code');
  const receipt = readReceiptForRestore(join(chain.directory, chain.head!.file), target);
  let duringPrompt: Map<string, string> | undefined;
  const status = await runUninstallFlow({
    receipt, current: readFileSync(target, 'utf8'), backupParent: f.recovery, host: 'claude-code', pruneRoot: uninstallPruneRoot('claude-code', target, f.home),
    confirm: async () => {
      writeFileSync(path, readFileSync(path, 'utf8').replace(leadEnd, `changed\n${leadEnd}`));
      duringPrompt = snapshot(f.root);
      return 'uninstall';
    },
    output: message => { f.output.push(message); },
    error: message => { f.errors.push(message); },
    save: () => { throw new Error('must not save'); },
  });
  assert.equal(status, 1);
  assert.ok(f.errors.some(line => /harness block edited or missing/.test(line)), f.errors.join('\n'));
  assert.deepEqual(snapshot(f.root), duringPrompt);
});

test('line-ending conversion alone does not count as a block edit, and converted endings are kept', async t => {
  const f = fixture(t);
  await install(f, 'claude-code', 'project');
  const path = join(f.project, 'CLAUDE.md');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\nTail note.\n`.replaceAll('\n', '\r\n'));
  assert.equal(await uninstall(f, 'claude-code', projectArgs(f), 'uninstall'), 0, f.errors.join('\n'));
  assert.equal(readFileSync(path, 'utf8'), 'Tail note.\r\n');
});

test('edits a harness update recorded as installed content still survive uninstall', async t => {
  const f = fixture(t);
  const path = join(f.project, 'CLAUDE.md');
  writeFileSync(path, '# Team\n');
  await install(f, 'claude-code', 'project');
  // The second install rewrites only because the block differs, as a new harness version's block would.
  writeFileSync(path, readFileSync(path, 'utf8').replace('# Team', '# Team\n\nAdded before the update.').replace(leadEnd, `older block\n${leadEnd}`));
  await install(f, 'claude-code', 'project');
  const chain = discoverReceiptChain(f.recovery, join(f.project, '.claude', 'settings.json'), 'claude-code');
  const recorded = chain.head!.receipt.version === 2 ? chain.head!.receipt.managedFiles!.find(file => file.path === path)! : undefined;
  assert.ok(recorded && 'content' in recorded.after && recorded.after.content!.includes('Added before the update.'), 'the update recorded the edit as installed content');
  assert.equal(readFileSync(path, 'utf8'), (recorded!.after as { content: string }).content, 'the file matches its recorded installed state');
  assert.equal(await uninstall(f, 'claude-code', projectArgs(f), 'uninstall'), 0, f.errors.join('\n'));
  assert.equal(readFileSync(path, 'utf8'), '# Team\n\nAdded before the update.\n');
});

test('an unedited file with no trailing newline is restored byte for byte', async t => {
  const f = fixture(t);
  const path = join(f.project, 'CLAUDE.md');
  writeFileSync(path, '# Team');
  await install(f, 'claude-code', 'project');
  assert.equal(await uninstall(f, 'claude-code', projectArgs(f), 'uninstall'), 0, f.errors.join('\n'));
  assert.equal(readFileSync(path, 'utf8'), '# Team');
});

test('uninstall, reinstall, and uninstall again keep edits to CLAUDE.md', async t => {
  const f = fixture(t);
  await install(f, 'claude-code', 'project');
  const path = join(f.project, 'CLAUDE.md');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\nKeep me.\n`);
  assert.equal(await uninstall(f, 'claude-code', projectArgs(f), 'uninstall'), 0, f.errors.join('\n'));
  assert.equal(readFileSync(path, 'utf8'), 'Keep me.\n');
  await install(f, 'claude-code', 'project');
  assert.match(readFileSync(path, 'utf8'), /advanced-harness:lead:start/);
  assert.equal(await uninstall(f, 'claude-code', projectArgs(f), 'uninstall'), 0, f.errors.join('\n'));
  assert.equal(readFileSync(path, 'utf8'), 'Keep me.\n');
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
  assert.throws(() => selectUninstallTarget({ ...base, host: 'claude-code', scope: 'global', project: f.project }), /--project cannot be combined with --scope global/);
  assert.throws(() => selectUninstallTarget({ ...base, host: 'claude-code', scope: 'everywhere' }), /--scope must be global or project/);
  assert.equal(selectUninstallTarget({ ...base, host: 'claude-code', scope: 'global' }), join(f.home, '.claude', 'settings.json'));
  assert.throws(() => selectUninstallTarget({ ...base, host: 'claude-code', scope: 'project' }), /--project is required/);
  assert.throws(() => selectUninstallTarget({ ...base, host: 'claude-code', scope: 'project', project: f.project, config: 'opencode.json' }), /--config is supported only with --host opencode/);
  assert.throws(() => selectUninstallTarget({ ...base, host: 'antigravity', scope: 'global', project: f.project }), /--project cannot be combined with --scope global/);
  assert.throws(() => selectUninstallTarget({ ...base, host: 'antigravity', scope: 'project', project: f.project, config: 'opencode.json' }), /--config is supported only with --host opencode/);
  assert.equal(selectUninstallTarget({ ...base, host: 'claude-code', scope: 'project', project: f.project }), join(f.project, '.claude', 'settings.json'));
  assert.equal(selectUninstallTarget({ ...base, host: 'antigravity', scope: 'project', project: f.project }), join(f.project, '.agents', 'hooks.json'));
  assert.equal(selectUninstallTarget({ ...base, host: 'antigravity', scope: 'global' }), join(f.home, '.gemini', 'config', 'hooks.json'));
});

test('a global Claude Code install uninstalls back to the prior user directory (#146)', async t => {
  const f = fixture(t);
  mkdirSync(join(f.home, '.claude'));
  writeFileSync(join(f.home, '.claude', 'settings.json'), '{\n  "theme": "dark"\n}\n');
  await install(f, 'claude-code', 'global');
  assert.ok(existsSync(join(f.home, '.claude', 'agents', 'lead.md')));
  assert.equal(await uninstall(f, 'claude-code', { scope: 'global' }, 'uninstall'), 0, f.errors.join('\n'));
  assert.equal(readFileSync(join(f.home, '.claude', 'settings.json'), 'utf8'), '{\n  "theme": "dark"\n}\n');
  assert.equal(existsSync(join(f.home, '.claude', 'CLAUDE.md')), false);
  assert.equal(existsSync(join(f.home, '.claude', 'agents')), false, 'installer-created agents directory is pruned');
  assert.ok(existsSync(join(f.home, '.claude')), 'the pre-existing ~/.claude container is kept');
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
