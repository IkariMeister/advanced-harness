import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compileCodexAgent, compileCodexMergeRule, diagnoseCodex, encodeCodexYamlScalar, installCodex, validateCodexToml } from '../src/codex-adapter.ts';
import { parseDocument } from 'yaml';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import { askHostSelection } from '../src/host-registry.ts';
import { saveInstallation } from '../src/native-installer.ts';

function roleAnswers(model: string, finalAnswer = 'install', reasoning = 'medium'): string[] {
  return ['', ...rolePairAnswers(model, reasoning), finalAnswer];
}
function rolePairAnswers(model: string, reasoning = 'medium'): string[] { return Array.from({ length: 8 }, () => [model, reasoning]).flat(); }

test('Codex skill YAML scalar roundtrips punctuation and embedded newlines', () => {
  for (const value of ['colon: # hash [brackets] "quotes" \'apostrophe\'', 'first line\nsecond: # line\nthird']) {
    const parsed = parseDocument(`description: ${encodeCodexYamlScalar(value)}\n`);
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.toJSON()?.description, value);
  }
});

test('Codex agent serializes only supported explicit role fields and validates TOML', () => {
  const text = compileCodexAgent('lead', 'gpt-example', 'high', 'Lead role', 'Ask the human before writes.');
  assert.match(text, /^name = "lead"/m);
  assert.match(text, /^model = "gpt-example"/m);
  assert.match(text, /^model_reasoning_effort = "high"/m);
  validateCodexToml(text);
  assert.throws(() => compileCodexAgent('lead', '', 'medium', 'x', 'y'));
  assert.throws(() => validateCodexToml('[duplicate]\nx = 1\n[duplicate]\ny = 2'));
  assert.throws(() => validateCodexToml('x = [not_toml]'));
  assert.throws(() => validateCodexToml('x = {broken}'));
  assert.throws(() => validateCodexToml('a = 1\n[a]'));
  for (const invalid of [
    'a = 1\na.b = 2',
    'a.b = 2\na = 1',
    'x = { a = 1, a.b = 2 }',
    'x = { a.b = 2, a = 1 }',
    'x = { a = { b = 1 }, a.c = 2 }',
  ]) assert.throws(() => validateCodexToml(invalid));
  for (const invalid of ['a. = 1', '[a.]', 'x = { a. = 1 }', 'x = { a .   = 1 }']) assert.throws(() => validateCodexToml(invalid));
  for (const valid of ['[a]\nb = 1\n[b]\nx = 2', 'a."b.c" = 1', 'x = { a."b.c" = 1 }']) validateCodexToml(valid);
  for (const unsafe of [
    'x = { __proto__.codexReviewProbe = 1 }',
    'x = { constructor.prototype.codexReviewProbe = 1 }',
  ]) {
    delete (Object.prototype as Record<string, unknown>).codexReviewProbe;
    validateCodexToml(unsafe);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'codexReviewProbe'), false);
    assert.equal(({} as Record<string, unknown>).codexReviewProbe, undefined);
  }
  assert.throws(() => validateCodexToml('[a]\nx = 1\n[a.x]'));
  for (const invalid of ['x = +0x1', 'x = -0b1', 'x = 01', 'x = 01.2', 'x = 01e2', 'x = 1_', 'x = 1__0', 'x = 0x_1']) assert.throws(() => validateCodexToml(invalid));
  for (const valid of ['x = 0x1', 'x = 0o7', 'x = 0b1', 'x = +0', 'x = -1', 'x = 1_000', 'x = 1.2', 'x = 1e2', 'x = 1.2e-2', 'x = { a = 1, b = { c = 2 } }']) validateCodexToml(valid);
  for (const valid of ['"quoted.key" = 1', "'literal.key' = 2", '["mcp_servers"."server.with.dot"]\nenabled = true', 'root = { "quoted.key" = 1 }']) validateCodexToml(valid);
  validateCodexToml('"literal.key" = 1\nliteral.key = 2');
  for (const valid of ['"equals=key" = "v=x"', '"escaped\\\"=key" = 2 # = in comment', '["mcp_servers"."a=b"]\n"enabled" = true # retained =']) validateCodexToml(valid);
  assert.throws(() => validateCodexToml('"literal.key" = 1\n"literal.key" = 2'));
  assert.throws(() => validateCodexToml('"unterminated = 1'));
  assert.match(compileCodexMergeRule(), /decision = "forbidden"/);
  assert.match(compileCodexMergeRule(), /indirect\/API routes are not blocked/);
});

