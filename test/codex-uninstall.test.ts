import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCodex, planCodexUninstall } from '../src/codex-adapter.ts';
import { recordThread } from '../src/codex-role-launcher.mjs';
import { effectiveReceiptHost } from '../src/installation-receipt.ts';
import { saveInstallation } from '../src/native-installer.ts';
import { discoverReceiptChain, readReceiptForRestore } from '../src/receipt-lineage.ts';
import { runUninstallFlow } from '../src/uninstall-cli-flow.ts';
import { selectUninstallTarget, uninstallPruneRoot } from '../src/uninstall-target.ts';

function sandbox(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'codex-uninstall-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(home);
  return { root, home, codex: join(home, '.codex'), recovery: join(root, 'recovery'), output: [] as string[], errors: [] as string[] };
}
type Box = ReturnType<typeof sandbox>;

const install = async (box: Box, mcp = '', tools = '') => {
  const ask = async (question: string) => question.startsWith('Existing Codex MCP server') ? mcp
    : question.startsWith('Exact tool names') ? tools
    : /model ID/.test(question) ? 'gpt-example' : /reasoning effort/.test(question) ? 'medium'
    : question.startsWith('Type install') ? 'install' : '';
  assert.equal(await installCodex({ scope: 'global', home: box.home, recoveryDirectory: box.recovery, mode: 'role-processes', ask, output: line => box.output.push(line), error: line => box.errors.push(line) }), 0, box.errors.join('\n'));
};

// Mirrors scripts/uninstall-native-harness.ts for --host codex after target selection.
async function uninstall(box: Box, answer = 'uninstall', remove?: (path: string) => void, duringConfirm?: () => void) {
  const target = selectUninstallTarget({ host: 'codex', scope: 'global', home: box.home, cwd: box.root });
  const current = readFileSync(target, 'utf8');
  const chain = discoverReceiptChain(box.recovery, target, 'codex');
  assert.ok(chain.head, 'active Codex receipt');
  const receipt = readReceiptForRestore(join(chain.directory, chain.head.file), target);
  assert.equal(effectiveReceiptHost(receipt), 'codex');
  const hostStep = planCodexUninstall(target, box.recovery, remove);
  for (const key of hostStep.kept) box.output.push(`Kept in config.toml (changed since install, review by hand): ${key}`);
  return runUninstallFlow({
    receipt, current, hostStep, backupParent: box.recovery, host: 'codex', pruneRoot: uninstallPruneRoot('codex', target, box.home),
    confirm: async () => { duringConfirm?.(); return answer; }, output: line => box.output.push(line), error: line => box.errors.push(line),
    save: updated => { saveInstallation(target, current, updated, box.recovery); },
  });
}

const userConfig = '# my Codex settings\nmodel = "gpt-x"\n\n[mcp_servers.gh]\ncommand = "gh-mcp"\nenabled = true\n\n[mcp_servers.other]\ncommand = "other-mcp"\n';

test('Codex uninstall targets the global state manifest and refuses project scope', t => {
  const box = sandbox(t);
  assert.equal(selectUninstallTarget({ host: 'codex', home: box.home, cwd: box.root }), join(box.home, '.codex', '.advanced-harness-state.json'));
  assert.throws(() => selectUninstallTarget({ host: 'codex', scope: 'project', project: box.root, home: box.home, cwd: box.root }), /global/);
  assert.throws(() => selectUninstallTarget({ host: 'cursor', home: box.home, cwd: box.root }), /not supported for --host cursor/);
});

test('Codex uninstall restores a pre-existing config.toml and AGENTS.md byte for byte (#45)', async t => {
  const box = sandbox(t);
  mkdirSync(box.codex);
  writeFileSync(join(box.codex, 'config.toml'), userConfig);
  writeFileSync(join(box.codex, 'AGENTS.md'), '# Personal Codex notes\n');
  await install(box, 'gh', 'merge_pr');
  const installed = readFileSync(join(box.codex, 'config.toml'), 'utf8');
  assert.match(installed, /\[mcp_servers\.gh\][\s\S]*enabled = false[\s\S]*disabled_tools = \["merge_pr"\]/);
  assert.match(installed, /multi_agent = false/);

  assert.equal(await uninstall(box, 'cancel'), 0);
  assert.equal(readFileSync(join(box.codex, 'config.toml'), 'utf8'), installed, 'cancel writes nothing');

  assert.equal(await uninstall(box), 0, box.errors.join('\n'));
  assert.equal(readFileSync(join(box.codex, 'config.toml'), 'utf8'), userConfig);
  assert.equal(readFileSync(join(box.codex, 'AGENTS.md'), 'utf8'), '# Personal Codex notes\n');
  assert.deepEqual(readdirSync(box.codex).sort(), ['AGENTS.md', 'config.toml'], 'profiles, launcher, schema, rules and state are removed');
  assert.equal(existsSync(join(box.home, '.agents', 'skills')), false, 'installer-created skill directories are pruned');
});

