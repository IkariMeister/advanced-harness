import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadNativeDefinitions, nativeRoles } from '../src/native-installer.ts';
import { loadRoleDefinitions } from '../src/role-definitions.ts';
import { lowerOpenCodePolicy } from '../src/capability-policy.ts';
import { reconcilePermissions, type PermissionRule } from '../src/permission-reconciliation.ts';
import { claudeGuardrailDenyRules, destructiveGitCommands, isDestructiveGitInvocation, isOpenCodeGuardrailRule, openCodeGuardrailRules, sensitivePaths } from '../src/security-guardrails.ts';
import { claudeSettingsDeny, mergeClaudeSettings } from '../src/claude-code-compiler.ts';
import { compileCodexMergeRule, diagnoseCodex, installCodex } from '../src/codex-adapter.ts';
import { getAntigravityMergeGuardMjsSource } from '../src/antigravity-compiler.ts';
import { evaluatePreToolUse, isDestructiveGitCommand } from '../scripts/antigravity-merge-guard.ts';
import { makeTempRoot } from './temp-directory.ts';

const agents = fileURLToPath(new URL('../agents/', import.meta.url));
const definitions = loadNativeDefinitions(agents);
const r = (action: string, resource: string, effect: PermissionRule['effect']): PermissionRule => ({ action, resource, effect });

/** OpenCode-style ordered last-match evaluation where `*` matches any run of characters and `?` one character. */
function effect(permissions: readonly PermissionRule[], action: string, value: string): PermissionRule['effect'] | undefined {
  const literal = (part: string) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const matches = (pattern: string, text: string) => new RegExp(`^${pattern.split('*').map(part => part.split('?').map(literal).join('.')).join('.*')}$`, 's').test(text);
  return permissions.filter(rule => (rule.action === '*' || rule.action === action) && matches(rule.resource, value)).at(-1)?.effect;
}

const sensitiveSamples = ['app/release.jks', 'keys/upload.keystore', 'local.properties', 'app/google-services.json', 'signing.properties', 'certs/server.pem', 'tls/private.key', '~/.ssh/id_ed25519', '~/.aws/credentials', '~/.config/gh/hosts.yml', 'C:\\Users\\dev\\.ssh\\id_ed25519', '/home/dev/.ssh/id_rsa', 'C:\\Users\\dev\\.aws\\credentials', '/home/dev/.aws/credentials', 'C:\\Users\\dev\\.config\\gh\\hosts.yml', 'app\\release.jks'];
const destructiveSamples = ['git reset --hard', 'git reset --hard HEAD~1', 'git reset origin/main --hard', 'git clean -fdx', 'git clean -xdf', 'git push --force', 'git push --force origin feature', 'git push origin feature --force', 'git push -f origin feature', 'git push origin main -f', 'git push --force-with-lease', 'git push --force-with-lease=main origin main', 'git push origin +main', 'git push -uf origin HEAD', 'git push -fu origin HEAD', 'git push origin HEAD -uf', 'git push -vuf', 'git push origin -qf main', 'git push -vuqf origin HEAD', 'git push origin HEAD -fvuq'];

test('every OpenCode role denies sensitive-path reads after all source rules', () => {
  for (const role of nativeRoles) {
    const permissions = definitions[role].permissions as PermissionRule[];
    for (const path of sensitiveSamples) assert.equal(effect(permissions, 'read', path), 'deny', `${role} read ${path}`);
    assert.equal(effect(permissions, 'read', 'src/main/App.kt'), 'allow', role);
    assert.equal(effect(permissions, 'read', '.env'), 'ask', `${role} keeps .env as ask`);
  }
});

test('OpenCode edit and shell guardrails apply only to roles that can reach those tools', () => {
  for (const role of nativeRoles) {
    const permissions = definitions[role].permissions as PermissionRule[];
    const canEdit = permissions.some(rule => rule.action === 'edit' && rule.effect !== 'deny');
    const canShell = permissions.some(rule => rule.action === 'shell' && rule.effect !== 'deny');
    for (const path of sensitiveSamples) assert.equal(effect(permissions, 'edit', path), 'deny', `${role} edit ${path}`);
    assert.equal(permissions.some(rule => rule.action === 'edit' && sensitivePaths.some(path => (path.opencode as readonly string[]).includes(rule.resource))), canEdit, role);
    assert.equal(permissions.some(rule => rule.action === 'shell' && (destructiveGitCommands as readonly string[]).includes(rule.resource)), canShell, role);
    if (canShell) for (const command of destructiveSamples) assert.equal(effect(permissions, 'shell', command), 'deny', `${role} ${command}`);
  }
  assert.equal(effect(definitions.operator.permissions as PermissionRule[], 'shell', 'git status'), 'ask');
  assert.equal(effect(definitions.operator.permissions as PermissionRule[], 'shell', 'git reset --soft HEAD~1'), 'ask');
  assert.equal(effect(definitions.operator.permissions as PermissionRule[], 'shell', 'git push-helper'), 'ask');
  assert.equal(effect(definitions.external.permissions as PermissionRule[], 'shell', 'git push origin feature'), 'allow');
  for (const command of ['git push -u origin feature', 'git push --follow-tags', 'git push origin feature-fix', 'git push -u origin fix-f']) assert.equal(effect(definitions.external.permissions as PermissionRule[], 'shell', command), 'allow', command);
  assert.equal(effect(definitions.implementer.permissions as PermissionRule[], 'edit', 'app/src/main/App.kt'), 'allow');
});

