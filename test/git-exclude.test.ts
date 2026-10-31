import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRoot } from './temp-directory.ts';
import { applyGitExclude, harnessExcludePatterns, planGitExclude, planGitExcludeRemoval, previewGitExclude, resolveExcludePath } from '../src/git-exclude.ts';
import { runSetupFlow } from '../src/project-setup.ts';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { runUninstallFlow } from '../src/uninstall-cli-flow.ts';
import { discoverReceiptChain, readReceiptForRestore } from '../src/receipt-lineage.ts';
import { saveInstallation } from '../src/native-installer.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Harness Test', '-c', 'user.email=harness@example.invalid', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repository(t: { after(fn: () => void): void }) {
  const root = makeTempRoot('harness-git-exclude-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  git(project, 'init', '--quiet');
  writeFileSync(join(project, '.gitignore'), 'build/\n');
  git(project, 'add', '.gitignore');
  git(project, 'commit', '--quiet', '-m', 'init');
  return { root, project, exclude: () => resolveExcludePath(project)! };
}

function writeHarnessScratch(directory: string): void {
  mkdirSync(join(directory, '.harness'), { recursive: true });
  writeFileSync(join(directory, '.harness', 'index.json'), '{}');
  mkdirSync(join(directory, '.harness-state'), { recursive: true });
  writeFileSync(join(directory, '.harness-state', 'state.json'), '{}');
  writeFileSync(join(directory, 'opencode.json.harness-1234.tmp'), '{}');
}

test('adding the harness block hides scratch state from git status without touching the tracked .gitignore', t => {
  const { project, exclude } = repository(t);
  writeHarnessScratch(project);
  assert.notEqual(git(project, 'status', '--porcelain'), '');
  const plan = planGitExclude(project, 'setup');
  assert.equal(plan.status, 'change');
  assert.equal(applyGitExclude(plan), true);
  assert.equal(git(project, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), 'build/\n');
  for (const pattern of harnessExcludePatterns) assert.ok(readFileSync(exclude(), 'utf8').split('\n').includes(pattern), pattern);
  assert.equal(planGitExclude(project, 'setup').status, 'current', 'repeat runs are idempotent');
});

test('existing exclude content and CRLF line endings are preserved around the block', t => {
  const { project, exclude } = repository(t);
  writeFileSync(exclude(), '# user rule\r\n*.local');
  applyGitExclude(planGitExclude(project, 'opencode'));
  const text = readFileSync(exclude(), 'utf8');
  assert.ok(text.startsWith('# user rule\r\n*.local\r\n# advanced-harness:exclude:start owners=opencode\r\n'));
  assert.ok(text.endsWith('# advanced-harness:exclude:end\r\n'));
  assert.equal(text.replaceAll('\r\n', '').includes('\n'), false);
});

test('the block resolves to the shared exclude file and applies across linked worktrees', t => {
  const { root, project, exclude } = repository(t);
  const linked = join(root, 'linked');
  git(project, 'worktree', 'add', '--quiet', '-b', 'feature', linked);
  assert.equal(resolveExcludePath(linked), exclude());
  applyGitExclude(planGitExclude(linked, 'claude-code'));
  for (const directory of [project, linked]) {
    writeHarnessScratch(directory);
    assert.equal(git(directory, 'status', '--porcelain'), '', directory);
  }
  assert.equal(planGitExclude(project, 'claude-code').status, 'current');
});

test('owners share one block; it is removed only when the last owner releases it', t => {
  const { project, exclude } = repository(t);
  writeFileSync(exclude(), '*.local\n');
  applyGitExclude(planGitExclude(project, 'setup'));
  const added = planGitExclude(project, 'antigravity');
  assert.equal(added.status === 'change' && added.action, 'update');
  applyGitExclude(added);
  assert.match(readFileSync(exclude(), 'utf8'), /owners=antigravity,setup\n/);
  assert.equal(planGitExcludeRemoval(project, 'opencode').status, 'current', 'a non-owner releases nothing');
  const released = planGitExcludeRemoval(project, 'setup');
  assert.equal(released.status === 'change' && released.action, 'release');
  applyGitExclude(released);
  assert.match(readFileSync(exclude(), 'utf8'), /owners=antigravity\n/);
  const removed = planGitExcludeRemoval(project, 'antigravity');
  assert.equal(removed.status === 'change' && removed.action, 'remove');
  applyGitExclude(removed);
  assert.equal(readFileSync(exclude(), 'utf8'), '*.local\n');
});

test('non-Git directories and malformed markers skip the step without writing', t => {
  const { root, project, exclude } = repository(t);
  const plain = join(root, 'plain');
  mkdirSync(plain);
  const lines: string[] = [];
  assert.equal(previewGitExclude(plain, 'setup', line => lines.push(line))?.status, 'unavailable');
  assert.match(lines[0]!, /skipped \(not inside a Git work tree/);
  const malformed = '# advanced-harness:exclude:start owners=setup\n.harness/\n';
  writeFileSync(exclude(), malformed);
  assert.equal(previewGitExclude(project, 'setup', line => lines.push(line))?.status, 'unavailable');
  assert.match(lines[1]!, /Malformed advanced-harness markers/);
  assert.equal(readFileSync(exclude(), 'utf8'), malformed);
  assert.equal(previewGitExclude(undefined, 'setup', line => lines.push(line)), undefined, 'global scope has no project exclude');
});

test('an exclude file edited after the preview is left untouched', t => {
  const { project, exclude } = repository(t);
  const plan = planGitExclude(project, 'setup');
  writeFileSync(exclude(), '# concurrent edit\n');
  assert.throws(() => applyGitExclude(plan), /changed after the preview/);
  assert.equal(readFileSync(exclude(), 'utf8'), '# concurrent edit\n');
});

async function setup(project: string, root: string, confirm: string) {
  const home = join(root, 'home');
  const xdg = join(root, 'xdg');
  mkdirSync(home, { recursive: true });
  const outputs: string[] = [];
  const errors: string[] = [];
  const responses = ['bash', 'main', '-', '-', '-', '-', '-', '', join(home, 'worktrees'), join(home, 'data', 'MEMORY.md'), confirm];
  const code = await runSetupFlow({ scope: 'project', project }, { ask: async () => responses.shift() ?? '', output: line => outputs.push(line), error: line => errors.push(line), home, xdgConfigHome: xdg, recoveryDirectory: join(root, 'recovery') });
  return { code, outputs, errors };
}

test('setup previews the exclude block; cancellation writes nothing and save adds it', async t => {
  const { root, project, exclude } = repository(t);
  for (const response of ['', 'cancel']) {
    const cancelled = await setup(project, root, response);
    assert.equal(cancelled.code, 0);
    assert.ok(cancelled.outputs.some(line => /^Local Git exclude: .*add harness block/.test(line)));
    assert.equal(existsSync(exclude()) && readFileSync(exclude(), 'utf8').includes('advanced-harness'), false, `cancel "${response}" wrote no block`);
    assert.equal(existsSync(join(root, 'recovery')), false, 'no backups');
  }
  const saved = await setup(project, root, 'save');
  assert.deepEqual(saved.errors, []);
  assert.ok(saved.outputs.some(line => line.startsWith('Local Git exclude updated:')));
  assert.match(readFileSync(exclude(), 'utf8'), /owners=setup\n/);
  assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), 'build/\n');
});