test('MCP servers named like Object.prototype members keep their own records through update and uninstall', async t => {
  const box = sandbox(t);
  mkdirSync(box.codex);
  // Both servers start disabled; uninstall must leave them disabled, not re-enable them.
  const original = '[mcp_servers.constructor]\ncommand = "c-mcp"\nenabled = false\n\n[mcp_servers.__proto__]\ncommand = "p-mcp"\nenabled = false\n';
  const config = join(box.codex, 'config.toml');
  writeFileSync(config, original);
  await install(box, 'constructor, __proto__', 'merge_pr');
  const state = JSON.parse(readFileSync(join(box.codex, '.advanced-harness-state.json'), 'utf8')) as { configEdits: { mcp: Record<string, { enabledBefore: unknown }> } };
  for (const id of ['constructor', '__proto__']) {
    assert.ok(Object.hasOwn(state.configEdits.mcp, id), `${id} is recorded as its own entry`);
    assert.equal(state.configEdits.mcp[id]!.enabledBefore, false, `${id} was recorded as originally disabled`);
  }
  await install(box, 'constructor, __proto__', 'merge_pr');
  assert.equal(await uninstall(box), 0, box.errors.join('\n'));
  assert.equal(readFileSync(config, 'utf8'), original, 'both servers stay disabled and the restriction is removed');
});

test('Codex uninstall removes a config.toml the harness created', async t => {
  const box = sandbox(t);
  await install(box);
  assert.equal(await uninstall(box), 0, box.errors.join('\n'));
  assert.equal(existsSync(join(box.codex, 'config.toml')), false);
  assert.equal(existsSync(join(box.codex, '.advanced-harness-state.json')), false);
});

test('Codex uninstall keeps a config key changed since install and reports it', async t => {
  const box = sandbox(t);
  mkdirSync(box.codex);
  writeFileSync(join(box.codex, 'config.toml'), userConfig);
  await install(box);
  const config = join(box.codex, 'config.toml');
  writeFileSync(config, readFileSync(config, 'utf8').replace('sandbox_mode = "read-only"', 'sandbox_mode = "workspace-write"'));
  assert.equal(await uninstall(box), 0, box.errors.join('\n'));
  const restored = readFileSync(config, 'utf8');
  assert.match(restored, /sandbox_mode = "workspace-write"/, 'user change kept');
  assert.doesNotMatch(restored, /approval_policy|multi_agent/, 'other harness edits reversed');
  assert.ok(box.output.some(line => line === 'Kept in config.toml (changed since install, review by hand): sandbox_mode'));
});

test('Codex uninstall keeps a disabled_tools list customized since install and reports it', async t => {
  const box = sandbox(t);
  mkdirSync(box.codex);
  writeFileSync(join(box.codex, 'config.toml'), userConfig);
  await install(box, 'gh', 'merge_pr');
  const config = join(box.codex, 'config.toml');
  writeFileSync(config, readFileSync(config, 'utf8').replace('disabled_tools = ["merge_pr"]', 'disabled_tools = ["merge_pr", "delete_repo"]'));
  assert.equal(await uninstall(box), 0, box.errors.join('\n'));
  const restored = readFileSync(config, 'utf8');
  assert.match(restored, /disabled_tools = \["merge_pr", "delete_repo"\]/, 'customized restriction list is preserved whole');
  assert.match(restored, /\[mcp_servers\.gh\]\ncommand = "gh-mcp"\nenabled = true\n/, 'the unchanged enabled key is still reversed');
  assert.doesNotMatch(restored, /approval_policy|multi_agent/);
  assert.ok(box.output.some(line => line === 'Kept in config.toml (changed since install, review by hand): mcp_servers.gh.disabled_tools'), box.output.join('\n'));
});

