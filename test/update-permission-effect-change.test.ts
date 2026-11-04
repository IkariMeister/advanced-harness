import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRoot } from './temp-directory.ts';
import { runUpdateFlow, type UpdateFlowDependencies } from '../src/update-cli-flow.ts';
import { planUninstall, readInstallationReceipt } from '../src/installation-receipt.ts';
import { createSuccessorReceipt, discoverReceiptChain, finalizeSuccessor, writePendingSuccessor } from '../src/receipt-lineage.ts';
import { chooseConfiguration, loadNativeDefinitions, nativeRoles, parseConfiguration, type NativeRole } from '../src/native-installer.ts';
import { reconcilePermissions, type PermissionRule, type ReconciliationResult } from '../src/permission-reconciliation.ts';

const definitions = loadNativeDefinitions(join(process.cwd(), 'agents'));
const released = JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', 'released-operator-permissions.json'), 'utf8')) as Record<string, PermissionRule[]>;
const shell = (resource: string, effect: PermissionRule['effect']): PermissionRule => ({ action: 'shell', resource, effect });
const oldFetch = shell('git fetch *', 'deny');
const newFetch = shell('git fetch *', 'allow');
const operatorRules = (text: string, path: string) => (parseConfiguration(text, path).agents as Record<string, { permissions: PermissionRule[] }>).operator!.permissions;
const snapshotFiles = (directory: string) => readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name), 'utf8')] as const);
const headPath = (recovery: string, config: string) => join(recovery, discoverReceiptChain(recovery, config, 'opencode').head!.file);