test('Codex canonical merge block is added despite unowned lookalikes and replaces owned blocks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-rules-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const rules = join(project, '.codex', 'rules', 'advanced-harness.rules'); mkdirSync(join(project, '.codex', 'rules'), { recursive: true });
  writeFileSync(rules, '# user note: prefix_rule(pattern = ["gh", "pr", "merge"], decision = "prompt")\n');
  const answers = roleAnswers('model');
  await installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error() {} });
  const result = readFileSync(rules, 'utf8');
  assert.match(result, /pattern = \["gh", "pr", "merge"\], decision = "forbidden"/);
  assert.match(result, /pattern = \["gh\.exe", "pr", "merge"\], decision = "forbidden"/);
  assert.match(result, /# user note:/);
});

test('Codex cancellation creates no target files or backups; explicit choices install idempotently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-harness-'));
  const project = join(root, 'project'), home = join(root, 'home');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(project); mkdirSync(home);
  const answers = roleAnswers('gpt-example', 'cancel');
  const ask = async () => answers.shift() ?? '';
  const output: string[] = [];
  assert.equal(await installCodex({ scope: 'project', project, home, ask, output: value => output.push(value), error() {} }), 0);
  assert.equal(existsSync(join(project, '.codex')), false);
  assert.equal(existsSync(join(home, 'Projects', 'advanced-harness-backups')), false);

  const installAnswers = roleAnswers('gpt-example');
  assert.equal(await installCodex({ scope: 'project', project, home, ask: async () => installAnswers.shift() ?? '', output: value => output.push(value), error() {} }), 0);
  assert.equal(readFileSync(join(project, '.codex', 'agents', 'lead.toml'), 'utf8').includes('gpt-example'), true);
  assert.equal((await diagnoseCodex({ project, home })).ok, true);
  const rerunAnswers = roleAnswers('gpt-example');
  assert.equal(await installCodex({ scope: 'project', project, home, ask: async () => rerunAnswers.shift() ?? '', output: value => output.push(value), error() {} }), 0);
  assert.equal(readdirSync(join(project, '.codex', 'agents')).length, 8);
  const receipts = readdirSync(join(home, 'Projects', 'advanced-harness-backups')).filter(name => name.startsWith('native-install-'));
  assert.equal(receipts.length, 1, 'idempotent update must not churn its host-scoped receipt');
});

test('Codex MCP changes require actual selected IDs/tools, disable routes, and preserve unrelated TOML', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-mcp-'));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project); mkdirSync(home);
  const configDir = join(project, '.codex'); mkdirSync(configDir);
  writeFileSync(join(configDir, 'config.toml'), 'model = "existing-model"\n\n[mcp_servers.real_server]\nenabled = true\nrequired = true\ncommand = "real-mcp"\nargs = ["--safe"]\n\n  [mcp_servers.unselected] # indented table header\nenabled = true\n\n  [mcp_servers.unselected.tools.some_tool]\napproval_mode = "auto"\n');
  const answers = ['real_server', 'merge_tool', ...rolePairAnswers('custom/model', 'low'), 'install'];
  const result = await installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error() {} });
  assert.equal(result, 0);
  const saved = readFileSync(join(configDir, 'config.toml'), 'utf8');
  assert.match(saved, /^sandbox_mode = "read-only"/m);
  assert.match(saved, /^approval_policy = "on-request"/m);
  assert.match(saved, /model = "existing-model"/);
  const selectedSection = saved.split('[mcp_servers.unselected]')[0]!;
  const unselectedSection = saved.split('[mcp_servers.unselected]')[1]!;
  assert.match(selectedSection, /enabled = false/);
  assert.match(selectedSection, /disabled_tools = \["merge_tool"\]/);
  assert.match(unselectedSection, /enabled = true/);
  assert.doesNotMatch(unselectedSection, /disabled_tools/);
  assert.match(saved, /command = "real-mcp"/);
  assert.match(saved, /required = true/);
  assert.doesNotMatch(selectedSection, /approval_mode/);
  assert.match(unselectedSection, /approval_mode = "auto"/);
  const report = await diagnoseCodex({ project, home });
  assert.equal(report.ok, true, report.issues.join('; '));
});

test('Codex quoted MCP identity edits preserve CRLF, comments, and blank lines', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-quoted-mcp-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const configDir = join(project, '.codex'); mkdirSync(configDir);
  const source = '# preserved\r\n"literal.key" = true\r\n\r\n[mcp_servers."server.with.dot"] # server comment\r\n# before enabled\r\nenabled = true # keep comment\r\n\r\n[mcp_servers.other]\r\nenabled = true\r\n';
  writeFileSync(join(configDir, 'config.toml'), source);
  const answers = ['server.with.dot', 'tool.name', ...rolePairAnswers('model'), 'install'];
  await installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error() {} });
  const saved = readFileSync(join(configDir, 'config.toml'), 'utf8');
  assert.ok(saved.includes('# before enabled\r\nenabled = false # keep comment\r\n'));
  assert.ok(saved.includes('\r\n\r\n[mcp_servers.other]'));
  assert.ok(saved.includes('disabled_tools = ["tool.name"]\r\n'));
  assert.ok(saved.includes('# preserved\r\n'));
});