test('a reinstall refreshes the recorded disabled_tools list so uninstall still narrows it', async t => {
  const box = sandbox(t);
  mkdirSync(box.codex);
  writeFileSync(join(box.codex, 'config.toml'), userConfig);
  await install(box, 'gh', 'merge_pr');
  await install(box, 'gh', 'merge_pr, close_issue');
  assert.match(readFileSync(join(box.codex, 'config.toml'), 'utf8'), /disabled_tools = \["merge_pr", "close_issue"\]/);
  assert.equal(await uninstall(box), 0, box.errors.join('\n'));
  assert.equal(readFileSync(join(box.codex, 'config.toml'), 'utf8'), userConfig);
});

test('an edited role profile blocks Codex uninstall with no writes', async t => {
  const box = sandbox(t);
  await install(box);
  const profile = join(box.codex, 'harness-reviewer.config.toml');
  writeFileSync(profile, readFileSync(profile, 'utf8').replace('read-only', 'workspace-write'));
  const before = readdirSync(box.codex).sort();
  assert.equal(await uninstall(box), 1);
  assert.match(box.errors.join('\n'), /Uninstall blocked by .*harness-reviewer\.config\.toml/);
  assert.deepEqual(readdirSync(box.codex).sort(), before);
});

test('Codex uninstall also removes the launcher thread bindings and their empty directories', async t => {
  const box = sandbox(t);
  await install(box);
  const bindings = join(box.codex, 'advanced-harness', 'role-threads');
  recordThread(bindings, 'thread-1', 'implementer');
  recordThread(bindings, 'thread-2', 'reviewer');
  assert.equal(await uninstall(box), 0, box.errors.join('\n'));
  assert.equal(existsSync(bindings), false);
  assert.equal(existsSync(join(box.codex, 'advanced-harness')), false);
  assert.ok(box.output.some(line => line.includes('remove 2 role thread binding file(s)')), 'listed in the planned actions before confirmation');
  assert.ok(box.output.includes(`Removed 2 role thread binding file(s) from ${bindings}`), box.output.join('\n'));
  const backup = box.output.find(line => line.startsWith('Private backup of role thread bindings: '))?.split(': ')[1];
  assert.ok(backup && existsSync(join(backup, 'thread-1')) && existsSync(join(backup, 'thread-2')), 'bindings are backed up privately');
});

test('an update that leaves a customized disabled_tools list untouched keeps it marked as customized', async t => {
  const box = sandbox(t);
  mkdirSync(box.codex);
  writeFileSync(join(box.codex, 'config.toml'), userConfig);
  await install(box, 'gh', 'merge_pr');
  const config = join(box.codex, 'config.toml');
  writeFileSync(config, readFileSync(config, 'utf8').replace('disabled_tools = ["merge_pr"]', 'disabled_tools = ["merge_pr", "delete_repo"]'));
  // The update selects no MCP server, so it never touches the customized list.
  await install(box);
  assert.match(readFileSync(config, 'utf8'), /disabled_tools = \["merge_pr", "delete_repo"\]/);
  assert.equal(await uninstall(box), 0, box.errors.join('\n'));
  assert.match(readFileSync(config, 'utf8'), /disabled_tools = \["merge_pr", "delete_repo"\]/, 'the user list is not narrowed');
  assert.ok(box.output.some(line => line === 'Kept in config.toml (changed since install, review by hand): mcp_servers.gh.disabled_tools'), box.output.join('\n'));
});

