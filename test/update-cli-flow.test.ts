import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRoot } from './temp-directory.ts';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import { nativeRoles, parseConfiguration } from '../src/native-installer.ts';
import type { PermissionRule } from '../src/permission-reconciliation.ts';
import { discoverReceiptChain } from '../src/receipt-lineage.ts';
import { createSuccessorReceipt, finalizeSuccessor, writePendingSuccessor } from '../src/receipt-lineage.ts';
import { loadNativeDefinitions, updateNativeConfiguration } from '../src/native-installer.ts';

function createDummyInstalledConfig(): Record<string, unknown> {
  return {
    agents: Object.fromEntries(
      nativeRoles.map(role => [
        role,
        {
          description: `Custom desc of ${role}`,
          mode: role === 'lead' ? 'primary' : 'subagent',
          model: 'custom/model#low',
          permissions: [],
          system: `Old system prompt for ${role}`,
          customField: 'keep-custom'
        }
      ])
    )
  };
}

test('update flow cancellation makes no configuration or recovery writes', async t => {
  const root = makeTempRoot('harness-update-cancel-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const config = join(project, 'opencode.json');
  const initialJson = JSON.stringify(createDummyInstalledConfig(), null, 2);
  writeFileSync(config, initialJson);

  const answer = (question: string) => {
    if (question.startsWith('Check remote')) return 'no';
    if (question.includes('system prompt to latest')) return 'no';
    if (question.startsWith('Type update')) return 'cancel';
    throw new Error(`Unexpected question: ${question}`);
  };

  const output: string[] = [];
  const status = await runUpdateFlow(
    { scope: 'project', project },
    {
      ask: async q => answer(q),
      output: text => output.push(text),
      error: text => output.push(text),
      home: root,
      recoveryDirectory: join(root, 'recovery'),
      runCommand: () => ''
    }
  );

  assert.equal(status, 0);
  assert.equal(readFileSync(config, 'utf8'), initialJson);
  assert.equal(existsSync(join(project, '.opencode', 'commands', 'start-issue.md')), false);
  assert.equal(existsSync(join(root, 'recovery')), false);
  assert.ok(output.some(line => line.includes('Update cancelled. No files or receipts were modified.')));
});

test('permission conflicts block update before prompts and preserve all artifacts', async t => {
  const root = makeTempRoot('harness-update-permission-conflict-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const config = join(project, '.opencode', 'opencode.jsonc'); mkdirSync(join(project, '.opencode'));
  const definitions = loadNativeDefinitions(join(process.cwd(), 'agents'));
  const dummy = createDummyInstalledConfig();
  const agents = dummy.agents as Record<string, Record<string, unknown>>;
  const desired = definitions.lead.permissions[0] as PermissionRule | undefined;
  assert.ok(desired && ['allow', 'ask', 'deny'].includes(desired.effect));
  agents.lead!.permissions = [{ ...desired, effect: desired.effect === 'deny' ? 'allow' : 'deny' } satisfies PermissionRule];
  const recovery = join(root, 'recovery');
  const baseline = JSON.stringify(dummy, null, 2);
  writeFileSync(config, baseline);
  const permissionPlans = Object.fromEntries(nativeRoles.map(role => {
    const rules = ((parseConfiguration(baseline, config).agents as Record<string, Record<string, unknown>>)[role]?.permissions ?? []) as import('../src/permission-reconciliation.ts').PermissionRule[];
    return [role, { rules, provenance: [], preview: { additions: [], removals: [], retainedObsolete: [], order: rules, conflicts: [] } }];
  })) as never;
  const chain = discoverReceiptChain(recovery, config, 'opencode');
  finalizeSuccessor(writePendingSuccessor(chain, createSuccessorReceipt(chain, undefined, baseline, permissionPlans, undefined, { host: 'opencode' })), baseline);
  const receiptFiles = (await import('node:fs')).readdirSync(recovery).map(name => [name, readFileSync(join(recovery, name))] as const);
  const initial = JSON.stringify(dummy, null, 2);
  writeFileSync(config, initial);
  const errors: string[] = [];
  const questions: string[] = [];
  let updates = 0, verifications = 0;
  const status = await runUpdateFlow({ scope: 'project', project, config, checkRemote: false }, {
    ask: async question => { questions.push(question); throw new Error(`Unexpected prompt: ${question}`); },
    output: () => {}, error: text => errors.push(text), home: root, recoveryDirectory: recovery,
    updateConfiguration: ((...args: Parameters<typeof updateNativeConfiguration>) => { updates++; return updateNativeConfiguration(...args); }),
    verify: async () => { verifications++; return { ok: true, checks: [] } as never; },
    runCommand: (_cmd, args) => args[0] === 'rev-parse' ? '1111222233334444' : ''
  });
  assert.equal(status, 2);
  assert.deepEqual(questions, []);
  assert.equal(updates, 0); assert.equal(verifications, 0);
  assert.equal(readFileSync(config, 'utf8'), initial);
  assert.deepEqual((await import('node:fs')).readdirSync(recovery), receiptFiles.map(([name]) => name));
  for (const [name, bytes] of receiptFiles) assert.deepEqual(readFileSync(join(recovery, name)), bytes);
  assert.equal(existsSync(join(project, '.opencode', 'commands')), false);
  assert.ok(errors.some(line => line.includes(config)));
  assert.ok(errors.some(line => line.includes('[lead] identity:')));
});

test('global receipt-free conflict at alternate JSONC path with spaces retries invalid scope', async t => {
  const root = makeTempRoot('harness-update-global-conflict-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const xdg = join(root, 'global settings'); mkdirSync(join(xdg, 'opencode'), { recursive: true });
  const config = join(xdg, 'opencode', 'opencode.jsonc');
  const project = join(root, 'unused project'); mkdirSync(project);
  const definitions = loadNativeDefinitions(join(process.cwd(), 'agents'));
  const dummy = createDummyInstalledConfig();
  const agents = dummy.agents as Record<string, Record<string, unknown>>;
  const desired = definitions.operator.permissions[0] as PermissionRule | undefined;
  assert.ok(desired && ['allow', 'ask', 'deny'].includes(desired.effect));
  agents.operator!.permissions = [{ ...desired, effect: desired.effect === 'deny' ? 'allow' : 'deny' } satisfies PermissionRule];
  const initial = JSON.stringify(dummy, null, 2);
  writeFileSync(config, initial);
  const recovery = join(root, 'recovery');
  const questions: string[] = [], errors: string[] = [];
  let scopeAnswers = 0;
  const status = await runUpdateFlow({ config, checkRemote: false }, {
    ask: async question => {
      questions.push(question);
      if (question.startsWith('Update scope:')) return scopeAnswers++ === 0 ? 'invalid' : 'global';
      throw new Error(question);
    },
    output: () => {}, error: text => errors.push(text), home: root, xdgConfigHome: xdg,
    recoveryDirectory: recovery, runCommand: (_cmd, args) => args[0] === 'rev-parse' ? '1111222233334444' : ''
  });
  assert.equal(status, 2);
  assert.deepEqual(questions, ['Update scope: project or global', 'Update scope: project or global']);
  assert.equal(readFileSync(config, 'utf8'), initial);
  assert.equal(existsSync(recovery), false);
  assert.equal(existsSync(join(xdg, 'opencode', 'commands')), false);
  assert.ok(errors.some(line => line.includes(`permission conflicts in ${config}`)));
  assert.ok(errors.some(line => line.includes('[operator] identity:')));
});

test('blank and unknown final answers cancel without writes or recovery artifacts', async t => {
  const root = makeTempRoot('harness-update-cancel-answers-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const finalAnswer of ['', 'not update']) {
    const project = join(root, finalAnswer ? 'unknown' : 'blank'); mkdirSync(project);
    const config = join(project, 'opencode.json');
    const initial = JSON.stringify(createDummyInstalledConfig()); writeFileSync(config, initial);
    const recovery = join(root, `recovery-${finalAnswer ? 'unknown' : 'blank'}`);
    const status = await runUpdateFlow({ scope: 'project', project, checkRemote: false }, {
      ask: async question => question.startsWith('Type update') ? finalAnswer : question.includes('system prompt to latest') ? 'no' : (() => { throw new Error(question); })(),
      output: () => {}, error: () => {}, home: root, recoveryDirectory: recovery,
      runCommand: (_cmd, args) => args[0] === 'rev-parse' ? '1111222233334444' : ''
    });
    assert.equal(status, 0);
    assert.equal(readFileSync(config, 'utf8'), initial);
    assert.equal(existsSync(recovery), false);
    assert.equal(existsSync(join(project, '.opencode', 'commands')), false);
  }
});

test('update flow default-on-Enter keeps installed system prompt', async t => {
  const root = makeTempRoot('harness-update-default-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const config = join(project, 'opencode.json');
  const dummy = createDummyInstalledConfig();
  writeFileSync(config, JSON.stringify(dummy, null, 2));

  const answer = (question: string) => {
    if (question.startsWith('Check remote')) return 'no';
    // Empty string simulates pressing Enter on default [no]
    if (question.includes('system prompt to latest')) return '';
    if (question.startsWith('Type update')) return 'update';
    throw new Error(`Unexpected question: ${question}`);
  };

  const output: string[] = [];
  const status = await runUpdateFlow(
    { scope: 'project', project },
    {
      ask: async q => answer(q),
      output: text => output.push(text),
      error: text => output.push(text),
      home: root,
      recoveryDirectory: join(root, 'recovery'),
      runCommand: (cmd, args) => {
        if (args[0] === 'rev-parse') return '1111222233334444';
        return '';
      },
      verify: async () => ({ ok: true, checks: [] } as never),
      printReport: () => {}
    }
  );

  assert.equal(status, 0);
  const saved = parseConfiguration(readFileSync(config, 'utf8'), config);
  const agents = saved.agents as Record<string, Record<string, unknown>>;
  // lead system prompt was kept as Old system prompt
  assert.equal(agents.lead?.system, 'Old system prompt for lead');
  // custom field preserved
  assert.equal(agents.lead?.customField, 'keep-custom');
  // model preserved
  assert.equal(agents.lead?.model, 'custom/model#low');
});

test('missing role permission preview agrees with saved rules and final order', async t => {
  const root = makeTempRoot('harness-update-missing-role-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const config = join(project, 'opencode.json');
  const dummy = createDummyInstalledConfig();
  delete (dummy.agents as Record<string, unknown>).lead;
  writeFileSync(config, JSON.stringify(dummy, null, 2));
  const output: string[] = [];
  const status = await runUpdateFlow({ scope: 'project', project }, {
    ask: async question => question.startsWith('Check remote') ? 'no' : question.includes('system prompt to latest') ? 'no' : question.startsWith('Type update') ? 'update' : (() => { throw new Error(question); })(),
    output: text => output.push(text), error: text => output.push(text), home: root,
    recoveryDirectory: join(root, 'recovery'),
    runCommand: (_cmd, args) => args[0] === 'rev-parse' ? '1111222233334444' : '',
    verify: async () => ({ ok: true, checks: [] } as never), printReport: () => {}
  });
  assert.equal(status, 0);
  const saved = parseConfiguration(readFileSync(config, 'utf8'), config).agents as Record<string, Record<string, unknown>>;
  const permissions = saved.lead!.permissions as unknown[];
  assert.ok(permissions.length > 0);
  const previewLines = output.join('\n').split('\n');
  const previewStart = previewLines.indexOf('Final permission rule order from the saved-configuration plan:');
  assert.notEqual(previewStart, -1);
  const leadHeader = previewLines.findIndex((line, index) => index > previewStart && line === '  [lead]');
  assert.notEqual(leadHeader, -1);
  const nextRole = previewLines.findIndex((line, index) => index > leadHeader && /^  \[/.test(line));
  assert.deepEqual(previewLines.slice(leadHeader + 1, nextRole === -1 ? undefined : nextRole),
    permissions.map(rule => `    ${JSON.stringify(rule)}`));
  assert.deepEqual(permissions, loadNativeDefinitions(join(process.cwd(), 'agents')).lead.permissions);
});

test('receipt-managed prompt remains unchanged when prompt update is declined', async t => {
  const root = makeTempRoot('harness-update-receipt-decline-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const config = join(project, 'opencode.json');
  const agentsDirectory = join(root, 'agents'); mkdirSync(agentsDirectory);
  const sourceDefinitions = loadNativeDefinitions(join(process.cwd(), 'agents'));
  const agents = structuredClone(sourceDefinitions);
  const initial = updateNativeConfiguration(JSON.stringify({ agents: {} }), agents,
    Object.fromEntries(nativeRoles.map(role => [role, agents[role].model])) as Record<typeof nativeRoles[number], string>, false);
  writeFileSync(config, initial);
  const recovery = join(root, 'recovery');
  const before = readFileSync(config, 'utf8');
  const permissionPlans = Object.fromEntries(nativeRoles.map(role => {
    const rules = (parseConfiguration(before, config).agents as Record<string, Record<string, unknown>>)[role]!.permissions as import('../src/permission-reconciliation.ts').PermissionRule[];
    return [role, { rules, provenance: [], preview: { additions: [], removals: [], retainedObsolete: [], order: rules, conflicts: [] } }];
  })) as never;
  const successor = createSuccessorReceipt(discoverReceiptChain(recovery, config), undefined, before, permissionPlans);
  const pending = writePendingSuccessor(discoverReceiptChain(recovery, config), successor);
  finalizeSuccessor(pending, before);

  const installedPrompt = (parseConfiguration(before, config).agents as Record<string, Record<string, unknown>>).lead!.system;
  agents.lead.system = `${agents.lead.system}\nsource template changed line`;
  const output: string[] = [];
  const invoke = (promptAnswer: string) => runUpdateFlow({ scope: 'project', project }, {
    ask: async question => question.startsWith('Check remote') ? 'no' : question.includes('system prompt to latest') ? promptAnswer : question.startsWith('Type update') ? 'update' : (() => { throw new Error(question); })(),
    output: text => output.push(text), error: () => {}, home: root, recoveryDirectory: recovery,
    agentsDirectory,
    loadDefinitions: () => agents,
    runCommand: (_cmd, args) => args[0] === 'rev-parse' ? '1111222233334444' : '',
    verify: async () => ({ ok: true, checks: [] } as never), printReport: () => {}
  });
  await invoke('no');
  const after = parseConfiguration(readFileSync(config, 'utf8'), config).agents as Record<string, Record<string, unknown>>;
  assert.equal(after.lead!.system, installedPrompt);
  assert.ok(output.some(line => line.includes('+ source template changed line')));
  const leadRules = after.lead!.permissions as unknown[];
  assert.deepEqual(leadRules, agents.lead.permissions);
  const previewLines = output.join('\n').split('\n');
  const previewStart = previewLines.indexOf('Final permission rule order from the saved-configuration plan:');
  assert.notEqual(previewStart, -1);
  const leadHeader = previewLines.findIndex((line, index) => index > previewStart && line === '  [lead]');
  assert.notEqual(leadHeader, -1);
  const nextRole = previewLines.findIndex((line, index) => index > leadHeader && /^  \[/.test(line));
  assert.deepEqual(previewLines.slice(leadHeader + 1, nextRole === -1 ? undefined : nextRole),
    leadRules.map(rule => `    ${JSON.stringify(rule)}`));

  writeFileSync(config, before);
  output.length = 0;
  await invoke('');
  const afterEnter = parseConfiguration(readFileSync(config, 'utf8'), config).agents as Record<string, Record<string, unknown>>;
  assert.equal(afterEnter.lead!.system, installedPrompt);
  assert.deepEqual(afterEnter.lead!.permissions, agents.lead.permissions);
  const enterLines = output.join('\n').split('\n');
  const enterPreviewStart = enterLines.indexOf('Final permission rule order from the saved-configuration plan:');
  assert.notEqual(enterPreviewStart, -1);
  const enterLeadHeader = enterLines.findIndex((line, index) => index > enterPreviewStart && line === '  [lead]');
  assert.notEqual(enterLeadHeader, -1);
  const enterNextRole = enterLines.findIndex((line, index) => index > enterLeadHeader && /^  \[/.test(line));
  assert.deepEqual(enterLines.slice(enterLeadHeader + 1, enterNextRole === -1 ? undefined : enterNextRole),
    (afterEnter.lead!.permissions as unknown[]).map(rule => `    ${JSON.stringify(rule)}`));
  assert.ok(output.some(line => line.includes('+ source template changed line')));
});

test('update flow applies prompt when explicitly selected and records harness version stamp', async t => {
  const root = makeTempRoot('harness-update-apply-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const config = join(project, 'opencode.json');
  const dummy = createDummyInstalledConfig();
  writeFileSync(config, JSON.stringify(dummy, null, 2));

  const answer = (question: string) => {
    if (question.startsWith('Check remote')) return 'no';
    if (question.includes('Update lead system prompt')) return 'yes';
    if (question.includes('system prompt to latest')) return 'no';
    if (question.startsWith('Type update')) return 'update';
    throw new Error(`Unexpected question: ${question}`);
  };

  const output: string[] = [];
  const status = await runUpdateFlow(
    { scope: 'project', project },
    {
      ask: async q => answer(q),
      output: text => output.push(text),
      error: text => output.push(text),
      home: root,
      recoveryDirectory: join(root, 'recovery'),
      runCommand: (cmd, args) => {
        if (args[0] === 'rev-parse') return 'deadbeef1234';
        if (args[0] === 'status') return '';
        return '';
      },
      verify: async () => ({ ok: true, checks: [] } as never),
      printReport: () => {}
    }
  );

  assert.equal(status, 0);
  const saved = parseConfiguration(readFileSync(config, 'utf8'), config);
  const agents = saved.agents as Record<string, Record<string, unknown>>;
  // Lead prompt was updated away from Old system prompt
  assert.notEqual(agents.lead?.system, 'Old system prompt for lead');
  // Other roles were kept
  assert.equal(agents.operator?.system, 'Old system prompt for operator');

  // Verify finalized v2 receipt contains harnessVersion stamp
  const chain = discoverReceiptChain(join(root, 'recovery'), config);
  assert.ok(chain.head);
  assert.equal(chain.head.receipt.version, 2);
  assert.deepEqual(chain.head.receipt.harnessVersion, {
    version: '0.1.0',
    commit: 'deadbeef1234'
  });
});

test('update flow checkRemote reports newer remote version and prints pull guidance without pulling', async t => {
  const root = makeTempRoot('harness-update-remote-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const config = join(project, 'opencode.json');
  writeFileSync(config, JSON.stringify(createDummyInstalledConfig(), null, 2));

  const answer = (question: string) => {
    if (question.startsWith('Check remote')) return 'yes';
    if (question.includes('system prompt to latest')) return 'no';
    if (question.startsWith('Type update')) return 'cancel';
    throw new Error(`Unexpected question: ${question}`);
  };

  const output: string[] = [];
  await runUpdateFlow(
    { scope: 'project', project },
    {
      ask: async q => answer(q),
      output: text => output.push(text),
      error: text => output.push(text),
      home: root,
      recoveryDirectory: join(root, 'recovery'),
      runCommand: (cmd, args) => {
        if (args[0] === 'ls-remote') return 'ffffffffffffffffffffffffffffffffffffffff\trefs/heads/main';
        if (args[0] === 'rev-parse') return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        if (args[0] === 'merge-base' && args[1] === '--is-ancestor' && args[2] === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' && args[3] === 'ffffffffffffffffffffffffffffffffffffffff') return '';
        throw new Error('git error');
      }
    }
  );

  assert.ok(output.some(line => line.includes('NOTICE: A newer version of the harness is available on origin/main.')));
  assert.ok(output.some(line => line.includes('git pull origin main')));
});

test('update flow pending-write or finalization failure retains pending recovery evidence', async t => {
  const root = makeTempRoot('harness-update-fail-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const config = join(project, 'opencode.json');
  writeFileSync(config, JSON.stringify(createDummyInstalledConfig(), null, 2));

  const answer = (question: string) => {
    if (question.startsWith('Check remote')) return 'no';
    if (question.includes('system prompt to latest')) return 'no';
    if (question.startsWith('Type update')) return 'update';
    throw new Error(`Unexpected question: ${question}`);
  };

  const output: string[] = [];
  await assert.rejects(
    async () => {
      await runUpdateFlow(
        { scope: 'project', project },
        {
          ask: async q => answer(q),
          output: text => output.push(text),
          error: text => output.push(text),
          home: root,
          recoveryDirectory: join(root, 'recovery'),
          runCommand: (cmd, args) => {
            if (args[0] === 'rev-parse') return '1111222233334444';
            return '';
          },
          finalize: () => { throw new Error('simulated finalization failure'); }
        }
      );
    },
    /simulated finalization failure/
  );

  assert.ok(output.some(line => line.includes('receipt finalization failed; pending evidence retained')));
});

test('update flow adds missing commands, records managedFiles in receipt, and uninstall removes them', async t => {
  const root = makeTempRoot('harness-update-missing-commands-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const config = join(project, 'opencode.json');
  const dummy = createDummyInstalledConfig();
  writeFileSync(config, JSON.stringify(dummy, null, 2));
  const recovery = join(root, 'recovery');
  const commandsDir = join(project, '.opencode', 'commands');

  const answer = (question: string) => {
    if (question.startsWith('Check remote')) return 'no';
    if (question.includes('system prompt to latest')) return 'no';
    if (question.startsWith('Type update')) return 'update';
    throw new Error(`Unexpected question: ${question}`);
  };

  const status = await runUpdateFlow(
    { scope: 'project', project },
    {
      ask: async q => answer(q),
      output: () => {},
      error: () => {},
      home: root,
      recoveryDirectory: recovery,
      runCommand: (cmd, args) => args[0] === 'rev-parse' ? '1111222233334444' : '',
      verify: async () => ({ ok: true, checks: [] } as never),
      printReport: () => {},
    }
  );

  assert.equal(status, 0);
  assert.ok(existsSync(commandsDir));
  assert.ok(existsSync(join(commandsDir, 'start-issue.md')));

  const chain = discoverReceiptChain(recovery, config, 'opencode');
  assert.ok(chain.head);
  assert.equal(chain.head.receipt.version, 2);
  assert.ok(Array.isArray(chain.head.receipt.managedFiles));
  assert.equal(chain.head.receipt.managedFiles.length, 6);
  for (const f of chain.head.receipt.managedFiles) {
    assert.equal(f.kind, 'commands');
    assert.ok('absent' in f.before && f.before.absent === true);
    assert.ok('content' in f.after && typeof f.after.content === 'string');
    assert.ok('digest' in f.after && typeof f.after.digest === 'string');
  }

  // Now run uninstall - all added commands must be removed cleanly
  const { runUninstallFlow } = await import('../src/uninstall-cli-flow.ts');
  const { readReceiptForRestore } = await import('../src/receipt-lineage.ts');
  const receipt = readReceiptForRestore(join(recovery, chain.head.file), config);
  const currentConfig = readFileSync(config, 'utf8');

  const uninstallStatus = await runUninstallFlow({
    receipt,
    current: currentConfig,
    confirm: async () => 'uninstall',
    output: () => {},
    error: err => { throw new Error(err); },
    save: updated => writeFileSync(config, updated, 'utf8'),
    backupParent: join(root, 'backups'),
    host: 'opencode',
  });

  assert.equal(uninstallStatus, 0);
  assert.equal(existsSync(join(commandsDir, 'start-issue.md')), false);
});

test('update flow auto-updates untouched older generated commands and updates receipt after state', async t => {
  const root = makeTempRoot('harness-update-outdated-commands-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const config = join(project, 'opencode.json');
  const dummy = createDummyInstalledConfig();
  writeFileSync(config, JSON.stringify(dummy, null, 2));
  const recovery = join(root, 'recovery');
  const commandsDir = join(project, '.opencode', 'commands');
  mkdirSync(commandsDir, { recursive: true });

  const oldContent = '---\ndescription: Start approved work on a Jira issue\n---\nOld start issue content\n';
  const { createHash } = await import('node:crypto');
  const oldHash = createHash('sha256').update(oldContent).digest('hex');
  writeFileSync(join(commandsDir, 'start-issue.md'), oldContent);

  // Initial receipt with start-issue as managed file
  const beforeConfig = readFileSync(config, 'utf8');
  const permissionPlans = Object.fromEntries(nativeRoles.map(role => {
    const rules = ((parseConfiguration(beforeConfig, config).agents as Record<string, Record<string, unknown>>)[role]?.permissions ?? []) as import('../src/permission-reconciliation.ts').PermissionRule[];
    return [role, { rules, provenance: [], preview: { additions: [], removals: [], retainedObsolete: [], order: rules, conflicts: [] } }];
  })) as never;
  const initialReceipt = createSuccessorReceipt(
    discoverReceiptChain(recovery, config, 'opencode'),
    undefined,
    beforeConfig,
    permissionPlans,
    undefined,
    {
      host: 'opencode',
      managedFiles: [
        {
          path: join(commandsDir, 'start-issue.md'),
          kind: 'commands',
          before: { absent: true },
          after: { content: oldContent, digest: oldHash },
        }
      ]
    }
  );
  const pendingInitial = writePendingSuccessor(discoverReceiptChain(recovery, config, 'opencode'), initialReceipt);
  finalizeSuccessor(pendingInitial, beforeConfig);

  const answer = (question: string) => {
    if (question.startsWith('Check remote')) return 'no';
    if (question.includes('system prompt to latest')) return 'no';
    if (question.includes('Replace customized workflow command')) {
      throw new Error(`Untouched older command should not prompt for replacement: ${question}`);
    }
    if (question.startsWith('Type update')) return 'update';
    throw new Error(`Unexpected question: ${question}`);
  };

  const output: string[] = [];
  const status = await runUpdateFlow(
    { scope: 'project', project },
    {
      ask: async q => answer(q),
      output: text => output.push(text),
      error: text => output.push(text),
      home: root,
      recoveryDirectory: recovery,
      runCommand: (cmd, args) => args[0] === 'rev-parse' ? '1111222233334444' : '',
      verify: async () => ({ ok: true, checks: [] } as never),
      printReport: () => {},
    }
  );

  assert.equal(status, 0);
  assert.ok(output.some(line => line.includes('start-issue: outdated')));
  assert.notEqual(readFileSync(join(commandsDir, 'start-issue.md'), 'utf8'), oldContent);

  const chain = discoverReceiptChain(recovery, config, 'opencode');
  assert.ok(chain.head);
  const headReceipt = chain.head.receipt;
  assert.equal(headReceipt.version, 2);
  const startIssueEntry = headReceipt.managedFiles?.find(f => f.path.endsWith('start-issue.md'));
  assert.ok(startIssueEntry);
  assert.ok('absent' in startIssueEntry.before && startIssueEntry.before.absent === true);
  assert.ok('content' in startIssueEntry.after && startIssueEntry.after.content !== oldContent);
  assert.equal(startIssueEntry.after.content, readFileSync(join(commandsDir, 'start-issue.md'), 'utf8'));

  // Uninstall restores clean state (removes start-issue since before was absent)
  const { runUninstallFlow } = await import('../src/uninstall-cli-flow.ts');
  const { readReceiptForRestore } = await import('../src/receipt-lineage.ts');
  const receipt = readReceiptForRestore(join(recovery, chain.head.file), config);
  const uninstallStatus = await runUninstallFlow({
    receipt,
    current: readFileSync(config, 'utf8'),
    confirm: async () => 'uninstall',
    output: () => {},
    error: err => { throw new Error(err); },
    save: updated => writeFileSync(config, updated, 'utf8'),
    backupParent: join(root, 'backups'),
    host: 'opencode',
  });
  assert.equal(uninstallStatus, 0);
  assert.equal(existsSync(join(commandsDir, 'start-issue.md')), false);
});

test('update flow partial command write failure retains pending recovery evidence', async t => {
  const root = makeTempRoot('harness-update-partial-fail-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const config = join(project, 'opencode.json');
  const dummy = createDummyInstalledConfig();
  writeFileSync(config, JSON.stringify(dummy, null, 2));
  const recovery = join(root, 'recovery');
  const commandsDir = join(project, '.opencode', 'commands');
  mkdirSync(commandsDir, { recursive: true });

  const answer = (question: string) => {
    if (question.startsWith('Check remote')) return 'no';
    if (question.includes('system prompt to latest')) return 'no';
    if (question.startsWith('Type update')) return 'update';
    throw new Error(`Unexpected question: ${question}`);
  };

  const errors: string[] = [];
  await assert.rejects(
    runUpdateFlow(
      { scope: 'project', project },
      {
        ask: async q => answer(q),
        output: () => {},
        error: text => errors.push(text),
        home: root,
        recoveryDirectory: recovery,
        applyWorkflowCommands: (plan, selections, backupParent, onFileWritten) => {
          // Write one command to simulate partial success
          const target = join(commandsDir, 'start-issue.md');
          writeFileSync(target, 'partial command written', 'utf8');
          onFileWritten?.(target);
          throw new Error('simulated disk full during command writes');
        },
        runCommand: (cmd, args) => args[0] === 'rev-parse' ? '1111222233334444' : '',
        verify: async () => ({ ok: true, checks: [] } as never),
        printReport: () => {},
      }
    ),
    /simulated disk full/
  );

  const { readdirSync } = await import('node:fs');
  const receipts = readdirSync(recovery).filter(n => n.endsWith('.json'));
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(readFileSync(join(recovery, receipts[0]!), 'utf8'));
  assert.equal(receipt.status, 'pending');
  assert.ok(errors.some(e => e.includes('pending recovery evidence retained')));
});