test('Claude Code install and uninstall add and release the exclude owner through their confirmations', async t => {
  const { root, project, exclude } = repository(t);
  applyGitExclude(planGitExclude(project, 'setup'));
  const before = readFileSync(exclude(), 'utf8');
  const recovery = join(root, 'recovery');
  const deps = (answer: string, output: string[] = []) => ({
    ask: async (question: string) => question.startsWith('Type yes') ? answer : '',
    output: (line: string) => { output.push(line); },
    error: (line: string) => assert.fail(line),
    home: root,
    recoveryDirectory: recovery,
    agentsDirectory: fileURLToPath(new URL('../agents/', import.meta.url)),
    commandsDirectory: fileURLToPath(new URL('../commands/', import.meta.url)),
  });
  assert.equal(await runInstallerFlow({ scope: 'project', project, host: 'claude-code' }, deps('no')), 1);
  assert.equal(readFileSync(exclude(), 'utf8'), before, 'cancelled install leaves the exclude file');
  assert.equal(existsSync(recovery), false);

  const lines: string[] = [];
  assert.equal(await runInstallerFlow({ scope: 'project', project, host: 'claude-code' }, deps('yes', lines)), 0);
  assert.ok(lines.some(line => /^Local Git exclude: .*update harness block/.test(line)));
  assert.match(readFileSync(exclude(), 'utf8'), /owners=claude-code,setup\n/);
  assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), 'build/\n');

  const target = join(project, '.claude', 'settings.json');
  const snapshot = discoverReceiptChain(recovery, target, 'claude-code');
  const receipt = readReceiptForRestore(join(snapshot.directory, snapshot.head!.file), target);
  const uninstall = (answer: string, output: string[]) => runUninstallFlow({
    receipt, current: readFileSync(target, 'utf8'), host: 'claude-code', excludeRoot: project, backupParent: recovery, pruneRoot: project,
    confirm: async () => answer, output: line => { output.push(line); }, error: line => assert.fail(line),
    save: updated => { saveInstallation(target, readFileSync(target, 'utf8'), updated, recovery); },
  });
  const cancelled: string[] = [];
  assert.equal(await uninstall('', cancelled), 0);
  assert.ok(cancelled.some(line => /release this component/.test(line)));
  assert.match(readFileSync(exclude(), 'utf8'), /owners=claude-code,setup\n/, 'cancelled uninstall keeps the owner');
  const receipts = readdirSync(recovery).length;
  assert.equal(await uninstall('uninstall', []), 0);
  assert.equal(readFileSync(exclude(), 'utf8'), before, 'setup still owns the block after the host is uninstalled');
  assert.ok(readdirSync(recovery).length >= receipts);
});