/** A v2 install of a released Operator policy, with every rule owned per rule in the receipt. */
function v2Install(t: test.TestContext, operator: readonly PermissionRule[], configDirectory?: (root: string) => string) {
  const root = makeTempRoot('harness-effect-change-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = configDirectory?.(root) ?? join(root, 'project');
  mkdirSync(directory, { recursive: true });
  const config = join(directory, 'opencode.json');
  const recovery = join(root, 'recovery');
  mkdirSync(recovery);
  const rulesFor = (role: NativeRole) => role === 'operator' ? operator : definitions[role].permissions as PermissionRule[];
  const plans = Object.fromEntries(nativeRoles.map(role => [role, reconcilePermissions({ existing: [], desired: rulesFor(role).map(rule => ({ rule, sources: [`native:${role}`] })) })])) as Record<NativeRole, ReconciliationResult>;
  const installed = JSON.stringify({ agents: Object.fromEntries(nativeRoles.map(role => [role, {
    description: definitions[role].description,
    mode: definitions[role].mode,
    model: 'custom/model#low',
    system: definitions[role].system,
    permissions: plans[role].rules
  }])) }, null, 2);
  const chain = discoverReceiptChain(recovery, config, 'opencode');
  const pending = writePendingSuccessor(chain, createSuccessorReceipt(chain, undefined, installed, plans, undefined, { host: 'opencode' }));
  writeFileSync(config, installed);
  finalizeSuccessor(pending, installed);
  return { root, directory, config, recovery, installed };
}

type Fixture = ReturnType<typeof v2Install>;
async function update(fixture: Fixture, final: string, options: { global?: boolean } = {}) {
  const questions: string[] = [], output: string[] = [], errors: string[] = [];
  const deps: UpdateFlowDependencies = {
    ask: async question => {
      questions.push(question);
      if (question.startsWith('Choose new models')) return 'no';
      if (question.startsWith('Type update')) return final;
      throw new Error(`Unexpected prompt: ${question}`);
    },
    output: text => output.push(text), error: text => errors.push(text),
    home: fixture.root, recoveryDirectory: fixture.recovery,
    runCommand: (_cmd, args) => args[0] === 'rev-parse' ? '1111222233334444' : '',
    verify: async () => ({ ok: true, checks: [] } as never), printReport: () => {},
    ...(options.global ? { xdgConfigHome: join(fixture.root, 'xdg') } : {})
  };
  const status = await runUpdateFlow(options.global ? { scope: 'global', checkRemote: false } : { scope: 'project', project: fixture.directory, checkRemote: false }, deps);
  return { status, questions, output, errors };
}

for (const tag of ['v0.1.0', 'v0.2.0']) {
  test(`a ${tag} v2 install updates past the Operator git fetch policy change, and later uninstalls cleanly`, async t => {
    const operator = released[tag]!;
    assert.ok(operator.some(rule => JSON.stringify(rule) === JSON.stringify(oldFetch)));
    const fixture = v2Install(t, operator);

    const result = await update(fixture, 'update');
    assert.equal(result.status, 0, result.errors.join('\n'));
    assert.ok(!result.questions.some(question => question.startsWith('Type migrate')));
    assert.ok(result.output.includes(`    - ${JSON.stringify(oldFetch)}`), result.output.join('\n'));
    assert.ok(result.output.includes(`    + ${JSON.stringify(newFetch)}`), result.output.join('\n'));
    assert.ok(result.output.includes('    ! effect change: shell git fetch * goes from deny to allow'), result.output.join('\n'));

    const saved = readFileSync(fixture.config, 'utf8');
    const rules = operatorRules(saved, fixture.config);
    assert.ok(!rules.some(rule => JSON.stringify(rule) === JSON.stringify(oldFetch)));
    // OpenCode rules are last-match: the upload-pack denials must stay after the broad allow.
    const at = (resource: string) => rules.findIndex(rule => rule.action === 'shell' && rule.resource === resource);
    assert.ok(at('git fetch *') >= 0);
    for (const denial of ['git fetch *--upl*', 'git fetch -u*', 'git fetch * -u*']) {
      assert.ok(at(denial) > at('git fetch *'), denial);
      assert.equal(rules[at(denial)]!.effect, 'deny');
    }
    // Everything else in the current policy is present, and nothing outside it survives.
    const key = (rule: PermissionRule) => JSON.stringify([rule.action, rule.resource, rule.effect]);
    assert.deepEqual(new Set(rules.map(key)), new Set((definitions.operator.permissions as PermissionRule[]).map(key)));

    const head = readInstallationReceipt(headPath(fixture.recovery, fixture.config), fixture.config);
    assert.equal(head.version, 2);
    const evidence = head.version === 2 ? head.permissions.find(p => p.path[1] === 'operator')! : undefined;
    assert.deepEqual(evidence?.owned.find(o => o.rule.resource === 'git fetch *'), { rule: newFetch, sources: ['native:operator'] });

    const restore = planUninstall(head, saved);
    assert.deepEqual(restore.conflicts, []);
    assert.equal((parseConfiguration(restore.updated, fixture.config).agents as Record<string, Record<string, unknown>> | undefined)?.operator?.permissions, undefined);

    // A repeat update has no further effect change and leaves the rules as they are.
    const next = await update(fixture, 'update');
    assert.equal(next.status, 0, next.errors.join('\n'));
    assert.ok(!next.output.some(line => line.includes('effect change')), next.output.join('\n'));
    assert.deepEqual(operatorRules(readFileSync(fixture.config, 'utf8'), fixture.config), rules);
  });
}

test('cancelling the final confirmation after an effect-change preview writes nothing', async t => {
  const fixture = v2Install(t, released['v0.2.0']!);
  const before = snapshotFiles(fixture.recovery);
  const result = await update(fixture, 'cancel');
  assert.equal(result.status, 0);
  assert.ok(result.output.includes('    ! effect change: shell git fetch * goes from deny to allow'));
  assert.ok(result.output.includes('Update cancelled. No files or receipts were modified.'));
  assert.equal(readFileSync(fixture.config, 'utf8'), fixture.installed);
  assert.deepEqual(snapshotFiles(fixture.recovery), before);
  assert.equal(existsSync(join(fixture.directory, '.opencode', 'commands')), false);
});

test('a hand-edited owned rule still blocks update with no writes', async t => {
  const fixture = v2Install(t, released['v0.2.0']!);
  const edited = fixture.installed.replace(/("resource": "git fetch \*",\s*"effect": )"deny"/, '$1"ask"');
  assert.notEqual(edited, fixture.installed);
  writeFileSync(fixture.config, edited);
  const before = snapshotFiles(fixture.recovery);
  const result = await update(fixture, 'update');
  assert.equal(result.status, 2);
  assert.ok(result.errors.some(line => line.includes('[operator] invalid-prior')), result.errors.join('\n'));
  assert.ok(!result.questions.some(question => question.startsWith('Type update')));
  assert.equal(readFileSync(fixture.config, 'utf8'), edited);
  assert.deepEqual(snapshotFiles(fixture.recovery), before);
});

const retiring = { retiringSources: ['native:operator'] };
const native = (rule: PermissionRule) => ({ rule, sources: ['native:operator'] });

test('an owned rule retires for a new effect and takes the ordinary addition path', () => {
  const broad = shell('*', 'ask');
  const plan = reconcilePermissions({ existing: [broad, oldFetch], prior: [native(broad), native(oldFetch)], previousOrder: [broad, oldFetch], desired: [native(broad), native(newFetch)], ...retiring });
  assert.deepEqual(plan.preview.conflicts, []);
  assert.deepEqual(plan.preview.removals, [oldFetch]);
  assert.deepEqual(plan.preview.additions, [newFetch]);
  assert.deepEqual(plan.preview.retainedObsolete, []);
  assert.deepEqual(plan.rules, [broad, newFetch]);
  assert.deepEqual(plan.provenance, [native(broad), native(newFetch)]);
});

test('an effect change still honours existing restrictions on the addition path', () => {
  const restriction = shell('git *', 'deny');
  const plan = reconcilePermissions({ existing: [oldFetch, restriction], prior: [native(oldFetch)], desired: [native(newFetch)], ...retiring });
  assert.ok(plan.preview.conflicts.some(c => c.code === 'last-match'), JSON.stringify(plan.preview.conflicts));
  assert.deepEqual(plan.rules, [oldFetch, restriction]);
});

test('effect changes refuse rules the retiring sources do not fully own', () => {
  const blocked = (options: Parameters<typeof reconcilePermissions>[0]) => {
    const plan = reconcilePermissions(options);
    assert.ok(plan.preview.conflicts.some(c => c.code === 'identity'), JSON.stringify(plan.preview.conflicts));
    assert.deepEqual(plan.rules, [...options.existing]);
    assert.deepEqual(plan.preview.removals, []);
  };
  // The user's own rule: no receipt evidence, or evidence only for a different rule.
  const other = shell('other', 'ask');
  blocked({ existing: [oldFetch], desired: [native(newFetch)], ...retiring });
  blocked({ existing: [oldFetch, other], prior: [native(other)], desired: [native(newFetch), native(other)], ...retiring });
  // Another active source still needs the old effect.
  blocked({ existing: [oldFetch], prior: [{ rule: oldFetch, sources: ['native:operator', 'integration:github'] }], desired: [native(newFetch)], ...retiring });
  // Owned, but no source is being retired.
  blocked({ existing: [oldFetch], prior: [native(oldFetch)], desired: [native(newFetch)] });
});

test('required denials never retire for a weaker effect', () => {
  const merge = shell('gh pr merge *', 'deny');
  const reset = shell('git reset --hard *', 'deny');
  for (const denial of [merge, reset]) {
    const plan = reconcilePermissions({ existing: [denial], prior: [native(denial)], desired: [native({ ...denial, effect: 'allow' })], ...retiring });
    assert.ok(plan.preview.conflicts.some(c => c.code === 'identity'), JSON.stringify(plan.preview.conflicts));
    assert.deepEqual(plan.rules, [denial]);
  }
});

/** Creates a file symlink, or skips where the platform does not allow it (unprivileged Windows). */
function linkOrSkip(t: test.TestContext, target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.skip('file symlinks are not available');
    return false;
  }
}