test('Codex selected MCP routes with basic- and literal-quoted enabled keys are actually disabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-quoted-enabled-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const configDir = join(project, '.codex'); mkdirSync(configDir);
  writeFileSync(join(configDir, 'config.toml'), '[mcp_servers."basic"]\n"enabled" = true\n[mcp_servers.\'literal\']\n\'enabled\' = true\n');
  const answers = ['basic, literal', '', '', ...rolePairAnswers('model'), 'install'];
  await installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error() {} });
  const config = readFileSync(join(configDir, 'config.toml'), 'utf8');
  assert.match(config, /"enabled" = false/);
  assert.match(config, /'enabled' = false/);
});

test('Codex baseline insertion retains exact original CRLF root/table bytes and uses CRLF additions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-baseline-crlf-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const configDir = join(project, '.codex'); mkdirSync(configDir);
  const before = '# original comment\r\nroot = "keep"\r\n\r\n[mcp_servers.server]\r\nenabled = true\r\n';
  writeFileSync(join(configDir, 'config.toml'), before);
  const answers = ['', ...rolePairAnswers('model'), 'install'];
  await installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error() {} });
  const expected = '# original comment\r\nroot = "keep"\r\n\r\nsandbox_mode = "read-only"\r\n\r\napproval_policy = "on-request"\r\n\r\n[mcp_servers.server]\r\nenabled = true\r\n';
  assert.equal(readFileSync(join(configDir, 'config.toml'), 'utf8'), expected);
});

test('Codex MCP additions preserve trailing bytes and disabled-tools unions idempotently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-tools-union-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const configDir = join(project, '.codex'); mkdirSync(configDir);
  const source = '[mcp_servers.server]\r\ndisabled_tools = ["old"] # keep\r\n\r\n';
  writeFileSync(join(configDir, 'config.toml'), source);
  const run = async () => { const answers = ['server', 'new', ...rolePairAnswers('model'), 'install']; await installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error() {} }); };
  await run();
  const once = readFileSync(join(configDir, 'config.toml'), 'utf8');
  assert.match(once, /disabled_tools = \["old", "new"\] # keep\r\n/);
  assert.ok(once.endsWith('\r\n\r\n'));
  await run();
  assert.equal(readFileSync(join(configDir, 'config.toml'), 'utf8'), once);
});

test('Codex malformed role TOML prompts explicit assignments and preserves exact bytes by default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-malformed-role-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const rolePath = join(project, '.codex', 'agents', 'lead.toml'); mkdirSync(dirname(rolePath), { recursive: true });
  const original = 'developer_instructions = """\ncustom\ntext\n"""\r\n'; writeFileSync(rolePath, original);
  const answers = ['', ...rolePairAnswers('explicit/model')]; let consentAsked = false;
  await installCodex({ scope: 'project', project, home, ask: async question => { if (question.includes('Overwrite customized')) { consentAsked = true; return 'no'; } return answers.shift() ?? 'install'; }, output() {}, error() {} });
  assert.equal(consentAsked, true);
  assert.equal(readFileSync(rolePath, 'utf8'), original);
  const configPath = join(project, '.codex', 'config.toml');
  assert.ok(existsSync(configPath), 'unsupported multiline config remains fail-closed only when config itself uses it');
});

test('Codex Enter defaults preserve role and MCP choices; dash clears tracking without enabling routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-defaults-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const configDir = join(project, '.codex'); mkdirSync(configDir);
  writeFileSync(join(configDir, 'config.toml'), '[mcp_servers.selected]\nenabled = true\n');
  const initial = ['selected', 'tool_x', ...rolePairAnswers('chosen/model', 'high'), 'install'];
  await installCodex({ scope: 'project', project, home, ask: async () => initial.shift() ?? '', output() {}, error() {} });
  const beforeRole = readFileSync(join(configDir, 'agents', 'lead.toml'), 'utf8');
  const update = ['-', ...rolePairAnswers('', ''), 'install'];
  await installCodex({ scope: 'project', project, home, ask: async () => update.shift() ?? '', output() {}, error() {} });
  assert.equal(readFileSync(join(configDir, 'agents', 'lead.toml'), 'utf8'), beforeRole);
  const config = readFileSync(join(configDir, 'config.toml'), 'utf8');
  assert.match(config, /enabled = false/);
  assert.match(config, /disabled_tools = \["tool_x"\]/);
  const state = JSON.parse(readFileSync(join(configDir, '.advanced-harness-state.json'), 'utf8')) as { selectedMcpServers: string[]; disabledTools: Record<string, string[]> };
  assert.deepEqual(state.selectedMcpServers, []);
  assert.deepEqual(state.disabledTools, {});
});

