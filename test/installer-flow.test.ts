import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRoot } from './temp-directory.ts';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { discoverReceiptChain } from '../src/receipt-lineage.ts';
import { loadNativeDefinitions, nativeRoles, parseConfiguration } from '../src/native-installer.ts';
import type { HostAdapter } from '../src/host-registry.ts';

test('injected production installer flow writes a fresh configuration and finalizes its receipt', async t => {
  const root = makeTempRoot('harness-flow-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const recovery = join(root, 'recovery');
  const config = join(project, 'opencode.json');
  const custom = { providerID: 'custom', model: 'preserved', variant: 'fast' };
  writeFileSync(join(project, 'opencode.json'), JSON.stringify({ model: 'custom/root', agents: { lead: { model: custom, customField: 'keep' } } }));
  const answer = (question: string) => {
    if (question.startsWith('lead: model')) return 'local/model#low';
    if (question.startsWith('lead: reasoning')) return '-';
    if (question.startsWith('operator: model')) return 'local/model#low';
    if (question.startsWith('operator: reasoning')) return '-';
    if (question.startsWith('external: model')) return 'local/model#low';
    if (question.startsWith('external: reasoning')) return '-';
    if (question.startsWith('researcher: model')) return 'local/model#low';
    if (question.startsWith('researcher: reasoning')) return '-';
    if (question.startsWith('planner: model')) return 'local/model#low';
    if (question.startsWith('planner: reasoning')) return '-';
    if (question.startsWith('implementer: model')) return 'local/model#low';
    if (question.startsWith('implementer: reasoning')) return '-';
    if (question.startsWith('reviewer: model')) return 'local/model#low';
    if (question.startsWith('reviewer: reasoning')) return '-';
    if (question.startsWith('qa: model')) return 'local/model#low';
    if (question.startsWith('qa: reasoning')) return '-';
    if (question.startsWith('Replace existing lead model?')) return 'no';
    if (question.startsWith('Install workflow slash commands')) return 'no';
    if (question.startsWith('Make Lead')) return 'no';
    if (question.startsWith('Also set')) return 'no';
    if (question.startsWith('Replace customized')) return 'no';
    if (question.startsWith('Query the live OpenCode')) return 'no'; if (question.startsWith('Type install')) return 'install';
    throw new Error(`Unexpected question: ${question}`);
  };
  const output: string[] = [];
  let verified = false;
  await runInstallerFlow({ scope: 'project', project }, {
    ask: async question => answer(question),
    output: text => output.push(text), error: text => output.push(text),
    home: root, recoveryDirectory: recovery,
    verify: async () => { verified = true; return { ok: true, checks: [] } as never; },
    printReport: () => {},
  });
  assert.ok(existsSync(config));
  const saved = parseConfiguration(readFileSync(config, 'utf8'), config);
  assert.deepEqual((saved.agents as Record<string, Record<string, unknown>>).lead?.model, custom);
  assert.equal((saved.agents as Record<string, Record<string, unknown>>).lead?.customField, 'keep');
  assert.ok(verified);
  assert.ok(output.some(line => line.includes('Private uninstall receipt')));
});

test('injected installer cancellation makes no configuration or recovery writes', async t => {
  const root = makeTempRoot('harness-flow-cancel-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const answer = (question: string) => {
    if (question.includes(': model ID')) return 'local/model#low';
    if (question.includes(': reasoning variant')) return 'low';
    if (question.startsWith('Install workflow slash commands')) return 'no';
    if (question.startsWith('Make Lead') || question.startsWith('Also set') || question.startsWith('Replace') || question.startsWith('Query the live OpenCode') || question.startsWith('Type install')) return 'no';
    throw new Error(`Unexpected question: ${question}`);
  };
  await runInstallerFlow({ scope: 'project', project }, { ask: async question => answer(question), output: () => {}, error: () => {}, home: root, recoveryDirectory: join(root, 'recovery') });
  assert.equal(existsSync(join(project, 'opencode.json')), false);
  assert.equal(existsSync(join(root, 'recovery')), false);
});

test('Codex install is gated before Codex prompts or filesystem writes, even with --context', async t => {
  const root = makeTempRoot('codex-gated-install-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const context of [undefined, 'local']) {
    let prompts = 0;
    const errors: string[] = [];
    const status = await runInstallerFlow({ host: 'codex', scope: 'project', project: root, ...(context ? { context } : {}) }, {
      ask: async () => { prompts++; return ''; }, output: () => {}, error: message => errors.push(message), home: root,
    });
    assert.equal(status, 2);
    assert.equal(prompts, 0);
    assert.ok(errors.some(message => message.includes('Installation blocked') && message.includes('issue #45')), errors.join('\n'));
    assert.deepEqual(readdirSync(root), []);
  }
});

test('Antigravity context is forwarded to its adapter while a Codex adapter is never invoked', async t => {
  const root = makeTempRoot('host-context-route-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const seen: string[] = [];
  const adapters = new Map<string, HostAdapter>([
    ['antigravity', { host: 'antigravity', install: async options => { seen.push(`antigravity:${options.context}`); return 0; } }],
    ['codex', { host: 'codex', install: async () => { seen.push('codex'); return 0; } }],
  ]);
  const antigravity = await runInstallerFlow({ host: 'antigravity', scope: 'project', project, context: 'local' }, {
    ask: async () => '', output: () => {}, error: () => {}, home: root,
    getHostAdapter: host => adapters.get(host),
  });
  const codex = await runInstallerFlow({ host: 'codex', scope: 'project', project }, {
    ask: async () => '', output: () => {}, error: () => {}, home: root,
    getHostAdapter: host => adapters.get(host),
  });
  assert.equal(antigravity, 0);
  assert.equal(codex, 2);
  assert.deepEqual(seen, ['antigravity:local']);
});

test('injected installer explicitly replaces a preserved model only after its role-specific confirmation', async t => {
  const root = makeTempRoot('harness-flow-replace-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const config = join(project, 'opencode.json');
  writeFileSync(config, JSON.stringify({ agents: { lead: { model: { providerID: 'custom', model: 'old', variant: 'fast' } } } }));
  const answer = (question: string) => {
    if (question.includes(': model ID')) return 'local/selected#low';
    if (question.includes(': reasoning variant')) return 'low';
    if (question === 'Replace existing lead model?') return 'yes';
    if (question.startsWith('Replace existing ')) return 'no';
    if (question.startsWith('Install workflow slash commands')) return 'no';
    if (question.startsWith('Make Lead') || question.startsWith('Also set') || question.startsWith('Replace customized')) return 'no';
    if (question.startsWith('Query the live OpenCode')) return 'no'; if (question.startsWith('Type install')) return 'install';
    throw new Error(`Unexpected question: ${question}`);
  };
  await runInstallerFlow({ scope: 'project', project }, {
    ask: async question => answer(question), output: () => {}, error: () => {},
    home: root, recoveryDirectory: join(root, 'recovery'), verify: async () => ({ ok: true, checks: [] } as never), printReport: () => {},
  });
  const saved = parseConfiguration(readFileSync(config, 'utf8'), config);
  assert.equal(((saved.agents as Record<string, Record<string, unknown>>).lead?.model), 'local/selected#low');
});

test('installer verification returns failure and inconclusive statuses instead of success', async t => {
  const root = makeTempRoot('harness-flow-status-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const makeAnswers = (target: string) => async (question: string) => {
    if (question.includes(': model ID')) return 'local/model';
    if (question.includes(': reasoning variant')) return '-';
    if (question.startsWith('Install workflow slash commands')) return 'no';
    if (question.startsWith('Make Lead') || question.startsWith('Also set') || question.startsWith('Replace')) return 'no';
    if (question.startsWith('Query the live OpenCode')) return 'no'; if (question.startsWith('Type install')) return target;
    throw new Error(`Unexpected question: ${question}`);
  };
  const base = { scope: 'project', project };
  const deps = { ask: makeAnswers('install'), output: () => {}, error: () => {}, home: root, recoveryDirectory: join(root, 'recovery'), printReport: () => {} };
  assert.equal(await runInstallerFlow(base, { ...deps, verify: async () => ({ ok: false } as never) }), 1);
  const secondProject = join(root, 'second'); mkdirSync(secondProject);
  await assert.doesNotReject(async () => {
    const result = await runInstallerFlow({ scope: 'project', project: secondProject }, { ...deps, recoveryDirectory: join(root, 'recovery-2'), verify: async () => { throw new Error('diagnostic unavailable'); } });
    assert.equal(result, 2);
  });
});

test('installer injected project and config paths use injected home/cwd', async t => {
  const root = makeTempRoot('harness-flow-paths-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'sandbox-home'); const cwd = join(root, 'sandbox-cwd');
  const project = join(home, 'project'); mkdirSync(project, { recursive: true });
  const asks = async (question: string) => { if (question.includes(': model ID')) return 'local/model'; if (question.includes(': reasoning variant')) return '-'; if (question.startsWith('Install workflow slash commands')) return 'no'; if (/Replace|Make Lead|Also set/.test(question)) return 'no'; if (question.startsWith('Query the live OpenCode')) return 'no'; if (question.startsWith('Type install')) return 'cancel'; throw new Error(question); };
  await runInstallerFlow({ scope: 'project', project: '~/project', config: '$HOME/project/opencode.json' }, { ask: asks, output: () => {}, error: () => {}, home, cwd, recoveryDirectory: join(root, 'recovery') }).catch(error => { throw error; });
  assert.equal(existsSync(join(project, 'opencode.json')), false);
  assert.equal(existsSync(join(cwd, 'project')), false);
});

test('installer pending-write and finalization failures retain the expected evidence state', async t => {
  const root = makeTempRoot('harness-flow-failures-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const makeAnswer = (config: string) => async (question: string) => {
    if (question.includes(': model ID')) return 'local/model';
    if (question.includes(': reasoning variant')) return '-';
    if (question.startsWith('Install workflow slash commands')) return 'no';
    if (/Replace|Make Lead|Also set/.test(question)) return 'no';
    if (question.startsWith('Query the live OpenCode')) return 'no'; if (question.startsWith('Type install')) return 'install';
    throw new Error(question);
  };
  const pendingProject = join(root, 'pending'); mkdirSync(pendingProject);
  await assert.rejects(runInstallerFlow({ scope: 'project', project: pendingProject }, { ask: makeAnswer(''), output: () => {}, error: () => {}, home: root, recoveryDirectory: join(root, 'pending-recovery'), writePending: () => { throw new Error('pending failed'); } }), /pending failed/);
  assert.equal(existsSync(join(pendingProject, 'opencode.json')), false);
  const finalProject = join(root, 'final'); mkdirSync(finalProject); const recovery = join(root, 'final-recovery');
  await assert.rejects(runInstallerFlow({ scope: 'project', project: finalProject }, { ask: makeAnswer(''), output: () => {}, error: () => {}, home: root, recoveryDirectory: recovery, verify: async () => ({ ok: true } as never), printReport: () => {}, finalize: () => { throw new Error('finalize failed'); } }), /finalize failed/);
  assert.ok(existsSync(join(finalProject, 'opencode.jsonc')));
  assert.ok(existsSync(recovery));
  const { readdirSync } = await import('node:fs');
  const receipts = readdirSync(recovery).filter(name => name.endsWith('.json'));
  assert.equal(receipts.length, 1);
  assert.equal(JSON.parse(readFileSync(join(recovery, receipts[0]!), 'utf8')).status, 'pending');
});

test('repeated injected installer flow is a true no-op without a new receipt or backup', async t => {
  const root = makeTempRoot('harness-flow-noop-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project); const recovery = join(root, 'recovery');
  const answer = async (question: string) => {
    if (question.includes(': model ID')) return 'local/model'; if (question.includes(': reasoning variant')) return '-';
    if (question.startsWith('Install workflow slash commands')) return 'no';
    if (/Replace|Make Lead|Also set/.test(question)) return 'no'; if (question.startsWith('Query the live OpenCode')) return 'no'; if (question.startsWith('Type install')) return 'install';
    throw new Error(`Unexpected question: ${question}`);
  };
  const deps = { ask: answer, output: () => {}, error: () => {}, home: root, recoveryDirectory: recovery, verify: async () => ({ ok: true } as never), printReport: () => {} };
  assert.equal(await runInstallerFlow({ scope: 'project', project }, deps), 0);
  const before = readFileSync(join(project, 'opencode.jsonc'), 'utf8'); const inventory = (await import('node:fs')).readdirSync(recovery).sort();
  assert.equal(await runInstallerFlow({ scope: 'project', project }, deps), 0);
  assert.equal(readFileSync(join(project, 'opencode.jsonc'), 'utf8'), before);
  assert.deepEqual((await import('node:fs')).readdirSync(recovery).sort(), inventory);
});

test('installer obsolete owned rule defaults to keep and can be explicitly removed', async t => {
  for (const remove of [false, true]) {
    const root = makeTempRoot('harness-flow-obsolete-');
    try {
      const project = join(root, 'project'); mkdirSync(project); const recovery = join(root, 'recovery');
      const source = loadNativeDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));
      const obsolete = source.external.permissions[0];
      assert.ok(obsolete);
      const askInitial = async (question: string) => {
        if (question.includes(': model ID')) return 'local/model'; if (question.includes(': reasoning variant')) return '-';
        if (question.startsWith('Install workflow slash commands')) return 'no';
        if (/Replace|Make Lead|Also set/.test(question)) return 'no'; if (question.startsWith('Query the live OpenCode')) return 'no'; if (question.startsWith('Type install')) return 'install';
        throw new Error(question);
      };
      const deps = { ask: askInitial, output: () => {}, error: () => {}, home: root, recoveryDirectory: recovery, verify: async () => ({ ok: true } as never), printReport: () => {} };
      await runInstallerFlow({ scope: 'project', project }, deps);
      const changed = { ...source, external: { ...source.external, permissions: source.external.permissions.filter(rule => rule !== obsolete) } };
      const askUpgrade = async (question: string) => {
        if (question.includes(': model ID')) return 'local/model'; if (question.includes(': reasoning variant')) return '-';
        if (question.startsWith('Remove obsolete owned external permission')) return remove ? 'yes' : 'no';
        if (question.startsWith('Install workflow slash commands')) return 'no';
        if (/Replace|Make Lead|Also set/.test(question)) return 'no'; if (question.startsWith('Query the live OpenCode')) return 'no'; if (question.startsWith('Type install')) return 'install';
        throw new Error(`Unexpected upgrade prompt: ${question}`);
      };
      await runInstallerFlow({ scope: 'project', project }, { ...deps, ask: askUpgrade, loadDefinitions: () => changed });
      const saved = parseConfiguration(readFileSync(join(project, 'opencode.jsonc'), 'utf8'), 'config');
      const perms = (saved.agents as Record<string, Record<string, unknown>>).external!.permissions as unknown[];
      assert.equal(perms.some(rule => JSON.stringify(rule) === JSON.stringify(obsolete)), !remove);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('installer flow retries invalid scope/model/variant inputs and honors default-on-Enter', async t => {
  const root = makeTempRoot('harness-flow-retry-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const scopeReplies = ['invalid-scope', ''];
  const leadModelReplies = ['not-a-model', ''];
  const leadVariantReplies = ['bad/variant', '-'];
  const ask = async (question: string, suggested?: string) => {
    if (question.startsWith('Install scope')) return scopeReplies.shift() ?? '';
    if (question.startsWith('Project directory')) return '';
    if (question.startsWith('lead: model ID')) return leadModelReplies.shift() ?? (suggested ?? 'local/model');
    if (question.startsWith('lead: reasoning variant')) return leadVariantReplies.shift() ?? '-';
    if (question.includes(': model ID')) return '';
    if (question.includes(': reasoning variant')) return '';
    if (question.startsWith('Query the live OpenCode')) return 'no'; if (question.startsWith('Type install')) return 'cancel';
    return '';
  };
  assert.equal(await runInstallerFlow({}, {
    ask, output: () => {}, error: () => {}, cwd: project, home: root, recoveryDirectory: join(root, 'recovery'),
  }), 0);
  assert.equal(scopeReplies.length, 0);
  assert.equal(leadModelReplies.length, 0);
  assert.equal(leadVariantReplies.length, 0);
  assert.equal(existsSync(join(project, 'opencode.jsonc')), false);
});

test('global installer selects default, XDG, and injected config directories and cancels without writes', async t => {
  const root = makeTempRoot('harness global paths ');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home with spaces');
  const xdg = join(root, 'xdg config with spaces');
  const override = join(xdg, 'opencode');
  const unrelated = join(home, 'unrelated.json');
  mkdirSync(home, { recursive: true });
  writeFileSync(unrelated, '{"keep":true}\n');
  const answer = async (question: string) => {
    if (question.includes(': model ID')) return 'local/model';
    if (question.includes(': reasoning variant')) return '-';
    if (question.startsWith('Install workflow slash commands')) return 'no';
    if (/Replace|Make Lead|Also set/.test(question)) return 'no';
    if (question.startsWith('Query the live OpenCode')) return 'no'; if (question.startsWith('Type install')) return 'cancel';
    throw new Error(`Unexpected prompt: ${question}`);
  };
  for (const [label, deps, expected] of [
    ['home default', { environment: {} }, join(home, '.config', 'opencode')],
    ['XDG', { environment: { XDG_CONFIG_HOME: xdg } }, join(xdg, 'opencode')],
    ['injected override', { environment: { XDG_CONFIG_HOME: join(root, 'decoy config') }, xdgConfigHome: xdg }, override],
  ] as const) {
    const config = label === 'injected override' ? join(override, 'opencode.json') : undefined;
    const recovery = join(root, `recovery ${label}`);
    const output: string[] = [];
    await runInstallerFlow({ scope: 'global', ...(config ? { config } : {}) }, {
      ask: answer, output: text => output.push(text), error: () => {}, home,
      environment: deps.environment,
      ...(deps.xdgConfigHome ? { xdgConfigHome: deps.xdgConfigHome } : {}),
      recoveryDirectory: recovery,
    });
    assert.ok(output.some(line => line.includes(`Target: ${config ?? join(expected, 'opencode.jsonc')}`)));
    assert.equal(existsSync(expected), false);
    assert.equal(existsSync(recovery), false);
  }
  assert.equal(readFileSync(unrelated, 'utf8'), '{"keep":true}\n');
});

test('OpenCode install stamps harnessVersion on the head receipt and prints it before confirmation; cancel writes nothing', async t => {
  const root = makeTempRoot('harness-flow-version-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const harnessRoot = join(root, 'checkout');
  mkdirSync(harnessRoot);
  writeFileSync(join(harnessRoot, 'package.json'), JSON.stringify({ version: '9.8.7' }));
  const commit = 'c'.repeat(40);
  const run = async (decision: string, dirty = false) => {
    const label = `${decision}${dirty ? '-dirty' : ''}`;
    const project = join(root, `project-${label}`);
    mkdirSync(project);
    const recovery = join(root, `recovery-${label}`);
    const output: string[] = [];
    const runCommand = (_executable: string, args: string[]) => args[0] === 'rev-parse' ? commit : dirty ? ' M src/installer-flow.ts' : '';
    const expectedLine = `Harness version: 9.8.7 (${commit})${dirty ? ' [dirty local changes]' : ''}`;
    let sawVersionBeforeConfirm = false;
    const code = await runInstallerFlow({ scope: 'project', project }, {
      ask: async question => {
        if (question.startsWith('Query the live OpenCode')) return 'no'; if (question.startsWith('Type install')) sawVersionBeforeConfirm = output.includes(expectedLine);
        if (/^(lead|operator|external|researcher|planner|implementer|reviewer|qa): model/.test(question)) return 'local/model#low';
        if (/^(lead|operator|external|researcher|planner|implementer|reviewer|qa): reasoning/.test(question)) return '-';
        if (question.startsWith('Query the live OpenCode')) return 'no'; if (question.startsWith('Type install')) return decision;
        return question.startsWith('Install workflow slash commands') || question.startsWith('Make Lead') || question.startsWith('Also set') || question.startsWith('Replace') ? 'no' : '';
      },
      output: text => output.push(text), error: text => output.push(text),
      home: root, recoveryDirectory: recovery, harnessRoot, runCommand,
      verify: async () => ({ ok: true, checks: [] } as never), printReport: () => {},
    });
    return { code, output, recovery, project, sawVersionBeforeConfirm };
  };

  const installed = await run('install');
  assert.equal(installed.code, 0);
  assert.equal(installed.sawVersionBeforeConfirm, true);
  const head = discoverReceiptChain(installed.recovery, join(installed.project, 'opencode.jsonc'), 'opencode').head;
  assert.deepEqual(head?.receipt.version === 2 ? head.receipt.harnessVersion : undefined, { version: '9.8.7', commit });

  const dirty = await run('install', true);
  assert.equal(dirty.code, 0);
  assert.equal(dirty.sawVersionBeforeConfirm, true, 'dirty annotation printed before the final confirmation');
  const dirtyHead = discoverReceiptChain(dirty.recovery, join(dirty.project, 'opencode.jsonc'), 'opencode').head;
  assert.deepEqual(dirtyHead?.receipt.version === 2 ? dirtyHead.receipt.harnessVersion : undefined, { version: '9.8.7', commit, dirty: true });

  const cancelled = await run('cancel');
  assert.equal(cancelled.code, 0);
  assert.ok(cancelled.output.some(line => /Cancelled\. No files were changed\./.test(line)));
  assert.equal(existsSync(join(cancelled.project, 'opencode.jsonc')), false);
  assert.equal(existsSync(cancelled.recovery), false, 'no receipt or backup on cancel');
});