test('updating an install that predates guardrails appends them last without conflicts', () => {
  const sources = loadRoleDefinitions(agents);
  for (const role of nativeRoles) {
    const old = lowerOpenCodePolicy(role, sources[role].deployment.opencode.policy).permissions!;
    const desired = definitions[role].permissions as PermissionRule[];
    const plan = reconcilePermissions({ existing: old, prior: old.map(rule => ({ rule, sources: [`native:${role}`] })), previousOrder: old, desired: desired.map(rule => ({ rule, sources: [`native:${role}`] })), retiringSources: [`native:${role}`] });
    assert.deepEqual(plan.preview.conflicts, [], role);
    assert.deepEqual(plan.rules, desired, role);
  }
});

test('updating a first BH-036 install adds separator-agnostic paths and four-letter clusters without conflicts', () => {
  const addedLater = (rule: PermissionRule) => /^\*[/\\]\./.test(rule.resource) || /(?:^| )-[?f]{4}(?: |$)/.test(rule.resource);
  for (const role of nativeRoles) {
    const desired = definitions[role].permissions as PermissionRule[];
    const old = desired.filter(rule => !addedLater(rule));
    assert.ok(old.length < desired.length, role);
    const plan = reconcilePermissions({ existing: old, prior: old.map(rule => ({ rule, sources: [`native:${role}`] })), previousOrder: old, desired: desired.map(rule => ({ rule, sources: [`native:${role}`] })), retiringSources: [`native:${role}`] });
    assert.deepEqual(plan.preview.conflicts, [], role);
    const key = (rule: PermissionRule) => `${rule.action} ${rule.resource} ${rule.effect}`;
    assert.deepEqual(plan.rules.map(key).sort(), desired.map(key).sort(), role);
    const guards = plan.rules.map(isOpenCodeGuardrailRule);
    assert.equal(guards.indexOf(true) >= 0 && guards.slice(guards.indexOf(true)).every(Boolean), true, `${role} keeps guardrails last`);
    for (const path of sensitiveSamples) assert.equal(effect(plan.rules, 'read', path), 'deny', `${role} read ${path}`);
  }
});

test('later setup rules land before guardrails, and a later override of a guardrail fails closed', () => {
  const guard = r('shell', 'git push --force *', 'deny');
  const added = reconcilePermissions({ existing: [r('shell', '*', 'ask'), guard], desired: [{ rule: r('shell', 'git push *', 'allow'), sources: ['integration'] }] });
  assert.deepEqual(added.preview.conflicts, []);
  assert.deepEqual(added.rules, [r('shell', '*', 'ask'), r('shell', 'git push *', 'allow'), guard]);
  const overridden = reconcilePermissions({ existing: [guard, r('shell', 'git push *', 'allow')], desired: [{ rule: guard, sources: ['native:external'] }] });
  assert.equal(overridden.preview.conflicts.length, 1);
  assert.match(overridden.preview.conflicts[0]!.message, /required denial shell git push --force \*/);
  const disjoint = reconcilePermissions({ existing: [r('read', '*', 'allow'), r('read', '*.env', 'ask')], desired: [{ rule: r('read', '*.jks', 'deny'), sources: ['native:lead'] }] });
  assert.deepEqual(disjoint.preview.conflicts, [], 'star-only suffix globs are compared exactly');
  assert.deepEqual(openCodeGuardrailRules([r('read', '*', 'allow')]).map(rule => rule.action), sensitivePaths.flatMap(path => path.opencode.map(() => 'read')));
});

test('Claude settings deny sensitive-path Read/Edit and destructive Git for every session', () => {
  const merged = JSON.parse(mergeClaudeSettings(JSON.stringify({ permissions: { allow: ['Read(**)'] } }))) as { permissions: { deny: string[]; ask: string[] } };
  for (const rule of ['Read(**/*.jks)', 'Edit(**/*.keystore)', 'Read(**/local.properties)', 'Edit(**/google-services.json)', 'Read(~/.ssh/**)', 'Read(~/.aws/credentials)', 'Read(~/.config/gh/hosts.yml)', 'Bash(git reset --hard *)', 'Bash(git clean *)', 'Bash(git push * --force)', 'Bash(git push --force-with-lease*)']) {
    assert.ok(merged.permissions.deny.includes(rule), rule);
  }
  for (const rule of claudeGuardrailDenyRules()) assert.ok(claudeSettingsDeny.includes(rule), rule);
  assert.ok(!merged.permissions.deny.some(rule => /\.env/.test(rule)), '.env stays an ask rule');
  assert.ok(merged.permissions.ask.includes('Read(./.env)'));
});

