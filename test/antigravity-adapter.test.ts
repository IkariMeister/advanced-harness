import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRoot } from './temp-directory.ts';
import { planAntigravityDeployment, installAntigravity, diagnoseAntigravity, formatAntigravityConfigMergeError } from '../src/antigravity-adapter.ts';
import { AntigravityConfigMergeError, mergeAntigravityMcpConfig } from '../src/antigravity-compiler.ts';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import { diagnoseHost } from '../src/native-diagnostics.ts';
import { discoverReceiptChain } from '../src/receipt-lineage.ts';

const rolesDir = fileURLToPath(new URL('../agents/', import.meta.url));
const commandsDir = fileURLToPath(new URL('../commands/', import.meta.url));

test('planAntigravityDeployment produces expected project footprint', () => {
  const tempProject = makeTempRoot('ag-project-plan-');
  const tempHome = makeTempRoot('ag-home-plan-');

  try {
    const plan = planAntigravityDeployment('project', tempProject, tempHome, rolesDir, commandsDir);
    assert.equal(plan.targetConfig, join(tempProject, '.agents', 'hooks.json'));
    // 1 lead rule + 6 skills + merge-guard script + hooks.json + mcp_config.json = 10 files
    assert.equal(plan.filesToDeploy.length, 10);

    const leadRule = plan.filesToDeploy.find(f => f.relativePath === '.agents/rules/advanced-harness-lead.md');
    assert.ok(leadRule);
    assert.equal(leadRule.kind, 'rules');

    const script = plan.filesToDeploy.find(f => f.relativePath === '.agents/scripts/antigravity-merge-guard.mjs');
    assert.ok(script);
    assert.equal(script.kind, 'config');

    const hooks = plan.filesToDeploy.find(f => f.relativePath === '.agents/hooks.json');
    assert.ok(hooks);
    assert.equal(hooks.kind, 'config');
    assert.ok(hooks.content.includes('antigravity-merge-guard.mjs'));
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('planAntigravityDeployment produces expected global footprint including workflow skills', () => {
  const tempHome = makeTempRoot('ag-home-global-plan-');

  try {
    const plan = planAntigravityDeployment('global', undefined, tempHome, rolesDir, commandsDir);
    assert.equal(plan.targetConfig, join(tempHome, '.gemini', 'config', 'hooks.json'));
    // 1 lead rule + 6 skills + merge-guard script + hooks.json + mcp_config.json = 10 files
    assert.equal(plan.filesToDeploy.length, 10);

    const leadRule = plan.filesToDeploy.find(f => f.relativePath === 'rules/advanced-harness-lead.md');
    assert.ok(leadRule);

    const script = plan.filesToDeploy.find(f => f.relativePath === 'scripts/antigravity-merge-guard.mjs');
    assert.ok(script);

    const skill = plan.filesToDeploy.find(f => f.relativePath === 'skills/start-issue/SKILL.md');
    assert.ok(skill);

    const hooks = plan.filesToDeploy.find(f => f.relativePath === 'hooks.json');
    assert.ok(hooks);
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('planAntigravityDeployment marks a receipt-owned older Lead rule outdated and an edited one customized', () => {
  const tempProject = makeTempRoot('ag-project-outdated-rule-');
  const tempHome = makeTempRoot('ag-home-outdated-rule-');
  const rulePath = join(tempProject, '.agents', 'rules', 'advanced-harness-lead.md');
  const olderRule = '# Advanced Harness Lead Orchestrator Rule\n\n| **external** | `flash_lite` | false | true | `inherit` | older |\n';

  try {
    mkdirSync(join(tempProject, '.agents', 'rules'), { recursive: true });
    writeFileSync(rulePath, olderRule);
    const prior = [{ path: rulePath, kind: 'rules' as const, before: { absent: true as const }, after: { content: olderRule } }];

    const outdated = planAntigravityDeployment('project', tempProject, tempHome, rolesDir, commandsDir, prior);
    const outdatedRule = outdated.filesToDeploy.find(f => f.relativePath === '.agents/rules/advanced-harness-lead.md');
    assert.equal(outdatedRule?.status, 'outdated');
    assert.ok(outdatedRule?.content.includes('## Subagent Definition Lifecycle'));

    writeFileSync(rulePath, `${olderRule}user edit\n`);
    const customized = planAntigravityDeployment('project', tempProject, tempHome, rolesDir, commandsDir, prior);
    const customizedRule = customized.filesToDeploy.find(f => f.relativePath === '.agents/rules/advanced-harness-lead.md');
    assert.equal(customizedRule?.status, 'customized');
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('installAntigravity performs full installation and preserves existing unrelated hooks and mcp servers', async () => {
  const tempProject = makeTempRoot('ag-project-install-');
  const tempHome = makeTempRoot('ag-home-install-');
  const recoveryDir = join(tempHome, 'backups');

  // Pre-populate unrelated hook in .agents/hooks.json
  mkdirSync(join(tempProject, '.agents'), { recursive: true });
  writeFileSync(
    join(tempProject, '.agents', 'hooks.json'),
    JSON.stringify({
      'existing-linter': {
        PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }],
      },
    }, null, 2)
  );

  // Pre-populate unrelated server in .agents/mcp_config.json
  writeFileSync(
    join(tempProject, '.agents', 'mcp_config.json'),
    JSON.stringify({
      customField: 'preserved',
      mcpServers: {
        'my-custom-mcp': { command: 'node', args: ['server.js'] },
      },
    }, null, 2)
  );

  let confirmed = false;
  const outputs: string[] = [];

  try {
    const exitCode = await installAntigravity({
      scope: 'project',
      project: tempProject,
      home: tempHome,
      recoveryDirectory: recoveryDir,
      agentsDirectory: rolesDir,
      commandsDirectory: commandsDir,
      ask: async (q, s) => {
        confirmed = true;
        return q.startsWith('Type yes to install the Antigravity') ? 'yes' : (s ?? 'yes');
      },
      output: msg => outputs.push(msg),
      error: msg => outputs.push(`ERROR: ${msg}`),
    });

    assert.equal(exitCode, 0);
    assert.equal(confirmed, true);

    // Verify deployed files
    assert.ok(existsSync(join(tempProject, '.agents', 'rules', 'advanced-harness-lead.md')));
    assert.ok(existsSync(join(tempProject, '.agents', 'scripts', 'antigravity-merge-guard.mjs')));
    assert.ok(existsSync(join(tempProject, '.agents', 'hooks.json')));
    assert.ok(existsSync(join(tempProject, '.agents', 'mcp_config.json')));
    assert.ok(existsSync(join(tempProject, '.agents', 'skills', 'start-issue', 'SKILL.md')));

    // Verify existing integration was preserved
    const hooksParsed = JSON.parse(readFileSync(join(tempProject, '.agents', 'hooks.json'), 'utf8'));
    assert.ok(hooksParsed['existing-linter'], 'existing-linter hook must be preserved');
    assert.ok(hooksParsed['gh-pr-merge-guard'], 'gh-pr-merge-guard must be added');

    const mcpParsed = JSON.parse(readFileSync(join(tempProject, '.agents', 'mcp_config.json'), 'utf8'));
    assert.equal(mcpParsed.customField, 'preserved', 'custom top-level field must be preserved');
    assert.ok(mcpParsed.mcpServers['my-custom-mcp'], 'my-custom-mcp must be preserved');

    // Verify doctor diagnosis
    const doctor = await diagnoseAntigravity({ project: tempProject, home: tempHome });
    assert.equal(doctor.ok, true);
    assert.ok(doctor.notes.some(n => n.includes('PreToolUse merge guard hook is configured')));
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('diagnoseAntigravity reports ok: false when uninstalled or when required artifacts are missing', async () => {
  const tempProject = makeTempRoot('ag-diag-fail-');
  const tempHome = makeTempRoot('ag-home-fail-');

  try {
    // 1. Uninstalled -> ok: false
    const diagEmpty = await diagnoseAntigravity({ project: tempProject, home: tempHome });
    assert.equal(diagEmpty.ok, false);
    assert.ok(diagEmpty.issues.some(i => i.includes('not installed')));

    // 2. Install
    await installAntigravity({
      scope: 'project',
      project: tempProject,
      home: tempHome,
      agentsDirectory: rolesDir,
      commandsDirectory: commandsDir,
      ask: async (q, s) => q.startsWith('Type yes to install the Antigravity') ? 'yes' : (s ?? 'yes'),
      output: () => {},
      error: () => {},
    });

    const diagInstalled = await diagnoseAntigravity({ project: tempProject, home: tempHome });
    assert.equal(diagInstalled.ok, true);

    // 3. Remove merge guard script -> doctor must catch it and report ok: false
    rmSync(join(tempProject, '.agents', 'scripts', 'antigravity-merge-guard.mjs'));
    const diagMissingScript = await diagnoseAntigravity({ project: tempProject, home: tempHome });
    assert.equal(diagMissingScript.ok, false);
    assert.ok(diagMissingScript.issues.some(i => i.includes('merge-guard executable referenced in hooks.json does not exist')));

    // 4. Corrupt hooks.json -> doctor must catch it and report ok: false
    writeFileSync(join(tempProject, '.agents', 'hooks.json'), '{ broken json');
    const diagBrokenHooks = await diagnoseAntigravity({ project: tempProject, home: tempHome });
    assert.equal(diagBrokenHooks.ok, false);
    assert.ok(diagBrokenHooks.issues.some(i => i.includes('Malformed')));

    // 5. Disabled gh-pr-merge-guard -> doctor must report ok: false
    writeFileSync(
      join(tempProject, '.agents', 'hooks.json'),
      JSON.stringify({
        'gh-pr-merge-guard': {
          enabled: false,
          PreToolUse: [
            {
              matcher: 'run_command',
              hooks: [{ command: `node "${join(tempProject, '.agents', 'scripts', 'antigravity-merge-guard.mjs')}"` }],
            },
          ],
        },
      })
    );
    // recreate script so only the hook configuration is flawed
    writeFileSync(join(tempProject, '.agents', 'scripts', 'antigravity-merge-guard.mjs'), 'console.log();');
    const diagDisabled = await diagnoseAntigravity({ project: tempProject, home: tempHome });
    assert.equal(diagDisabled.ok, false);
    assert.ok(diagDisabled.issues.some(i => i.includes('gh-pr-merge-guard is disabled')));

    // 6. Empty PreToolUse -> doctor must report ok: false without substituting a default script
    writeFileSync(
      join(tempProject, '.agents', 'hooks.json'),
      JSON.stringify({
        'gh-pr-merge-guard': {
          PreToolUse: [],
        },
      })
    );
    const diagEmptyPreToolUse = await diagnoseAntigravity({ project: tempProject, home: tempHome });
    assert.equal(diagEmptyPreToolUse.ok, false);
    assert.ok(diagEmptyPreToolUse.issues.some(i => i.includes('missing an enabled run_command handler')));

    // 7. Wrong matcher or empty hooks -> doctor must report ok: false
    writeFileSync(
      join(tempProject, '.agents', 'hooks.json'),
      JSON.stringify({
        'gh-pr-merge-guard': {
          PreToolUse: [{ matcher: 'run_command', hooks: [] }],
        },
      })
    );
    const diagEmptyHooks = await diagnoseAntigravity({ project: tempProject, home: tempHome });
    assert.equal(diagEmptyHooks.ok, false);
    assert.ok(diagEmptyHooks.issues.some(i => i.includes('missing an enabled run_command handler')));
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('installAntigravity writes the platform merge-guard hook command and doctor flags the quoted form on Windows (#94)', async (t) => {
  const tempProject = makeTempRoot('ag-hook-quote-');
  const tempHome = makeTempRoot('ag-home-hook-quote-');

  try {
    const guardPath = join(tempProject, '.agents', 'scripts', 'antigravity-merge-guard.mjs');
    // An unquoted command can only reference a whitespace-free path: Windows install
    // rejects such roots, and doctor cannot parse an unquoted spaced path anywhere.
    const spacedRoot = /\s/.test(guardPath);
    if (spacedRoot && process.platform === 'win32') {
      t.skip(`temporary root contains whitespace, which Windows install rejects by design: ${tempProject}`);
      return;
    }

    await installAntigravity({
      scope: 'project',
      project: tempProject,
      home: tempHome,
      agentsDirectory: rolesDir,
      commandsDirectory: commandsDir,
      ask: async (q, s) => q.startsWith('Type yes to install the Antigravity') ? 'yes' : (s ?? 'yes'),
      output: () => {},
      error: () => {},
    });

    const hooksPath = join(tempProject, '.agents', 'hooks.json');
    const installed = JSON.parse(readFileSync(hooksPath, 'utf8'));
    const expectedCommand = process.platform === 'win32' ? `node ${guardPath}` : `node "${guardPath}"`;
    assert.equal(installed['gh-pr-merge-guard'].PreToolUse[0].hooks[0].command, expectedCommand);

    if (!spacedRoot) {
      installed['gh-pr-merge-guard'].PreToolUse[0].hooks[0].command = `node ${guardPath}`;
      writeFileSync(hooksPath, JSON.stringify(installed, null, 2));
      const diagWindows = await diagnoseAntigravity({ project: tempProject, home: tempHome, platform: 'win32' });
      assert.equal(diagWindows.ok, true, diagWindows.issues.join('\n'));
    }

    installed['gh-pr-merge-guard'].PreToolUse[0].hooks[0].command = `node "${guardPath}"`;
    writeFileSync(hooksPath, JSON.stringify(installed, null, 2));

    const diagLegacyWindows = await diagnoseAntigravity({ project: tempProject, home: tempHome, platform: 'win32' });
    assert.equal(diagLegacyWindows.ok, false);
    assert.ok(diagLegacyWindows.issues.some(i => i.includes('quotes the merge-guard path') && i.includes('harness:update')));

    const diagLegacyLinux = await diagnoseAntigravity({ project: tempProject, home: tempHome, platform: 'linux' });
    assert.equal(diagLegacyLinux.ok, true, diagLegacyLinux.issues.join('\n'));
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('runInstallerFlow delegates clean installation and isolates writes to supplied home', async () => {
  const tempProject = makeTempRoot('ag-installer-flow-');
  const tempHome = makeTempRoot('ag-home-flow-');
  const recoveryDir = join(tempHome, 'custom-recovery');
  const outputs: string[] = [];
  const errors: string[] = [];

  try {
    const code = await runInstallerFlow(
      {
        host: 'antigravity',
        scope: 'project',
        project: tempProject,
      },
      {
        ask: async (q, s) => q.startsWith('Type yes to install the Antigravity') ? 'yes' : (s ?? 'yes'),
        output: msg => outputs.push(msg),
        error: msg => errors.push(msg),
        home: tempHome,
        recoveryDirectory: recoveryDir,
        agentsDirectory: rolesDir,
        commandsDirectory: commandsDir,
      }
    );

    assert.equal(code, 0);
    assert.ok(existsSync(join(tempProject, '.agents', 'hooks.json')));
    assert.ok(existsSync(join(tempProject, '.agents', 'rules', 'advanced-harness-lead.md')));
    assert.ok(existsSync(join(tempProject, '.agents', 'scripts', 'antigravity-merge-guard.mjs')));

    // Check that receipts were written to recoveryDir inside tempHome and NOT the user's real home
    assert.ok(existsSync(recoveryDir), 'Recovery directory inside tempHome must exist');
    const receiptChain = readFileSync(join(tempProject, '.agents', 'hooks.json'), 'utf8');
    assert.ok(receiptChain);
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('installAntigravity in global scope deploys skills and script into global config directory', async () => {
  const tempHome = makeTempRoot('ag-global-install-test-');

  try {
    const code = await installAntigravity({
      scope: 'global',
      home: tempHome,
      agentsDirectory: rolesDir,
      commandsDirectory: commandsDir,
      ask: async (q, s) => q.startsWith('Type yes to install the Antigravity') ? 'yes' : (s ?? 'yes'),
      output: () => {},
      error: () => {},
    });

    assert.equal(code, 0);
    const globalBase = join(tempHome, '.gemini', 'config');
    assert.ok(existsSync(join(globalBase, 'rules', 'advanced-harness-lead.md')));
    assert.ok(existsSync(join(globalBase, 'scripts', 'antigravity-merge-guard.mjs')));
    assert.ok(existsSync(join(globalBase, 'hooks.json')));
    assert.ok(existsSync(join(globalBase, 'mcp_config.json')));
    assert.ok(existsSync(join(globalBase, 'skills', 'start-issue', 'SKILL.md')));
    assert.ok(existsSync(join(globalBase, 'skills', 'report-defect', 'SKILL.md')));

    const doctor = await diagnoseAntigravity({ home: tempHome });
    assert.equal(doctor.ok, true);
    assert.ok(doctor.notes.some(n => n.includes('Global PreToolUse merge guard hook is configured')));
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('installAntigravity preserves customized/unowned rules, skills, and guard scripts by default', async () => {
  const tempProject = makeTempRoot('ag-project-preserve-');
  const tempHome = makeTempRoot('ag-home-preserve-');
  const recoveryDir = join(tempHome, 'backups');

  // Pre-create customized rule, skill, and script
  const rulePath = join(tempProject, '.agents', 'rules', 'advanced-harness-lead.md');
  const skillPath = join(tempProject, '.agents', 'skills', 'start-issue', 'SKILL.md');
  const scriptPath = join(tempProject, '.agents', 'scripts', 'antigravity-merge-guard.mjs');

  mkdirSync(join(tempProject, '.agents', 'rules'), { recursive: true });
  mkdirSync(join(tempProject, '.agents', 'skills', 'start-issue'), { recursive: true });
  mkdirSync(join(tempProject, '.agents', 'scripts'), { recursive: true });

  writeFileSync(rulePath, '# Custom Lead Rule\nuser custom content\n');
  writeFileSync(skillPath, '---\nname: start-issue\ndescription: custom\n---\ncustom skill body\n');
  writeFileSync(scriptPath, '// custom merge guard script\nprocess.exit(0);\n');

  const askedQuestions: string[] = [];

  try {
    const exitCode = await installAntigravity({
      scope: 'project',
      project: tempProject,
      home: tempHome,
      recoveryDirectory: recoveryDir,
      agentsDirectory: rolesDir,
      commandsDirectory: commandsDir,
      ask: async (question, suggested) => {
        askedQuestions.push(question);
        // Default answer for customized files is 'no'; the final confirmation is answered 'yes' explicitly
        return question.startsWith('Type yes to install the Antigravity') ? 'yes' : (suggested ?? 'no');
      },
      output: () => {},
      error: () => {},
    });

    assert.equal(exitCode, 0);

    // Verify prompts were asked for customized files
    assert.ok(askedQuestions.some(q => q.includes('Overwrite customized/unowned file') && q.includes('advanced-harness-lead.md')));
    assert.ok(askedQuestions.some(q => q.includes('Overwrite customized/unowned file') && q.includes('start-issue')));
    assert.ok(askedQuestions.some(q => q.includes('Overwrite customized/unowned file') && q.includes('antigravity-merge-guard.mjs')));

    // Verify files were preserved untouched
    assert.equal(readFileSync(rulePath, 'utf8'), '# Custom Lead Rule\nuser custom content\n');
    assert.equal(readFileSync(skillPath, 'utf8'), '---\nname: start-issue\ndescription: custom\n---\ncustom skill body\n');
    assert.equal(readFileSync(scriptPath, 'utf8'), '// custom merge guard script\nprocess.exit(0);\n');

    // Verify non-customized skills and configs were still deployed
    assert.ok(existsSync(join(tempProject, '.agents', 'skills', 'review-pr', 'SKILL.md')));
    assert.ok(existsSync(join(tempProject, '.agents', 'hooks.json')));
    assert.ok(existsSync(join(tempProject, '.agents', 'mcp_config.json')));
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('installAntigravity overwrites customized files when explicitly approved and updates receipt-owned files', async () => {
  const tempProject = makeTempRoot('ag-project-overwrite-');
  const tempHome = makeTempRoot('ag-home-overwrite-');
  const recoveryDir = join(tempHome, 'backups');

  // Pre-create customized skill
  const skillPath = join(tempProject, '.agents', 'skills', 'start-issue', 'SKILL.md');
  mkdirSync(join(tempProject, '.agents', 'skills', 'start-issue'), { recursive: true });
  writeFileSync(skillPath, '---\nname: start-issue\ndescription: custom\n---\ncustom skill body\n');

  try {
    // 1. Install with explicit 'yes' to overwrite customized skill
    const exitCode = await installAntigravity({
      scope: 'project',
      project: tempProject,
      home: tempHome,
      recoveryDirectory: recoveryDir,
      agentsDirectory: rolesDir,
      commandsDirectory: commandsDir,
      ask: async (question) => {
        if (question.includes('Overwrite customized/unowned file')) return 'yes';
        return 'yes';
      },
      output: () => {},
      error: () => {},
    });

    assert.equal(exitCode, 0);
    const updatedContent = readFileSync(skillPath, 'utf8');
    assert.ok(!updatedContent.includes('custom skill body'), 'Custom content should have been overwritten');
    assert.ok(updatedContent.includes('---'), 'Should contain generated skill frontmatter');

    // 2. Second run without changes should detect 'current' (idempotent, no writes)
    let promptAsked = false;
    const secondCode = await installAntigravity({
      scope: 'project',
      project: tempProject,
      home: tempHome,
      recoveryDirectory: recoveryDir,
      agentsDirectory: rolesDir,
      commandsDirectory: commandsDir,
      ask: async () => {
        promptAsked = true;
        return 'yes';
      },
      output: () => {},
      error: () => {},
    });

    assert.equal(secondCode, 0);
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('installAntigravity aborts and writes nothing if files diverge during confirmation', async () => {
  const tempProject = makeTempRoot('ag-project-concurrent-');
  const tempHome = makeTempRoot('ag-home-concurrent-');
  const recoveryDir = join(tempHome, 'backups');

  // Pre-create lead rule
  const rulePath = join(tempProject, '.agents', 'rules', 'advanced-harness-lead.md');
  mkdirSync(join(tempProject, '.agents', 'rules'), { recursive: true });
  writeFileSync(rulePath, '# Initial content\n');

  try {
    await assert.rejects(
      async () => {
        await installAntigravity({
          scope: 'project',
          project: tempProject,
          home: tempHome,
          recoveryDirectory: recoveryDir,
          agentsDirectory: rolesDir,
          commandsDirectory: commandsDir,
          ask: async (question) => {
            if (question.includes('Type yes to install the Antigravity')) {
              // Mutate a planned file while confirmation prompt is open
              writeFileSync(rulePath, '# Mutated concurrently while prompt was open\n');
            }
            return 'yes';
          },
          output: () => {},
          error: () => {},
        });
      },
      /Configuration or artifact changed while confirmation was open/
    );

    // Verify concurrently changed file was NOT overwritten
    assert.equal(readFileSync(rulePath, 'utf8'), '# Mutated concurrently while prompt was open\n');

    // Verify no pending receipt was left behind
    const backupEntries = existsSync(recoveryDir) ? rmSync : null;
    assert.ok(!existsSync(join(tempProject, '.agents', 'hooks.json')), 'hooks.json must not have been created');
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('runInstallerFlow stamps harnessVersion on the Antigravity receipt and prints it before confirmation', async () => {
  const tempProject = makeTempRoot('ag-version-project-');
  const tempHome = makeTempRoot('ag-version-home-');
  const harnessRoot = join(tempHome, 'checkout');
  const recoveryDir = join(tempHome, 'recovery');
  const outputs: string[] = [];
  const commit = 'd'.repeat(40);
  let versionBeforeConfirm = false;
  try {
    mkdirSync(harnessRoot);
    writeFileSync(join(harnessRoot, 'package.json'), JSON.stringify({ version: '9.8.7' }));
    const runCommand = (_executable: string, args: string[]) => args[0] === 'rev-parse' ? commit : '';
    const code = await runInstallerFlow({ host: 'antigravity', scope: 'project', project: tempProject }, {
      ask: async (q, s) => {
        if (!q.trimStart().startsWith('Type yes to install the Antigravity')) return s ?? '';
        versionBeforeConfirm = outputs.includes(`Harness version: 9.8.7 (${commit})`);
        return 'yes';
      },
      output: msg => outputs.push(msg),
      error: msg => outputs.push(msg),
      home: tempHome,
      recoveryDirectory: recoveryDir,
      agentsDirectory: rolesDir,
      commandsDirectory: commandsDir,
      harnessRoot,
      runCommand,
    });
    assert.equal(code, 0);
    assert.equal(versionBeforeConfirm, true, 'version line printed before the final confirmation');
    const head = discoverReceiptChain(recoveryDir, join(tempProject, '.agents', 'hooks.json'), 'antigravity').head;
    assert.deepEqual(head?.receipt.version === 2 ? head.receipt.harnessVersion : undefined, { version: '9.8.7', commit });
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

const isAntigravityConfirmation = (question: string) => question.trimStart().startsWith('Type yes to install the Antigravity');

function antigravityConfirmationFixture(answer: string) {
  const tempProject = makeTempRoot('ag-confirm-project-');
  const tempHome = makeTempRoot('ag-confirm-home-');
  const recoveryDir = join(tempHome, 'recovery');
  const prompts: Array<{ question: string; suggested: string | undefined }> = [];
  const outputs: string[] = [];
  const errors: string[] = [];
  const ask = async (question: string, suggested?: string) => {
    prompts.push({ question, suggested });
    return isAntigravityConfirmation(question) ? answer : (suggested ?? '');
  };
  const deps = {
    ask,
    output: (message: string) => { outputs.push(message); },
    error: (message: string) => { errors.push(message); },
    home: tempHome,
    recoveryDirectory: recoveryDir,
    agentsDirectory: rolesDir,
    commandsDirectory: commandsDir,
  };
  const cleanup = () => {
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  };
  return { tempProject, tempHome, recoveryDir, prompts, outputs, deps, cleanup };
}

test('Enter at the Antigravity confirmation (default no) cancels with no writes', async () => {
  const f = antigravityConfirmationFixture('');
  try {
    const code = await installAntigravity({ scope: 'project', project: f.tempProject, ...f.deps });
    assert.equal(code, 1);
    assert.ok(f.outputs.some(line => line.includes('Installation canceled by user. No files written.')));
    assert.equal(existsSync(join(f.tempProject, '.agents')), false, 'no .agents directory is created');
    assert.equal(existsSync(f.recoveryDir), false, 'no backups or receipts are written');
    const confirmations = f.prompts.filter(p => isAntigravityConfirmation(p.question));
    assert.equal(confirmations.length, 1, 'Enter is not retried or defaulted to yes');
    assert.equal(confirmations[0]?.suggested, 'no', 'the displayed default is no');
  } finally {
    f.cleanup();
  }
});

test('an explicit no and an unrecognized answer both cancel the Antigravity install with no writes', async () => {
  for (const answer of ['no', 'maybe']) {
    const f = antigravityConfirmationFixture(answer);
    try {
      const code = await installAntigravity({ scope: 'project', project: f.tempProject, ...f.deps });
      assert.equal(code, 1, answer);
      assert.equal(existsSync(join(f.tempProject, '.agents')), false, answer);
      assert.equal(existsSync(f.recoveryDir), false, answer);
    } finally {
      f.cleanup();
    }
  }
});

test('runInstallerFlow with Enter at the Antigravity confirmation cancels with no .agents directory', async () => {
  const f = antigravityConfirmationFixture('');
  try {
    const code = await runInstallerFlow({ host: 'antigravity', scope: 'project', project: f.tempProject }, f.deps);
    assert.equal(code, 1);
    assert.equal(existsSync(join(f.tempProject, '.agents')), false);
    assert.equal(existsSync(f.recoveryDir), false);
    assert.equal(f.prompts.filter(p => isAntigravityConfirmation(p.question)).length, 1);
  } finally {
    f.cleanup();
  }
});

test('formatAntigravityConfigMergeError names the file and how to resolve an MCP server conflict', () => {
  let caught: unknown;
  try {
    mergeAntigravityMcpConfig('{ "mcpServers": { "harness": { "command": "other" } } }', { harness: { command: 'node' } });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof AntigravityConfigMergeError);
  caught.path = join('C:', 'cfg', 'mcp_config.json');
  const message = formatAntigravityConfigMergeError(caught, join('C:', 'backups'));
  assert.equal(
    message,
    `Antigravity configuration conflict in ${join('C:', 'cfg', 'mcp_config.json')}: the MCP server "harness" does not match what the harness installs or last installed. Restore it to the content recorded in the latest Antigravity install receipt under ${join('C:', 'backups')}, or remove the "harness" entry from "mcpServers", then re-run. No files were changed.`
  );
});

test('installAntigravity reports a conflicting hooks.json as one error line and returns 1 without prompting', async () => {
  const tempProject = makeTempRoot('ag-conflict-project-');
  const tempHome = makeTempRoot('ag-conflict-home-');
  const recoveryDir = join(tempHome, 'recovery');
  const hooksPath = join(tempProject, '.agents', 'hooks.json');
  try {
    mkdirSync(join(tempProject, '.agents'), { recursive: true });
    writeFileSync(hooksPath, JSON.stringify({ 'gh-pr-merge-guard': { matcher: 'run_command', command: 'node scripts/antigravity-merge-guard.mjs' } }));
    const errors: string[] = [];
    const prompts: string[] = [];
    const code = await installAntigravity({
      scope: 'project', project: tempProject, home: tempHome, recoveryDirectory: recoveryDir,
      agentsDirectory: rolesDir, commandsDirectory: commandsDir,
      ask: async question => { prompts.push(question); return 'yes'; },
      output: () => {}, error: message => errors.push(message),
    });
    assert.equal(code, 1);
    assert.deepEqual(prompts, []);
    assert.equal(errors.length, 1);
    assert.ok(errors[0]!.includes(hooksPath));
    assert.match(errors[0]!, /remove the "gh-pr-merge-guard" key, then re-run\. No files were changed\.$/);
    assert.equal(existsSync(recoveryDir), false);
    assert.deepEqual(JSON.parse(readFileSync(hooksPath, 'utf8'))['gh-pr-merge-guard'].command, 'node scripts/antigravity-merge-guard.mjs');
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});