test('Codex uninstall keeps and reports files in the bindings directory that are not bindings', async t => {
  const box = sandbox(t);
  await install(box);
  const bindings = join(box.codex, 'advanced-harness', 'role-threads');
  recordThread(bindings, 'thread-1', 'implementer');
  writeFileSync(join(bindings, 'notes.txt'), 'mine\n');
  writeFileSync(join(bindings, 'thread-2'), 'not-a-role\n');
  assert.equal(await uninstall(box), 0, box.errors.join('\n'));
  assert.equal(existsSync(join(bindings, 'thread-1')), false);
  assert.equal(readFileSync(join(bindings, 'notes.txt'), 'utf8'), 'mine\n');
  assert.equal(readFileSync(join(bindings, 'thread-2'), 'utf8'), 'not-a-role\n');
  for (const name of ['notes.txt', 'thread-2']) {
    assert.ok(box.output.some(line => line.includes(`keep ${join(bindings, name)} (not a role thread binding`)), `${name} listed as kept before confirmation`);
    assert.ok(box.output.some(line => line.startsWith(`Kept ${join(bindings, name)}`)), `${name} reported as kept`);
  }
});

test('a binding changed after review stops the Codex step before any write', async t => {
  const box = sandbox(t);
  await install(box);
  const target = selectUninstallTarget({ host: 'codex', scope: 'global', home: box.home, cwd: box.root });
  const bindings = join(box.codex, 'advanced-harness', 'role-threads');
  recordThread(bindings, 'thread-1', 'implementer');
  const step = planCodexUninstall(target, box.recovery);
  writeFileSync(join(bindings, 'thread-1'), 'reviewer\n');
  const config = readFileSync(join(box.codex, 'config.toml'), 'utf8');
  assert.throws(() => step.apply(), /thread-1 changed after review; nothing was changed/);
  assert.equal(readFileSync(join(bindings, 'thread-1'), 'utf8'), 'reviewer\n');
  assert.equal(readFileSync(join(box.codex, 'config.toml'), 'utf8'), config);
  assert.ok(existsSync(target), 'state manifest kept');
});

test('a failed Codex step keeps the state manifest, reports completed work and backups, and can be retried', async t => {
  const box = sandbox(t);
  await install(box);
  const target = selectUninstallTarget({ host: 'codex', scope: 'global', home: box.home, cwd: box.root });
  const bindings = join(box.codex, 'advanced-harness', 'role-threads');
  recordThread(bindings, 'thread-1', 'implementer');
  recordThread(bindings, 'thread-2', 'reviewer');
  const config = readFileSync(join(box.codex, 'config.toml'), 'utf8');
  let calls = 0;
  const failing = planCodexUninstall(target, box.recovery, path => { if (++calls === 2) throw new Error('simulated delete failure'); rmSync(path); });
  let message = '';
  assert.throws(() => failing.apply(), error => { message = (error as Error).message; return true; });
  assert.match(message, /Codex step failed: simulated delete failure/);
  assert.match(message, /Private backup of role thread bindings: /);
  assert.match(message, /Removed 1 of 2 role thread binding file\(s\)/);
  assert.match(message, /is kept, so uninstall can be run again/);
  assert.ok(existsSync(target), 'state manifest kept for the retry');
  assert.equal(readFileSync(join(box.codex, 'config.toml'), 'utf8'), config, 'config.toml untouched: it is reversed after the bindings');

  const retry = planCodexUninstall(target, box.recovery);
  assert.ok(retry.actions.includes(`remove 1 role thread binding file(s) in ${bindings}`), retry.actions.join('\n'));
  const lines = retry.apply();
  assert.ok(lines.includes(`Removed ${target}`), lines.join('\n'));
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(bindings), false);
});

const leadStart = '<!-- BEGIN advanced-harness Codex Lead -->';
// Stands in for a harness version whose Lead block text changed: an update then rewrites the block.
const ageLeadBlock = (box: Box) => writeFileSync(join(box.codex, 'AGENTS.md'), readFileSync(join(box.codex, 'AGENTS.md'), 'utf8').replace('### Lead role instructions', '### Lead role instructions (older)'));

