import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { join } from 'node:path';
import { makeTempRoot } from './temp-directory.ts';
import { applyOpenCodeCommandDeployment, bindWorkflowArguments, emitOpenCodeCommand, loadWorkflowCommand, loadWorkflowCommands, planOpenCodeCommandDeployment, workflowCommandIds } from '../src/workflow-commands.ts';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import { nativeRoles } from '../src/native-installer.ts';

const commandsDir = new URL('../commands/', import.meta.url);
const openCodeDir = new URL('../.opencode/commands/', import.meta.url);
const file = (dir: URL, name: string) => readFileSync(new URL(`${name}.md`, dir), 'utf8');

test('canonical workflow definitions strictly load six commands and match generated OpenCode outputs', () => {
  const commands = loadWorkflowCommands(fileURLToPath(commandsDir));
  assert.deepEqual(Object.keys(commands), [...workflowCommandIds]);
  for (const id of workflowCommandIds) assert.equal(emitOpenCodeCommand(commands[id]), file(openCodeDir, id));
  assert.equal(commands['report-defect'].arguments.mode, 'positional');
  assert.deepEqual(commands['report-defect'].arguments, { mode: 'positional', names: ['parent', 'description'], remainder: 2 });
  const temp = makeTempRoot('workflow-schema-extra-');
  try {
    for (const id of workflowCommandIds) writeFileSync(join(temp, `${id}.md`), file(commandsDir, id));
    writeFileSync(join(temp, 'unexpected.md'), 'not a command');
    assert.throws(() => loadWorkflowCommands(temp), /exactly the six canonical/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('schema rejects unknown/missing fields, versions, malformed contracts, and placeholder drift', () => {
  const valid = file(commandsDir, 'start-issue');
  for (const candidate of [
    valid.replace('schemaVersion: 1', 'schemaVersion: 2'),
    valid.replace('description: Start approved work on a GitHub or Jira issue', 'description: ""'),
    valid.replace('  mode: full', '  mode: full\n  extra: true'),
    valid.replace('arguments:\n  mode: full', 'arguments:\n  mode: full\n  extra: true'),
    valid.replace('$ARGUMENTS', '$1'),
    valid.replace('arguments:\n  mode: full', 'arguments:\n  mode: positional\n  names: [parent, description]\n  remainder: 2'),
    valid.replace('schemaVersion: 1\n', 'schemaVersion: 1\nunknown: true\n')
  ]) assert.throws(() => loadWorkflowCommand(candidate, 'start-issue'), /workflow command/i);
  const defect = file(commandsDir, 'report-defect');
  assert.throws(() => loadWorkflowCommand(defect.replace('remainder: 2', 'remainder: 1'), 'report-defect'), /argument contract/i);
  assert.throws(() => loadWorkflowCommand(defect.replace('$2', '$3'), 'report-defect'), /placeholders/i);
});

test('full arguments bind as one opaque string and inserted placeholders are not recursively substituted', () => {
  const command = loadWorkflowCommands(fileURLToPath(commandsDir))['start-issue'];
  const userText = 'literal $ARGUMENTS and $1; do not expand';
  assert.equal(bindWorkflowArguments(command, userText), command.body.replace('$ARGUMENTS', userText));
});

test('report-defect binds parent and the complete description remainder without tokenizing it', () => {
  const command = loadWorkflowCommands(fileURLToPath(commandsDir))['report-defect'];
  const parent = 'PROJ-42';
  const description = 'a multi word description containing $1 and $2';
  assert.equal(bindWorkflowArguments(command, { parent, description }), command.body.replace('$1', parent).replace('$2', description));
  assert.equal(bindWorkflowArguments(command, { parent }), command.body.replace('$1', parent).replace('$2', ''));
  assert.throws(() => bindWorkflowArguments(command, `${parent} ${description}`), /not tokenized/i);
  assert.match(command.body, /Ask if parent or description is missing\/ambiguous/);
});

test('source metadata is not leaked and OpenCode generation retains description and body exactly', () => {
  for (const id of workflowCommandIds) {
    const source = file(commandsDir, id);
    const output = file(openCodeDir, id);
    assert.match(source, /^---\r?\nschemaVersion: 1/m);
    const outputHeader = /^---\r?\n([\s\S]*?)\r?\n---/.exec(output)?.[1] ?? '';
    assert.doesNotMatch(outputHeader, /schemaVersion|arguments:/);
    assert.equal(output, emitOpenCodeCommand(loadWorkflowCommand(source, id)));
  }
});

test('production update consumes canonical command sources and preserves customized generated files', async t => {
  const temp = makeTempRoot('workflow-command-update-');
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const project = join(temp, 'project'), source = join(temp, 'commands'), outputDir = join(project, '.opencode', 'commands');
  mkdirSync(project, { recursive: true }); mkdirSync(source, { recursive: true }); mkdirSync(outputDir, { recursive: true });
  for (const id of workflowCommandIds) {
    const text = file(commandsDir, id);
    writeFileSync(join(source, `${id}.md`), text.replace('schemaVersion: 1', 'schemaVersion: 1'));
  }
  const canonical = readFileSync(join(source, 'start-issue.md'), 'utf8').replace('Start approved work on a GitHub or Jira issue', 'Updated canonical issue workflow');
  writeFileSync(join(source, 'start-issue.md'), canonical);
  const custom = '---\ndescription: My customized command\n---\nDo not overwrite this user content.\n';
  writeFileSync(join(outputDir, 'review-pr.md'), custom);
  const config = join(project, 'opencode.json');
  writeFileSync(config, JSON.stringify({ agents: Object.fromEntries(nativeRoles.map(role => [role, {}])) }));
  const ask = async (question: string, fallback = '') => {
    if (question.startsWith('Check remote')) return 'no';
    if (question.includes('system prompt to latest')) return 'no';
    if (question.includes('Replace customized workflow command')) return 'no';
    if (question.startsWith('Choose new models')) return 'no'; if (question.startsWith('Type update')) return 'update';
    return fallback;
  };
  await runUpdateFlow({ scope: 'project', project }, {
    ask, output: () => {}, error: () => {}, home: temp, recoveryDirectory: join(temp, 'recovery'),
    workflowCommandsDirectory: source,
    runCommand: (_executable, args) => args[0] === 'rev-parse' ? 'a'.repeat(40) : '',
    verify: async () => ({ ok: true, checks: [] }), printReport: () => {}
  });
  assert.equal(readFileSync(join(outputDir, 'start-issue.md'), 'utf8'), emitOpenCodeCommand(loadWorkflowCommand(canonical, 'start-issue')));
  assert.equal(readFileSync(join(outputDir, 'review-pr.md'), 'utf8'), custom);
  assert.equal(readFileSync(join(outputDir, 'address-pr-feedback.md'), 'utf8'), file(openCodeDir, 'address-pr-feedback'));
});

test('command deployment rejects targets changed after preview without writing', t => {
  const temp = makeTempRoot('workflow-command-race-');
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const output = join(temp, 'out'); mkdirSync(output);
  const plan = planOpenCodeCommandDeployment(fileURLToPath(commandsDir), output);
  writeFileSync(join(output, 'start-issue.md'), 'concurrent user change');
  assert.throws(() => applyOpenCodeCommandDeployment(plan, workflowCommandIds, join(temp, 'backups')), /changed after preview/i);
  assert.equal(readFileSync(join(output, 'start-issue.md'), 'utf8'), 'concurrent user change');
  assert.equal(existsSync(join(output, 'review-pr.md')), false);
});

test('planOpenCodeCommandDeployment distinguishes untouched older generated commands from customization', () => {
  const temp = makeTempRoot('workflow-command-plan-status-');
  try {
    const output = join(temp, 'out');
    mkdirSync(output);
    const sourceDir = fileURLToPath(commandsDir);

    const oldContent = '---\ndescription: Start approved work on a GitHub or Jira issue\n---\nOld command body\n';
    const oldHash = createHash('sha256').update(oldContent).digest('hex');
    const userCustomContent = '---\ndescription: User custom\n---\nUser custom body\n';

    // 1. start-issue: untouched older generated file (matches prior after content)
    writeFileSync(join(output, 'start-issue.md'), oldContent);
    // 2. review-pr: customized file (differs from prior after content and current template)
    writeFileSync(join(output, 'review-pr.md'), userCustomContent);
    // 3. address-pr-feedback: current file (matches latest template exactly)
    writeFileSync(join(output, 'address-pr-feedback.md'), file(openCodeDir, 'address-pr-feedback'));
    // 4. report-defect: missing on disk (not created)
    // 5. assess-debt: absent on prior after, but user created file on disk
    writeFileSync(join(output, 'assess-debt.md'), 'user created without prior presence');

    const priorManagedFiles = [
      {
        path: join(output, 'start-issue.md'),
        kind: 'commands' as const,
        before: { absent: true as const },
        after: { content: oldContent, digest: oldHash },
      },
      {
        path: join(output, 'review-pr.md'),
        kind: 'commands' as const,
        before: { absent: true as const },
        after: { content: oldContent, digest: oldHash },
      },
      {
        path: join(output, 'address-pr-feedback.md'),
        kind: 'commands' as const,
        before: { absent: true as const },
        after: { content: file(openCodeDir, 'address-pr-feedback'), digest: createHash('sha256').update(file(openCodeDir, 'address-pr-feedback')).digest('hex') },
      },
      {
        path: join(output, 'assess-debt.md'),
        kind: 'commands' as const,
        before: { absent: true as const },
        after: { absent: true as const },
      },
    ];

    const plan = planOpenCodeCommandDeployment(sourceDir, output, priorManagedFiles);
    const byId = Object.fromEntries(plan.map(item => [item.id, item]));

    assert.equal(byId['start-issue']?.status, 'outdated');
    assert.equal(byId['review-pr']?.status, 'customized');
    assert.equal(byId['address-pr-feedback']?.status, 'current');
    assert.equal(byId['report-defect']?.status, 'missing');
    assert.equal(byId['assess-debt']?.status, 'customized');
    assert.equal(byId['grill-me']?.status, 'missing');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