test('destructive Git detection handles flags, wrappers, and global options without blocking safe Git', () => {
  for (const command of [...destructiveSamples, 'git -C ../app reset --hard', 'git.exe clean -n', 'env GIT_TRACE=1 git push -uf origin x', 'git status && git reset --hard', '"C:\\Program Files\\Git\\bin\\git.exe" push --force']) {
    assert.equal(isDestructiveGitCommand(command), true, command);
  }
  for (const command of ['git status', 'git reset --soft HEAD~1', 'git reset HEAD file.kt', 'git push', 'git push origin feature', 'git push --follow-tags', 'git push -u origin feature', 'git log --format=%H', 'echo git clean']) {
    assert.equal(isDestructiveGitCommand(command), false, command);
  }
  assert.equal(isDestructiveGitInvocation(['git', '-c', 'core.x=1', 'push', '--force']), true);
});

test('deployed Antigravity guard script matches the tested guard on destructive Git', () => {
  const dir = makeTempRoot('guardrail-mjs-');
  const script = join(dir, 'antigravity-merge-guard.mjs');
  writeFileSync(script, getAntigravityMergeGuardMjsSource());
  for (const command of ['git push origin main --force', 'git clean -fd', 'git reset --hard', 'git push origin feature', 'git status', 'gh pr merge 1']) {
    const payload = { toolCall: { name: 'run_command', args: { CommandLine: command } } };
    const run = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout.trim()).decision, evaluatePreToolUse(payload).decision, command);
  }
  assert.equal(evaluatePreToolUse({ toolCall: { name: 'run_command', args: { CommandLine: 'git push --force' } } }).decision, 'deny');
});

test('Codex rules forbid destructive Git prefixes and doctor reports a missing one', async () => {
  const rules = compileCodexMergeRule();
  for (const pattern of ['["git", "reset", "--hard"]', '["git", "clean"]', '["git", "push", "--force"]', '["git", "push", "-f"]', '["git", "push", "--force-with-lease"]', '["gh", "pr", "merge"]']) {
    assert.ok(rules.includes(`prefix_rule(pattern = ${pattern}, decision = "forbidden")`), pattern);
  }
  const listed = (source: string) => JSON.parse(source) as (string | string[])[];
  const patterns = [...rules.matchAll(/^prefix_rule\(pattern = (\[.*\]), decision = "forbidden"\)$/gm)].map(match => listed(match[1]!));
  const forbidden = (command: string) => patterns.some(pattern => pattern.every((token, index) => {
    const actual = command.split(' ')[index];
    return actual !== undefined && (typeof token === 'string' ? token === actual : token.includes(actual));
  }));
  for (const command of ['git push -uf origin HEAD', 'git push -fu origin HEAD', 'git push -vuf', 'git push origin --force', 'git push origin -f main', 'git push upstream -uf', 'git push origin --force-with-lease']) assert.ok(forbidden(command), command);
  for (const command of ['git push -u origin feature', 'git push origin feature', 'git push --follow-tags', 'git push origin -u feature']) assert.ok(!forbidden(command), command);
  const root = mkdtempSync(join(tmpdir(), 'codex-guardrails-'));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const answers = ['', ...nativeRoles.flatMap(() => ['gpt-example', 'medium']), 'install'];
  assert.equal(await installCodex({ scope: 'project', project, home, ask: async () => answers.shift() ?? '', output() {}, error() {} }), 0);
  assert.equal((await diagnoseCodex({ project, home })).ok, true);
  const path = join(project, '.codex', 'rules', 'advanced-harness.rules');
  writeFileSync(path, readFileSync(path, 'utf8').replace('prefix_rule(pattern = ["git", "clean"], decision = "forbidden")\n', ''));
  const report = await diagnoseCodex({ project, home });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some(issue => /destructive Git rules are missing or malformed \(git clean\)/.test(issue)), report.issues.join('\n'));
  const remoteRule = readFileSync(path, 'utf8').split('\n').find(line => line.startsWith('prefix_rule(pattern = ["git", "push", ["origin"'))!;
  writeFileSync(path, readFileSync(path, 'utf8').replace(`${remoteRule}\n`, ''));
  const remoteReport = await diagnoseCodex({ project, home });
  assert.ok(remoteReport.issues.some(issue => /git push \{origin\|upstream\} \{--force\|-f\|--force-with-lease\|…\}/.test(issue)), remoteReport.issues.join('\n'));
});
