import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeTempRoot } from './temp-directory.ts';
import { DiagnosticError } from '../src/native-diagnostics.ts';
import { chooseModelCatalog, discoverOpenCodeModels } from '../src/opencode-model-catalog.ts';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import { nativeRoles, parseConfiguration } from '../src/native-installer.ts';
import { HOST_CAPABILITIES, describeModelSupport, supportedHosts } from '../src/host-registry.ts';

const catalogRows = (directory: string) => ({
  location: { directory },
  data: [
    { providerID: 'live', id: 'big', enabled: true, variants: [{ id: 'high' }, { id: 'low' }] },
    { providerID: 'live', id: 'small', enabled: true, variants: [] },
    { providerID: 'live', id: 'off', enabled: false, variants: [{ id: 'low' }] },
  ],
});

test('live discovery lists enabled catalog models and their variants only', async () => {
  const directory = resolve('.');
  const paths: string[] = [];
  const models = await discoverOpenCodeModels({ directory }, async path => { paths.push(path); return catalogRows(directory); });
  assert.deepEqual(models, ['live/big', 'live/big#high', 'live/big#low', 'live/small']);
  assert.deepEqual(paths, ['/api/model'], 'only the read-only model catalog is queried');
});

test('live discovery rejects a catalog for another project location', async () => {
  await assert.rejects(discoverOpenCodeModels({ directory: resolve('.') }, async () => catalogRows(resolve('..'))), DiagnosticError);
});

test('declining live discovery lists configured IDs without querying OpenCode', async () => {
  const output: string[] = [];
  let queried = false;
  const sources = [{ path: 'opencode.json', text: '', value: { model: 'cfg/root' } }];
  const catalog = await chooseModelCatalog(sources, { directory: '.' }, async () => 'no', text => output.push(text), async () => { queried = true; return []; });
  assert.equal(queried, false);
  assert.deepEqual(catalog, { choices: ['cfg/root'] });
  assert.ok(output.some(line => line.includes('Live model discovery skipped')));
});

test('unavailable live discovery falls back to configured IDs and suppresses raw error text', async () => {
  for (const [failure, expected] of [[new DiagnosticError('OpenCode API check failed.'), 'OpenCode API check failed.'], [new Error('token=secret'), 'could not be read']] as const) {
    const output: string[] = [];
    const catalog = await chooseModelCatalog([], { directory: '.' }, async () => '', text => output.push(text), async () => { throw failure; });
    assert.equal(catalog.live, undefined, 'fallback is not treated as a live catalog');
    assert.ok(output.some(line => line.includes('Live model discovery unavailable') && line.includes(expected)), output.join('\n'));
    assert.ok(output.some(line => line.includes('Falling back to configured model IDs')));
    assert.ok(!output.join('\n').includes('secret'));
  }
});

test('every host declares its model selection and discovery support', () => {
  for (const host of supportedHosts) {
    const support = HOST_CAPABILITIES[host].modelSupport;
    assert.ok(support.limitation.length > 0, host);
    assert.equal(describeModelSupport(host).length, 2);
  }
  for (const host of ['opencode', 'codex'] as const) assert.equal(HOST_CAPABILITIES[host].modelSupport.discovery, 'live-catalog', host);
  for (const host of ['claude-code', 'antigravity', 'cursor'] as const) assert.equal(HOST_CAPABILITIES[host].modelSupport.discovery, 'unsupported', host);
});

function installAnswers(models: Record<string, string[]>, extra: (question: string) => string | undefined = () => undefined) {
  const queues = Object.fromEntries(Object.entries(models).map(([role, answers]) => [role, [...answers]]));
  const asked: string[] = [];
  const ask = async (question: string) => {
    asked.push(question);
    const custom = extra(question);
    if (custom !== undefined) return custom;
    const role = question.split(':')[0]!;
    if (question.includes(': model ID')) return queues[role]?.length ? queues[role]!.shift()! : '';
    if (question.includes(': reasoning variant')) return '';
    if (question.includes('type keep')) return queues[`${role}:keep`]?.shift() ?? '';
    if (question.startsWith('Query the live OpenCode')) return '';
    if (question.startsWith('Install workflow slash commands')) return 'no';
    if (/Replace|Make Lead|Also set/.test(question)) return 'no';
    if (question.startsWith('Type install')) return 'install';
    throw new Error(`Unexpected question: ${question}`);
  };
  return { ask, asked };
}

