import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { codexForbiddenPrefixes, compileCodexMergeRule, diagnoseCodex, disableMultiAgent, installCodex, validateCodexToml } from '../src/codex-adapter.ts';
import { createSuccessorReceipt, discoverReceiptChain, finalizeSuccessor, writePendingSuccessor } from '../src/receipt-lineage.ts';
import { codexChildRoles, codexRoleLauncherSource, codexRolePolicies, compileCodexRoleProfile, compileCodexRoleStatusSchema, mergeCodexLeadBlock } from '../src/codex-role-processes.ts';
import { assertResumable, buildRoleInvocation, isEntryPoint, launcherRuntime, listMcpServers, main as launcherMain, parseProfile, readSelectedMcpServers, readThreadBindings, recordThread, reportRun, securityKeys, threadBindingsPath } from '../src/codex-role-launcher.mjs';
import { loadRoleDefinitions } from '../src/role-definitions.ts';

const definitions = loadRoleDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));
const policies = codexRolePolicies(definitions);

function sandbox(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'codex-role-processes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(home);
  return { root, home, codex: join(home, '.codex') };
}

// One MCP prompt, then a model and effort for each of the seven child roles (Lead is the Desktop session).
const answers = (model: string, final = 'install') => ['', ...codexChildRoles.flatMap(() => [model, 'medium']), final];
const run = (home: string, list: string[], output: string[] = []) =>
  installCodex({ scope: 'global', home, mode: 'role-processes', ask: async () => list.shift() ?? '', output: line => output.push(line), error() {} });

test('role sandbox, network and MCP are derived from the role sources (#45, #218)', () => {
  assert.deepEqual(policies, {
    operator: { sandbox: 'danger-full-access', network: false, mcp: false },
    external: { sandbox: 'danger-full-access', network: true, mcp: true },
    researcher: { sandbox: 'read-only', network: false, mcp: false },
    planner: { sandbox: 'read-only', network: false, mcp: false },
    implementer: { sandbox: 'workspace-write', network: false, mcp: false },
    reviewer: { sandbox: 'read-only', network: false, mcp: false },
    qa: { sandbox: 'read-only', network: false, mcp: false },
  });
});

test('danger-full-access profiles say network is not restricted, and launch and resume both override the sandbox (#218)', () => {
  const windowsRoot = resolve(join(tmpdir(), 'work tree'));
  const profile = compileCodexRoleProfile('operator', policies.operator, 'gpt-example', 'high', 'Operate.');
  validateCodexToml(profile, 'operator profile');
  assert.match(profile, /^# danger-full-access: network is not restricted under this sandbox mode/m);
  assert.match(profile, /^sandbox_mode = "danger-full-access"$/m);
  assert.match(profile, /^network_access = false$/m, 'the line stays, and has no effect under danger-full-access');
  const implementer = compileCodexRoleProfile('implementer', policies.implementer, 'm', 'low', 'x');
  assert.doesNotMatch(implementer, /danger-full-access/, 'workspace-write profiles carry no full-access comment');

  const base = { role: 'operator', profileText: profile, mcpServers: [], mcpAllowed: false, task: 'Create the worktree', schemaPath: 's.json', resultPath: 'r.json' };
  const launch = buildRoleInvocation(base);
  assert.ok(launch.includes('sandbox_mode="danger-full-access"'), 'launch overrides the sandbox');
  assert.ok(!launch.includes('sandbox_mode="workspace-write"'));
  const resume = buildRoleInvocation({ ...base, resumeId: 'thread-1', task: 'Continue' });
  assert.ok(resume.includes('sandbox_mode="danger-full-access"'), 'resume overrides the sandbox');
  assert.ok(!resume.includes('sandbox_mode="workspace-write"'));
  const implementerProfile = compileCodexRoleProfile('implementer', policies.implementer, 'm', 'low', 'x');
  const implLaunch = buildRoleInvocation({ ...base, role: 'implementer', profileText: implementerProfile, workspaceRoot: windowsRoot });
  const implResume = buildRoleInvocation({ ...base, role: 'implementer', profileText: implementerProfile, workspaceRoot: windowsRoot, resumeId: 'thread-1' });
  assert.ok(implLaunch.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([windowsRoot])}`));
  assert.ok(implResume.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([windowsRoot])}`));
  assert.throws(() => buildRoleInvocation({ ...base, role: 'implementer', profileText: implementerProfile }), /validated absolute workspace root/);
  assert.throws(() => buildRoleInvocation({ ...base, role: 'implementer', profileText: implementerProfile.replace('writable_roots = []', 'writable_roots = ["C:\\\\outside"]'), workspaceRoot: windowsRoot }), /incompatible writable_roots baseline/);
});

test('role profiles are valid TOML that the launcher can re-apply key by key', () => {
  for (const role of codexChildRoles) {
    const text = compileCodexRoleProfile(role, policies[role], 'gpt-example', 'high', definitions[role].instructions);
    validateCodexToml(text, `${role} profile`);
    const parsed = parseProfile(text);
    for (const key of securityKeys) assert.ok(parsed.has(key), `${role}: ${key}`);
    assert.equal(parsed.get('approval_policy'), '"never"');
    assert.equal(parsed.get('sandbox_mode'), JSON.stringify(policies[role].sandbox));
    assert.equal(parsed.get('sandbox_workspace_write.writable_roots'), '[]');
  }
});

test('launcher re-applies role settings on launch and resume and switches MCP off unless allowed', () => {
  const profileText = compileCodexRoleProfile('reviewer', policies.reviewer, 'gpt-example', 'high', 'Review.');
  const base = { role: 'reviewer', profileText, mcpServers: ['github', 'my server'], mcpAllowed: false, task: 'Review the diff', schemaPath: 's.json', resultPath: 'r.json' };
  const launch = buildRoleInvocation(base);
  assert.deepEqual(launch.slice(0, 5), ['-p', 'harness-reviewer', '--disable', 'plugins', 'exec']);
  assert.ok(launch.includes('sandbox_mode="read-only"'));
  assert.ok(launch.includes('approval_policy="never"'));
  assert.ok(launch.includes('sandbox_workspace_write.network_access=false'));
  assert.ok(launch.includes('sandbox_workspace_write.writable_roots=[]'));
  assert.ok(launch.includes('mcp_servers.github.enabled=false'));
  assert.ok(launch.includes('mcp_servers."my server".enabled=false'));
  assert.deepEqual(launch.slice(-1), ['Review the diff']);

  const resume = buildRoleInvocation({ ...base, resumeId: 'thread-1', task: 'Continue' });
  assert.deepEqual(resume.slice(0, 4), ['exec', 'resume', '--disable', 'plugins']);
  assert.ok(!resume.includes('-p'), 'resume has no -p; every setting comes from -c');
  assert.ok(resume.includes('sandbox_mode="read-only"'), 'resume cannot fall back to the base sandbox');
  assert.deepEqual(resume.slice(-2), ['thread-1', 'Continue']);

  const external = buildRoleInvocation({ ...base, role: 'external', profileText: compileCodexRoleProfile('external', policies.external, 'm', 'low', 'x'), mcpAllowed: true });
  assert.ok(external.includes('mcp_servers.github.enabled=false') && external.includes('mcp_servers."my server".enabled=false'), 'with nothing selected, External has no MCP server');

  const selected = buildRoleInvocation({ ...base, role: 'external', profileText: compileCodexRoleProfile('external', policies.external, 'm', 'low', 'x'), mcpAllowed: true, mcpSelected: ['my server'] });
  assert.ok(selected.includes('mcp_servers."my server".enabled=true'), 'a selected server is turned on for External');
  assert.ok(selected.includes('mcp_servers.github.enabled=false'), 'an unselected server is turned off, even if the base config enables it');
  const resumed = buildRoleInvocation({ ...base, role: 'external', profileText: compileCodexRoleProfile('external', policies.external, 'm', 'low', 'x'), mcpAllowed: true, mcpSelected: ['my server'], resumeId: 'thread-1', task: 'Continue' });
  assert.ok(resumed.includes('mcp_servers."my server".enabled=true') && resumed.includes('mcp_servers.github.enabled=false'), 'a resume keeps the same MCP set');
  const other = buildRoleInvocation({ ...base, mcpSelected: ['my server'] });
  assert.ok(other.includes('mcp_servers."my server".enabled=false'), 'a selection never reaches a role without MCP');
});

