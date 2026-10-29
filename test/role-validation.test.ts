import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadNativeDefinitions, nativeRoles, type NativeRole } from '../src/native-installer.ts';
import { ROLE_TOOL_OWNERSHIP, checkToolOwnership, validateRoleToolMatrix } from '../src/role-validation.ts';

const definitions = loadNativeDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));

test('validateRoleToolMatrix covers all eight native roles with defined domains', () => {
  const matrix = validateRoleToolMatrix();
  assert.equal(matrix.length, 8);
  for (const { role, rule } of matrix) {
    assert.equal(rule.role, role);
    assert.ok(rule.domain.length > 0);
    assert.ok(rule.allowedCapabilities.length > 0);
    assert.ok(rule.deniedCapabilities.length > 0);
  }
});

test('checkToolOwnership denies gh pr merge for all roles and escalates to human', () => {
  for (const role of nativeRoles) {
    const result = checkToolOwnership(role, 'shell', 'gh pr merge 123');
    assert.equal(result.allowed, false);
    assert.ok(result.violation);
    assert.equal(result.violation?.escalateTo, 'human');
    assert.match(result.violation?.reason ?? '', /human-only/);

    const exeResult = checkToolOwnership(role, 'shell', 'gh.exe pr merge 456');
    assert.equal(exeResult.allowed, false);
    assert.equal(exeResult.violation?.escalateTo, 'human');
  }
});

test('checkToolOwnership enforces remote git push ownership strictly for external', () => {
  // External is allowed git push
  const externalResult = checkToolOwnership('external', 'shell', 'git push origin main');
  assert.equal(externalResult.allowed, true);

  // Other roles are denied git push and escalated to external
  for (const role of nativeRoles.filter(r => r !== 'external')) {
    const result = checkToolOwnership(role, 'shell', 'git push origin main');
    assert.equal(result.allowed, false);
    assert.equal(result.violation?.escalateTo, 'external');
  }
});

test('owned command checks reject unsupported prefixes and global options safely', () => {
  for (const [role, command] of [
    ['operator', 'git -C . push origin main'],
    ['external', 'gh --repo owner/repo pr merge 123'],
    ['external', 'gh -R owner/repo pr merge 123']
  ] as const) {
    const result = checkToolOwnership(role, 'shell', command);
    assert.equal(result.allowed, false, command);
    assert.equal(result.violation?.escalateTo, 'lead');
  }
  for (const role of nativeRoles) {
    assert.equal(checkToolOwnership(role, 'shell', 'gh pr merge 123').allowed, false);
  }
});

test('quoted owned subcommands normalize consistently for shell and execute', () => {
  for (const action of ['shell', 'execute']) {
    for (const quote of ['"', "'"]) {
      const push = checkToolOwnership('operator', action, `git ${quote}push${quote} origin main`);
      assert.equal(push.allowed, false, `${action}: quoted git push`);
      assert.equal(push.violation?.escalateTo, 'external');

      const merge = checkToolOwnership('external', action, `gh pr ${quote}merge${quote} 123`);
      assert.equal(merge.allowed, false, `${action}: quoted gh merge`);
      assert.equal(merge.violation?.escalateTo, 'human');
    }
  }
});

test('unsupported interleaved options and partial quoting fail closed for shell and execute', () => {
  const unsafe = [
    ['external', 'gh pr --repo owner/repo merge 123'],
    ['external', 'gh pr -R owner/repo merge 123'],
    ['operator', 'git pu"sh" origin main'],
    ['external', 'gh pr mer"ge" 123'],
    ['external', 'gh pr "merge 123']
  ] as const;
  for (const action of ['shell', 'execute']) for (const [role, command] of unsafe) {
    const result = checkToolOwnership(role, action, command);
    assert.equal(result.allowed, false, `${action}: ${command}`);
    assert.equal(result.violation?.escalateTo, 'lead');
  }
  assert.equal(checkToolOwnership('external', 'shell', 'gh pr create --title test').allowed, true);
  assert.equal(checkToolOwnership('external', 'shell', 'git push origin main').allowed, true);
});

test('checkToolOwnership enforces gh CLI ownership strictly for external', () => {
  // External is allowed gh commands
  const externalResult = checkToolOwnership('external', 'shell', 'gh pr create --title "test"');
  assert.equal(externalResult.allowed, true);

  // Other roles are denied gh commands
  for (const role of nativeRoles.filter(r => r !== 'external')) {
    const result = checkToolOwnership(role, 'shell', 'gh issue list');
    assert.equal(result.allowed, false);
    assert.equal(result.violation?.escalateTo, 'external');
  }
});

test('checkToolOwnership enforces file editing ownership to implementer, operator, lead', () => {
  assert.equal(checkToolOwnership('implementer', 'edit', 'src/app.ts').allowed, true);
  assert.equal(checkToolOwnership('operator', 'write', 'MEMORY.md').allowed, true);
  assert.equal(checkToolOwnership('lead', 'edit', 'AGENTS.md').allowed, true);

  // Read-only / verification roles are denied edit actions and escalated to implementer
  for (const role of ['reviewer', 'qa', 'researcher', 'planner'] as NativeRole[]) {
    const result = checkToolOwnership(role, 'edit', 'src/app.ts');
    assert.equal(result.allowed, false);
    assert.equal(result.violation?.escalateTo, 'implementer');
  }
});

test('operator and lead exceptions apply only to explicit context or memory files', () => {
  assert.equal(checkToolOwnership('operator', 'edit', 'MEMORY.md').allowed, true);
  assert.equal(checkToolOwnership('operator', 'write', 'memory/notes.md').allowed, true);
  assert.equal(checkToolOwnership('lead', 'edit', 'AGENTS.md').allowed, true);
  for (const resource of ['src/app.ts', 'package.json', 'docs/guide.md']) {
    assert.equal(checkToolOwnership('operator', 'edit', resource).allowed, false, resource);
    assert.equal(checkToolOwnership('lead', 'write', resource).allowed, false, resource);
  }
});

test('native template definitions align with role tool ownership policies', () => {
  for (const role of nativeRoles) {
    const def = definitions[role];
    const ownership = ROLE_TOOL_OWNERSHIP[role];

    // Every template must state WAIT for explicit approval if approvalRequired
    if (ownership.approvalRequired && role === 'lead') {
      assert.ok(def.system.includes('WAIT for explicit human approval'));
    }

    // External template specifically documents narrow push and gh allowances and merge denial
    if (role === 'external') {
      assert.ok(def.system.includes('`pr merge` is explicitly denied'));
      assert.ok(def.system.includes('`git push`'));
      assert.ok(def.permissions.some((rule: any) => rule.action === 'webfetch' && rule.effect === 'ask'));
      assert.ok(def.permissions.some((rule: any) => rule.action === 'websearch' && rule.effect === 'ask'));
    }
    if (role === 'researcher') {
      assert.ok(!ownership.allowedCapabilities.includes('websearch'));
      assert.ok(!ownership.allowedCapabilities.includes('webfetch'));
      assert.ok(def.permissions.some((rule: any) => rule.action === '*' && rule.effect === 'deny'));
      assert.ok(!def.permissions.some((rule: any) => rule.action === 'websearch'));
      assert.ok(!def.permissions.some((rule: any) => rule.action === 'webfetch'));
    }
  }
});
