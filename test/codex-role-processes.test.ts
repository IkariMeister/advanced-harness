import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnoseCodex, disableMultiAgent, installCodex, validateCodexToml } from '../src/codex-adapter.ts';
import { codexChildRoles, codexRoleLauncherSource, codexRolePolicies, compileCodexRoleProfile, compileCodexRoleStatusSchema, mergeCodexLeadBlock } from '../src/codex-role-processes.ts';
import { buildRoleInvocation, main as launcherMain, parseProfile, securityKeys } from '../src/codex-role-launcher.mjs';
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

test('role sandbox, network and MCP are derived from the role sources (#45)', () => {
  assert.deepEqual(policies, {
    operator: { sandbox: 'workspace-write', network: false, mcp: false },
    external: { sandbox: 'workspace-write', network: true, mcp: true },
    researcher: { sandbox: 'read-only', network: false, mcp: false },
    planner: { sandbox: 'read-only', network: false, mcp: false },
    implementer: { sandbox: 'workspace-write', network: false, mcp: false },
    reviewer: { sandbox: 'read-only', network: false, mcp: false },
    qa: { sandbox: 'read-only', network: false, mcp: false },
  });
});

test('role profiles are valid TOML that the launcher can re-apply key by key', () => {
  for (const role of codexChildRoles) {
    const text = compileCodexRoleProfile(role, policies[role], 'gpt-example', 'high', definitions[role].instructions);
    validateCodexToml(text, `${role} profile`);
    const parsed = parseProfile(text);
    for (const key of securityKeys) assert.ok(parsed.has(key), `${role}: ${key}`);
    assert.equal(parsed.get('approval_policy'), '"never"');
    assert.equal(parsed.get('sandbox_mode'), JSON.stringify(policies[role].sandbox));
  }
});

test('launcher re-applies role settings on launch and resume and switches MCP off unless allowed', () => {
  const profileText = compileCodexRoleProfile('reviewer', policies.reviewer, 'gpt-example', 'high', 'Review.');
  const base = { role: 'reviewer', profileText, mcpServers: ['github', 'my server'], mcpAllowed: false, task: 'Review the diff', schemaPath: 's.json', resultPath: 'r.json' };
  const launch = buildRoleInvocation(base);
  assert.deepEqual(launch.slice(0, 3), ['-p', 'harness-reviewer', 'exec']);
  assert.ok(launch.includes('sandbox_mode="read-only"'));
  assert.ok(launch.includes('approval_policy="never"'));
  assert.ok(launch.includes('sandbox_workspace_write.network_access=false'));
  assert.ok(launch.includes('mcp_servers.github.enabled=false'));
  assert.ok(launch.includes('mcp_servers."my server".enabled=false'));
  assert.deepEqual(launch.slice(-1), ['Review the diff']);

  const resume = buildRoleInvocation({ ...base, resumeId: 'thread-1', task: 'Continue' });
  assert.deepEqual(resume.slice(0, 2), ['exec', 'resume']);
  assert.ok(!resume.includes('-p'), 'resume has no -p; every setting comes from -c');
  assert.ok(resume.includes('sandbox_mode="read-only"'), 'resume cannot fall back to the base sandbox');
  assert.deepEqual(resume.slice(-2), ['thread-1', 'Continue']);

  const external = buildRoleInvocation({ ...base, role: 'external', profileText: compileCodexRoleProfile('external', policies.external, 'm', 'low', 'x'), mcpAllowed: true });
  assert.ok(!external.some(arg => arg.startsWith('mcp_servers.')), 'External keeps the configured MCP servers');
});

test('launcher refuses Lead, empty tasks, incomplete profiles and unknown roles', () => {
  const profileText = compileCodexRoleProfile('qa', policies.qa, 'm', 'low', 'x');
  const base = { role: 'qa', profileText, mcpServers: [], mcpAllowed: false, task: 't', schemaPath: 's', resultPath: 'r' };
  assert.throws(() => buildRoleInvocation({ ...base, role: 'lead' }), /Not a launchable role/);
  assert.throws(() => buildRoleInvocation({ ...base, task: '  ' }), /task is required/);
  assert.throws(() => buildRoleInvocation({ ...base, profileText: 'model = "m"\n' }), /lacks sandbox_mode/);
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
  const config = readFileSync(join(codex, 'config.toml'), 'utf8');
  assert.match(config, /sandbox_mode = "read-only"/);
  assert.match(config, /approval_policy = "on-request"/);
  assert.match(config, /\[features\]\r?\nmulti_agent = false/);
  assert.ok(output.some(line => /you approve every launch/.test(line)));

  const doctor = await diagnoseCodex({ home });
  assert.equal(doctor.ok, true, doctor.issues.join('\n'));
  assert.ok(doctor.notes.some(note => /Role-process mode/.test(note)));

  const receipts = () => readdirSync(join(home, 'Projects', 'advanced-harness-backups')).filter(name => name.startsWith('native-install-')).length;
  const before = receipts();
  assert.equal(await run(home, answers('gpt-example')), 0);
  assert.equal(receipts(), before, 'repeated identical install writes no new receipt');
});

test('doctor reports a widened role profile and re-enabled multi_agent', async t => {
  const { home, codex } = sandbox(t);
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