test('Codex invalid required model and effort answers retry in the interactive adapter flow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-retry-required-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const answers = ['', '\n', 'fixed/model', 'unsupported', 'high', ...rolePairAnswers('fixed/model', 'medium').slice(2), 'install'];
  const output: string[] = [];
  const result = await installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output: message => output.push(message), error() {} });
  assert.equal(result, 0);
  assert.match(readFileSync(join(project, '.codex', 'agents', 'lead.toml'), 'utf8'), /model = "fixed\/model"/);
  assert.match(readFileSync(join(project, '.codex', 'agents', 'lead.toml'), 'utf8'), /model_reasoning_effort = "high"/);
  assert.ok(output.some(message => message.includes('Enter a valid explicit model ID')));
  assert.ok(output.some(message => message.includes('supported reasoning efforts')));
});

test('Codex required assignments stop after three invalid attempts and preserve targets', async () => {
  for (const invalid of ['model', 'effort'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'codex-attempt-limit-'));
    const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
    const answers = invalid === 'model' ? ['', '-', '-', '-', ...rolePairAnswers('valid/model').slice(2)] : ['', 'valid/model', '', '', ''];
    let calls = 0;
    await assert.rejects(installCodex({ scope: 'project', project, home, ask: async () => { calls++; return answers.shift() ?? ''; }, output() {}, error() {} }), /3 attempts/);
    assert.equal(calls, invalid === 'model' ? 4 : 5, 'MCP prompts precede the three invalid required answers');
    assert.equal(existsSync(join(project, '.codex')), false);
    assert.equal(existsSync(join(home, 'Projects', 'advanced-harness-backups')), false);
  }
});

test('Codex custom role preservation and explicit overwrite and independent doctor findings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-custom-role-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const rolePath = join(project, '.codex', 'agents', 'lead.toml'); mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
  writeFileSync(rolePath, 'name = "lead"\ndescription = "custom"\n');
  const existing = ['', ...rolePairAnswers('new/model'), 'no', 'install'];
  await installCodex({ scope: 'project', project, home, ask: async () => existing.shift() ?? '', output() {}, error() {} });
  assert.match(readFileSync(rolePath, 'utf8'), /description = "custom"/);
  const doctor = await diagnoseCodex({ project, home });
  assert.ok(doctor.issues.some(issue => issue.includes('Missing Codex agent definition')) || doctor.issues.some(issue => issue.includes('lacks required explicit')));
});

test('Codex explicit customized role overwrite updates the role while preserving shared skill', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-custom-overwrite-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const rolePath = join(project, '.codex', 'agents', 'lead.toml'); mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
  writeFileSync(rolePath, 'name = "lead"\ndescription = "custom"\n');
  const sharedSkill = join(project, '.agents', 'skills', 'start-issue', 'SKILL.md'); mkdirSync(join(project, '.agents', 'skills', 'start-issue'), { recursive: true });
  writeFileSync(sharedSkill, 'other-host owns this skill');
  const answers = ['', ...rolePairAnswers('new/model'), 'yes', 'install'];
  await installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error() {} });
  assert.match(readFileSync(rolePath, 'utf8'), /model = "new\/model"/);
  assert.equal(readFileSync(sharedSkill, 'utf8'), 'other-host owns this skill');
});

test('Codex doctor independently reports missing roles, missing rules, and selected MCP tampering', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-independent-doctor-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const codex = join(project, '.codex'); mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, 'config.toml'), 'sandbox_mode = "read-only"\napproval_policy = "on-request"\n');
  writeFileSync(join(codex, '.advanced-harness-state.json'), JSON.stringify({ selectedMcpServers: ['selected'], disabledTools: {} }));
  const report = await diagnoseCodex({ project, home });
  assert.ok(report.issues.some(issue => issue.includes('Missing Codex agent definition')));
  assert.ok(report.issues.some(issue => issue.includes('Missing Codex direct merge rule')));
  assert.ok(report.issues.some(issue => issue.includes('not disabled pending validation')));
});

test('Codex closed required prompts abort without spinning or writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-prompt-close-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  await assert.rejects(installCodex({ scope: 'project', project, home, ask: async () => { throw new Error('closed'); }, output() {}, error() {} }), /rejected or closed/);
  assert.equal(existsSync(join(project, '.codex')), false);
  assert.equal(existsSync(join(home, 'Projects', 'advanced-harness-backups')), false);
});

test('Codex doctor fails closed on malformed TOML and MCP route remains disabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-doctor-'));
  const codex = join(root, '.codex');
  const { mkdirSync } = await import('node:fs'); mkdirSync(codex);
  writeFileSync(join(codex, 'config.toml'), 'not valid toml');
  const report = await diagnoseCodex({ project: root, home: root });
  assert.equal(report.ok, false);
  assert.match(report.issues.join(' '), /Malformed|Unsupported/);
});