test('Codex uninstall keeps notes added to AGENTS.md, with or without an update in between (#45)', async t => {
  const direct = sandbox(t);
  await install(direct);
  appendFileSync(join(direct.codex, 'AGENTS.md'), '\n# My notes\n');
  assert.equal(await uninstall(direct), 0, direct.errors.join('\n'));
  assert.equal(readFileSync(join(direct.codex, 'AGENTS.md'), 'utf8'), '# My notes\n', 'a harness-created file stays while it holds user content');

  const updated = sandbox(t);
  await install(updated);
  appendFileSync(join(updated.codex, 'AGENTS.md'), '\n# My notes\n');
  ageLeadBlock(updated);
  await install(updated);
  assert.ok(!readFileSync(join(updated.codex, 'AGENTS.md'), 'utf8').includes('(older)'), 'the update refreshed the block');
  assert.equal(await uninstall(updated), 0, updated.errors.join('\n'));
  assert.equal(readFileSync(join(updated.codex, 'AGENTS.md'), 'utf8'), '# My notes\n');

  const preexisting = sandbox(t);
  mkdirSync(preexisting.codex);
  writeFileSync(join(preexisting.codex, 'AGENTS.md'), '# Original\n');
  await install(preexisting);
  const edited = readFileSync(join(preexisting.codex, 'AGENTS.md'), 'utf8').replace('# Original\n', '# Original\n\n# Added before the block\n');
  writeFileSync(join(preexisting.codex, 'AGENTS.md'), `${edited}\n# Added after the block\n`);
  ageLeadBlock(preexisting);
  await install(preexisting);
  assert.equal(await uninstall(preexisting), 0, preexisting.errors.join('\n'));
  assert.equal(readFileSync(join(preexisting.codex, 'AGENTS.md'), 'utf8'), '# Original\n\n# Added before the block\n\n\n# Added after the block\n');
});

test('Codex uninstall restores AGENTS.md whitespace and removes a harness-created file (#45)', async t => {
  for (const original of ['# Notes', '# Notes\n\n\n', '# Notes\r\nMore\r\n', '  \n']) {
    const box = sandbox(t);
    mkdirSync(box.codex);
    writeFileSync(join(box.codex, 'AGENTS.md'), original);
    await install(box);
    assert.equal(await uninstall(box), 0, box.errors.join('\n'));
    assert.equal(readFileSync(join(box.codex, 'AGENTS.md'), 'utf8'), original);
  }
  const created = sandbox(t);
  await install(created);
  await install(created);
  assert.equal(await uninstall(created), 0, created.errors.join('\n'));
  assert.equal(existsSync(join(created.codex, 'AGENTS.md')), false);
});

test('Codex keeps AGENTS.md out of the receipt (#45)', async t => {
  const box = sandbox(t);
  mkdirSync(box.codex);
  writeFileSync(join(box.codex, 'AGENTS.md'), '# Private notes\n');
  await install(box);
  const target = selectUninstallTarget({ host: 'codex', scope: 'global', home: box.home, cwd: box.root });
  const chain = discoverReceiptChain(box.recovery, target, 'codex');
  const receipt = readFileSync(join(chain.directory, chain.head!.file), 'utf8');
  assert.ok(!receipt.includes('# Private notes'), 'the receipt holds no user AGENTS.md content');
  const managed = (JSON.parse(receipt) as { managedFiles: Array<{ path: string }> }).managedFiles.map(file => file.path);
  assert.ok(managed.length > 0);
  assert.ok(!managed.some(path => path.endsWith('AGENTS.md')), 'the receipt does not manage AGENTS.md');
});

test('Codex uninstall keeps and reports an edited or malformed Lead block (#45)', async t => {
  const cases: Array<[string, (text: string) => string, RegExp]> = [
    ['edited', text => text.replace('You are Lead.', 'You are my Lead.'), /was edited since install/],
    ['duplicated', text => `${text}${leadStart}\n`, /has 2 start and 1 end markers/],
  ];
  for (const [name, change, expected] of cases) {
    const box = sandbox(t);
    await install(box);
    const text = change(readFileSync(join(box.codex, 'AGENTS.md'), 'utf8'));
    writeFileSync(join(box.codex, 'AGENTS.md'), text);
    assert.equal(await uninstall(box), 0, box.errors.join('\n'));
    assert.equal(readFileSync(join(box.codex, 'AGENTS.md'), 'utf8'), text, `${name}: left in place`);
    assert.ok(box.output.some(line => line.trim().startsWith('keep the Lead block') && expected.test(line)), `${name}: listed before confirmation`);
    assert.ok(box.output.some(line => line.startsWith('Kept the Lead block') && expected.test(line)), `${name}: reported after`);
  }
});