test('launcher refuses Lead, empty tasks, incomplete profiles and unknown roles', () => {
  const profileText = compileCodexRoleProfile('qa', policies.qa, 'm', 'low', 'x');
  const base = { role: 'qa', profileText, mcpServers: [], mcpAllowed: false, task: 't', schemaPath: 's', resultPath: 'r' };
  assert.throws(() => buildRoleInvocation({ ...base, role: 'lead' }), /Not a launchable role/);
  assert.throws(() => buildRoleInvocation({ ...base, task: '  ' }), /task is required/);
  assert.throws(() => buildRoleInvocation({ ...base, profileText: 'model = "m"\n' }), /lacks sandbox_workspace_write\.writable_roots/);
  assert.throws(() => launcherMain(['implementer', '--task', 't'], { CODEX_HOME: join(tmpdir(), 'no-such-codex-home') }), /Unknown role "implementer"/);
  assert.throws(() => launcherMain(['qa', '--bogus', 'x'], {}), /Unknown, duplicate, or incomplete option/);
});

test('multi_agent is turned off only when unset; an explicit user value is kept and reported', () => {
  assert.equal(disableMultiAgent(''), '[features]\nmulti_agent = false\n');
  assert.equal(disableMultiAgent('model = "m"\n\n[features]\njs_repl = true\n'), 'model = "m"\n\n[features]\njs_repl = true\nmulti_agent = false\n');
  const warnings: string[] = [];
  assert.equal(disableMultiAgent('[features]\nmulti_agent = true\n', line => warnings.push(line)), '[features]\nmulti_agent = true\n');
  assert.match(warnings.join('\n'), /sets features\.multi_agent explicitly/);
});

test('Lead block merge preserves user content and replaces only the managed block', () => {
  const first = mergeCodexLeadBlock('# My notes\n', 'block one');
  assert.ok(first.startsWith('# My notes\n\n<!-- BEGIN advanced-harness Codex Lead -->\nblock one\n'));
  const second = mergeCodexLeadBlock(first, 'block two');
  assert.ok(second.includes('block two') && !second.includes('block one') && second.startsWith('# My notes\n'));
  assert.throws(() => mergeCodexLeadBlock(`${first}${first}`, 'x'), /duplicate advanced-harness Lead markers/);
});

test('role-process install is global only and Enter at confirmation writes nothing', async t => {
  const { root, home } = sandbox(t);
  const project = join(root, 'project'); mkdirSync(project);
  await assert.rejects(installCodex({ scope: 'project', project, home, mode: 'role-processes', ask: async () => '', output() {}, error() {} }), /global scope only/);
  assert.equal(await run(home, answers('gpt-example', '')), 0);
  assert.equal(existsSync(join(home, '.codex')), false);
  assert.equal(existsSync(join(home, 'Projects', 'advanced-harness-backups')), false);
});