test('Codex doctor reports independent rules when its state manifest is invalid', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-doctor-independent-'));
  const codex = join(root, '.codex'); mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, 'config.toml'), 'sandbox_mode = "read-only"\napproval_policy = "on-request"\n');
  writeFileSync(join(codex, '.advanced-harness-state.json'), '{invalid');
  const report = await diagnoseCodex({ project: root, home: root });
  assert.ok(report.issues.some(issue => issue.includes('Malformed Codex harness state manifest')));
  assert.ok(report.issues.some(issue => issue.includes('Missing Codex direct merge rule')));
});

test('Codex doctor ignores commented/string merge-rule lookalikes for both executables', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-doctor-rule-lookalike-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const answers = roleAnswers('doctor-model');
  await installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error() {} });
  const rules = join(project, '.codex', 'rules', 'advanced-harness.rules');
  writeFileSync(rules, [
    '# prefix_rule(pattern = ["gh", "pr", "merge"], decision = "forbidden")',
    'example = "prefix_rule(pattern = [\\"gh.exe\\", \\"pr\\", \\"merge\\"], decision = \\"forbidden\\")"',
    'example = """documentation for gh rule:',
    'prefix_rule(pattern = ["gh", "pr", "merge"], decision = "forbidden")',
    '"""',
    "example = '''documentation for gh.exe rule:",
    'prefix_rule(pattern = ["gh.exe", "pr", "merge"], decision = "forbidden")',
    "'''",
    'example = "escaped delimiter: \\" and rule text prefix_rule(pattern = [\"gh.exe\", \"pr\", \"merge\"], decision = \"forbidden\")"',
    'False and prefix_rule(pattern = ["gh", "pr", "merge"], decision = "forbidden")',
    'prefix_rule(pattern = ["gh.exe", "pr", "merge"], decision = "forbidden") and False',
    'if False: prefix_rule(pattern = ["gh", "pr", "merge"], decision = "forbidden")',
    'assigned = prefix_rule(pattern = ["gh.exe", "pr", "merge"], decision = "forbidden")',
    'if False:',
    '  prefix_rule(pattern = ["gh", "pr", "merge"], decision = "forbidden")',
    'def nested():',
    '  prefix_rule(pattern = ["gh.exe", "pr", "merge"], decision = "forbidden")',
    'wrapped = (',
    'prefix_rule(pattern = ["gh", "pr", "merge"], decision = "forbidden")',
    ')',
    'False and \\',
    'prefix_rule(pattern = ["gh.exe", "pr", "merge"], decision = "forbidden")',
  ].join('\n') + '\n');
  const report = await diagnoseCodex({ project, home });
  assert.ok(report.issues.some(issue => issue.includes('Codex direct gh pr merge rules are missing or malformed')));

  writeFileSync(rules, 'prefix_rule(pattern = ["gh", "pr", "merge"], decision = "forbidden")\nprefix_rule(pattern = ["gh.exe", "pr", "merge"], decision = "forbidden")\n');
  const active = await diagnoseCodex({ project, home });
  assert.equal(active.issues.some(issue => issue.includes('Codex direct gh pr merge rules are missing or malformed')), false);
});

test('Codex rejects malformed supported-subset TOML before prompts, backups, receipts, or writes', async () => {
  for (const invalid of [
    'x = [not_toml]\n', 'x = {broken}\n', 'a = 1\n[a]\n',
    'a = 1\na.b = 2\n', 'a.b = 2\na = 1\n', 'x = { a = 1, a.b = 2 }\n',
    'x = +0x1\n', 'x = 01.2\n',
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'codex-invalid-'));
    const project = join(root, 'project'), home = join(root, 'home');
    const { mkdirSync } = await import('node:fs'); mkdirSync(project); mkdirSync(home);
    const configDir = join(project, '.codex'); mkdirSync(configDir);
    const configPath = join(configDir, 'config.toml'); writeFileSync(configPath, invalid);
    let prompts = 0;
    await assert.rejects(installCodex({ scope: 'project', project, home, ask: async () => { prompts++; return 'install'; }, output() {}, error() {} }));
    assert.equal(prompts, 0);
    assert.equal(readFileSync(configPath, 'utf8'), invalid);
    assert.equal(existsSync(join(home, 'Projects', 'advanced-harness-backups')), false);
  }
});

test('actual installer flow routes Codex selection and cancellation leaves no artifacts, backups, or receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-flow-'));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project); mkdirSync(home);
  const answers = roleAnswers('gpt-explicit', 'no');
  const output: string[] = [];
  const status = await runInstallerFlow({ host: 'codex', scope: 'project', project }, {
    ask: async () => answers.shift() ?? '', output: message => output.push(message), error: message => output.push(message), cwd: root, home,
  });
  assert.equal(status, 0);
  assert.equal(existsSync(join(project, '.codex')), false);
  assert.equal(existsSync(join(home, 'Projects', 'advanced-harness-backups')), false);
  assert.ok(output.some(line => line.includes('Cancelled.')));
});

