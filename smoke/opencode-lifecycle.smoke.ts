// SMK-OC: OpenCode install → doctor → deploy-prompts → update → uninstall in an isolated home.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { createSandbox, realHomeFingerprintOf, tree, type Sandbox } from './support/sandbox.ts';
import { ask, openCodeInstall, roles } from './support/steps.ts';

const commands = ['address-pr-feedback', 'assess-debt', 'grill-me', 'report-defect', 'review-pr', 'start-issue'];

describe('SMK-OC OpenCode project lifecycle (non-TTY piped answers)', () => {
  let box: Sandbox;
  let pristine: Map<string, string>;
  const config = () => join(box.project, 'opencode.jsonc');
  const readConfig = () => parse(readFileSync(config(), 'utf8')) as { agents?: Record<string, Record<string, unknown>> };
  const projectArgs = () => ['--host', 'opencode', '--scope', 'project', '--project', box.project];

  before(() => { box = createSandbox('opencode'); pristine = tree(box.project); });
  after(() => box.dispose());

  it('SMK-OC-01 refuses to run without an interactive terminal and writes nothing', async () => {
    const result = await box.run('install-native-harness.ts', projectArgs(), { tty: false });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /interactive terminal\. No configuration was changed/);
    assert.deepEqual(tree(box.project), pristine);
    assert.equal(existsSync(box.recoveryDirectory), false);
  });

  it('SMK-OC-02 cancelling the install preview writes no files, receipts, or backups', async () => {
    const result = await box.run('install-native-harness.ts', projectArgs(), { steps: openCodeInstall('') });
    assert.equal(result.code, 0);
    assert.deepEqual(result.unansweredSteps, []);
    assert.match(result.stdout, /Cancelled\. No files were changed\./);
    assert.deepEqual(tree(box.project), pristine);
    assert.equal(existsSync(box.recoveryDirectory), false);
    assert.deepEqual(box.openCodeCalls(), []);
  });

  it('SMK-OC-03 install writes inline agents, workflow commands, and a receipt, then verifies the runtime', async () => {
    const result = await box.run('install-native-harness.ts', projectArgs(), { steps: openCodeInstall('install') });
    assert.equal(result.code, 0, result.transcript);
    assert.deepEqual(result.unansweredSteps, []);
    const agents = readConfig().agents ?? {};
    assert.deepEqual(Object.keys(agents).sort(), [...roles].sort());
    assert.equal(agents.lead?.mode, 'primary');
    for (const command of commands) assert.ok(existsSync(join(box.project, '.opencode', 'commands', `${command}.md`)), command);
    assert.equal(readFileSync(join(box.project, 'AGENTS.md'), 'utf8'), pristine.get('AGENTS.md'));
    assert.equal([...tree(box.recoveryDirectory).keys()].filter(file => file.startsWith('native-install-')).length, 1);
    for (const role of roles) assert.match(result.stdout, new RegExp(`PASS ${role}:`));
    assert.match(result.stdout, /Verified: all eight agents are visible/);
    assert.ok(box.openCodeCalls().every(call => call.args[0] === 'api' && call.args[1] === 'get'), 'only read-only `opencode api get` calls');
  });

  it('SMK-OC-04 doctor reports all eight roles healthy against the stub runtime', async () => {
    const result = await box.run('diagnose-native-harness.ts', ['--host', 'opencode', '--project', box.project]);
    assert.equal(result.code, 0, result.transcript);
    assert.equal(result.stdout.match(/^PASS /gm)?.length, 8);
    assert.match(result.stdout, /No paid model requests were sent/);
  });

  it('SMK-OC-05 deploy-prompts restores a drifted system prompt and preserves the model', async () => {
    const before = readFileSync(config(), 'utf8');
    const original = readConfig().agents!.lead!;
    writeFileSync(config(), before.replace(JSON.stringify(original.system), JSON.stringify('stale lead prompt')));
    assert.equal(readConfig().agents!.lead!.system, 'stale lead prompt', 'precondition: prompt drift was introduced');
    const result = await box.run('deploy-native-prompts.ts', ['--scope', 'project', '--project', box.project], { steps: [ask('Type deploy to confirm', 'deploy')] });
    assert.equal(result.code, 0, result.transcript);
    assert.deepEqual(result.unansweredSteps, []);
    const lead = readConfig().agents!.lead!;
    assert.equal(lead.system, original.system);
    assert.deepEqual(lead.model, original.model);
  });

  it('SMK-OC-06 update cancel is a no-op; applying records the harness version stamp', async () => {
    const receipts = () => [...tree(box.recoveryDirectory).keys()].filter(file => file.startsWith('native-install-')).sort();
    const beforeConfig = readFileSync(config(), 'utf8');
    const beforeReceipts = receipts();
    const preview = [ask('Check remote repository', 'no'), ask('Choose new models')];
    const cancelled = await box.run('update-native-harness.ts', projectArgs(), { steps: [...preview, ask('Type update to apply', '')] });
    assert.equal(cancelled.code, 0, cancelled.transcript);
    assert.match(cancelled.stdout, /Update cancelled\. No files or receipts were modified\./);
    assert.equal(readFileSync(config(), 'utf8'), beforeConfig);
    assert.deepEqual(receipts(), beforeReceipts);

    const applied = await box.run('update-native-harness.ts', projectArgs(), { steps: [...preview, ask('Type update to apply', 'update')] });
    assert.equal(applied.code, 0, applied.transcript);
    assert.deepEqual(applied.unansweredSteps, []);
    const again = await box.run('update-native-harness.ts', projectArgs(), { steps: [...preview, ask('Type update to apply', '')] });
    assert.doesNotMatch(again.stdout, /Installed version: unknown/);
  });

  it('SMK-OC-07 uninstall cancel is a no-op; confirming removes harness agents and commands only', async () => {
    const beforeConfig = readFileSync(config(), 'utf8');
    const args = ['--host', 'opencode', '--scope', 'project', '--project', box.project];
    const cancelled = await box.run('uninstall-native-harness.ts', args, { steps: [ask('Type uninstall to continue', '')] });
    assert.equal(cancelled.code, 0, cancelled.transcript);
    assert.match(cancelled.stdout, /Cancelled; no configuration writes made\./);
    assert.equal(readFileSync(config(), 'utf8'), beforeConfig);

    const removed = await box.run('uninstall-native-harness.ts', args, { steps: [ask('Type uninstall to continue', 'uninstall')] });
    assert.equal(removed.code, 0, removed.transcript);
    assert.match(removed.stdout, /Uninstall complete\. Backup retained:/);
    assert.equal(readConfig().agents, undefined);
    for (const command of commands) assert.equal(existsSync(join(box.project, '.opencode', 'commands', `${command}.md`)), false, command);
    assert.equal(readFileSync(join(box.project, 'AGENTS.md'), 'utf8'), pristine.get('AGENTS.md'));
  });

  it('SMK-OC-08 the fresh install receipt carries a harness version stamp', async () => {
    const fresh = createSandbox('opencode-stamp');
    try {
      const install = await fresh.run('install-native-harness.ts', ['--host', 'opencode', '--scope', 'project', '--project', fresh.project], { steps: openCodeInstall('install') });
      assert.equal(install.code, 0, install.transcript);
      const update = await fresh.run('update-native-harness.ts', ['--host', 'opencode', '--scope', 'project', '--project', fresh.project], { steps: [ask('Check remote repository', 'no'), ask('Choose new models'), ask('Type update to apply', '')] });
      assert.doesNotMatch(update.stdout, /Installed version: unknown/);
      assert.match(update.stdout, /Installed version: \d+\.\d+\.\d+ \([0-9a-f]{40}\)/);
    } finally { fresh.dispose(); }
  });

  it('SMK-OC-09 update model reselection lists the live catalog read-only; cancelling writes nothing', async () => {
    const fresh = createSandbox('opencode-catalog');
    try {
      const args = ['--host', 'opencode', '--scope', 'project', '--project', fresh.project];
      const install = await fresh.run('install-native-harness.ts', args, { steps: openCodeInstall('install') });
      assert.equal(install.code, 0, install.transcript);
      const configPath = join(fresh.project, 'opencode.jsonc');
      const before = readFileSync(configPath, 'utf8');
      const callsBefore = fresh.openCodeCalls().length;
      const update = await fresh.run('update-native-harness.ts', args, { steps: [
        ask('Check remote repository', 'no'),
        ask('Choose new models', 'yes'),
        ask('Query the live OpenCode model catalog', 'yes'),
        ...roles.flatMap(role => [ask(`${role}: model ID`), ask(`${role}: reasoning variant`)]),
        ask('Type update to apply', ''),
      ] });
      assert.equal(update.code, 0, update.transcript);
      assert.deepEqual(update.unansweredSteps, []);
      assert.match(update.stdout, /Live OpenCode catalog models \(listed by OpenCode; not proof of account entitlement/);
      assert.doesNotMatch(update.stdout, /absent (or disabled )?(from|in) the live catalog/);
      assert.match(update.stdout, /Update cancelled\. No files or receipts were modified\./);
      assert.equal(readFileSync(configPath, 'utf8'), before);
      const calls = fresh.openCodeCalls().slice(callsBefore);
      assert.ok(calls.length > 0 && calls.every(call => call.args[0] === 'api' && call.args[1] === 'get' && String(call.args[2]).startsWith('/api/model')), JSON.stringify(calls));
    } finally { fresh.dispose(); }
  });
});

