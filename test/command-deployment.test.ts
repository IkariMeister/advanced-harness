import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRoot } from './temp-directory.ts';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { runUninstallFlow } from '../src/uninstall-cli-flow.ts';
import { discoverReceiptChain, readReceiptForRestore } from '../src/receipt-lineage.ts';
import { canonicalWorkflowCommands, loadWorkflowCommands, planCommandDeployment, filterCommandPlanForExecution } from '../src/command-deployment.ts';

test('loadWorkflowCommands loads all 6 canonical commands', () => {
  const sourceDir = fileURLToPath(new URL('../.opencode/commands/', import.meta.url));
  const commands = loadWorkflowCommands(sourceDir);
  assert.equal(commands.length, 6);
  assert.deepEqual(commands.map(c => c.filename).sort(), [...canonicalWorkflowCommands].sort());
  for (const cmd of commands) {
    assert.ok(cmd.content.length > 0);
  }
});

test('installer flow in project scope deploys commands and records managedFiles in v2 receipt', async t => {
  const root = makeTempRoot('harness-cmd-deploy-project-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const recovery = join(root, 'recovery');
  const commandsDir = join(project, '.opencode', 'commands');

  const answer = (question: string) => {
    if (question.includes(': model ID')) return 'local/model#low';
    if (question.includes(': reasoning variant')) return '-';
    if (question.startsWith('Install workflow slash commands')) return 'yes';
    if (/Replace|Make Lead|Also set/.test(question)) return 'no';
    if (question.startsWith('Type install')) return 'install';
    throw new Error(`Unexpected question: ${question}`);
  };

  const output: string[] = [];
  const status = await runInstallerFlow(
    { scope: 'project', project },
    {
      ask: async q => answer(q),
      output: text => output.push(text),
      error: text => output.push(text),
      home: root,
      recoveryDirectory: recovery,
      verify: async () => ({ ok: true, checks: [] } as never),
      printReport: () => {},
    }
  );

  assert.equal(status, 0);
  assert.ok(existsSync(commandsDir));
  for (const name of canonicalWorkflowCommands) {
    assert.ok(existsSync(join(commandsDir, name)));
  }

  const { readdirSync } = await import('node:fs');
  const receipts = readdirSync(recovery).filter(n => n.endsWith('.json'));
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(readFileSync(join(recovery, receipts[0]!), 'utf8'));
  assert.equal(receipt.version, 2);
  assert.ok(Array.isArray(receipt.managedFiles));
  assert.equal(receipt.managedFiles.length, 6);
  for (const f of receipt.managedFiles) {
    assert.equal(f.kind, 'commands');
    assert.equal(f.before.absent, true);
    assert.ok(typeof f.after.content === 'string');
    assert.ok(typeof f.after.digest === 'string');
  }
});

test('installer flow in global scope deploys commands to global commands directory', async t => {
  const root = makeTempRoot('harness-cmd-deploy-global-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const xdg = join(root, 'xdg');
  const globalCommandsDir = join(xdg, 'opencode', 'commands');
  const recovery = join(root, 'recovery');

  const answer = (question: string) => {
    if (question.includes(': model ID')) return 'local/model#low';
    if (question.includes(': reasoning variant')) return '-';
    if (question.startsWith('Install workflow slash commands')) return 'yes';
    if (/Replace|Make Lead|Also set/.test(question)) return 'no';
    if (question.startsWith('Type install')) return 'install';
    throw new Error(`Unexpected question: ${question}`);
  };

  const output: string[] = [];
  const status = await runInstallerFlow(
    { scope: 'global' },
    {
      ask: async q => answer(q),
      output: text => output.push(text),
      error: text => output.push(text),
      home: root,
      xdgConfigHome: xdg,
      recoveryDirectory: recovery,
      verify: async () => ({ ok: true, checks: [] } as never),
      printReport: () => {},
    }
  );

  assert.equal(status, 0);
  assert.ok(existsSync(globalCommandsDir));
  for (const name of canonicalWorkflowCommands) {
    assert.ok(existsSync(join(globalCommandsDir, name)));
  }
});

test('answering no to workflow commands prompt leaves commands folder untouched and omits managedFiles', async t => {
  const root = makeTempRoot('harness-cmd-deploy-no-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const recovery = join(root, 'recovery');
  const commandsDir = join(project, '.opencode', 'commands');

  const answer = (question: string) => {
    if (question.includes(': model ID')) return 'local/model#low';
    if (question.includes(': reasoning variant')) return '-';
    if (question.startsWith('Install workflow slash commands')) return 'no';
    if (/Replace|Make Lead|Also set/.test(question)) return 'no';
    if (question.startsWith('Type install')) return 'install';
    throw new Error(`Unexpected question: ${question}`);
  };

  await runInstallerFlow(
    { scope: 'project', project },
    {
      ask: async q => answer(q),
      output: () => {},
      error: () => {},
      home: root,
      recoveryDirectory: recovery,
      verify: async () => ({ ok: true, checks: [] } as never),
      printReport: () => {},
    }
  );

  assert.equal(existsSync(commandsDir), false);
  const { readdirSync } = await import('node:fs');
  const receipts = readdirSync(recovery).filter(n => n.endsWith('.json'));
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(readFileSync(join(recovery, receipts[0]!), 'utf8'));
  assert.equal(receipt.managedFiles, undefined);
});

test('cancellation at final confirmation creates no commands files, backups, or receipts', async t => {
  const root = makeTempRoot('harness-cmd-deploy-cancel-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const recovery = join(root, 'recovery');
  const commandsDir = join(project, '.opencode', 'commands');

  const answer = (question: string) => {
    if (question.includes(': model ID')) return 'local/model#low';
    if (question.includes(': reasoning variant')) return '-';
    if (question.startsWith('Install workflow slash commands')) return 'yes';
    if (/Replace|Make Lead|Also set/.test(question)) return 'no';
    if (question.startsWith('Type install')) return 'cancel';
    throw new Error(`Unexpected question: ${question}`);
  };

  await runInstallerFlow(
    { scope: 'project', project },
    {
      ask: async q => answer(q),
      output: () => {},
      error: () => {},
      home: root,
      recoveryDirectory: recovery,
    }
  );

  assert.equal(existsSync(commandsDir), false);
  assert.equal(existsSync(recovery), false);
});

test('idempotent rerun when commands already exist and match does not re-write or churn receipts', async t => {
  const root = makeTempRoot('harness-cmd-deploy-idempotent-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const recovery = join(root, 'recovery');

  const answer = (question: string) => {
    if (question.includes(': model ID')) return 'local/model#low';
    if (question.includes(': reasoning variant')) return '-';
    if (question.startsWith('Install workflow slash commands')) return 'yes';
    if (/Replace|Make Lead|Also set/.test(question)) return 'no';
    if (question.startsWith('Type install')) return 'install';
    throw new Error(`Unexpected question: ${question}`);
  };

  const deps = {
    ask: async (q: string) => answer(q),
    output: () => {},
    error: () => {},
    home: root,
    recoveryDirectory: recovery,
    verify: async () => ({ ok: true, checks: [] } as never),
    printReport: () => {},
  };

  assert.equal(await runInstallerFlow({ scope: 'project', project }, deps), 0);

  const { readdirSync } = await import('node:fs');
  const receiptsInitial = readdirSync(recovery).sort();

  // Second run:
  assert.equal(await runInstallerFlow({ scope: 'project', project }, deps), 0);
  assert.deepEqual(readdirSync(recovery).sort(), receiptsInitial);
});

test('differing customized command file: default no preserves it; yes overwrites and records prior content', async t => {
  // Test case A: declining overwrite preserves customized file
  {
    const root = makeTempRoot('harness-cmd-diff-no-');
    const project = join(root, 'project');
    const commandsDir = join(project, '.opencode', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, 'grill-me.md'), 'CUSTOM GRILL ME');
    const recovery = join(root, 'recovery');

    const answer = (question: string) => {
      if (question.includes(': model ID')) return 'local/model#low';
      if (question.includes(': reasoning variant')) return '-';
      if (question.startsWith('Install workflow slash commands')) return 'yes';
      if (question.startsWith('Overwrite ')) return 'no';
      if (/Replace|Make Lead|Also set/.test(question)) return 'no';
      if (question.startsWith('Type install')) return 'install';
      throw new Error(`Unexpected question: ${question}`);
    };

    await runInstallerFlow(
      { scope: 'project', project },
      {
        ask: async q => answer(q),
        output: () => {},
        error: () => {},
        home: root,
        recoveryDirectory: recovery,
        verify: async () => ({ ok: true, checks: [] } as never),
        printReport: () => {},
      }
    );

    assert.equal(readFileSync(join(commandsDir, 'grill-me.md'), 'utf8'), 'CUSTOM GRILL ME');
    // The other 5 should be deployed
    assert.ok(existsSync(join(commandsDir, 'start-issue.md')));
    const { readdirSync } = await import('node:fs');
    const receipt = JSON.parse(readFileSync(join(recovery, readdirSync(recovery)[0]!), 'utf8'));
    assert.equal(receipt.managedFiles.length, 5);
    assert.ok(!receipt.managedFiles.some((f: { path: string }) => f.path.endsWith('grill-me.md')));
    rmSync(root, { recursive: true, force: true });
  }

  // Test case B: accepting overwrite overwrites and records prior content in receipt
  {
    const root = makeTempRoot('harness-cmd-diff-yes-');
    const project = join(root, 'project');
    const commandsDir = join(project, '.opencode', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, 'grill-me.md'), 'CUSTOM GRILL ME');
    const recovery = join(root, 'recovery');

    const answer = (question: string) => {
      if (question.includes(': model ID')) return 'local/model#low';
      if (question.includes(': reasoning variant')) return '-';
      if (question.startsWith('Install workflow slash commands')) return 'yes';
      if (question.startsWith('Overwrite ')) return 'yes';
      if (/Replace|Make Lead|Also set/.test(question)) return 'no';
      if (question.startsWith('Type install')) return 'install';
      throw new Error(`Unexpected question: ${question}`);
    };

    await runInstallerFlow(
      { scope: 'project', project },
      {
        ask: async q => answer(q),
        output: () => {},
        error: () => {},
        home: root,
        recoveryDirectory: recovery,
        verify: async () => ({ ok: true, checks: [] } as never),
        printReport: () => {},
      }
    );

    assert.notEqual(readFileSync(join(commandsDir, 'grill-me.md'), 'utf8'), 'CUSTOM GRILL ME');
    const { readdirSync } = await import('node:fs');
    const receipt = JSON.parse(readFileSync(join(recovery, readdirSync(recovery)[0]!), 'utf8'));
    assert.equal(receipt.managedFiles.length, 6);
    const grillEntry = receipt.managedFiles.find((f: { path: string }) => f.path.endsWith('grill-me.md'));
    assert.ok(grillEntry);
    assert.equal(grillEntry.before.content, 'CUSTOM GRILL ME');
    assert.ok(grillEntry.after.content.length > 0);
    rmSync(root, { recursive: true, force: true });
  }
});

test('harness uninstall cleanly removes new command files and restores overwritten ones', async t => {
  const root = makeTempRoot('harness-cmd-uninstall-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const commandsDir = join(project, '.opencode', 'commands');
  mkdirSync(commandsDir, { recursive: true });
  writeFileSync(join(commandsDir, 'grill-me.md'), 'CUSTOM GRILL ME BEFORE');
  writeFileSync(join(commandsDir, 'unrelated.md'), 'UNRELATED COMMAND KEEP ME');
  const recovery = join(root, 'recovery');
  const backupParent = join(root, 'backups');

  const answer = (question: string) => {
    if (question.includes(': model ID')) return 'local/model#low';
    if (question.includes(': reasoning variant')) return '-';
    if (question.startsWith('Install workflow slash commands')) return 'yes';
    if (question.startsWith('Overwrite ')) return 'yes';
    if (/Replace|Make Lead|Also set/.test(question)) return 'no';
    if (question.startsWith('Type install')) return 'install';
    throw new Error(`Unexpected question: ${question}`);
  };

  await runInstallerFlow(
    { scope: 'project', project },
    {
      ask: async q => answer(q),
      output: () => {},
      error: () => {},
      home: root,
      recoveryDirectory: recovery,
      verify: async () => ({ ok: true, checks: [] } as never),
      printReport: () => {},
    }
  );

  const { readdirSync } = await import('node:fs');
  const receiptFile = join(recovery, readdirSync(recovery)[0]!);
  const receipt = readReceiptForRestore(receiptFile, join(project, 'opencode.jsonc'));

  const configFile = join(project, 'opencode.jsonc');
  const currentConfig = readFileSync(configFile, 'utf8');

  const uninstallStatus = await runUninstallFlow({
    receipt,
    current: currentConfig,
    confirm: async () => 'uninstall',
    output: () => {},
    error: err => { throw new Error(err); },
    save: updated => writeFileSync(configFile, updated, 'utf8'),
    backupParent,
    host: 'opencode',
  });

  assert.equal(uninstallStatus, 0);

  // Unrelated command preserved
  assert.ok(existsSync(join(commandsDir, 'unrelated.md')));
  assert.equal(readFileSync(join(commandsDir, 'unrelated.md'), 'utf8'), 'UNRELATED COMMAND KEEP ME');

  // Overwritten file restored to original content
  assert.ok(existsSync(join(commandsDir, 'grill-me.md')));
  assert.equal(readFileSync(join(commandsDir, 'grill-me.md'), 'utf8'), 'CUSTOM GRILL ME BEFORE');

  // Newly deployed commands removed
  for (const name of canonicalWorkflowCommands) {
    if (name === 'grill-me.md') continue;
    assert.equal(existsSync(join(commandsDir, name)), false);
  }
});

test('commands installation honors displayed yes default on Enter', async t => {
  const root = makeTempRoot('harness-cmd-deploy-enter-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const recovery = join(root, 'recovery');
  const commandsDir = join(project, '.opencode', 'commands');

  const answer = (question: string) => {
    if (question.includes(': model ID')) return 'local/model#low';
    if (question.includes(': reasoning variant')) return '-';
    // Empty string simulates pressing Enter at prompt
    if (question.startsWith('Install workflow slash commands')) return '';
    if (/Replace|Make Lead|Also set/.test(question)) return 'no';
    if (question.startsWith('Type install')) return 'install';
    throw new Error(`Unexpected question: ${question}`);
  };

  const status = await runInstallerFlow(
    { scope: 'project', project },
    {
      ask: async q => answer(q),
      output: () => {},
      error: () => {},
      home: root,
      recoveryDirectory: recovery,
      verify: async () => ({ ok: true, checks: [] } as never),
      printReport: () => {},
    }
  );

  assert.equal(status, 0);
  assert.ok(existsSync(commandsDir));
  for (const name of canonicalWorkflowCommands) {
    assert.ok(existsSync(join(commandsDir, name)));
  }
});

test('original managed-file baseline is preserved across upgrades (v1 -> v2 -> uninstall)', async t => {
  const root = makeTempRoot('harness-cmd-upgrade-baseline-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const commandsDir = join(project, '.opencode', 'commands');
  mkdirSync(commandsDir, { recursive: true });
  // Custom file originally exists before any harness install
  writeFileSync(join(commandsDir, 'grill-me.md'), 'INITIAL CUSTOM CONTENT');
  const recovery = join(root, 'recovery');
  const backupParent = join(root, 'backups');

  // Step 1: First install - overwrite custom grill-me
  const answer1 = (question: string) => {
    if (question.includes(': model ID')) return 'local/model#low';
    if (question.includes(': reasoning variant')) return '-';
    if (question.startsWith('Install workflow slash commands')) return 'yes';
    if (question.startsWith('Overwrite ')) return 'yes';
    if (/Replace|Make Lead|Also set/.test(question)) return 'no';
    if (question.startsWith('Type install')) return 'install';
    throw new Error(`Unexpected question: ${question}`);
  };

  await runInstallerFlow(
    { scope: 'project', project },
    {
      ask: async q => answer1(q),
      output: () => {},
      error: () => {},
      home: root,
      recoveryDirectory: recovery,
      verify: async () => ({ ok: true, checks: [] } as never),
      printReport: () => {},
    }
  );

  // Step 2: Second install (upgrade). Modify template in source directory to simulate new version v2
  const fakeCommandsDir = join(root, 'fake-commands');
  mkdirSync(fakeCommandsDir);
  for (const name of canonicalWorkflowCommands) {
    writeFileSync(join(fakeCommandsDir, name), `VERSION 2 of ${name}\n`);
  }

  const answer2 = (question: string) => {
    if (question.includes(': model ID')) return 'local/model#low';
    if (question.includes(': reasoning variant')) return '-';
    if (question.startsWith('Install workflow slash commands')) return 'yes';
    if (question.startsWith('Overwrite ')) {
      // grill-me was customized from the beginning, so it prompts to overwrite 1 file
      assert.ok(question.includes('Overwrite 1 customized/differing command file'));
      return 'yes';
    }
    if (/Replace|Make Lead|Also set/.test(question)) return 'no';
    if (question.startsWith('Type install')) return 'install';
    throw new Error(`Unexpected question: ${question}`);
  };

  await runInstallerFlow(
    { scope: 'project', project },
    {
      ask: async q => answer2(q),
      output: () => {},
      error: () => {},
      home: root,
      recoveryDirectory: recovery,
      commandsDirectory: fakeCommandsDir,
      verify: async () => ({ ok: true, checks: [] } as never),
      printReport: () => {},
    }
  );

  // Check active receipt head: grill-me.md must have before.content === 'INITIAL CUSTOM CONTENT'
  // and other commands (e.g. start-issue.md) must have before.absent === true
  const { readdirSync } = await import('node:fs');
  const receiptFiles = readdirSync(recovery).filter(n => n.endsWith('.json'));
  assert.equal(receiptFiles.length, 2);
  const chain = discoverReceiptChain(recovery, join(project, 'opencode.jsonc'), 'opencode');
  assert.ok(chain.head);
  const headReceiptDoc = readReceiptForRestore(join(recovery, chain.head.file), join(project, 'opencode.jsonc'));
  assert.equal(headReceiptDoc.version, 2);
  assert.ok(headReceiptDoc.managedFiles);

  const grillEntry = headReceiptDoc.managedFiles.find(f => f.path.endsWith('grill-me.md'));
  assert.ok(grillEntry);
  assert.ok('content' in grillEntry.before);
  assert.equal(grillEntry.before.content, 'INITIAL CUSTOM CONTENT');
  assert.ok('content' in grillEntry.after);
  assert.equal(grillEntry.after.content, 'VERSION 2 of grill-me.md\n');

  const startEntry = headReceiptDoc.managedFiles.find(f => f.path.endsWith('start-issue.md'));
  assert.ok(startEntry);
  assert.ok('absent' in startEntry.before);
  assert.equal(startEntry.before.absent, true);
  assert.ok('content' in startEntry.after);
  assert.equal(startEntry.after.content, 'VERSION 2 of start-issue.md\n');

  // Step 3: Uninstall against active head
  const configFile = join(project, 'opencode.jsonc');
  const currentConfig = readFileSync(configFile, 'utf8');

  const uninstallStatus = await runUninstallFlow({
    receipt: headReceiptDoc,
    current: currentConfig,
    confirm: async () => 'uninstall',
    output: () => {},
    error: err => { throw new Error(err); },
    save: updated => writeFileSync(configFile, updated, 'utf8'),
    backupParent,
    host: 'opencode',
  });

  assert.equal(uninstallStatus, 0);
  // grill-me.md must be restored to INITIAL CUSTOM CONTENT
  assert.equal(readFileSync(join(commandsDir, 'grill-me.md'), 'utf8'), 'INITIAL CUSTOM CONTENT');
  // start-issue.md must be removed
  assert.equal(existsSync(join(commandsDir, 'start-issue.md')), false);
});

test('partial command deployment failure retains pending recovery evidence', async t => {
  const root = makeTempRoot('harness-cmd-partial-fail-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const commandsDir = join(project, '.opencode', 'commands');
  mkdirSync(commandsDir, { recursive: true });
  const recovery = join(root, 'recovery');

  const answer = (question: string) => {
    if (question.includes(': model ID')) return 'local/model#low';
    if (question.includes(': reasoning variant')) return '-';
    if (question.startsWith('Install workflow slash commands')) return 'yes';
    if (/Replace|Make Lead|Also set/.test(question)) return 'no';
    if (question.startsWith('Type install')) return 'install';
    throw new Error(`Unexpected question: ${question}`);
  };

  const errors: string[] = [];
  await assert.rejects(
    runInstallerFlow(
      { scope: 'project', project },
      {
        ask: async q => answer(q),
        output: () => {},
        error: text => errors.push(text),
        home: root,
        recoveryDirectory: recovery,
        applyCommands: (files, destDir) => {
          // Write the first file, then simulate an unexpected I/O failure on the second file
          const first = files[0]!;
          writeFileSync(first.targetPath, first.newContent, 'utf8');
          throw new Error('injected write failure on second command file');
        },
        verify: async () => ({ ok: true, checks: [] } as never),
        printReport: () => {},
      }
    ),
    /injected write failure/
  );

  // Check that pending recovery receipt is retained because the first command was written
  const { readdirSync } = await import('node:fs');
  const receipts = readdirSync(recovery).filter(n => n.endsWith('.json'));
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(readFileSync(join(recovery, receipts[0]!), 'utf8'));
  assert.equal(receipt.status, 'pending');
  assert.ok(errors.some(e => e.includes('pending recovery evidence retained')));
});
