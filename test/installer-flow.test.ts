import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { loadNativeDefinitions, nativeRoles, parseConfiguration } from '../src/native-installer.ts';
import { applyOpenCodeCommandDeployment } from '../src/workflow-commands.ts';

test('injected production installer flow writes a fresh configuration and finalizes its receipt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-flow-'));
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
    if (question.startsWith('Make Lead')) return 'no';
    if (question.startsWith('Also set')) return 'no';
    if (question.startsWith('Replace customized')) return 'no';
    if (question.startsWith('Type install')) return 'install';
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
  const root = mkdtempSync(join(tmpdir(), 'harness-flow-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const answer = (question: string) => {
    if (question.includes(': model ID')) return 'local/model#low';
    if (question.includes(': reasoning variant')) return 'low';
    if (question.startsWith('Make Lead') || question.startsWith('Also set') || question.startsWith('Replace') || question.startsWith('Type install')) return 'no';
    throw new Error(`Unexpected question: ${question}`);
  };
  await runInstallerFlow({ scope: 'project', project }, { ask: async question => answer(question), output: () => {}, error: () => {}, home: root, recoveryDirectory: join(root, 'recovery') });
  assert.equal(existsSync(join(project, 'opencode.json')), false);
  assert.equal(existsSync(join(root, 'recovery')), false);
});

test('installer deploys missing and explicitly selected command files when configuration needs no receipt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-command-only-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const config = join(project, 'opencode.json');
  const original = JSON.stringify({ agents: Object.fromEntries(nativeRoles.map(role => [role, { model: 'local/model' }])) });
  writeFileSync(config, original);
  const commandDir = join(project, '.opencode', 'commands'); mkdirSync(commandDir, { recursive: true });
  writeFileSync(join(commandDir, 'start-issue.md'), 'user-customized command\n');
  const ask = async (question: string) => {
    if (question.includes(': model ID')) return 'local/model';
    if (question.includes(': reasoning variant')) return '-';
    if (/Replace existing |Make Lead|Also set|Replace customized\/unattributed/.test(question)) return 'no';
    if (question.includes('Replace customized workflow command start-issue')) return 'yes';
    if (question.startsWith('Type install')) return 'install';
    throw new Error(`Unexpected question: ${question}`);
  };
  const outputs: string[] = [];
  await runInstallerFlow({ scope: 'project', project }, {
    ask, output: message => outputs.push(message), error: message => outputs.push(message), home: root,
    recoveryDirectory: join(root, 'recovery'),
    updateConfiguration: () => original,
    verify: async () => { throw new Error('No config update should require runtime verification'); }
  });
  assert.equal(readFileSync(config, 'utf8'), original);
  assert.match(readFileSync(join(commandDir, 'start-issue.md'), 'utf8'), /description: Start approved work on a Jira issue/);
  assert.ok(existsSync(join(commandDir, 'review-pr.md')));
  assert.ok(outputs.some(line => line.includes('Workflow command backup:')));
  assert.equal(existsSync(join(root, 'recovery')), true);
});

test('installer cancellation after selecting customized command replacement writes neither config nor commands', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-command-replace-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const commandDir = join(project, '.opencode', 'commands'); mkdirSync(commandDir, { recursive: true });
  const custom = 'preserve this customized command';
  writeFileSync(join(commandDir, 'start-issue.md'), custom);
  let replacementSelected = false;
  const ask = async (question: string) => {
    if (question.includes(': model ID')) return 'local/model';
    if (question.includes(': reasoning variant')) return '-';
    if (/Replace existing |Make Lead|Also set|Replace customized\/unattributed/.test(question)) return 'no';
    if (question.includes('Replace customized workflow command start-issue')) { replacementSelected = true; return 'yes'; }
    if (question.startsWith('Type install')) return 'cancel';
    throw new Error(`Unexpected question: ${question}`);
  };
  await runInstallerFlow({ scope: 'project', project }, {
    ask, output: () => {}, error: () => {}, home: root, recoveryDirectory: join(root, 'recovery')
  });
  assert.equal(replacementSelected, true);
  assert.equal(readFileSync(join(commandDir, 'start-issue.md'), 'utf8'), custom);
  assert.equal(existsSync(join(commandDir, 'review-pr.md')), false);
  assert.equal(existsSync(join(project, 'opencode.json')), false);
  assert.equal(existsSync(join(root, 'recovery')), false);
});