test('Codex installer and updater route both project and global scopes to their separate targets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-routing-'));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project); mkdirSync(home);
  const runInstall = (scope: 'project' | 'global', model: string) => {
    const answers = roleAnswers(model);
    return runInstallerFlow({ host: 'codex', scope, ...(scope === 'project' ? { project } : {}) }, {
      ask: async () => answers.shift() ?? '', output() {}, error() {}, cwd: root, home,
    });
  };
  const runUpdate = (scope: 'project' | 'global', model: string) => {
    const answers = roleAnswers(model);
    return runUpdateFlow({ host: 'codex', scope, ...(scope === 'project' ? { project } : {}) }, {
      ask: async () => answers.shift() ?? '', output() {}, error() {}, cwd: root, home,
    });
  };
  assert.equal(await runInstall('project', 'project-model'), 0);
  const enterDefaults = ['', ...rolePairAnswers('', ''), 'install'];
  assert.equal(await runUpdateFlow({ host: 'codex', scope: 'project', project }, {
    ask: async () => enterDefaults.shift() ?? '', output() {}, error() {}, cwd: root, home,
  }), 0, 'blank answers on the actual Codex update flow preserve installed model/effort values');
  assert.match(readFileSync(join(project, '.codex', 'agents', 'lead.toml'), 'utf8'), /model = "project-model"/);
  assert.equal(await runUpdate('project', 'project-updated-model'), 0);
  assert.equal(await runInstall('global', 'global-model'), 0);
  assert.equal(await runUpdate('global', 'global-updated-model'), 0);
  assert.match(readFileSync(join(project, '.codex', 'agents', 'lead.toml'), 'utf8'), /project-updated-model/);
  assert.match(readFileSync(join(home, '.codex', 'agents', 'lead.toml'), 'utf8'), /global-updated-model/);
  assert.equal(existsSync(join(project, '.codex', '.advanced-harness-state.json')), true);
  assert.equal(existsSync(join(home, '.codex', '.advanced-harness-state.json')), true);
});

test('customized Codex roles and shared skills default to preserve; AGENTS is never modified', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-preserve-'));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project); mkdirSync(home);
  const rolePath = join(project, '.codex', 'agents', 'lead.toml');
  const skillPath = join(project, '.agents', 'skills', 'start-issue', 'SKILL.md');
  const agentsPath = join(project, 'AGENTS.md');
  mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
  mkdirSync(join(project, '.agents', 'skills', 'start-issue'), { recursive: true });
  const customRole = 'name = "lead"\n# customized role remains user-owned\n';
  const customSkill = '---\nname: start-issue\ndescription: My customized skill\n---\nKeep this skill.\n';
  const projectInstructions = '# Existing project workflow\nLeave every byte intact.\n';
  writeFileSync(rolePath, customRole); writeFileSync(skillPath, customSkill); writeFileSync(agentsPath, projectInstructions);
  const answers = ['', ...rolePairAnswers('chosen-model'), 'no', 'install'];
  const output: string[] = [];
  const status = await installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output: value => output.push(value), error() {} });
  assert.equal(status, 1, 'preserving a required role file leaves installation explicitly incomplete');
  assert.equal(readFileSync(rolePath, 'utf8'), customRole);
  assert.equal(readFileSync(skillPath, 'utf8'), customSkill);
  assert.equal(readFileSync(agentsPath, 'utf8'), projectInstructions);
  assert.ok(output.some(line => line.includes('preserved: lead')));
  const receiptName = readdirSync(join(home, 'Projects', 'advanced-harness-backups')).find(name => name.startsWith('native-install-'))!;
  const receipt = JSON.parse(readFileSync(join(home, 'Projects', 'advanced-harness-backups', receiptName), 'utf8')) as { managedFiles: Array<{ path: string }> };
  assert.equal(receipt.managedFiles.some(item => item.path === rolePath || item.path === skillPath || item.path === agentsPath), false);
});

test('Codex requires consent for customized instructions while valid preserved profiles remain doctor-compatible', async () => {
  for (const consent of ['no', 'yes']) {
    const root = mkdtempSync(join(tmpdir(), `codex-instructions-consent-${consent}-`));
    const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
    const rolePath = join(project, '.codex', 'agents', 'lead.toml'); mkdirSync(dirname(rolePath), { recursive: true });
    const generated = compileCodexAgent('lead', 'profile-model', 'medium', 'Canonical lead description', 'Canonical lead instructions');
    const edited = generated.replace('developer_instructions = "Canonical lead instructions"', 'developer_instructions = "custom lead instructions"');
    writeFileSync(rolePath, edited);
    const answers = ['', ...rolePairAnswers('profile-model')];
    let overwriteAsked = false;
    const status = await installCodex({ scope: 'project', project, home, ask: async question => {
      if (question.includes('Overwrite customized/unowned Codex agent')) { overwriteAsked = true; return consent; }
      if (question.includes('Type install')) return 'install';
      return answers.shift() ?? '';
    }, output() {}, error() {} });
    assert.equal(overwriteAsked, true);
    if (consent === 'no') {
      assert.equal(status, 0);
      assert.equal(readFileSync(rolePath, 'utf8'), edited);
      assert.equal((await diagnoseCodex({ project, home })).ok, true);
    } else {
      assert.equal(status, 0);
      assert.notEqual(readFileSync(rolePath, 'utf8'), edited);
      assert.doesNotMatch(readFileSync(rolePath, 'utf8'), /custom lead instructions/);
    }
  }
});