test('Codex uninstall handles AGENTS.md changing or failing during the host step (#45)', async t => {
  const box = sandbox(t);
  mkdirSync(box.codex);
  writeFileSync(join(box.codex, 'AGENTS.md'), '# Notes\n');
  await install(box);
  const target = selectUninstallTarget({ host: 'codex', scope: 'global', home: box.home, cwd: box.root });

  const changing = planCodexUninstall(target, box.recovery);
  const installed = readFileSync(join(box.codex, 'AGENTS.md'), 'utf8');
  writeFileSync(join(box.codex, 'AGENTS.md'), `${installed}\n# Just added\n`);
  assert.throws(() => changing.apply(), /AGENTS\.md changed after review; nothing was changed/);
  assert.ok(existsSync(target));
  writeFileSync(join(box.codex, 'AGENTS.md'), installed);

  let failed = false;
  const failing = planCodexUninstall(target, box.recovery, path => { if (path === target && !failed) { failed = true; throw new Error('EBUSY'); } unlinkSync(path); });
  assert.throws(() => failing.apply(), /Removed the Lead block[\s\S]*is kept, so uninstall can be run again/);
  assert.equal(readFileSync(join(box.codex, 'AGENTS.md'), 'utf8'), '# Notes\n');

  const retry = planCodexUninstall(target, box.recovery);
  assert.ok(retry.actions.some(action => action.includes('no Lead block left to remove')));
  retry.apply();
  assert.equal(readFileSync(join(box.codex, 'AGENTS.md'), 'utf8'), '# Notes\n');
  assert.equal(existsSync(target), false);
});

test('Codex uninstall reverses a dotted features.multi_agent byte for byte (#45)', async t => {
  const box = sandbox(t);
  mkdirSync(box.codex);
  const config = 'sandbox_mode = "read-only"\napproval_policy = "on-request"\nfeatures.web_search = true\n';
  writeFileSync(join(box.codex, 'config.toml'), config);
  await install(box);
  assert.match(readFileSync(join(box.codex, 'config.toml'), 'utf8'), /^features\.multi_agent = false$/m);
  assert.equal(await uninstall(box), 0, box.errors.join('\n'));
  assert.equal(readFileSync(join(box.codex, 'config.toml'), 'utf8'), config);
});

test('Codex uninstall restores config.toml byte for byte whatever separates the baseline keys (#45)', async t => {
  const configs = [
    'model = "x"\n[tui]\nfoo = 1\n',
    'model = "x"\n\n[tui]\nfoo = 1\n',
    'model = "x"\r\n[tui]\r\nfoo = 1\r\n',
    '[tui]\nfoo = 1\n',
    'model = "x"\n',
    'features.web_search = true\n',
    'model = "x"\n\n[features]\nweb_search = true\n',
  ];
  for (const config of configs) {
    const box = sandbox(t);
    mkdirSync(box.codex);
    writeFileSync(join(box.codex, 'config.toml'), config);
    await install(box);
    assert.equal(await uninstall(box), 0, box.errors.join('\n'));
    assert.equal(readFileSync(join(box.codex, 'config.toml'), 'utf8'), config, JSON.stringify(config));
  }

  const kept = sandbox(t);
  mkdirSync(kept.codex);
  writeFileSync(join(kept.codex, 'config.toml'), 'model = "x"\n[tui]\nfoo = 1\n');
  await install(kept);
  const path = join(kept.codex, 'config.toml');
  writeFileSync(path, readFileSync(path, 'utf8').replace('approval_policy = "on-request"', 'approval_policy = "untrusted"'));
  assert.equal(await uninstall(kept), 0, kept.errors.join('\n'));
  assert.equal(readFileSync(path, 'utf8'), 'model = "x"\n\napproval_policy = "untrusted"\n\n[tui]\nfoo = 1\n', 'the separator stays while a baseline key does');
});

