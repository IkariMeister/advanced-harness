import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRoot } from './temp-directory.ts';
import { ANTIGRAVITY_MODEL_LABELS, parseAntigravityModelPreferences, planAntigravityModelPreferenceWrites, antigravityGlobalModelPreferencesPath } from '../src/antigravity-model-preferences.ts';
import { installAntigravity } from '../src/antigravity-adapter.ts';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { discoverReceiptChain, readReceiptForRestore } from '../src/receipt-lineage.ts';
import { runUninstallFlow } from '../src/uninstall-cli-flow.ts';
import { updateContext } from '../src/project-context.ts';
import { nativeRoles, saveInstallation } from '../src/native-installer.ts';
import { fileURLToPath } from 'node:url';

const rolesDir = fileURLToPath(new URL('../agents/', import.meta.url));
const commandsDir = fileURLToPath(new URL('../commands/', import.meta.url));
const prefsPath = (home: string) => join(home, '.gemini', 'config', 'harness.model-preferences.json');
const emptyPreferences = () => ({ version: 1, preferences: Object.fromEntries(nativeRoles.map(role => [role, null])) });
const defaultAnswer = async (_question: string, suggested?: string) => suggested ?? 'yes';
const snapshotTree = (root: string): Array<[string, 'directory' | 'file' | 'symlink', string?]> => {
  if (!existsSync(root)) return [];
  const entries: Array<[string, 'directory' | 'file' | 'symlink', string?]> = [];
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push([relativePath, 'directory']);
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        entries.push([relativePath, 'file', readFileSync(absolutePath, 'utf8')]);
      } else {
        entries.push([relativePath, 'symlink']);
      }
    }
  };
  visit(root, '');
  return entries;
};

test('Antigravity desired preference format rejects malformed, incomplete, or unknown assignments', () => {
  const valid = JSON.stringify({ version: 1, preferences: Object.fromEntries(nativeRoles.map(role => [role, role === 'lead' ? 'Claude Opus 5.5' : null])) });
  assert.equal(parseAntigravityModelPreferences(valid, 'prefs').preferences.lead, 'Claude Opus 5.5');
  assert.throws(() => parseAntigravityModelPreferences('{broken', 'prefs'));
  assert.throws(() => parseAntigravityModelPreferences(JSON.stringify({ version: 1, preferences: { lead: 'Gemini 4 Argon' } }), 'prefs'));
  assert.throws(() => parseAntigravityModelPreferences(JSON.stringify({ ...JSON.parse(valid), entitlement: true }), 'prefs'));
});