test('Codex declining an invalid customized required role reports incomplete installation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-invalid-preserved-role-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const rolePath = join(project, '.codex', 'agents', 'lead.toml'); mkdirSync(dirname(rolePath), { recursive: true });
  const invalidRole = 'name = "lead"\ndescription = "custom"\n'; writeFileSync(rolePath, invalidRole);
  const answers = ['', ...rolePairAnswers('valid/model')];
  const status = await installCodex({ scope: 'project', project, home, ask: async question => {
    if (question.includes('Overwrite customized/unowned Codex agent')) return 'no';
    if (question.includes('Type install')) return 'install';
    return answers.shift() ?? '';
  }, output() {}, error() {} });
  assert.equal(status, 1);
  assert.equal(readFileSync(rolePath, 'utf8'), invalidRole);
});

test('Codex confirmation-time config drift is refused before backup or receipt creation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-drift-'));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project); mkdirSync(home);
  const configDir = join(project, '.codex'); mkdirSync(configDir);
  const configPath = join(configDir, 'config.toml');
  const original = 'model = "original-model"\n'; writeFileSync(configPath, original);
  const answers = roleAnswers('drift-model');
  let changed = false;
  await assert.rejects(installCodex({ scope: 'project', project, home, ask: async question => {
    const answer = answers.shift() ?? '';
    if (question.includes('Type install')) { writeFileSync(configPath, 'model = "concurrent-user-model"\n'); changed = true; return 'install'; }
    return answer;
  }, output() {}, error() {} }), /changed while confirmation was open/);
  assert.equal(changed, true);
  assert.equal(readFileSync(configPath, 'utf8'), 'model = "concurrent-user-model"\n');
  assert.equal(existsSync(join(project, '.codex', 'agents', 'lead.toml')), false);
  assert.equal(existsSync(join(home, 'Projects', 'advanced-harness-backups')), false);
});

test('Codex partial file failure restores verified prior state and clears pending evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-partial-'));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project); mkdirSync(home);
  let saves = 0;
  const save = (...args: Parameters<typeof saveInstallation>) => {
    saves++;
    if (saves === 2) throw new Error('injected second-file failure');
    return saveInstallation(...args);
  };
  const errors: string[] = [];
  const answers = roleAnswers('partial-model');
  await assert.rejects(installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error: message => errors.push(message), save }), /injected second-file failure/);
  assert.equal(existsSync(join(project, '.codex', 'config.toml')), false);
  assert.equal(existsSync(join(project, '.codex', 'agents', 'lead.toml')), false);
  const recovery = join(home, 'Projects', 'advanced-harness-backups');
  assert.equal(readdirSync(recovery).some(name => name.startsWith('native-install-')), false);
  assert.equal(errors.some(message => message.includes('pending recovery evidence retained')), false);
});

test('Codex write-then-throw failures at early and manifest stages roll back only verified writes', async () => {
  for (const failureAt of [1, 17]) {
    const root = mkdtempSync(join(tmpdir(), `codex-write-throw-${failureAt}-`));
    const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
    let writes = 0;
    const save = (...args: Parameters<typeof saveInstallation>) => {
      const backup = saveInstallation(...args);
      if (++writes === failureAt) throw new Error(`write then throw ${failureAt}`);
      return backup;
    };
    const answers = roleAnswers('throw-model');
    await assert.rejects(installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error() {}, save }), /write then throw/);
    assert.equal(existsSync(join(project, '.codex', 'config.toml')), false);
    assert.equal(existsSync(join(project, '.codex', '.advanced-harness-state.json')), false);
    const recovery = join(home, 'Projects', 'advanced-harness-backups');
    assert.equal(readdirSync(recovery).some(name => name.startsWith('native-install-')), false);
  }
});

