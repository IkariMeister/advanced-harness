import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRoot } from './temp-directory.ts';
import { runPromptDeploymentFlow } from '../src/prompt-deployment-flow.ts';
import { parsePromptDeploymentArgs } from '../src/prompt-deployment-cli.ts';
import { nativeRoles, parseConfiguration, type NativeDefinition } from '../src/native-installer.ts';
import { saveInstallation } from '../src/native-installer.ts';
import { finalizeSuccessor, writePendingSuccessor } from '../src/receipt-lineage.ts';

const definitions = Object.fromEntries(nativeRoles.map(role => [role, { description: `new ${role}`, system: `new system ${role}` }])) as Record<typeof nativeRoles[number], NativeDefinition>;

test('CLI argument adapter maps explicit option flags to production flow fields', () => {
  assert.deepEqual(parsePromptDeploymentArgs(['--scope', 'global', '--project', 'D:/project', '--config', 'D:/config.json']), {
    scope: 'global', project: 'D:/project', config: 'D:/config.json'
  });
});
function fixture(t: { after(fn: () => void): void }) {
  const root = makeTempRoot('prompt-flow-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const target = join(project, 'opencode.json');
  const global = join(root, 'global');
  const backup = join(root, 'backups');
  const agents = Object.fromEntries(nativeRoles.map(role => [role, { description: 'old', system: 'old', model: `custom/${role}#low`, permissions: [{ action: 'shell', resource: '*', effect: 'deny' }] }]));
  const original = JSON.stringify({ agents }, null, 2);
  mkdirSync(project, { recursive: true });
  mkdirSync(global, { recursive: true });
  writeFileSync(target, original);
  return { root, project, target, global, backup, original };
}

test('actual prompt deployment flow cancellation causes no config, backup, or receipt writes', async t => {
  const f = fixture(t); const answers = ['no']; const output: string[] = [];
  await runPromptDeploymentFlow({ scope: 'project', project: f.project, config: f.target }, {
    cwd: f.root, home: f.root, xdgConfigHome: f.global, environment: { ADVANCED_HARNESS_RECOVERY_DIR: f.backup },
    loadDefinitions: () => definitions,
    ask: async () => answers.shift()!, output: value => output.push(value)
  });
  assert.equal(readFileSync(f.target, 'utf8'), f.original);
  assert.equal(existsSync(f.backup), false);
  assert.match(output.join('\n'), /Cancelled/);
});

test('actual flow retries invalid scope and uses project default on Enter; alternate global target is selected', async t => {
  const f = fixture(t); const globalTarget = join(f.global, 'opencode', 'opencode.json');
  mkdirSync(join(f.global, 'opencode'), { recursive: true });
  writeFileSync(globalTarget, f.original);
  const prompts: Array<[string, string | undefined]> = [];
  const answers = ['bogus', 'global', 'deploy'];
  await runPromptDeploymentFlow({ config: globalTarget }, {
    cwd: f.root, home: f.root, xdgConfigHome: f.global, environment: { ADVANCED_HARNESS_RECOVERY_DIR: f.backup },
    loadDefinitions: () => definitions, ask: async (q, d) => { prompts.push([q, d]); return answers.shift()!; }, output: () => {}
  });
  assert.deepEqual(prompts[0], ['Deploy scope: project or global', 'project']);
  assert.equal(prompts.at(-1)?.[0], 'Type deploy to confirm prompt deployment');
  const deployed = parseConfiguration(readFileSync(globalTarget, 'utf8'), globalTarget).agents as Record<string, Record<string, unknown>>;
  assert.equal(deployed.lead?.system, definitions.lead.system);
  assert.equal(readFileSync(f.target, 'utf8'), f.original);
});

test('actual flow accepts project scope and directory defaults on Enter', async t => {
  const f = fixture(t); const prompts: Array<[string, string | undefined]> = [];
  const answers = ['', '', 'cancel'];
  await runPromptDeploymentFlow({ config: f.target }, {
    cwd: f.root, home: f.root, xdgConfigHome: f.global, environment: { ADVANCED_HARNESS_RECOVERY_DIR: f.backup },
    loadDefinitions: () => definitions, ask: async (q, d) => { prompts.push([q, d]); return answers.shift()!; }, output: () => {}
  });
  assert.deepEqual(prompts.slice(0, 2), [['Deploy scope: project or global', 'project'], ['Project directory', f.root]]);
  assert.equal(readFileSync(f.target, 'utf8'), f.original);
  assert.equal(existsSync(f.backup), false);
});

test('actual flow requires fresh confirmation when config or templates drift after preview', async t => {
  for (const drift of ['config', 'templates']) {
    const f = fixture(t); let count = 0;
    await assert.rejects(runPromptDeploymentFlow({ scope: 'project', project: f.project, config: f.target }, {
      cwd: f.root, home: f.root, xdgConfigHome: f.global, environment: { ADVANCED_HARNESS_RECOVERY_DIR: f.backup },
      loadDefinitions: () => { count++; return count > 1 && drift === 'templates' ? { ...definitions, lead: { ...definitions.lead, system: 'drift' } } : definitions; },
      ask: async () => { if (drift === 'config') writeFileSync(f.target, f.original + ' '); return 'deploy'; }, output: () => {}
    }), /changed since preview/);
    assert.equal(existsSync(f.backup), false);
    assert.equal(readdirSync(f.root).some(name => name.includes('receipt')), false);
  }
});

test('actual flow keeps pending/save/finalization failures explicit', async t => {
  for (const failure of ['pending', 'save', 'finalize']) {
    const f = fixture(t); let pendingCalled = 0, saveCalled = 0, finalizeCalled = 0;
    const deps: any = {
      writePending: (...args: unknown[]) => { pendingCalled++; if (failure === 'pending') throw new Error('pending failure'); return writePendingSuccessor(...args as Parameters<typeof writePendingSuccessor>); },
      save: (...args: Parameters<typeof saveInstallation>) => { saveCalled++; if (failure === 'save') throw new Error('save failure'); return saveInstallation(...args); },
      finalize: (...args: Parameters<typeof finalizeSuccessor>) => { finalizeCalled++; if (failure === 'finalize') throw new Error('finalize failure'); return finalizeSuccessor(...args); }
    };
    const call = runPromptDeploymentFlow({ scope: 'project', project: f.project, config: f.target }, {
      cwd: f.root, home: f.root, xdgConfigHome: f.global, environment: { ADVANCED_HARNESS_RECOVERY_DIR: f.backup },
      loadDefinitions: () => definitions, deployDependencies: deps, ask: async () => 'deploy', output: () => {}
    });
    await assert.rejects(call, failure === 'pending' ? /^Error: pending failure$/ : failure === 'save' ? /^Error: save failure$/ : /Configuration saved but receipt finalization failed; pending evidence at .*finalize failure/);
    assert.equal(pendingCalled, 1);
    assert.equal(saveCalled, failure === 'pending' ? 0 : 1);
    assert.equal(finalizeCalled, failure === 'finalize' ? 1 : 0);
    const receipts = existsSync(f.backup) ? readdirSync(f.backup).filter(name => name.endsWith('.json')) : [];
    if (failure === 'pending') {
      assert.equal(readFileSync(f.target, 'utf8'), f.original);
      assert.deepEqual(receipts, []);
    } else if (failure === 'save') {
      assert.equal(readFileSync(f.target, 'utf8'), f.original);
      assert.deepEqual(receipts, []);
    } else {
      assert.notEqual(readFileSync(f.target, 'utf8'), f.original);
      assert.equal(receipts.length, 1);
      assert.equal(JSON.parse(readFileSync(join(f.backup, receipts[0]!), 'utf8')).status, 'pending');
      const backupDirectories = readdirSync(f.backup, { withFileTypes: true }).filter(entry => entry.isDirectory());
      assert.equal(backupDirectories.length, 1);
      assert.ok(readdirSync(join(f.backup, backupDirectories[0]!.name)).includes('opencode.json'));
    }
  }
});