test('a symlink to its sibling is one configuration, whichever name is the link', t => {
  const root = makeTempRoot('harness-config-alias-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [real, link] of [['opencode.json', 'opencode.jsonc'], ['opencode.jsonc', 'opencode.json']] as const) {
    const directory = join(root, real.replace('.', '-'));
    mkdirSync(directory);
    writeFileSync(join(directory, real), '{}');
    if (!linkOrSkip(t, real, join(directory, link))) return;
    assert.equal(chooseConfiguration(directory), join(directory, real));
  }
});

test('other JSON and JSONC pairs still require --config', t => {
  const root = makeTempRoot('harness-config-pair-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ambiguous = /Both opencode.json and opencode.jsonc exist/;

  const distinct = join(root, 'distinct');
  mkdirSync(distinct);
  writeFileSync(join(distinct, 'opencode.json'), '{}');
  writeFileSync(join(distinct, 'opencode.jsonc'), '{}');
  assert.throws(() => chooseConfiguration(distinct), ambiguous);

  // A link to some other file is not the sibling, even with identical contents.
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'other.json'), '{}');
  writeFileSync(join(elsewhere, 'opencode.json'), '{}');
  if (!linkOrSkip(t, 'other.json', join(elsewhere, 'opencode.jsonc'))) return;
  assert.throws(() => chooseConfiguration(elsewhere), ambiguous);

  // Two links to one file leave no regular file to write through.
  const links = join(root, 'links');
  mkdirSync(links);
  writeFileSync(join(links, 'real.json'), '{}');
  symlinkSync('real.json', join(links, 'opencode.json'), 'file');
  symlinkSync('real.json', join(links, 'opencode.jsonc'), 'file');
  assert.throws(() => chooseConfiguration(links), ambiguous);
});

test('global update through a JSONC alias writes the regular file and keeps the link', async t => {
  const fixture = v2Install(t, released['v0.2.0']!, root => join(root, 'xdg', 'opencode'));
  const alias = join(fixture.directory, 'opencode.jsonc');
  if (!linkOrSkip(t, 'opencode.json', alias)) return;
  const result = await update(fixture, 'update', { global: true });
  assert.equal(result.status, 0, result.errors.join('\n'));
  assert.ok(result.output.includes(`  Configuration file: ${fixture.config}`), result.output.join('\n'));
  assert.ok(lstatSync(alias).isSymbolicLink());
  assert.ok(!lstatSync(fixture.config).isSymbolicLink());
  assert.equal(readFileSync(alias, 'utf8'), readFileSync(fixture.config, 'utf8'));
  assert.ok(operatorRules(readFileSync(alias, 'utf8'), alias).some(rule => JSON.stringify(rule) === JSON.stringify(newFetch)));
});