test('a retried Codex uninstall reports nothing false and removes emptied directories (#45)', async t => {
  const box = sandbox(t);
  mkdirSync(box.codex);
  writeFileSync(join(box.codex, 'config.toml'), userConfig);
  await install(box, 'gh', 'merge_pr');
  const threads = join(box.codex, 'advanced-harness', 'role-threads');
  recordThread(threads, 'thread-1', 'reviewer');
  const target = selectUninstallTarget({ host: 'codex', scope: 'global', home: box.home, cwd: box.root });

  // Everything but the manifest completes, as when the first run fails on its last step.
  let failed = false;
  assert.equal(await uninstall(box, 'uninstall', path => { if (path === target && !failed) { failed = true; throw new Error('EBUSY'); } unlinkSync(path); }), 1);
  assert.match(box.errors.join('\n'), /is kept, so uninstall can be run again/);
  assert.equal(readFileSync(join(box.codex, 'config.toml'), 'utf8'), userConfig);
  assert.deepEqual(readdirSync(threads), [], 'the first run emptied the directory but could not get to removing it');

  box.output.length = 0;
  box.errors.length = 0;
  assert.equal(await uninstall(box), 0, box.errors.join('\n'));
  assert.ok(!box.output.some(line => line.startsWith('Kept in config.toml')), 'values the first run reversed are not reported as user changes');
  assert.equal(existsSync(join(box.codex, 'advanced-harness')), false, 'the emptied launcher directories are removed');
  assert.ok(box.output.some(line => line.startsWith('Removed empty installer directory') && line.includes('role-threads')));
  assert.equal(readFileSync(join(box.codex, 'config.toml'), 'utf8'), userConfig);
});

test('Codex uninstall handles a config.toml without a final newline, byte for byte (#45)', async t => {
  const configs = [
    'model = "x"',
    'model = "x"\n',
    'model = "x"\n\n',
    'model = "x"\n\n\n',
    'model = "x"\r\nname = "y"',
    '# only a comment',
    'features.web_search = true',
    'sandbox_mode = "read-only"\napproval_policy = "on-request"',
    'sandbox_mode = "read-only"\napproval_policy = "on-request"\n\n\n',
    'sandbox_mode = "read-only"\napproval_policy = "on-request"\nfeatures.web_search = true',
    'sandbox_mode = "read-only"\napproval_policy = "on-request"\n\n[features]\nweb_search = true',
    '[tui]\nfoo = 1',
    'model = "x"\n[mcp_servers.gh]\ncommand = "gh-mcp"\nenabled = true',
  ];
  for (const config of configs) {
    for (const updates of [1, 2]) {
      const box = sandbox(t);
      mkdirSync(box.codex);
      const path = join(box.codex, 'config.toml');
      writeFileSync(path, config);
      for (let run = 0; run < updates; run++) await install(box, config.includes('mcp_servers') ? 'gh' : '', config.includes('mcp_servers') ? 'merge_pr' : '');
      assert.equal(await uninstall(box), 0, box.errors.join('\n'));
      assert.equal(readFileSync(path, 'utf8'), config, JSON.stringify(config));
    }
  }
});

test('Codex uninstall keeps config.toml valid when the user added keys after the baseline', async t => {
  const box = sandbox(t);
  mkdirSync(box.codex);
  const path = join(box.codex, 'config.toml');
  writeFileSync(path, 'model = "x"');
  await install(box);
  appendFileSync(path, 'web_search = true\n');
  assert.equal(await uninstall(box), 0, box.errors.join('\n'));
  assert.match(readFileSync(path, 'utf8'), /^model = "x"\n+\[features\]\nweb_search = true\n$/);

  const other = sandbox(t);
  mkdirSync(other.codex);
  const second = join(other.codex, 'config.toml');
  writeFileSync(second, 'model = "x"');
  await install(other);
  writeFileSync(second, readFileSync(second, 'utf8').replace('[features]', 'added = 1\n\n[features]'));
  assert.equal(await uninstall(other), 0, other.errors.join('\n'));
  assert.match(readFileSync(second, 'utf8'), /^model = "x"\n+added = 1\n$/);
});

// Replaces a reviewed file with a link to a same-content file elsewhere, so a content check alone passes.
function swapForLink(t: { skip(message: string): void }, box: Box, path: string): string | undefined {
  const outside = join(box.root, 'outside-' + path.split(/[\\/]/).at(-1));
  writeFileSync(outside, readFileSync(path));
  const moved = path + '.moved';
  renameSync(path, moved);
  try { symlinkSync(outside, path, 'file'); }
  catch (error) {
    renameSync(moved, path);
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('creating a symlink needs extra privileges here'); return undefined; }
    throw error;
  }
  rmSync(moved);
  return outside;
}