test('Codex rollback preserves divergent concurrent content and retains pending evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-divergent-rollback-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const configPath = join(project, '.codex', 'config.toml');
  let writes = 0;
  const save = (...args: Parameters<typeof saveInstallation>) => {
    if (++writes === 2) throw new Error('injected later failure');
    const backup = saveInstallation(...args);
    writeFileSync(configPath, '# concurrent edit wins\n');
    return backup;
  };
  const errors: string[] = [];
  const answers = roleAnswers('divergent-model');
  await assert.rejects(installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error: message => errors.push(message), save }), /injected later failure/);
  assert.equal(readFileSync(configPath, 'utf8'), '# concurrent edit wins\n');
  assert.ok(errors.some(message => message.includes('rollback was incomplete')));
  const recovery = join(home, 'Projects', 'advanced-harness-backups');
  assert.ok(readdirSync(recovery).some(name => name.startsWith('native-install-')));
});

test('Codex rollback retains evidence when a backup changes after creation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-changed-backup-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const config = join(project, '.codex', 'config.toml'); mkdirSync(join(project, '.codex'));
  writeFileSync(config, 'sandbox_mode = "workspace-write"\n');
  let saves = 0;
  const save = (...args: Parameters<typeof saveInstallation>) => {
    const backup = saveInstallation(...args);
    if (++saves === 1) { if (backup) writeFileSync(backup, 'concurrent replacement\n'); throw new Error('injected failure after changed backup'); }
    return backup;
  };
  const errors: string[] = [];
  const answers = roleAnswers('changed-backup');
  await assert.rejects(installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error: message => errors.push(message), save }), /injected failure/);
  assert.equal(readFileSync(config, 'utf8'), 'sandbox_mode = "workspace-write"\n');
  assert.ok(errors.some(message => message.includes('cleanup was incomplete')));
  const recovery = join(home, 'Projects', 'advanced-harness-backups');
  assert.ok(readdirSync(recovery).some(name => name.startsWith('native-install-')));
});

test('Codex returned backup is tracked without callback and duplicate callback/return is deduplicated', async () => {
  for (const duplicate of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'codex-returned-backup-'));
    const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
    const config = join(project, '.codex', 'config.toml'); mkdirSync(dirname(config), { recursive: true }); writeFileSync(config, 'sandbox_mode = "workspace-write"\n');
    let called = 0;
    const save = (...args: Parameters<typeof saveInstallation>) => {
      called++;
      const [path, before, content, parent, onBackup, onDirectory] = args;
      const backup = saveInstallation(path, before, content, parent, duplicate ? onBackup : undefined, duplicate ? onDirectory : undefined);
      if (called === 2) throw new Error('injected after write with returned backup');
      return backup;
    };
    const answers = roleAnswers('returned-model');
    await assert.rejects(installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error() {}, save }), /injected after write with returned backup/);
    const recovery = join(home, 'Projects', 'advanced-harness-backups');
      assert.equal(existsSync(recovery) ? readdirSync(recovery).some(name => name.startsWith('native-install-')) : false, false);
  }
});

test('Codex rollback preserves concurrent files in transaction-created directories and pending evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-concurrent-dir-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const config = join(project, '.codex', 'config.toml'); mkdirSync(join(project, '.codex'));
  writeFileSync(config, 'sandbox_mode = "workspace-write"\n');
  let saves = 0;
  const save = (...args: Parameters<typeof saveInstallation>) => {
    const backup = saveInstallation(...args);
    if (++saves === 1) { if (backup) writeFileSync(join(dirname(backup), 'concurrent.txt'), 'keep me'); throw new Error('injected failure with concurrent backup sibling'); }
    return backup;
  };
  const errors: string[] = [];
  const answers = roleAnswers('concurrent-dir');
  await assert.rejects(installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error: message => errors.push(message), save }), /injected failure/);
  const recovery = join(home, 'Projects', 'advanced-harness-backups');
  const children = readdirSync(recovery).filter(name => !name.startsWith('native-install-'));
  const transactionDir = join(recovery, children[0]!);
  assert.equal(readFileSync(join(transactionDir, 'concurrent.txt'), 'utf8'), 'keep me');
  assert.ok(errors.some(message => message.includes('cleanup was incomplete')));
  assert.ok(readdirSync(recovery).some(name => name.startsWith('native-install-')));
});

test('CLI-used host selection retries; Enter defaults scope/project and cancels without writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-prompt-flow-'));
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const answers = ['unknown-host', 'codex', 'invalid-scope', '', '', '', ...rolePairAnswers('explicit-model'), ''];
  const ask = async () => answers.shift() ?? '';
  const hosts = await askHostSelection(ask, 'opencode');
  const output: string[] = [];
  const status = await runInstallerFlow({ host: hosts.join(',') }, { ask, output: message => output.push(message), error: message => output.push(message), cwd: root, home });
  assert.equal(status, 0);
  assert.ok(output.some(line => line.includes('Cancelled. No files, backups, or receipts were written.')));
  assert.equal(existsSync(join(root, '.codex')), false);
  assert.equal(existsSync(join(home, 'Projects', 'advanced-harness-backups')), false);
});