test('role-process install writes profiles, launcher, schema and Lead block, and doctor passes (#45)', async t => {
  const { home, codex } = sandbox(t);
  mkdirSync(codex);
  writeFileSync(join(codex, 'AGENTS.md'), '# Personal Codex notes\n');
  const output: string[] = [];
  assert.equal(await run(home, answers('gpt-example'), output), 0);

  for (const role of codexChildRoles) {
    const profile = readFileSync(join(codex, `harness-${role}.config.toml`), 'utf8');
    assert.match(profile, new RegExp(`sandbox_mode = "${policies[role].sandbox}"`), role);
    assert.match(profile, /model = "gpt-example"/);
  }
  assert.equal(existsSync(join(codex, 'harness-lead.config.toml')), false, 'Lead is the Desktop session, not a process');
  assert.equal(existsSync(join(codex, 'agents')), false, 'no in-process custom agents');
  assert.equal(readFileSync(join(codex, 'advanced-harness', 'codex-role.mjs'), 'utf8'), codexRoleLauncherSource());
  assert.equal(readFileSync(join(codex, 'advanced-harness', 'role-status.schema.json'), 'utf8'), compileCodexRoleStatusSchema());
  const lead = readFileSync(join(codex, 'AGENTS.md'), 'utf8');
  assert.ok(lead.startsWith('# Personal Codex notes\n'));
  assert.match(lead, /never use in-process subagents/);
  assert.ok(lead.includes(join(codex, 'advanced-harness', 'codex-role.mjs').replace(/\\/g, '\\\\')), 'launch command names the installed launcher');
  assert.match(lead, /\| `operator` \| danger-full-access \| unrestricted \| off \|/, 'Lead block shows Operator as full access, unrestricted network (#218)');
  assert.match(lead, /\| `implementer` \| workspace-write \| no \| off \|/);
  assert.match(lead, /`operator` has network access under danger-full-access, but it must still not push, pull, clone or use `gh`\. Do not ask it to\./);
  const config = readFileSync(join(codex, 'config.toml'), 'utf8');
  assert.match(config, /sandbox_mode = "read-only"/);
  assert.match(config, /approval_policy = "on-request"/);
  assert.match(config, /\[features\]\r?\nmulti_agent = false/);
  assert.ok(output.some(line => /You grant host permission for every launch/.test(line)));

  const doctor = await diagnoseCodex({ home });
  assert.equal(doctor.ok, true, doctor.issues.join('\n'));
  assert.ok(doctor.notes.some(note => /Role-process mode/.test(note)));

  const receipts = () => readdirSync(join(home, 'Projects', 'advanced-harness-backups')).filter(name => name.startsWith('native-install-')).length;
  const before = receipts();
  assert.equal(await run(home, answers('gpt-example')), 0);
  assert.equal(receipts(), before, 'repeated identical install writes no new receipt');

  const statePath = join(codex, '.advanced-harness-state.json');
  const stateBefore = readFileSync(statePath, 'utf8');
  const state = JSON.parse(stateBefore) as { managed: Array<{ path: string; after: unknown }> };
  const receiptChain = discoverReceiptChain(join(home, 'Projects', 'advanced-harness-backups'), statePath, 'codex');
  assert.ok(receiptChain.head?.receipt.version === 2 && receiptChain.head.receipt.managedFiles);
  const legacyContents = new Map<string, string>();
  for (const role of codexChildRoles) {
    const path = join(codex, `harness-${role}.config.toml`);
    legacyContents.set(path, readFileSync(path, 'utf8').replace('writable_roots = []\n', ''));
  }
  const oldLauncher = 'legacy managed role launcher\n';
  const launcherPath = join(codex, 'advanced-harness', 'codex-role.mjs');
  legacyContents.set(launcherPath, oldLauncher);
  for (const [path, content] of legacyContents) {
    writeFileSync(path, content);
    const managed = state.managed.find(entry => entry.path === path);
    assert.ok(managed, `state manifest tracks ${path}`);
    managed.after = { content };
  }
  const legacyManagedFiles = structuredClone(receiptChain.head.receipt.managedFiles);
  for (const item of legacyManagedFiles) {
    const content = legacyContents.get(item.path);
    if (content !== undefined) item.after = { content };
  }
  const stateAfter = JSON.stringify(state, null, 2) + '\n';
  const legacyReceipt = createSuccessorReceipt(receiptChain, stateBefore, stateAfter, {}, undefined, { host: 'codex', managedFiles: legacyManagedFiles });
  const pendingLegacy = writePendingSuccessor(receiptChain, legacyReceipt);
  writeFileSync(statePath, stateAfter);
  finalizeSuccessor(pendingLegacy, stateAfter);
  mkdirSync(threadBindingsPath(codex), { recursive: true });
  writeFileSync(join(threadBindingsPath(codex), 'thread-legacy-reviewer'), 'reviewer\n');
  assert.throws(() => launcherMain(['reviewer', '--task', 'pre-upgrade'], { CODEX_HOME: codex, CODEX_BIN: 'codex-must-not-run' }), /lacks sandbox_workspace_write\.writable_roots/);
  assert.throws(() => launcherMain(['reviewer', '--resume', 'thread-legacy-reviewer', '--task', 'pre-upgrade'], { CODEX_HOME: codex, CODEX_BIN: 'codex-must-not-run' }), /lacks sandbox_workspace_write\.writable_roots/);
  assert.equal(await run(home, answers('gpt-example')), 0, 'managed update upgrades the matching historical profiles and launcher');
  for (const role of codexChildRoles) assert.equal(parseProfile(readFileSync(join(codex, `harness-${role}.config.toml`), 'utf8')).get('sandbox_workspace_write.writable_roots'), '[]');
  assert.equal(readFileSync(join(codex, 'advanced-harness', 'codex-role.mjs'), 'utf8'), codexRoleLauncherSource());
  assert.equal((await diagnoseCodex({ home })).ok, true);
  const oldExec = launcherRuntime.execFileSync, oldSpawn = launcherRuntime.spawnSync, oldLog = console.log;
  const calls: Array<{ binary: string; args: string[]; cwd: string }> = [];
  t.after(() => { launcherRuntime.execFileSync = oldExec; launcherRuntime.spawnSync = oldSpawn; console.log = oldLog; });
  launcherRuntime.execFileSync = ((binary: string, args: string[], options: { cwd: string }) => {
    calls.push({ binary, args, cwd: options.cwd });
    if (args.at(-1) === '--json') return '[]';
    throw new Error('unexpected subprocess');
  }) as typeof launcherRuntime.execFileSync;
  launcherRuntime.spawnSync = ((binary: string, args: string[], options: { cwd: string }) => {
    calls.push({ binary, args, cwd: options.cwd });
    return { status: 0, stdout: '{"type":"thread.started","thread_id":"thread-review-fresh"}\n', stderr: '' };
  }) as typeof launcherRuntime.spawnSync;
  console.log = () => {};
  assert.equal(launcherMain(['reviewer', '--task', 'review'], { CODEX_HOME: codex, CODEX_BIN: 'codex-update-stub' }), 0);
  assert.ok(calls.some(call => call.binary === 'codex-update-stub' && call.args.includes('exec')));
  calls.length = 0;
  assert.equal(launcherMain(['reviewer', '--resume', 'thread-legacy-reviewer', '--task', 'continue review'], { CODEX_HOME: codex, CODEX_BIN: 'codex-update-stub' }), 0);
  assert.ok(calls.some(call => call.binary === 'codex-update-stub' && call.args.includes('resume')));
});

test('doctor reports a widened role profile and re-enabled multi_agent', async t => {
  const { home, codex } = sandbox(t);
  mkdirSync(codex);
  assert.equal(await run(home, answers('gpt-example')), 0);
  const reviewer = join(codex, 'harness-reviewer.config.toml');
  writeFileSync(reviewer, readFileSync(reviewer, 'utf8').replace('sandbox_mode = "read-only"', 'sandbox_mode = "workspace-write"'));
  const config = join(codex, 'config.toml');
  writeFileSync(config, readFileSync(config, 'utf8').replace('multi_agent = false', 'multi_agent = true'));
  const doctor = await diagnoseCodex({ home });
  assert.equal(doctor.ok, false);
  assert.match(doctor.issues.join('\n'), /reviewer sandbox_mode is not read-only/);
  assert.match(doctor.issues.join('\n'), /multi_agent is not false/);
});

test('doctor rejects absent, malformed and widened writable_roots without rewriting profiles', async t => {
  const { home, codex } = sandbox(t);
  assert.equal(await run(home, answers('gpt-example')), 0);
  const path = join(codex, 'harness-implementer.config.toml');
  const original = readFileSync(path, 'utf8');
  for (const [replacement, expected] of [
    ['', /writable_roots is not an empty array/],
    ['writable_roots = "outside"', /writable_roots is not an empty array/],
    ['writable_roots = ["C:\\\\outside"]', /writable_roots is not an empty array/],
  ] as const) {
    const text = replacement ? original.replace('writable_roots = []', replacement) : original.replace('writable_roots = []\n', '');
    writeFileSync(path, text);
    const doctor = await diagnoseCodex({ home });
    assert.equal(doctor.ok, false);
    assert.match(doctor.issues.join('\n'), expected);
    assert.equal(readFileSync(path, 'utf8'), text);
  }
});

test('doctor flags an Operator profile left on workspace-write, and a widened Lead sandbox, with no writes (#218)', async t => {
  const { home, codex } = sandbox(t);
  assert.equal(await run(home, answers('gpt-example')), 0);
  const operator = join(codex, 'harness-operator.config.toml');
  writeFileSync(operator, readFileSync(operator, 'utf8').replace('sandbox_mode = "danger-full-access"', 'sandbox_mode = "workspace-write"'));
  const config = join(codex, 'config.toml');
  writeFileSync(config, readFileSync(config, 'utf8').replace('sandbox_mode = "read-only"', 'sandbox_mode = "danger-full-access"'));
  const before = readFileSync(operator, 'utf8');
  const doctor = await diagnoseCodex({ home });
  assert.equal(doctor.ok, false);
  assert.match(doctor.issues.join('\n'), /Codex role operator sandbox_mode is not danger-full-access/);
  assert.match(doctor.issues.join('\n'), /Codex Lead sandbox_mode is "danger-full-access", not "read-only"/, 'Lead settings are still checked on their own');
  assert.equal(readFileSync(operator, 'utf8'), before, 'doctor never rewrites a profile');
});

test('the installer preview names the full-access roles, the rules that still apply, and the launch host permission prompt (#218)', async t => {
  const box = sandbox(t);
  const output: string[] = [];
  assert.equal(await run(box.home, answers('gpt-example'), output), 0);
  const line = output.find(entry => entry.startsWith('Full-access roles '));
  assert.ok(line, output.join('\n'));
  assert.match(line, /^Full-access roles \(operator, external\) run with danger-full-access/);
  assert.match(line, /destructive-command rules are still installed for them \(enforcement under this mode is unverified\)/);
  assert.match(line, /do not match \+refspec pushes or the --force-with-lease=<ref> form/);
  assert.match(line, /each launch still needs your host permission at the Codex Desktop prompt\.$/);
  assert.equal(output.filter(entry => entry.startsWith('Full-access roles ')).length, 1, 'one line');
});