test('production installer detects a command target changed after preview and preserves the concurrent edit', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-command-race-flow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const original = JSON.stringify({ agents: Object.fromEntries(nativeRoles.map(role => [role, { model: 'local/model' }])) });
  const config = join(project, 'opencode.json'); writeFileSync(config, original);
  let raced = false;
  const ask = async (question: string) => {
    if (question.includes(': model ID')) return 'local/model';
    if (question.includes(': reasoning variant')) return '-';
    if (/Replace existing |Make Lead|Also set|Replace customized/.test(question)) return 'no';
    if (question.startsWith('Type install')) {
      const commandDir = join(project, '.opencode', 'commands'); mkdirSync(commandDir, { recursive: true });
      writeFileSync(join(commandDir, 'start-issue.md'), 'concurrent edit'); raced = true;
      return 'install';
    }
    throw new Error(`Unexpected question: ${question}`);
  };
  await assert.rejects(runInstallerFlow({ scope: 'project', project }, {
    ask, output: () => {}, error: () => {}, home: root, recoveryDirectory: join(root, 'recovery'),
    updateConfiguration: () => original
  }), /changed after preview/i);
  assert.equal(raced, true);
  assert.equal(readFileSync(join(project, '.opencode', 'commands', 'start-issue.md'), 'utf8'), 'concurrent edit');
  assert.equal(existsSync(join(project, '.opencode', 'commands', 'review-pr.md')), false);
  assert.equal(readFileSync(config, 'utf8'), original);
});

test('production installer reports completed command and backup paths when a later command write fails', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-command-partial-flow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const original = JSON.stringify({ agents: Object.fromEntries(nativeRoles.map(role => [role, { model: 'local/model' }])) });
  writeFileSync(join(project, 'opencode.json'), original);
  const commandDir = join(project, '.opencode', 'commands'); mkdirSync(commandDir, { recursive: true });
  writeFileSync(join(commandDir, 'start-issue.md'), 'custom prior command');
  const output: string[] = [];
  const ask = async (question: string) => {
    if (question.includes(': model ID')) return 'local/model';
    if (question.includes(': reasoning variant')) return '-';
    if (/Replace existing |Make Lead|Also set|Replace customized\/unattributed/.test(question)) return 'no';
    if (question.includes('Replace customized workflow command start-issue')) return 'yes';
    if (question.startsWith('Type install')) return 'install';
    throw new Error(`Unexpected question: ${question}`);
  };
  await assert.rejects(runInstallerFlow({ scope: 'project', project }, {
    ask, output: message => output.push(message), error: message => output.push(message), home: root,
    recoveryDirectory: join(root, 'recovery'), updateConfiguration: () => original,
    applyWorkflowCommands: (items, selected, backups, onWritten) => applyOpenCodeCommandDeployment(items, selected, backups, (path, backup) => {
      onWritten?.(path, backup);
      if (path.endsWith('start-issue.md')) mkdirSync(join(commandDir, 'review-pr.md'));
    })
  }));
  assert.ok(output.some(line => line.includes(`Workflow command written: ${join(commandDir, 'start-issue.md')}`)));
  assert.ok(output.some(line => line.includes('Workflow command backup:')));
  assert.ok(output.some(line => line.includes('completed file paths/backups are listed above')));
  assert.ok(existsSync(join(commandDir, 'review-pr.md')));
});