test('a same-content link swapped in during confirmation is refused with no writes', async t => {
  for (const name of ['config.toml', 'AGENTS.md', '.advanced-harness-state.json']) {
    const box = sandbox(t);
    mkdirSync(box.codex);
    writeFileSync(join(box.codex, 'config.toml'), userConfig);
    writeFileSync(join(box.codex, 'AGENTS.md'), '# Notes\n');
    await install(box);
    const path = join(box.codex, name);
    let outside: string | undefined, before = '';
    const launcher = readdirSync(join(box.codex, 'advanced-harness'));
    const code = await uninstall(box, 'uninstall', undefined, () => { before = readFileSync(path, 'utf8'); outside = swapForLink(t, box, path); });
    if (!outside) return;
    assert.equal(code, 1, name);
    assert.match(box.errors.join('\n'), /Symlink path component refused[\s\S]*No writes made/);
    assert.equal(readFileSync(outside, 'utf8'), before, 'the link destination is not modified');
    assert.ok(lstatSync(path).isSymbolicLink(), 'the link is left as found');
    assert.deepEqual(readdirSync(join(box.codex, 'advanced-harness')), launcher, 'managed files are not restored either');
  }
});

test('a link swapped in after the flow check is refused by the Codex step itself', async t => {
  const box = sandbox(t);
  mkdirSync(box.codex);
  writeFileSync(join(box.codex, 'config.toml'), userConfig);
  await install(box);
  const target = selectUninstallTarget({ host: 'codex', scope: 'global', home: box.home, cwd: box.root });
  const step = planCodexUninstall(target, box.recovery);
  const before = readFileSync(join(box.codex, 'config.toml'), 'utf8');
  const outside = swapForLink(t, box, join(box.codex, 'config.toml'));
  if (!outside) return;
  assert.throws(() => step.apply(), /Symlink path component refused[\s\S]*nothing was changed by the Codex step/);
  assert.equal(readFileSync(outside, 'utf8'), before);
  assert.ok(existsSync(target), 'state manifest kept');
});

test('a binding directory replaced by a link is refused, leaving its destination alone', async t => {
  const box = sandbox(t);
  await install(box);
  const target = selectUninstallTarget({ host: 'codex', scope: 'global', home: box.home, cwd: box.root });
  const threads = join(box.codex, 'advanced-harness', 'role-threads');
  recordThread(threads, 'thread-1', 'implementer');
  const step = planCodexUninstall(target, box.recovery);
  const outside = join(box.root, 'outside-threads');
  mkdirSync(outside);
  writeFileSync(join(outside, 'thread-1'), 'implementer\n');
  rmSync(threads, { recursive: true });
  // A junction needs no extra privileges on Windows; elsewhere the type is ignored.
  symlinkSync(outside, threads, 'junction');
  assert.throws(() => step.apply(), /Symlink path component refused[\s\S]*nothing was changed/);
  assert.equal(readFileSync(join(outside, 'thread-1'), 'utf8'), 'implementer\n');
  assert.ok(existsSync(target));
});

test('a Codex directory swapped for a same-content link is refused, leaving its destination alone', async t => {
  const box = sandbox(t);
  mkdirSync(box.codex);
  writeFileSync(join(box.codex, 'config.toml'), userConfig);
  writeFileSync(join(box.codex, 'AGENTS.md'), '# Notes\n');
  await install(box);
  const target = selectUninstallTarget({ host: 'codex', scope: 'global', home: box.home, cwd: box.root });
  const step = planCodexUninstall(target, box.recovery);
  const before = readFileSync(join(box.codex, 'config.toml'), 'utf8');
  const lead = readFileSync(join(box.codex, 'AGENTS.md'), 'utf8');
  const outside = join(box.root, 'outside-codex');
  renameSync(box.codex, outside);
  // A junction needs no extra privileges on Windows; elsewhere the type is ignored.
  symlinkSync(outside, box.codex, 'junction');
  assert.throws(() => step.apply(), /Symlink path component refused[\s\S]*nothing was changed/);
  assert.equal(readFileSync(join(outside, 'config.toml'), 'utf8'), before);
  assert.equal(readFileSync(join(outside, 'AGENTS.md'), 'utf8'), lead);
  assert.ok(existsSync(join(outside, '.advanced-harness-state.json')));
});