test('the managed merge rule keeps its gh pr merge prefix and one rule per forbidden prefix (#218)', () => {
  const rule = compileCodexMergeRule();
  assert.ok(rule.startsWith('# BEGIN advanced-harness managed merge rules\n'));
  assert.ok(rule.includes('prefix_rule(pattern = ["gh", "pr", "merge"], decision = "forbidden")\n'));
  assert.equal(rule.match(/^prefix_rule\(/gm)?.length, codexForbiddenPrefixes.length);
});

test('resume is bound to the role that started the thread; unknown or other-role threads never run', t => {
  const { root, codex } = sandbox(t);
  const repository = join(root, 'repo'); mkdirSync(repository);
  const worktree = join(root, 'linked worktree'); mkdirSync(worktree);
  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  const gitRun = (args: string[]) => spawnSync(git, args, { cwd: repository, encoding: 'utf8' });
  assert.equal(gitRun(['init']).status, 0);
  writeFileSync(join(repository, 'tracked'), 'x');
  assert.equal(gitRun(['add', 'tracked']).status, 0);
  assert.equal(gitRun(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']).status, 0);
  assert.equal(gitRun(['worktree', 'add', '--detach', worktree]).status, 0);
  const bindings = threadBindingsPath(codex);
  const identity = { top: 'C:/task/worktree', gitDir: 'C:/task/repo/.git/worktrees/wt', commonDir: 'C:/task/repo/.git' };
  recordThread(bindings, 'thread-impl-1', 'implementer', identity);
  recordThread(bindings, 'thread-review-1', 'reviewer');
  assert.doesNotThrow(() => recordThread(bindings, 'thread-impl-1', 'implementer', identity), 'recording the same binding twice is harmless');
  assert.throws(() => recordThread(bindings, 'thread-impl-1', 'reviewer'), /already bound to implementer/);
  assert.deepEqual({ ...readThreadBindings(bindings) }, { 'thread-impl-1': { role: 'implementer', worktree: identity.top, gitDir: identity.gitDir, commonDir: identity.commonDir }, 'thread-review-1': 'reviewer' });
  assert.doesNotThrow(() => assertResumable(readThreadBindings(bindings), 'thread-impl-1', 'implementer'));
  assert.throws(() => assertResumable(readThreadBindings(bindings), 'thread-review-1', 'implementer'), /belongs to reviewer; it cannot be resumed as implementer/);
  assert.throws(() => assertResumable(readThreadBindings(bindings), 'thread-unknown', 'implementer'), /Unknown thread thread-unknown/);
  assert.throws(() => assertResumable(readThreadBindings(bindings), '../x', 'implementer'), /Invalid thread ID/);
  assert.throws(() => assertResumable(readThreadBindings(bindings), 'constructor', 'implementer'), /Unknown thread constructor/);

  // Through main(): rejected before the Codex binary (a missing path here) is ever called.
  writeFileSync(join(codex, 'harness-implementer.config.toml'), compileCodexRoleProfile('implementer', policies.implementer, 'm', 'low', 'x'));
  const env = { CODEX_HOME: codex, CODEX_BIN: join(codex, 'no-such-codex') };
  assert.throws(() => launcherMain(['implementer', '--cd', worktree, '--resume', 'thread-review-1', '--task', 'continue'], env), /belongs to reviewer/);
  assert.throws(() => launcherMain(['implementer', '--cd', worktree, '--resume', 'thread-unknown', '--task', 'continue'], env), /Unknown thread/);
  writeFileSync(join(codex, 'harness-reviewer.config.toml'), compileCodexRoleProfile('reviewer', policies.reviewer, 'm', 'low', 'x'));
  const reviewerBinding = join(bindings, 'thread-legacy-reviewer');
  writeFileSync(reviewerBinding, 'reviewer\n');
  assert.doesNotThrow(() => assertResumable(readThreadBindings(bindings), 'thread-legacy-reviewer', 'reviewer'), 'legacy role-only non-Implementer records remain resumable');
});

test('Implementer requires exact linked-worktree root and binds resume to Git worktree identity', t => {
  const { root, codex } = sandbox(t);
  const mainRepo = join(root, 'repo'); mkdirSync(mainRepo);
  const worktree = join(root, 'work tree'); mkdirSync(worktree);
  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  const gitEnv = { ...process.env };
  const runGit = (cwd: string, args: string[]) => spawnSync(git, args, { cwd, env: gitEnv, encoding: 'utf8' });
  const gitIdentity = (cwd: string, args: string[]) => {
    const result = runGit(cwd, args);
    assert.equal(result.status, 0, result.stderr);
    const raw = result.stdout.trim();
    return raw.match(/^(?:[A-Za-z]:[\\/]|\/)/) ? raw : join(cwd, raw);
  };
  assert.equal(runGit(mainRepo, ['init']).status, 0);
  writeFileSync(join(mainRepo, 'tracked.txt'), 'x');
  assert.equal(runGit(mainRepo, ['add', 'tracked.txt']).status, 0);
  assert.equal(runGit(mainRepo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']).status, 0);
  assert.equal(runGit(mainRepo, ['worktree', 'add', '--detach', worktree]).status, 0);
  mkdirSync(join(worktree, 'subdir'));
  mkdirSync(codex);
  writeFileSync(join(codex, 'harness-implementer.config.toml'), compileCodexRoleProfile('implementer', policies.implementer, 'm', 'low', 'x'));
  const noBinary = join(codex, 'no-such-codex');
  const env = { CODEX_HOME: codex, CODEX_BIN: noBinary };
  assert.throws(() => launcherMain(['implementer', '--cd', 'relative/path', '--task', 'x'], env), /explicit absolute --cd/);
  assert.throws(() => launcherMain(['implementer', '--cd', mainRepo, '--task', 'x'], env), /linked Git worktree/);
  assert.throws(() => launcherMain(['implementer', '--cd', join(worktree, 'subdir'), '--task', 'x'], env), /canonical linked worktree root/);
  assert.throws(() => launcherMain(['implementer', '--task', 'x'], env), /explicit absolute --cd/);
  mkdirSync(threadBindingsPath(codex), { recursive: true });
  writeFileSync(join(threadBindingsPath(codex), 'thread-legacy'), 'implementer\n');
  assert.throws(() => launcherMain(['implementer', '--cd', worktree, '--resume', 'thread-legacy', '--task', 'x'], env), /legacy or belongs to a different worktree/);
  assert.throws(() => launcherMain(['implementer', '--cd', worktree, '--resume', 'thread-legacy', '--task', 'x'], { ...env, GIT_DIR: mainRepo }), /legacy or belongs to a different worktree/);
});

test('launcher entry runs fresh and resumed Implementer in the exact space-containing root and refuses wrong identities before Codex', t => {
  const { root, home, codex } = sandbox(t);
  const mainRepo = join(root, 'repo'); mkdirSync(mainRepo);
  const worktree = join(root, 'linked worktree'); mkdirSync(worktree);
  const other = join(root, 'other worktree'); mkdirSync(other);
  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  const runGit = (cwd: string, args: string[]) => spawnSync(git, args, { cwd, env: process.env, encoding: 'utf8' });
  const gitPath = (cwd: string, args: string[]) => {
    const result = runGit(cwd, args);
    assert.equal(result.status, 0, result.stderr);
    const value = result.stdout.trim();
    const absolute = value.match(/^(?:[A-Za-z]:[\\/]|\/)/) ? value : join(cwd, value);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  assert.equal(runGit(mainRepo, ['init']).status, 0);
  writeFileSync(join(mainRepo, 'tracked.txt'), 'x');
  assert.equal(runGit(mainRepo, ['add', 'tracked.txt']).status, 0);
  assert.equal(runGit(mainRepo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']).status, 0);
  assert.equal(runGit(mainRepo, ['worktree', 'add', '--detach', worktree]).status, 0);
  assert.equal(runGit(mainRepo, ['worktree', 'add', '--detach', other]).status, 0);
  const expectedIdentity = {
    worktree,
    gitDir: gitPath(worktree, ['rev-parse', '--absolute-git-dir']),
    commonDir: gitPath(worktree, ['rev-parse', '--git-common-dir']),
  };
  const otherIdentity = {
    worktree: other,
    gitDir: gitPath(other, ['rev-parse', '--absolute-git-dir']),
    commonDir: gitPath(other, ['rev-parse', '--git-common-dir']),
  };
  mkdirSync(codex);
  writeFileSync(join(codex, 'harness-implementer.config.toml'), compileCodexRoleProfile('implementer', policies.implementer, 'm', 'low', 'x'));
  const bindingRoot = threadBindingsPath(codex);
  const codexPath = 'codex-stub';
  const originals = { exec: launcherRuntime.execFileSync, spawn: launcherRuntime.spawnSync };
  t.after(() => { launcherRuntime.execFileSync = originals.exec; launcherRuntime.spawnSync = originals.spawn; });
  const calls: Array<{ binary: string; args: string[]; cwd: string }> = [];
  launcherRuntime.execFileSync = ((binary: string, args: string[], options: { cwd: string }) => {
    calls.push({ binary, args, cwd: options.cwd });
    if (args[0] === 'rev-parse') {
      const identity = options.cwd === other ? otherIdentity : expectedIdentity;
      const outputs: Record<string, string> = {
        '--show-toplevel': identity.worktree,
        '--absolute-git-dir': identity.gitDir,
        '--git-common-dir': identity.commonDir,
        '--git-dir': identity.gitDir,
      };
      const key = args[1];
      if (key === undefined || !Object.hasOwn(outputs, key)) throw new Error(`unexpected rev-parse selector: ${String(key)}`);
      const value = outputs[key];
      if (value === undefined) throw new Error(`missing rev-parse fixture value: ${key}`);
      return value;
    }
    if (binary === codexPath && args.at(-1) === '--json') return '[]';
    throw new Error('unexpected git call');
  }) as typeof launcherRuntime.execFileSync;
  launcherRuntime.spawnSync = ((binary: string, args: string[], options: { cwd: string }) => {
    calls.push({ binary, args, cwd: options.cwd });
    return { status: 0, stdout: '{"type":"thread.started","thread_id":"thread-fresh"}\n', stderr: '' };
  }) as typeof launcherRuntime.spawnSync;
  const originalLog = console.log;
  console.log = () => {};
  t.after(() => { console.log = originalLog; });
  assert.equal(launcherMain(['implementer', '--cd', worktree, '--task', 'write file'], { CODEX_HOME: codex, CODEX_BIN: codexPath }), 0);
  const firstSpawn = calls.find(call => call.args.includes('exec'));
  assert.ok(firstSpawn);
  assert.equal(firstSpawn.cwd, worktree);
  assert.ok(firstSpawn.args.includes(`sandbox_workspace_write.writable_roots=[${JSON.stringify(worktree)}]`));
  const saved = readThreadBindings(bindingRoot)['thread-fresh'];
  assert.ok(typeof saved === 'object' && saved !== null);
  assert.equal(saved.role, 'implementer');
  const savedWorktree = saved.worktree;
  const savedGitDir = saved.gitDir;
  const savedCommonDir = saved.commonDir;
  assert.equal(typeof savedWorktree, 'string', 'record contains a worktree path');
  assert.equal(typeof savedGitDir, 'string', 'record contains a Git directory path');
  assert.equal(typeof savedCommonDir, 'string', 'record contains a Git common directory path');
  if (typeof savedWorktree !== 'string' || typeof savedGitDir !== 'string' || typeof savedCommonDir !== 'string') {
    throw new Error('Implementer thread record is missing its physical Git identity paths.');
  }
  const physical = (path: string) => {
    const normalized = path.replace(/[\\/]+/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  assert.equal(physical(savedWorktree), physical(expectedIdentity.worktree));
  assert.equal(physical(savedGitDir), physical(expectedIdentity.gitDir));
  assert.equal(physical(savedCommonDir), physical(expectedIdentity.commonDir));
  calls.length = 0;
  launcherRuntime.spawnSync = ((binary: string, args: string[], options: { cwd: string }) => {
    calls.push({ binary, args, cwd: options.cwd });
    return { status: 0, stdout: '', stderr: '' };
  }) as typeof launcherRuntime.spawnSync;
  assert.equal(launcherMain(['implementer', '--cd', worktree, '--resume', 'thread-fresh', '--task', 'continue'], { CODEX_HOME: codex, CODEX_BIN: codexPath }), 0);
  const resume = calls.find(call => call.args.includes('resume'));
  assert.ok(resume);
  assert.equal(resume.cwd, worktree);
  assert.ok(resume.args.includes(`sandbox_workspace_write.writable_roots=[${JSON.stringify(worktree)}]`));
  calls.length = 0;
  assert.throws(() => launcherMain(['implementer', '--cd', other, '--resume', 'thread-fresh', '--task', 'wrong'], { CODEX_HOME: codex, CODEX_BIN: codexPath }), /different worktree/);
  assert.equal(calls.filter(call => call.binary === codexPath).length, 0, 'no Codex subprocess occurs for mismatched resume');
  writeFileSync(join(bindingRoot, 'thread-malformed'), '{bad');
  assert.throws(() => launcherMain(['implementer', '--cd', worktree, '--task', 'x'], { CODEX_HOME: codex, CODEX_BIN: codexPath }), /Malformed role thread bindings/);
  assert.equal(calls.filter(call => call.binary === codexPath).length, 0);
  assert.notEqual(home, '');
});

test('launcher refuses absent, malformed and widened writable-roots profiles before any Codex subprocess', t => {
  const { root, codex } = sandbox(t);
  mkdirSync(codex);
  const project = join(root, 'project'); mkdirSync(project);
  const impl = join(codex, 'harness-implementer.config.toml');
  const reviewer = join(codex, 'harness-reviewer.config.toml');
  const validImpl = compileCodexRoleProfile('implementer', policies.implementer, 'm', 'low', 'x');
  const codexPath = 'codex-should-not-run';
  const originals = launcherRuntime.execFileSync;
  t.after(() => { launcherRuntime.execFileSync = originals; });
  const codexCalls: string[] = [];
  launcherRuntime.execFileSync = ((binary: string, args: string[]) => {
    if (binary === codexPath) codexCalls.push(args.join(' '));
    throw new Error('unexpected subprocess');
  }) as typeof launcherRuntime.execFileSync;
  for (const profile of [
    validImpl.replace('writable_roots = []\n', ''),
    validImpl.replace('writable_roots = []', 'writable_roots = "bad"'),
    validImpl.replace('writable_roots = []', 'writable_roots = ["/outside"]'),
  ]) {
    writeFileSync(impl, profile);
    assert.throws(() => launcherMain(['implementer', '--cd', project, '--task', 'x'], { CODEX_HOME: codex, CODEX_BIN: codexPath }), /writable_roots/);
    assert.throws(() => launcherMain(['implementer', '--cd', project, '--resume', 'thread-invalid', '--task', 'x'], { CODEX_HOME: codex, CODEX_BIN: codexPath }), /writable_roots/);
    assert.equal(codexCalls.length, 0);
  }
});

test('concurrent launchers recording different threads keep every binding', async t => {
  const { codex } = sandbox(t);
  const bindings = threadBindingsPath(codex);
  const launcher = new URL('../src/codex-role-launcher.mjs', import.meta.url).href;
  const writers = 6, perWriter = 25;
  // Separate processes, started together, each record their own threads into the same store.
  const script = `import { recordThread } from ${JSON.stringify(launcher)};
const [dir, writer, count] = process.argv.slice(1);
for (let index = 0; index < Number(count); index++) recordThread(dir, \`thread-\${writer}-\${index}\`, writer % 2 ? 'reviewer' : 'implementer', { top: '/fixture/worktree', gitDir: '/fixture/.git/worktrees/wt', commonDir: '/fixture/.git' });`;
  const exits = await Promise.all(Array.from({ length: writers }, (_, writer) => new Promise<number | null>(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, bindings, String(writer), String(perWriter)], { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('exit', resolve);
  })));
  assert.deepEqual(exits, Array(writers).fill(0));
  const recorded = readThreadBindings(bindings);
  assert.equal(Object.keys(recorded).length, writers * perWriter);
  for (let writer = 0; writer < writers; writer++) {
    for (let index = 0; index < perWriter; index++) {
      const binding = recorded[`thread-${writer}-${index}`];
      assert.ok(binding !== undefined, `writer ${writer}, item ${index} was recorded`);
      const actualRole = typeof binding === 'string' ? binding : binding.role;
      assert.equal(actualRole, writer % 2 ? 'reviewer' : 'implementer');
    }
  }
});

test('malformed thread bindings stop a new launch or resume before any child starts', t => {
  const { root, codex } = sandbox(t);
  const repo = join(root, 'repo'); mkdirSync(repo);
  const worktree = join(root, 'linked worktree'); mkdirSync(worktree);
  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  const gitRun = (args: string[]) => spawnSync(git, args, { cwd: repo, encoding: 'utf8' });
  assert.equal(gitRun(['init']).status, 0);
  writeFileSync(join(repo, 'tracked'), 'x');
  assert.equal(gitRun(['add', 'tracked']).status, 0);
  assert.equal(gitRun(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']).status, 0);
  assert.equal(gitRun(['worktree', 'add', '--detach', worktree]).status, 0);
  mkdirSync(codex);
  mkdirSync(join(codex, 'advanced-harness'), { recursive: true });
  writeFileSync(join(codex, 'harness-implementer.config.toml'), compileCodexRoleProfile('implementer', policies.implementer, 'm', 'low', 'x'));
  const bindings = threadBindingsPath(codex);
  // A missing binary would fail with ENOENT if the launcher got as far as calling Codex.
  const env = { CODEX_HOME: codex, CODEX_BIN: join(codex, 'no-such-codex') };
  const launch = () => launcherMain(['implementer', '--cd', worktree, '--task', 'new work'], env);
  const resume = () => launcherMain(['implementer', '--cd', worktree, '--resume', 'thread-impl-1', '--task', 'continue'], env);

  writeFileSync(bindings, '{ "thread-impl-1": "implementer" }');
  assert.throws(launch, /Malformed role thread bindings .*not a directory/);
  assert.throws(resume, /Malformed role thread bindings .*not a directory/);
  rmSync(bindings);

  mkdirSync(bindings, { recursive: true });
  writeFileSync(join(bindings, 'thread-impl-1'), 'implementer\n');
  writeFileSync(join(bindings, 'thread-broken'), '');
  assert.throws(launch, /thread-broken does not name a role/);
  assert.throws(resume, /thread-broken does not name a role/);
  rmSync(join(bindings, 'thread-broken'));
  writeFileSync(join(bindings, 'notes.txt'), 'x');
  assert.throws(launch, /unexpected entry notes\.txt/);
});

test('a finished run whose thread cannot be recorded is reported for a decision, keeping its outcome', t => {
  const { codex } = sandbox(t);
  const bindings = threadBindingsPath(codex);
  const stdout = ['{"type":"thread.started","thread_id":"thread-new-1"}', '{"type":"turn.completed"}'].join('\n');
  const resultText = JSON.stringify({ status: 'Ready', summary: 'Implemented the change.', details: 'Edited src/a.ts' });
  const identity = { top: 'C:/work tree', gitDir: 'C:/repo/.git/worktrees/wt', commonDir: 'C:/repo/.git' };

  const ok = reportRun({ role: 'implementer', bindingsPath: bindings, stdout, exitCode: 0, resultText, identity });
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.report, { role: 'implementer', threadId: 'thread-new-1', exitCode: 0, status: 'Ready', summary: 'Implemented the change.', details: 'Edited src/a.ts' });
  assert.deepEqual(readThreadBindings(bindings)['thread-new-1'], { role: 'implementer', worktree: identity.top, gitDir: identity.gitDir, commonDir: identity.commonDir });

  // The thread ID is already bound to another role: recording fails after the child did its work.
  recordThread(bindings, 'thread-new-2', 'reviewer');
  const conflict = reportRun({ role: 'implementer', bindingsPath: bindings, stdout: stdout.replace('thread-new-1', 'thread-new-2'), exitCode: 0, resultText, identity });
  assert.equal(conflict.code, 2);
  assert.equal(conflict.report.status, 'Needs your decision');
  assert.equal(conflict.report.threadId, 'thread-new-2');
  assert.equal(conflict.report.exitCode, 0);
  assert.match(String(conflict.report.summary), /finished \(exit 0\) but thread thread-new-2 could not be recorded.*already bound to reviewer/);
  assert.match(String(conflict.report.details), /Do not repeat the task blindly/);
  assert.deepEqual(conflict.report.roleResult, JSON.parse(resultText));
  assert.equal(readThreadBindings(bindings)['thread-new-2'], 'reviewer', 'the existing binding is not overwritten');

  // The store cannot be written at all (a file where the directory should be).
  const blocked = join(codex, 'blocked');
  writeFileSync(blocked, '');
  const unwritable = reportRun({ role: 'implementer', bindingsPath: join(blocked, 'role-threads'), stdout, exitCode: 1, resultText: undefined, identity });
  assert.equal(unwritable.code, 2);
  assert.equal(unwritable.report.threadId, 'thread-new-1');
  assert.equal(unwritable.report.exitCode, 1);
  assert.match(String(unwritable.report.summary), /finished \(exit 1\) but thread thread-new-1 could not be recorded/);
  assert.equal((unwritable.report.roleResult as { status: string }).status, 'Needs your decision');

  // A resume records nothing, so its result passes through unchanged.
  const resumed = reportRun({ role: 'implementer', resumeId: 'thread-new-1', bindingsPath: join(blocked, 'role-threads'), stdout: '', exitCode: 0, resultText });
  assert.deepEqual(resumed, { code: 0, report: { role: 'implementer', threadId: 'thread-new-1', exitCode: 0, status: 'Ready', summary: 'Implemented the change.', details: 'Edited src/a.ts' } });
});

test('doctor reports a missing, malformed, empty or edited Lead block without rewriting AGENTS.md', async t => {
  const { home, codex } = sandbox(t);
  mkdirSync(codex);
  writeFileSync(join(codex, 'AGENTS.md'), '# Personal Codex notes\n');
  assert.equal(await run(home, answers('gpt-example')), 0);
  const path = join(codex, 'AGENTS.md');
  const installed = readFileSync(path, 'utf8');
  const start = '<!-- BEGIN advanced-harness Codex Lead -->', end = '<!-- END advanced-harness Codex Lead -->';
  const body = installed.slice(installed.indexOf(start) + start.length, installed.indexOf(end));
  const cases: Array<[string, string, RegExp]> = [
    ['missing', '# Personal Codex notes\n', /Lead block in .* is missing/],
    ['empty', installed.replace(body, '\n'), /empty, edited, or from another harness version/],
    ['edited', installed.replace('never use in-process subagents', 'may use in-process subagents'), /empty, edited, or from another harness version/],
    ['duplicated', `${installed}${start}\n${end}\n`, /has 2 start and 2 end markers/],
    ['out of order', installed.replace(start, 'TMP').replace(end, start).replace('TMP', end), /end marker before its start marker/],
  ];
  for (const [name, text, expected] of cases) {
    writeFileSync(path, text);
    const doctor = await diagnoseCodex({ home });
    assert.equal(doctor.ok, false, name);
    assert.match(doctor.issues.join('\n'), expected, name);
    assert.equal(readFileSync(path, 'utf8'), text, `${name}: doctor never rewrites AGENTS.md`);
  }
  writeFileSync(path, installed.replace('# Personal Codex notes', '# Personal Codex notes, edited by me'));
  assert.equal((await diagnoseCodex({ home })).ok, true, 'edits outside the managed block are not drift');
});

test('multi_agent follows the form config.toml already uses for features, so Codex can still load it (#45)', () => {
  assert.equal(disableMultiAgent('features.web_search = true\n'), 'features.web_search = true\nfeatures.multi_agent = false\n');
  assert.equal(disableMultiAgent('features.web_search = true # mine\nmodel = "x"\n\n[tui]\nfoo = 1\n'), 'features.web_search = true # mine\nfeatures.multi_agent = false\nmodel = "x"\n\n[tui]\nfoo = 1\n');
  assert.equal(disableMultiAgent('features.web_search = true'), 'features.web_search = true\nfeatures.multi_agent = false\n');
  assert.throws(() => disableMultiAgent('[features.sub]\nx = 1\n'), /out-of-order/, 'the scanner refuses a parent table after its sub-table, so this stops before any write');

  const inlineFalse = 'features = { multi_agent = false }\n';
  assert.equal(disableMultiAgent(inlineFalse), inlineFalse);
  const warnings: string[] = [];
  assert.equal(disableMultiAgent('features = { multi_agent = true }\n', line => warnings.push(line)), 'features = { multi_agent = true }\n');
  assert.match(warnings.join('\n'), /sets features\.multi_agent explicitly/);
  assert.throws(() => disableMultiAgent('features = { web_search = true }\n'), /inline table[\s\S]*No changes made/);
});

test('the TOML check refuses a table that redefines dotted keys, as Codex does (#45)', () => {
  assert.throws(() => validateCodexToml('features.web_search = true\n\n[features]\nmulti_agent = false\n'), /redefines dotted keys/);
  assert.throws(() => validateCodexToml('[a]\nb.c = 1\n\n[a.b]\nd = 2\n'), /redefines dotted keys/);
  assert.throws(() => validateCodexToml('[a.b]\nc = 1\n\n[x]\ny = 1\n[a.b.d]\ne.f = 1\n\n[a.b.d.e]\ng = 1\n'), /redefines dotted keys/);
  validateCodexToml('[a]\nb.c = 1\n\n[a.b.d]\ne = 2\n');
  validateCodexToml('features.web_search = true\n\n[features.sub]\nx = 1\n');
});

test('install with dotted features writes a config doctor accepts, and refuses an inline table with no writes (#45)', async t => {
  const dotted = sandbox(t);
  mkdirSync(dotted.codex);
  writeFileSync(join(dotted.codex, 'config.toml'), 'features.web_search = true\n');
  assert.equal(await run(dotted.home, answers('gpt-example')), 0);
  const written = readFileSync(join(dotted.codex, 'config.toml'), 'utf8');
  assert.match(written, /^features\.web_search = true\nfeatures\.multi_agent = false$/m);
  assert.doesNotMatch(written, /^\[features\]/m);
  assert.deepEqual((await diagnoseCodex({ home: dotted.home })).issues, []);

  const inline = sandbox(t);
  mkdirSync(inline.codex);
  const config = 'features = { web_search = true }\n';
  writeFileSync(join(inline.codex, 'config.toml'), config);
  await assert.rejects(run(inline.home, answers('gpt-example')), /inline table[\s\S]*No changes made/);
  assert.deepEqual(readdirSync(inline.codex), ['config.toml']);
  assert.equal(readFileSync(join(inline.codex, 'config.toml'), 'utf8'), config);
});

test('install warns and doctor fails when Lead settings remove the host permission point (#45)', async t => {
  const cases: Array<[string, RegExp[]]> = [
    ['sandbox_mode = "danger-full-access"\napproval_policy = "never"\n', [/sandbox_mode is "danger-full-access"/, /approval_policy is "never"/]],
    ['approval_policy = "never"\n', [/approval_policy is "never"/]],
    ['sandbox_mode = "workspace-write"\n', [/sandbox_mode is "workspace-write"/]],
  ];
  for (const [config, expected] of cases) {
    const box = sandbox(t);
    mkdirSync(box.codex);
    writeFileSync(join(box.codex, 'config.toml'), config);
    const output: string[] = [];
    assert.equal(await run(box.home, answers('gpt-example'), output), 0);
    const preview = output.join('\n');
    assert.match(preview, /you may not be asked for host permission on role launches/);
    assert.doesNotMatch(preview, /You grant host permission for every launch/);
    const doctor = await diagnoseCodex({ home: box.home });
    assert.equal(doctor.ok, false, config);
    for (const pattern of expected) {
      assert.match(preview, pattern);
      assert.match(doctor.issues.join('\n'), pattern);
    }
    assert.ok(readFileSync(join(box.codex, 'config.toml'), 'utf8').startsWith(config), 'the user values are kept');
  }

  const clean = sandbox(t);
  const output: string[] = [];
  assert.equal(await run(clean.home, answers('gpt-example'), output), 0);
  assert.match(output.join('\n'), /You grant host permission for every launch/);
  assert.deepEqual((await diagnoseCodex({ home: clean.home })).issues, []);

  writeFileSync(join(clean.codex, 'config.toml'), readFileSync(join(clean.codex, 'config.toml'), 'utf8').replace('approval_policy = "on-request"', 'approval_policy = "never"'));
  assert.match((await diagnoseCodex({ home: clean.home })).issues.join('\n'), /Lead approval_policy is "never"/, 'drift after install is caught too');
});

test('a task starting with a dash reaches Codex as text, never as a flag (#45)', () => {
  const profileText = compileCodexRoleProfile('reviewer', policies.reviewer, 'gpt-example', 'medium', 'Review.');
  const base = { role: 'reviewer', profileText, mcpServers: [], mcpAllowed: false, schemaPath: 's.json', resultPath: 'r.json' };
  for (const task of ['--dangerously-bypass-approvals-and-sandbox', '-csandbox_mode="danger-full-access"', '--help']) {
    const launch = buildRoleInvocation({ ...base, task });
    assert.deepEqual(launch.slice(-2), ['--', task]);
    assert.equal(launch.indexOf(task), launch.length - 1, 'nothing but the task follows the separator');
    const resume = buildRoleInvocation({ ...base, task, resumeId: 'thread-1' });
    assert.deepEqual(resume.slice(-3), ['--', 'thread-1', task]);
    assert.equal(resume.indexOf('--'), resume.length - 3);
  }
  assert.throws(() => buildRoleInvocation({ ...base, task: ' - ' }), /cannot be "-"/);
});

test('child processes run with Codex plugins disabled, before the -- separator, on launch and resume (#209)', () => {
  const profileText = compileCodexRoleProfile('external', policies.external, 'm', 'low', 'x');
  const base = { role: 'external', profileText, mcpServers: ['gh'], mcpAllowed: true, mcpSelected: ['gh'], schemaPath: 's.json', resultPath: 'r.json' };
  const disabledBeforeSeparator = (args: string[]) => {
    const flag = args.indexOf('--disable');
    return flag > 0 && args[flag + 1] === 'plugins' && flag < args.indexOf('--');
  };

  const launch = buildRoleInvocation({ ...base, task: 'Check the diff' });
  assert.ok(disabledBeforeSeparator(launch), launch.join(' '));
  assert.deepEqual(launch.slice(0, 5), ['-p', 'harness-external', '--disable', 'plugins', 'exec']);
  assert.ok(launch.includes('mcp_servers.gh.enabled=true'), 'the selected config.toml server is still switched on for External');

  const resume = buildRoleInvocation({ ...base, resumeId: 'thread-1', task: 'Continue' });
  assert.ok(disabledBeforeSeparator(resume), resume.join(' '));
  assert.deepEqual(resume.slice(0, 4), ['exec', 'resume', '--disable', 'plugins']);
  assert.ok(resume.includes('mcp_servers.gh.enabled=true'), 'a resume keeps the same MCP set');
  assert.deepEqual(resume.slice(-3), ['--', 'thread-1', 'Continue']);
});

test('the MCP listing runs with plugins disabled and names the role and Codex reason when it fails (#209)', () => {
  const calls: string[][] = [];
  const names = listMcpServers('external', args => { calls.push(args); return '[{"name":"gh"}]'; });
  assert.deepEqual(names, ['gh']);
  assert.deepEqual(calls, [['-p', 'harness-external', '--disable', 'plugins', 'mcp', 'list', '--json']]);

  // The Codex config-load failure from #209: Codex prints its reason on stderr and exits 1.
  const configError = Object.assign(new Error('Command failed: codex mcp list --json'), { stderr: '\nError loading config: invalid transport in `mcp_servers.codex_app`\n' });
  assert.throws(
    () => listMcpServers('researcher', () => { throw configError; }),
    /could not list the MCP servers for role researcher; no role was launched\. Codex said: Error loading config: invalid transport in `mcp_servers\.codex_app`$/,
  );
  // Without stderr the error's own message is the reason; a missing binary still reports ENOENT.
  assert.throws(
    () => listMcpServers('qa', () => { throw Object.assign(new Error('spawnSync codex ENOENT'), { stderr: '' }); }),
    /role qa[\s\S]*Codex said: spawnSync codex ENOENT/,
  );
  assert.throws(() => listMcpServers('qa', () => 'not json'), /role qa in an unreadable format/);
  assert.throws(() => listMcpServers('qa', () => '{}'), /role qa in an unexpected format/);
});

test('the launcher runs when started through a linked directory, instead of exiting silently (#45)', async t => {
  const { root } = sandbox(t);
  const real = join(root, 'real'), linked = join(root, 'linked');
  mkdirSync(real);
  writeFileSync(join(real, 'codex-role.mjs'), codexRoleLauncherSource());
  symlinkSync(real, linked, 'junction');
  const start = (script: string) => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script, 'no-such-role', '--task', 't'], { env: { ...process.env, CODEX_HOME: join(root, 'no-home') }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  });
  // An unknown role proves main() ran: it fails with exit 2 before any Codex process could start.
  for (const script of [join(real, 'codex-role.mjs'), join(linked, 'codex-role.mjs')]) {
    const result = await start(script);
    assert.equal(result.code, 2, script);
    assert.match(result.stderr, /Unknown role "no-such-role"/, script);
  }
  const moduleUrl = pathToFileURL(join(real, 'codex-role.mjs')).href;
  assert.equal(isEntryPoint(join(linked, 'codex-role.mjs'), moduleUrl), true);
  assert.equal(isEntryPoint(join(root, 'other.mjs'), moduleUrl), false);
  assert.equal(isEntryPoint(undefined, moduleUrl), false);
});

test('External launches only with a readable MCP selection from the install (#45)', async t => {
  const box = sandbox(t);
  mkdirSync(box.codex);
  writeFileSync(join(box.codex, 'config.toml'), '[mcp_servers.gh]\ncommand = "gh-mcp"\nenabled = true\n\n[mcp_servers.other]\ncommand = "other-mcp"\nenabled = true\n');
  const output: string[] = [];
  assert.equal(await installCodex({ scope: 'global', home: box.home, mode: 'role-processes', output: line => output.push(line), error() {}, ask: async question =>
    question.startsWith('Existing Codex MCP server') ? 'gh' : /model ID/.test(question) ? 'gpt-example' : /reasoning effort/.test(question) ? 'medium' : question.startsWith('Type install') ? 'install' : '' }), 0);
  assert.deepEqual(readSelectedMcpServers(box.codex), ['gh']);
  assert.match(output.join('\n'), /External may use only these MCP servers: gh\./);
  const config = readFileSync(join(box.codex, 'config.toml'), 'utf8');
  assert.match(config, /\[mcp_servers\.gh\]\ncommand = "gh-mcp"\nenabled = false/, 'stays off for Lead and the other roles');
  assert.match(config, /\[mcp_servers\.other\]\ncommand = "other-mcp"\nenabled = true/, 'an unselected server is not edited');
  assert.match(readFileSync(join(box.codex, 'AGENTS.md'), 'utf8'), /\| `external` \| danger-full-access \| unrestricted \| selected servers \|/);

  // Refused before any Codex process: no binary exists at CODEX_BIN, so reaching the listing would fail differently.
  const env = { CODEX_HOME: box.codex, CODEX_BIN: join(box.root, 'no-codex') };
  const state = join(box.codex, '.advanced-harness-state.json');
  const valid = readFileSync(state, 'utf8');
  for (const [text, expected] of [['not json', /Cannot read the selected MCP servers/], ['{}', /Malformed selectedMcpServers/], ['{"selectedMcpServers":[1]}', /Malformed selectedMcpServers/]] as const) {
    writeFileSync(state, text);
    assert.throws(() => launcherMain(['external', '--task', 't'], env), expected);
  }
  writeFileSync(state, valid);
  assert.throws(() => launcherMain(['external', '--task', 't'], env), /ENOENT/, 'a valid selection moves on to the listing, whose failure also stops the launch');
  rmSync(state);
  assert.throws(() => launcherMain(['reviewer', '--task', 't'], env), /ENOENT/, 'roles without MCP never read the selection');
});