test('OpenCode project install adds its owner only after typing install', async t => {
  const { root, project, exclude } = repository(t);
  const run = (confirm: string) => runInstallerFlow({ scope: 'project', project, host: 'opencode' }, {
    ask: async question => question.includes(': model ID') ? 'local/model#low' : question.includes(': reasoning variant') ? 'low' : question.startsWith('Type install') ? confirm : 'no',
    output: () => {}, error: line => assert.fail(line), home: root, recoveryDirectory: join(root, 'recovery'),
    verify: async () => ({ ok: true, checks: [] }) as never, printReport: () => {},
  });
  assert.equal(await run('cancel'), 0);
  assert.equal(existsSync(exclude()) && readFileSync(exclude(), 'utf8').includes('advanced-harness'), false);
  assert.equal(existsSync(join(root, 'recovery')), false);
  assert.equal(await run('install'), 0);
  assert.match(readFileSync(exclude(), 'utf8'), /owners=opencode\n/);
});

test('Antigravity adds its owner for project scope and leaves global installs alone', async t => {
  const { root, project, exclude } = repository(t);
  const options = (scope: 'project' | 'global') => ({ scope, ...(scope === 'project' ? { project } : {}), host: 'antigravity' });
  const deps = {
    ask: async (question: string, suggested?: string) => question.trimStart().startsWith('Type yes to install the Antigravity') ? 'yes' : (suggested ?? 'yes'),
    output: () => {}, error: (line: string) => assert.fail(line), home: join(root, 'home'), recoveryDirectory: join(root, 'recovery'),
    agentsDirectory: fileURLToPath(new URL('../agents/', import.meta.url)),
    commandsDirectory: fileURLToPath(new URL('../commands/', import.meta.url)),
  };
  mkdirSync(deps.home);
  assert.equal(await runInstallerFlow(options('global'), deps), 0);
  assert.equal(existsSync(exclude()) && readFileSync(exclude(), 'utf8').includes('advanced-harness'), false);
  assert.equal(await runInstallerFlow(options('project'), deps), 0);
  assert.match(readFileSync(exclude(), 'utf8'), /owners=antigravity\n/);
});