function installSandbox(t: { after(fn: () => void): void }) {
  const root = makeTempRoot('harness-catalog-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  return { root, project, config: join(project, 'opencode.jsonc'), recovery: join(root, 'recovery') };
}

test('installer presents the live catalog and saves listed numbers without confirmation', async t => {
  const { root, project, config, recovery } = installSandbox(t);
  const output: string[] = [];
  const { ask, asked } = installAnswers(Object.fromEntries(nativeRoles.map(role => [role, ['2']])));
  const status = await runInstallerFlow({ scope: 'project', project }, {
    ask, output: text => output.push(text), error: text => output.push(text), home: root, recoveryDirectory: recovery,
    discoverModels: async () => ['live/big', 'live/big#high', 'live/small'],
    verify: async () => ({ ok: true, checks: [] } as never), printReport: () => {},
  });
  assert.equal(status, 0, output.join('\n'));
  assert.ok(output.some(line => line.startsWith('\nLive OpenCode catalog models') && line.includes('not proof of account entitlement')));
  assert.ok(output.includes('  2. live/big#high'));
  assert.equal(asked.some(question => question.includes('type keep')), false);
  const agents = parseConfiguration(readFileSync(config, 'utf8'), config).agents as Record<string, Record<string, unknown>>;
  for (const role of nativeRoles) assert.equal(agents[role]?.model, 'live/big#high', role);
});

test('installer re-prompts an off-catalog model on Enter and never substitutes it', async t => {
  const { root, project, config, recovery } = installSandbox(t);
  const output: string[] = [];
  const models = Object.fromEntries(nativeRoles.map(role => [role, ['live/small']]));
  models.lead = ['ghost/model', 'live/small'];
  const { ask, asked } = installAnswers(models);
  const status = await runInstallerFlow({ scope: 'project', project }, {
    ask, output: text => output.push(text), error: text => output.push(text), home: root, recoveryDirectory: recovery,
    discoverModels: async () => ['live/small'],
    verify: async () => ({ ok: true, checks: [] } as never), printReport: () => {},
  });
  assert.equal(status, 0, output.join('\n'));
  assert.ok(output.includes('ghost/model is absent or disabled in the live catalog.'));
  assert.equal(asked.filter(question => question.startsWith('lead: model ID')).length, 2, 'Enter on the keep prompt chooses again');
  const agents = parseConfiguration(readFileSync(config, 'utf8'), config).agents as Record<string, Record<string, unknown>>;
  assert.equal(agents.lead?.model, 'live/small');
});

test('installer saves an off-catalog model or variant only after an explicit keep', async t => {
  const { root, project, config, recovery } = installSandbox(t);
  const output: string[] = [];
  const models: Record<string, string[]> = Object.fromEntries(nativeRoles.map(role => [role, ['live/big']]));
  models.lead = ['ghost/model'];
  models['lead:keep'] = ['keep'];
  models.planner = ['live/big#ultra'];
  models['planner:keep'] = ['keep'];
  const { ask } = installAnswers(models);
  const status = await runInstallerFlow({ scope: 'project', project }, {
    ask, output: text => output.push(text), error: text => output.push(text), home: root, recoveryDirectory: recovery,
    discoverModels: async () => ['live/big', 'live/big#high'],
    verify: async () => ({ ok: true, checks: [] } as never), printReport: () => {},
  });
  assert.equal(status, 0, output.join('\n'));
  assert.ok(output.includes('Variant ultra of live/big is absent from the live catalog.'));
  const agents = parseConfiguration(readFileSync(config, 'utf8'), config).agents as Record<string, Record<string, unknown>>;
  assert.equal(agents.lead?.model, 'ghost/model');
  assert.equal(agents.planner?.model, 'live/big#ultra');
  assert.equal(agents.qa?.model, 'live/big');
});

test('installer falls back when discovery fails and cancellation writes nothing', async t => {
  const { root, project, config, recovery } = installSandbox(t);
  const output: string[] = [];
  const { ask } = installAnswers(Object.fromEntries(nativeRoles.map(role => [role, ['any/model']])), question => question.startsWith('Type install') ? '' : undefined);
  const status = await runInstallerFlow({ scope: 'project', project }, {
    ask, output: text => output.push(text), error: text => output.push(text), home: root, recoveryDirectory: recovery,
    discoverModels: async () => { throw new DiagnosticError('OpenCode API check failed or timed out.'); },
  });
  assert.equal(status, 0);
  assert.ok(output.some(line => line.includes('Live model discovery unavailable: OpenCode API check failed or timed out.')));
  assert.ok(output.includes('Cancelled. No files were changed.'));
  assert.equal(existsSync(config), false);
  assert.equal(existsSync(recovery), false);
});

function installedConfig() {
  return {
    agents: Object.fromEntries(nativeRoles.map(role => [role, {
      description: `Custom desc of ${role}`,
      mode: role === 'lead' ? 'primary' : 'subagent',
      model: role === 'qa' ? { providerID: 'live', model: 'small' } : 'live/small',
      permissions: [],
      system: `Old system prompt for ${role}`,
    }])),
  };
}

function updateAnswers(choose: string, leadModel: string, confirm: string) {
  const asked: string[] = [];
  const ask = async (question: string) => {
    asked.push(question);
    if (question.startsWith('Check remote')) return 'no';
    if (question.includes('system prompt to latest')) return 'no';
    if (question.startsWith('Replace customized workflow command')) return 'no';
    if (question.startsWith('Choose new models')) return choose;
    if (question.startsWith('Query the live OpenCode')) return 'yes';
    if (question.startsWith('lead: model ID')) return leadModel;
    if (question.includes(': model ID') || question.includes(': reasoning variant')) return '';
    if (question.startsWith('Type update')) return confirm;
    throw new Error(`Unexpected question: ${question}`);
  };
  return { ask, asked };
}

test('update preserves models on Enter and never queries the catalog', async t => {
  const { root, project, config, recovery } = installSandbox(t);
  writeFileSync(config, JSON.stringify(installedConfig(), null, 2));
  const output: string[] = [];
  let queried = false;
  const { ask, asked } = updateAnswers('', 'unused', 'cancel');
  const status = await runUpdateFlow({ scope: 'project', project }, {
    ask, output: text => output.push(text), error: text => output.push(text), home: root, recoveryDirectory: recovery, runCommand: (_command: string, args: readonly string[]) => args[0] === 'rev-parse' ? '1111222233334444' : '',
    discoverModels: async () => { queried = true; return []; },
  });
  assert.equal(status, 0);
  assert.equal(queried, false);
  assert.equal(asked.some(question => question.includes(': model ID')), false);
  assert.ok(output.includes('  Role models: preserved'));
});

test('update reselects a model from the live catalog; cancel writes nothing and apply changes only that role', async t => {
  const { root, project, config, recovery } = installSandbox(t);
  const original = JSON.stringify(installedConfig(), null, 2);
  writeFileSync(config, original);
  const deps = (confirm: string, output: string[]) => ({
    ...updateAnswers('yes', 'live/big#high', confirm), output: (text: string) => output.push(text), error: (text: string) => output.push(text),
    home: root, recoveryDirectory: recovery, runCommand: (_command: string, args: readonly string[]) => args[0] === 'rev-parse' ? '1111222233334444' : '',
    discoverModels: async () => ['live/big', 'live/big#high', 'live/small'],
    verify: async () => ({ ok: true, checks: [] } as never), printReport: () => {},
  });

  const cancelledOutput: string[] = [];
  assert.equal(await runUpdateFlow({ scope: 'project', project }, deps('cancel', cancelledOutput)), 0);
  assert.ok(cancelledOutput.includes('  lead model: live/small -> live/big#high'), cancelledOutput.join('\n'));
  assert.equal(readFileSync(config, 'utf8'), original);
  assert.equal(existsSync(recovery), false);

  const appliedOutput: string[] = [];
  assert.equal(await runUpdateFlow({ scope: 'project', project }, deps('update', appliedOutput)), 0, appliedOutput.join('\n'));
  const agents = parseConfiguration(readFileSync(config, 'utf8'), config).agents as Record<string, Record<string, unknown>>;
  assert.equal(agents.lead?.model, 'live/big#high');
  assert.equal(agents.operator?.model, 'live/small');
  assert.deepEqual(agents.qa?.model, { providerID: 'live', model: 'small' }, 'an unchanged object-form model keeps its shape');
});

test('non-OpenCode install reports the host model limitation before its adapter runs', async t => {
  const { root, project } = installSandbox(t);
  const output: string[] = [];
  const status = await runInstallerFlow({ host: 'claude-code', scope: 'project', project }, {
    ask: async () => '', output: text => output.push(text), error: text => output.push(text), home: root,
    getHostAdapter: () => ({ host: 'claude-code', install: async () => { output.push('adapter'); return 0; } }),
  });
  assert.equal(status, 0);
  const limitation = output.indexOf(HOST_CAPABILITIES['claude-code'].modelSupport.limitation);
  assert.ok(limitation >= 0 && limitation < output.indexOf('adapter'), output.join('\n'));
});