test('injected installer explicitly replaces a preserved model only after its role-specific confirmation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-flow-replace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const config = join(project, 'opencode.json');
  writeFileSync(config, JSON.stringify({ agents: { lead: { model: { providerID: 'custom', model: 'old', variant: 'fast' } } } }));
  const answer = (question: string) => {
    if (question.includes(': model ID')) return 'local/selected#low';
    if (question.includes(': reasoning variant')) return 'low';
    if (question === 'Replace existing lead model?') return 'yes';
    if (question.startsWith('Replace existing ')) return 'no';
    if (question.startsWith('Make Lead') || question.startsWith('Also set') || question.startsWith('Replace customized')) return 'no';
    if (question.startsWith('Type install')) return 'install';
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
  const root = mkdtempSync(join(tmpdir(), 'harness-flow-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const makeAnswers = (target: string) => async (question: string) => {
    if (question.includes(': model ID')) return 'local/model';
    if (question.includes(': reasoning variant')) return '-';
    if (question.startsWith('Make Lead') || question.startsWith('Also set') || question.startsWith('Replace')) return 'no';
    if (question.startsWith('Type install')) return target;
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
  const root = mkdtempSync(join(tmpdir(), 'harness-flow-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'sandbox-home'); const cwd = join(root, 'sandbox-cwd');
  const project = join(home, 'project'); mkdirSync(project, { recursive: true });
  const asks = async (question: string) => { if (question.includes(': model ID')) return 'local/model'; if (question.includes(': reasoning variant')) return '-'; if (/Replace|Make Lead|Also set/.test(question)) return 'no'; if (question.startsWith('Type install')) return 'cancel'; throw new Error(question); };
  await runInstallerFlow({ scope: 'project', project: '~/project', config: '$HOME/project/opencode.json' }, { ask: asks, output: () => {}, error: () => {}, home, cwd, recoveryDirectory: join(root, 'recovery') }).catch(error => { throw error; });
  assert.equal(existsSync(join(project, 'opencode.json')), false);
  assert.equal(existsSync(join(cwd, 'project')), false);
});

test('installer pending-write and finalization failures retain the expected evidence state', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-flow-failures-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const makeAnswer = (config: string) => async (question: string) => {
    if (question.includes(': model ID')) return 'local/model';
    if (question.includes(': reasoning variant')) return '-';
    if (/Replace|Make Lead|Also set/.test(question)) return 'no';
    if (question.startsWith('Type install')) return 'install';
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
  const root = mkdtempSync(join(tmpdir(), 'harness-flow-noop-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project); const recovery = join(root, 'recovery');
  const answer = async (question: string) => {
    if (question.includes(': model ID')) return 'local/model'; if (question.includes(': reasoning variant')) return '-';
    if (/Replace|Make Lead|Also set/.test(question)) return 'no'; if (question.startsWith('Type install')) return 'install';
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
    const root = mkdtempSync(join(tmpdir(), 'harness-flow-obsolete-'));
    try {
      const project = join(root, 'project'); mkdirSync(project); const recovery = join(root, 'recovery');
      const source = loadNativeDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));
      const obsolete = source.external.permissions[0];
      assert.ok(obsolete);
      const askInitial = async (question: string) => {
        if (question.includes(': model ID')) return 'local/model'; if (question.includes(': reasoning variant')) return '-';
        if (/Replace|Make Lead|Also set/.test(question)) return 'no'; if (question.startsWith('Type install')) return 'install';
        throw new Error(question);
      };
      const deps = { ask: askInitial, output: () => {}, error: () => {}, home: root, recoveryDirectory: recovery, verify: async () => ({ ok: true } as never), printReport: () => {} };
      await runInstallerFlow({ scope: 'project', project }, deps);
      const changed = { ...source, external: { ...source.external, permissions: source.external.permissions.filter(rule => rule !== obsolete) } };
      const askUpgrade = async (question: string) => {
        if (question.includes(': model ID')) return 'local/model'; if (question.includes(': reasoning variant')) return '-';
        if (question.startsWith('Remove obsolete owned external permission')) return remove ? 'yes' : 'no';
        if (/Replace|Make Lead|Also set/.test(question)) return 'no'; if (question.startsWith('Type install')) return 'install';
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
  const root = mkdtempSync(join(tmpdir(), 'harness-flow-retry-'));
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
    if (question.startsWith('Type install')) return 'cancel';
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
  const root = mkdtempSync(join(tmpdir(), 'harness global paths '));
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
    if (/Replace|Make Lead|Also set/.test(question)) return 'no';
    if (question.startsWith('Type install')) return 'cancel';
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