test('project preferences use global defaults as suggestions only and preserve alternate Markdown context', async t => {
  const root = makeTempRoot('ag-model-context-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const home = join(root, 'home');
  mkdirSync(join(project, 'docs'), { recursive: true }); mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  const defaults = { version: 1, preferences: Object.fromEntries(nativeRoles.map(role => [role, role === 'lead' ? ANTIGRAVITY_MODEL_LABELS[0] : null])) };
  const globalText = JSON.stringify(defaults, null, 2) + '\n';
  writeFileSync(prefsPath(home), globalText);
  const alternate = join(project, 'docs', 'HARNESS.md');
  const original = '# Project notes\n\nKeep this unrelated text.\n';
  writeFileSync(alternate, original);
  let invalidRetried = false;
  const messages: string[] = [];
  const plan = await planAntigravityModelPreferenceWrites({
    scope: 'project', project, home, context: 'docs/HARNESS.md',
    runtimeTiers: { lead: 'inherit', operator: 'flash_lite', external: 'flash_lite', researcher: 'flash', planner: 'pro', implementer: 'flash', reviewer: 'pro', qa: 'flash' },
    ask: async (question, suggested) => {
      if (question.startsWith('lead: desired')) {
        if (!invalidRetried) { invalidRetried = true; return '9'; }
        return '';
      }
      if (question.startsWith('operator: desired')) return '4';
      if (question.startsWith('operator: custom')) return 'Arbitrary model label';
      return suggested ?? '0';
    },
    output: message => messages.push(message),
  });
  assert.ok(invalidRetried);
  assert.equal(plan.preferences.preferences.lead, ANTIGRAVITY_MODEL_LABELS[0]);
  assert.equal(readFileSync(prefsPath(home), 'utf8'), globalText, 'project selection must not write global defaults');
  const contextWrite = plan.writes.find(write => write.path === alternate);
  const agentsWrite = plan.writes.find(write => write.path === join(project, 'AGENTS.md'));
  assert.ok(contextWrite && agentsWrite, 'alternate Markdown and its AGENTS.md reference are both planned');
  assert.ok(contextWrite.content.includes('Keep this unrelated text.'));
  assert.ok(agentsWrite.content.includes('docs/HARNESS.md'));
  assert.ok(contextWrite.content.includes('Claude Opus 5.5'));
  assert.equal(plan.preferences.preferences.operator, 'Arbitrary model label');
  assert.ok(contextWrite.content.includes('Arbitrary model label'));
  assert.ok(messages.includes('lead: existing Antigravity runtime tier inherit (unchanged).'));
  assert.ok(messages.includes('operator: existing Antigravity runtime tier flash_lite (unchanged).'));
});

test('Antigravity preference cancellation writes no project/global settings, backup, or receipt', async t => {
  const root = makeTempRoot('ag-model-cancel-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const home = join(root, 'home'); const recovery = join(root, 'recovery');
  mkdirSync(join(project, 'docs'), { recursive: true }); mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  const contextPath = join(project, 'docs', 'ALT.md'); const contextOriginal = '# Keep this content on cancel.\n'; writeFileSync(contextPath, contextOriginal);
  const globalText = JSON.stringify({ version: 1, preferences: Object.fromEntries(nativeRoles.map(role => [role, 'Global suggestion'])) }, null, 2) + '\n';
  writeFileSync(prefsPath(home), globalText);
  let cancellationPromptObserved = false;
  const exitCode = await runInstallerFlow({ scope: 'project', project, context: 'docs/ALT.md', host: 'antigravity' }, {
    home, recoveryDirectory: recovery, agentsDirectory: rolesDir, commandsDirectory: commandsDir,
    ask: async question => {
      if (question.trimStart().startsWith('Confirm installation')) { cancellationPromptObserved = true; return 'cancel'; }
      return '';
    },
    output: () => {}, error: () => {},
  });
  assert.equal(exitCode, 1);
  assert.ok(cancellationPromptObserved, 'cancellation response reached the actual confirmation prompt');
  assert.equal(existsSync(join(project, '.agents')), false);
  assert.equal(existsSync(join(project, 'AGENTS.md')), false);
  assert.equal(readFileSync(contextPath, 'utf8'), contextOriginal);
  assert.equal(readFileSync(prefsPath(home), 'utf8'), globalText);
  assert.equal(existsSync(recovery), false);
});

test('receipt-managed project context edits are refused before prompts or writes, including no-op preference plans', async t => {
  const root = makeTempRoot('ag-model-drift-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const home = join(root, 'home'); const recovery = join(root, 'recovery');
  mkdirSync(project); mkdirSync(home);
  const context = join(project, 'AGENTS.md'); const original = '# Existing notes\n'; writeFileSync(context, original);
  const install = async () => installAntigravity({ scope: 'project', project, home, recoveryDirectory: recovery,
    agentsDirectory: rolesDir, commandsDirectory: commandsDir, ask: defaultAnswer, output: () => {}, error: () => {} });
  assert.equal(await install(), 0);
  const installedContext = readFileSync(context, 'utf8');
  const target = join(project, '.agents', 'hooks.json');
  const targetBytes = readFileSync(target, 'utf8');
  const recoveryBefore = snapshotTree(recovery);
  writeFileSync(context, installedContext + '\nHuman change\n');
  const changedContext = readFileSync(context, 'utf8');
  let prompted = false;
  await assert.rejects(installAntigravity({ scope: 'project', project, home, recoveryDirectory: recovery,
    agentsDirectory: rolesDir, commandsDirectory: commandsDir,
    ask: async () => { prompted = true; return ''; }, output: () => {}, error: () => {} }), /recorded predecessor after-state/);
  assert.equal(prompted, false);
  assert.equal(readFileSync(context, 'utf8'), changedContext);
  assert.equal(readFileSync(target, 'utf8'), targetBytes);
  assert.deepEqual(snapshotTree(recovery), recoveryBefore);
});

test('receipt-managed global model preference drift blocks project update without writes', async t => {
  const root = makeTempRoot('ag-global-drift-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); const recovery = join(root, 'recovery');
  mkdirSync(home);
  const prefs = antigravityGlobalModelPreferencesPath(home);
  let asked = 0;
  const install = (scope: 'global' | 'project') => installAntigravity({ scope, ...(scope === 'project' ? { project: join(root, 'project') } : {}), home, recoveryDirectory: recovery,
    agentsDirectory: rolesDir, commandsDirectory: commandsDir, ask: async (question, suggested) => {
      asked++;
      return scope === 'global' && question.trimStart().startsWith('lead: desired') ? '1' : defaultAnswer(question, suggested);
    }, output: () => {}, error: () => {} });
  assert.equal(await install('global'), 0);
  const original = readFileSync(prefs, 'utf8');
  const changed = original.replace('Claude Opus 5.5', 'Human preference');
  assert.notEqual(changed, original, 'mutate the selected preference actually recorded in the fixture'); writeFileSync(prefs, changed);
  const entriesBefore = snapshotTree(recovery);
  const promptCount = asked;
  await assert.rejects(install('project'), /recorded predecessor after-state/);
  assert.equal(asked, promptCount);
  assert.equal(readFileSync(prefs, 'utf8'), changed);
  assert.deepEqual(snapshotTree(recovery), entriesBefore);
});

test('missing receipt-managed context fails closed before confirmation', async t => {
  const root = makeTempRoot('ag-missing-context-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const home = join(root, 'home'); const recovery = join(root, 'recovery');
  mkdirSync(join(project, 'docs'), { recursive: true }); mkdirSync(home);
  const context = join(project, 'docs', 'ALT.md'); writeFileSync(context, '# Preserve\n');
  const options = { scope: 'project' as const, project, context: 'docs/ALT.md', home, recoveryDirectory: recovery,
    agentsDirectory: rolesDir, commandsDirectory: commandsDir, ask: defaultAnswer, output: () => {}, error: () => {} };
  assert.equal(await installAntigravity(options), 0);
  const target = join(project, '.agents', 'hooks.json'); const targetBytes = readFileSync(target, 'utf8');
  const entriesBefore = snapshotTree(recovery); rmSync(context);
  let prompted = false;
  await assert.rejects(installAntigravity({ ...options, ask: async () => { prompted = true; return 'yes'; } }), /recorded predecessor after-state/);
  assert.equal(prompted, false); assert.equal(existsSync(context), false);
  assert.equal(readFileSync(target, 'utf8'), targetBytes); assert.deepEqual(snapshotTree(recovery), entriesBefore);
});

test('clean project update and subsequent uninstall restore pre-existing context', async t => {
  const root = makeTempRoot('ag-clean-lifecycle-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const home = join(root, 'home'); const recovery = join(root, 'recovery');
  mkdirSync(join(project, 'docs'), { recursive: true }); mkdirSync(home);
  const context = join(project, 'docs', 'clean.md'); const before = '# User-owned text\n'; writeFileSync(context, before);
  const options = { scope: 'project' as const, project, context: 'docs/clean.md', home, recoveryDirectory: recovery,
    agentsDirectory: rolesDir, commandsDirectory: commandsDir, ask: async (question: string, suggested?: string) => question.trimStart().startsWith('lead: desired') ? 'Personalized label' : (suggested ?? 'yes'), output: () => {}, error: () => {} };
  assert.equal(await installAntigravity(options), 0);
  const firstSnapshot = discoverReceiptChain(recovery, join(project, '.agents', 'hooks.json'), 'antigravity');
  const firstReceiptCount = readdirSync(recovery).filter(name => name.startsWith('native-install-')).length;
  assert.equal(await installAntigravity(options), 0);
  assert.equal(readdirSync(recovery).filter(name => name.startsWith('native-install-')).length, firstReceiptCount);
  const receipt = readReceiptForRestore(join(firstSnapshot.directory, firstSnapshot.head!.file), join(project, '.agents', 'hooks.json'));
  const uninstall = await runUninstallFlow({ receipt, current: readFileSync(join(project, '.agents', 'hooks.json'), 'utf8'), confirm: async () => 'uninstall', output: () => {}, error: message => assert.fail(message), save: updated => saveInstallation(join(project, '.agents', 'hooks.json'), readFileSync(join(project, '.agents', 'hooks.json'), 'utf8'), updated, recovery), backupParent: recovery });
  assert.equal(uninstall, 0); assert.equal(readFileSync(context, 'utf8'), before);
});

test('managed AGENTS reference drift and newly created context lifecycle are protected', async t => {
  const root = makeTempRoot('ag-reference-lifecycle-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const home = join(root, 'home'); const recovery = join(root, 'recovery');
  mkdirSync(join(project, 'docs'), { recursive: true }); mkdirSync(home);
  const agents = join(project, 'AGENTS.md'); const alternate = join(project, 'docs', 'ALT.md');
  writeFileSync(agents, '# Original instructions\n');
  const options = { scope: 'project' as const, project, context: 'docs/ALT.md', home, recoveryDirectory: recovery,
    agentsDirectory: rolesDir, commandsDirectory: commandsDir, ask: defaultAnswer, output: () => {}, error: () => {} };
  assert.equal(await installAntigravity(options), 0);
  assert.equal(existsSync(alternate), true, 'installer creates selected missing context');
  const target = join(project, '.agents', 'hooks.json');
  const targetBefore = readFileSync(target, 'utf8'); const alternateBefore = readFileSync(alternate, 'utf8');
  const managedAgents = readFileSync(agents, 'utf8');
  const receiptBytes = snapshotTree(recovery);
  const entriesBefore = snapshotTree(recovery);
  const referenceChanged = readFileSync(agents, 'utf8') + '\nHuman-added instructions\n'; writeFileSync(agents, referenceChanged);
  let prompted = false;
  await assert.rejects(installAntigravity({ ...options, ask: async () => { prompted = true; return ''; } }), /recorded predecessor after-state/);
  assert.equal(prompted, false); assert.equal(readFileSync(agents, 'utf8'), referenceChanged);
  assert.equal(readFileSync(alternate, 'utf8'), alternateBefore); assert.equal(readFileSync(target, 'utf8'), targetBefore);
  assert.deepEqual(snapshotTree(recovery), entriesBefore);
  assert.deepEqual(snapshotTree(recovery), receiptBytes);
  writeFileSync(agents, managedAgents);
  // Restore the exact managed reference before exercising clean uninstall.
  const snapshot = discoverReceiptChain(recovery, target, 'antigravity');
  const receipt = readReceiptForRestore(join(snapshot.directory, snapshot.head!.file), target);
  assert.equal(await runUninstallFlow({ receipt, current: readFileSync(target, 'utf8'), confirm: async () => 'uninstall', output: () => {}, error: message => assert.fail(message), save: updated => saveInstallation(target, readFileSync(target, 'utf8'), updated, recovery), backupParent: recovery }), 0);
  assert.equal(existsSync(alternate), false, 'clean uninstall removes installer-created alternate context');
  assert.equal(readFileSync(agents, 'utf8'), '# Original instructions\n');
});

test('predecessor edits injected during customized-artifact confirmation abort before receipts or writes', async t => {
  const root = makeTempRoot('ag-prompt-race-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const home = join(root, 'home'); const recovery = join(root, 'recovery');
  mkdirSync(project); mkdirSync(home);
  const agents = join(project, 'AGENTS.md');
  const options = { scope: 'project' as const, project, home, recoveryDirectory: recovery,
    agentsDirectory: rolesDir, commandsDirectory: commandsDir, ask: defaultAnswer, output: () => {}, error: () => {} };
  assert.equal(await installAntigravity(options), 0);
  const managedAgents = readFileSync(agents, 'utf8');
  const artifact = join(project, '.agents', 'skills', 'start-issue', 'SKILL.md');
  const artifactOriginal = readFileSync(artifact, 'utf8'); writeFileSync(artifact, `${artifactOriginal}\ncustomized\n`);
  const artifactChanged = readFileSync(artifact, 'utf8');
  const target = join(project, '.agents', 'hooks.json'); const targetOriginal = readFileSync(target, 'utf8');
  const recoveryBefore = snapshotTree(recovery);
  let injected = false;
  await assert.rejects(installAntigravity({ ...options, ask: async question => {
    if (question.includes('Overwrite customized/unowned file')) {
      injected = true; writeFileSync(agents, `${managedAgents}\nHuman edit during prompt\n`); return 'yes';
    }
    return defaultAnswer(question);
  } }), /recorded predecessor after-state/);
  assert.equal(injected, true, 'customized-artifact confirmation prompt was reached');
  assert.equal(readFileSync(agents, 'utf8'), `${managedAgents}\nHuman edit during prompt\n`);
  assert.equal(readFileSync(artifact, 'utf8'), artifactChanged);
  assert.equal(readFileSync(target, 'utf8'), targetOriginal);
  assert.deepEqual(snapshotTree(recovery), recoveryBefore);
});

test('retained prior context and global suggestion edits during preference prompts are revalidated', async t => {
  const root = makeTempRoot('ag-retained-context-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const home = join(root, 'home'); const recovery = join(root, 'recovery');
  mkdirSync(join(project, 'docs'), { recursive: true }); mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  const retained = join(project, 'docs', 'OLD.md'); writeFileSync(retained, '# Retained context\n');
  const globalPrefs = antigravityGlobalModelPreferencesPath(home);
  const initialPrefs = JSON.stringify(emptyPreferences(), null, 2) + '\n'; writeFileSync(globalPrefs, initialPrefs);
  const base = { scope: 'project' as const, project, home, recoveryDirectory: recovery, agentsDirectory: rolesDir, commandsDirectory: commandsDir, output: () => {}, error: () => {} };
  const confirm = async (question: string, suggested?: string) => question.trimStart().startsWith('Confirm installation') ? 'yes' : (suggested ?? 'yes');
  assert.equal(await installAntigravity({ ...base, context: 'docs/OLD.md', ask: confirm }), 0);
  assert.equal(await installAntigravity({ ...base, context: 'docs/NEW.md', ask: confirm }), 0);
  const oldManaged = readFileSync(retained, 'utf8'); writeFileSync(retained, `${oldManaged}\nHuman edit\n`);
  const oldChanged = readFileSync(retained, 'utf8');
  const target = join(project, '.agents', 'hooks.json'); const targetBytes = readFileSync(target, 'utf8');
  const entries = snapshotTree(recovery);
  await assert.rejects(installAntigravity({ ...base, context: 'docs/NEW.md', ask: confirm }), /recorded predecessor after-state/);
  assert.equal(readFileSync(retained, 'utf8'), oldChanged); assert.equal(readFileSync(target, 'utf8'), targetBytes);
  assert.deepEqual(snapshotTree(recovery), entries);

  // On a separate clean project, edit a managed global suggestion while project
  // preference questions are open; it must not be absorbed into the new receipt.
  const project2 = join(root, 'project2'); mkdirSync(project2);
  assert.equal(await installAntigravity({ scope: 'global', home, recoveryDirectory: recovery, agentsDirectory: rolesDir, commandsDirectory: commandsDir,
    ask: async question => question.trimStart().startsWith('lead: desired') ? '1' : 'yes', output: () => {}, error: () => {} }), 0);
  const managedGlobalPrefs = readFileSync(globalPrefs, 'utf8');
  assert.ok(managedGlobalPrefs.includes('Claude Opus 5.5'));
  const globalRecoveryBefore = snapshotTree(recovery);
  const emptyProjectTree = snapshotTree(project2);
  let injected = false;
  await assert.rejects(installAntigravity({ ...base, project: project2, ask: async (question, suggested) => {
    if (!injected && question.trimStart().startsWith('lead: desired')) {
      injected = true; writeFileSync(globalPrefs, managedGlobalPrefs.replace('Claude Opus 5.5', 'Changed during prompt'));
    }
    return question.trimStart().startsWith('Confirm installation') ? 'yes' : (suggested ?? 'yes');
  } }), /recorded predecessor after-state/);
  assert.equal(injected, true);
  assert.notEqual(readFileSync(globalPrefs, 'utf8'), managedGlobalPrefs);
  assert.deepEqual(snapshotTree(recovery), globalRecoveryBefore);
  assert.deepEqual(snapshotTree(project2), emptyProjectTree, 'no project target, artifacts, context Markdown, or AGENTS reference were created');
});

test('global model preferences are managed with earliest before-state and repeat installation is a no-op', async t => {
  const root = makeTempRoot('ag-model-global-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); const recovery = join(root, 'recovery');
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  const path = prefsPath(home);
  const before = JSON.stringify(emptyPreferences(), null, 2) + '\n'; writeFileSync(path, before);
  const ask = async (question: string, suggested?: string) => question.startsWith('lead: desired') ? '2' : defaultAnswer(question, suggested);
  const options = { scope: 'global' as const, home, recoveryDirectory: recovery, agentsDirectory: rolesDir, commandsDirectory: commandsDir, ask, output: () => {}, error: () => {} };
  assert.equal(await installAntigravity(options), 0);
  const savedText = readFileSync(path, 'utf8');
  assert.equal(JSON.parse(savedText).preferences.lead, 'Claude Sonnet 5.5');
  const snapshot = discoverReceiptChain(recovery, join(home, '.gemini', 'config', 'hooks.json'), 'antigravity');
  const evidence = snapshot.head?.receipt.version === 2 ? snapshot.head.receipt.managedFiles?.find(file => file.path === path) : undefined;
  assert.deepEqual(evidence?.before, { content: before });
  assert.deepEqual(evidence?.after, { content: savedText });
  assert.equal(evidence?.kind, 'config');
  assert.deepEqual(Object.keys(JSON.parse(savedText).preferences).sort(), [...nativeRoles].sort());
  const updateOptions = { ...options, ask: async (question: string, suggested?: string) => question.startsWith('lead: desired') ? '3' : defaultAnswer(question, suggested) };
  assert.equal(await installAntigravity(updateOptions), 0);
  const updatedText = readFileSync(path, 'utf8');
  assert.equal(JSON.parse(updatedText).preferences.lead, 'Gemini 4 Argon');
  const updatedSnapshot = discoverReceiptChain(recovery, join(home, '.gemini', 'config', 'hooks.json'), 'antigravity');
  const updatedEvidence = updatedSnapshot.head?.receipt.version === 2 ? updatedSnapshot.head.receipt.managedFiles?.find(file => file.path === path) : undefined;
  assert.deepEqual(updatedEvidence?.before, { content: before }, 'update preserves earliest managed before-state');
  assert.deepEqual(updatedEvidence?.after, { content: updatedText });
  assert.ok(readdirSync(recovery).some(name => name.startsWith('native-install-')));
  const receiptsBefore = readdirSync(recovery).filter(name => name.startsWith('native-install-')).length;
  assert.equal(await installAntigravity(updateOptions), 0);
  assert.equal(readdirSync(recovery).filter(name => name.startsWith('native-install-')).length, receiptsBefore);
});

test('alternate-context installation is managed and uninstall blocks after concurrent content changes', async t => {
  const root = makeTempRoot('ag-model-uninstall-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const home = join(root, 'home'); const recovery = join(root, 'recovery');
  mkdirSync(join(project, 'docs'), { recursive: true }); mkdirSync(home);
  const context = join(project, 'docs', 'HARNESS.md'); const original = '# Preserve these notes\n'; writeFileSync(context, original);
  let flowRetryObserved = false;
  const exitCode = await runInstallerFlow({ scope: 'project', project, context: 'docs/HARNESS.md', host: 'antigravity' }, {
    home, recoveryDirectory: recovery, agentsDirectory: rolesDir, commandsDirectory: commandsDir,
    ask: async (question, suggested) => {
      if (question.startsWith('lead: desired')) {
        if (!flowRetryObserved) { flowRetryObserved = true; return '9'; }
        return '';
      }
      return defaultAnswer(question, suggested);
    }, output: () => {}, error: () => {},
  });
  assert.equal(exitCode, 0);
  assert.ok(flowRetryObserved, 'CLI-used install flow retries invalid numbered input');
  assert.ok(readFileSync(context, 'utf8').includes('# Preserve these notes'));
  assert.ok(readFileSync(join(project, 'AGENTS.md'), 'utf8').includes('docs/HARNESS.md'));
  const installedContext = readFileSync(context, 'utf8');
  writeFileSync(context, installedContext + '\nUser edit after install.\n');
  const targetConfig = join(project, '.agents', 'hooks.json');
  const snapshot = discoverReceiptChain(recovery, targetConfig, 'antigravity');
  assert.ok(snapshot.head);
  const receipt = readReceiptForRestore(join(snapshot.directory, snapshot.head!.file), targetConfig);
  let saved = false; const errors: string[] = [];
  const currentConfig = readFileSync(targetConfig, 'utf8');
  const recoveryEntriesBeforeConflict = readdirSync(recovery).sort();
  const status = await runUninstallFlow({
    receipt,
    current: currentConfig,
    confirm: async () => 'uninstall', output: () => {}, error: message => errors.push(message),
    save: () => { saved = true; }, backupParent: recovery,
  });
  assert.equal(status, 1);
  assert.equal(saved, false);
  const conflictMessage = errors.find(message => message.includes('Uninstall blocked by concurrent edits to:'));
  assert.ok(conflictMessage, 'uninstall reports its production concurrent-edit refusal');
  assert.ok(conflictMessage.includes(context), 'conflict identifies the edited managed context path');
  assert.equal(readFileSync(targetConfig, 'utf8'), currentConfig);
  assert.deepEqual(readdirSync(recovery).sort(), recoveryEntriesBeforeConflict, 'conflict refusal creates no backup or receipt writes');
  assert.ok(readFileSync(context, 'utf8').includes('User edit after install.'));

  writeFileSync(context, installedContext);
  const restoreStatus = await runUninstallFlow({
    receipt,
    current: readFileSync(targetConfig, 'utf8'),
    confirm: async () => 'uninstall', output: () => {}, error: message => assert.fail(message),
    save: updated => { saveInstallation(targetConfig, readFileSync(targetConfig, 'utf8'), updated, recovery); },
    backupParent: recovery,
  });
  assert.equal(restoreStatus, 0);
  assert.equal(existsSync(targetConfig), false, 'installer-created Antigravity config is removed');
  assert.equal(readFileSync(context, 'utf8'), original);
  assert.equal(existsSync(join(project, 'AGENTS.md')), false, 'installer-created context reference is removed');
});

test('project model preference section can be round-tripped without replacing unrelated settings', () => {
  const base = '# Notes\n\n<!-- advanced-harness:integrations:start -->\nexisting unrelated block\n<!-- advanced-harness:integrations:end -->\n';
  const preferences = { version: 1, preferences: Object.fromEntries(nativeRoles.map(role => [role, role === 'qa' ? 'Arbitrary local label' : null])) };
  const text = updateContext(base, 'model-preferences', preferences, ['Desired labels only.']);
  assert.ok(text.startsWith('# Notes\n'));
  assert.ok(text.includes('existing unrelated block'));
  assert.deepEqual(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)?.[1] ?? '{}'), preferences);
});

test('concurrent preference-context change during review is preserved and leaves no recovery writes', async t => {
  const root = makeTempRoot('ag-model-concurrent-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const home = join(root, 'home'); const recovery = join(root, 'recovery');
  mkdirSync(project); mkdirSync(home);
  const agents = join(project, 'AGENTS.md'); writeFileSync(agents, '# Original project context\n');
  let confirmationPromptObserved = false;
  await assert.rejects(runInstallerFlow({ scope: 'project', project, host: 'antigravity' }, {
    home, recoveryDirectory: recovery, agentsDirectory: rolesDir, commandsDirectory: commandsDir,
    ask: async (question, suggested) => {
      if (question.trimStart().startsWith('Confirm installation')) {
        confirmationPromptObserved = true;
        writeFileSync(agents, '# Concurrent human edit\n');
      }
      return suggested ?? 'yes';
    },
    output: () => {}, error: () => {},
  }), /Model preference file changed while confirmation was open/);
  assert.ok(confirmationPromptObserved, 'concurrent mutation was injected during the actual confirmation prompt');
  assert.equal(readFileSync(agents, 'utf8'), '# Concurrent human edit\n');
  assert.equal(existsSync(join(project, '.agents')), false);
  assert.equal(existsSync(recovery), false);
});

test('OpenCode rejects Antigravity-only --context before any configuration writes', async t => {
  const root = makeTempRoot('ag-model-opencode-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  await assert.rejects(runInstallerFlow({ scope: 'project', project, host: 'opencode', context: 'docs/HARNESS.md' }, {
    home: root, ask: async () => { throw new Error('No prompt expected'); }, output: () => {}, error: () => {},
  }), /supported only with --host antigravity/);
  assert.deepEqual(readdirSync(project), []);
});

test('malformed global preference file aborts before deployment or recovery writes', async t => {
  const root = makeTempRoot('ag-model-malformed-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const home = join(root, 'home'); const recovery = join(root, 'recovery');
  mkdirSync(project); mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  writeFileSync(prefsPath(home), '{ malformed preferences');
  await assert.rejects(installAntigravity({
    scope: 'project', project, home, recoveryDirectory: recovery, agentsDirectory: rolesDir, commandsDirectory: commandsDir,
    ask: defaultAnswer, output: () => {}, error: () => {},
  }));
  assert.equal(existsSync(join(project, '.agents')), false);
  assert.equal(existsSync(recovery), false);
});

for (const collision of ['.agents/rules/advanced-harness-lead.md', '.agents/skills/start-issue/SKILL.md']) {
  test(`Antigravity preference context collision with ${collision} aborts before any write`, async t => {
    const root = makeTempRoot('ag-model-collision-'); t.after(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, 'project'); const home = join(root, 'home'); const recovery = join(root, 'recovery');
    mkdirSync(project); mkdirSync(home);
    let confirmationReached = false;
    await assert.rejects(installAntigravity({
      scope: 'project', project, home, context: collision, recoveryDirectory: recovery,
      agentsDirectory: rolesDir, commandsDirectory: commandsDir,
      ask: async question => {
        if (question.trimStart().startsWith('Confirm installation')) confirmationReached = true;
        return '';
      },
      output: () => {}, error: () => {},
    }), /overlaps Antigravity deployment artifact/);
    assert.equal(confirmationReached, false);
    assert.equal(existsSync(join(project, collision)), false);
    assert.equal(existsSync(join(project, '.agents')), false);
    assert.equal(existsSync(recovery), false);
  });
}