describe('SMK-GL OpenCode global scope + global integrations (non-TTY piped answers)', () => {
  let box: Sandbox;
  let realHome: Map<string, string>;
  const watched = ['.config/opencode/opencode.json', '.config/opencode/opencode.jsonc', '.config/opencode/harness.integrations.json', '.config/opencode/commands', 'Projects/advanced-harness-backups'];
  before(() => { box = createSandbox('global'); realHome = realHomeFingerprintOf(watched); });
  after(() => box.dispose());

  it('SMK-GL-01 global install, gh integration defaults, doctor, and uninstall stay inside the sandbox home', async () => {
    const install = await box.run('install-native-harness.ts', ['--host', 'opencode', '--scope', 'global'], { steps: openCodeInstall('install') });
    assert.equal(install.code, 0, install.transcript);
    const global = join(box.xdgConfigHome, 'opencode');
    assert.ok(existsSync(join(global, 'opencode.jsonc')) || existsSync(join(global, 'opencode.json')));

    const integrations = await box.run('configure-integrations.ts', ['--scope', 'global'], { steps: [
      ask('GitHub backend', 'gh'), ask('GitHub hostname for gh'), ask('jira: alias'), ask('Design source'), ask('Type integrations to save', 'integrations'),
    ] });
    assert.equal(integrations.code, 0, integrations.transcript);
    assert.deepEqual(integrations.unansweredSteps, []);
    const saved = JSON.parse(readFileSync(join(global, 'harness.integrations.json'), 'utf8'));
    assert.equal(saved.github?.backend, 'gh');

    const doctor = await box.run('diagnose-native-harness.ts', ['--host', 'opencode', '--project', box.project]);
    assert.equal(doctor.code, 0, doctor.transcript);

    const uninstall = await box.run('uninstall-native-harness.ts', ['--host', 'opencode', '--scope', 'global'], { steps: [ask('Type uninstall to continue', 'uninstall')] });
    assert.equal(uninstall.code, 0, uninstall.transcript);
    assert.deepEqual(realHomeFingerprintOf(watched), realHome, 'real home harness paths must be untouched');
  });
});
