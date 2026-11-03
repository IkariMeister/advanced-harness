import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCodex, planCodexUninstall } from '../src/codex-adapter.ts';
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
async function uninstall(box: Box, answer = 'uninstall') {
  const target = selectUninstallTarget({ host: 'codex', scope: 'global', home: box.home, cwd: box.root });
  const current = readFileSync(target, 'utf8');
  const chain = discoverReceiptChain(box.recovery, target, 'codex');
  assert.ok(chain.head, 'active Codex receipt');
  const receipt = readReceiptForRestore(join(chain.directory, chain.head.file), target);
  assert.equal(effectiveReceiptHost(receipt), 'codex');
  const hostStep = planCodexUninstall(target, box.recovery);
  for (const key of hostStep.kept) box.output.push(`Kept in config.toml (changed since install, review by hand): ${key}`);
  return runUninstallFlow({
    receipt, current, hostStep, backupParent: box.recovery, host: 'codex', pruneRoot: uninstallPruneRoot('codex', target, box.home),
    confirm: async () => answer, output: line => box.output.push(line), error: line => box.errors.push(line),
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

test('Codex uninstall also removes the launcher thread registry and its empty directory', async t => {
  const box = sandbox(t);
  await install(box);
  const registry = join(box.codex, 'advanced-harness', 'role-threads.json');
  writeFileSync(registry, '{ "thread-1": "implementer" }\n');
  assert.equal(await uninstall(box), 0, box.errors.join('\n'));
  assert.equal(existsSync(registry), false);
  assert.equal(existsSync(join(box.codex, 'advanced-harness')), false);
  assert.ok(box.output.some(line => line.includes('role thread bindings')), 'listed in the planned actions before confirmation');
});
