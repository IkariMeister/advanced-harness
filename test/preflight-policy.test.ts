import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { updateContext } from '../src/project-context.ts';
import { loadProjectPreflightPolicy } from '../src/preflight/policy.ts';
import { createDefaultChecks, runPreflight } from '../src/preflight/runner.ts';
import { scanAddedText } from '../src/preflight/secret-scanner.ts';
import { makeTempRoot } from './temp-directory.ts';

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function projectRepo(policy?: { forbiddenPathGlobs?: string[]; allowlist?: unknown }): string {
  const root = makeTempRoot('preflight-policy-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  const checks = Object.fromEntries(['build', 'lint', 'unit', 'roborazzi', 'runtime', 'e2e'].map(name => [name, { status: 'unconfigured' }]));
  const profile = { version: 1, baseBranch: 'main', shell: 'bash', checks, device: { preference: 'ask' }, worktreeDirectory: join(root, '..', 'wt'), memoryPath: join(root, '..', 'mem', 'MEMORY.md') };
  writeFileSync(join(root, 'AGENTS.md'), updateContext('', 'project', profile, []));
  if (policy) {
    mkdirSync(join(root, '.harness'));
    if (policy.forbiddenPathGlobs !== undefined) writeFileSync(join(root, '.harness', 'preflight.json'), JSON.stringify({ forbiddenPathGlobs: policy.forbiddenPathGlobs }));
    if (policy.allowlist !== undefined) writeFileSync(join(root, '.harness', 'preflight-allowlist.json'), JSON.stringify(policy.allowlist));
  }
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'base');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(root, 'checkout', '-q', '-b', 'task');
  return root;
}

test('trusted base policy replaces path globs, normalizes exact allowlist paths, and hides justifications', async () => {
  const justification = 'Reviewed approved fixture exception; no production credential.';
  const root = projectRepo({ forbiddenPathGlobs: ['**/*.bin'], allowlist: [{ path: 'src\\token.ts', rule: 'high-entropy-assignment', justification }] });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'token.ts'), 'const api_key = "THIS_IS_A_FAKE_SECRET_VALUE_0123456789";\n');
  writeFileSync(join(root, '.env.local'), 'ordinary text\n');
  const policy = loadProjectPreflightPolicy(root, 'main');
  assert.deepEqual(policy.sensitivePathGlobs, ['**/*.bin']);
  assert.equal(policy.secretExceptions[0]?.path, 'src/token.ts');
  assert.equal(policy.secretExceptions[0]?.justification, justification);
  assert.equal(createDefaultChecks().length, 5);
  const secretScanner: typeof scanAddedText = (changes, dependencies) => scanAddedText(changes, { ...dependencies, probe: () => ({ available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' }) });
  const result = await runPreflight({ worktree: root, base: 'main', secretScanner });
  assert.equal(result.checks.find(check => check.id === 'path-policy')?.status, 'pass', 'replacement globs do not retain the default .env rule');
  assert.equal(result.checks.find(check => check.id === 'secret-scan')?.status, 'pass');
  assert.equal(result.metrics['secret-scan.exceptionsApplied'], 1);
  assert.ok(!JSON.stringify(result).includes(justification));
});

test('branch policy edits are blocked and cannot weaken trusted checks; explicit options remain authoritative', async () => {
  const root = projectRepo({ forbiddenPathGlobs: ['**/*.pem'], allowlist: [] });
  mkdirSync(join(root, '.harness'), { recursive: true });
  writeFileSync(join(root, '.harness', 'preflight.json'), JSON.stringify({ forbiddenPathGlobs: [] }));
  writeFileSync(join(root, '.harness', 'preflight-allowlist.json'), JSON.stringify([{ path: 'candidate.pem', rule: 'high-entropy-assignment', justification: 'Branch-added suppression attempt.' }]));
  writeFileSync(join(root, 'candidate.pem'), 'const api_key = "THIS_IS_A_FAKE_SECRET_VALUE_0123456789";\n');
  const secretScanner: typeof scanAddedText = (changes, dependencies) => scanAddedText(changes, { ...dependencies, probe: () => ({ available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' }) });
  const trusted = await runPreflight({ worktree: root, base: 'main', secretScanner });
  assert.equal(trusted.checks.find(check => check.id === 'policy-integrity')?.status, 'block');
  assert.equal(trusted.checks.find(check => check.id === 'path-policy')?.status, 'block', 'base forbidden-path policy remains in force despite branch edits');
  assert.equal(trusted.checks.find(check => check.id === 'secret-scan')?.status, 'block', 'branch allowlist edits cannot suppress findings');

  const explicit = await runPreflight({ worktree: root, base: 'main', sensitivePathGlobs: ['**/*.txt'], secretExceptions: [], secretScanner });
  assert.equal(explicit.checks.find(check => check.id === 'path-policy')?.status, 'pass', 'trusted programmatic glob options take precedence over base policy');
  assert.equal(explicit.checks.find(check => check.id === 'secret-scan')?.status, 'block', 'explicit empty exceptions are preserved');
  assert.equal(explicit.checks.find(check => check.id === 'policy-integrity')?.status, 'block');
});

test('project-context base changes cannot select branch-authored policy', async () => {
  const root = projectRepo({ forbiddenPathGlobs: ['**/*.pem'], allowlist: [] });
  writeFileSync(join(root, 'candidate.pem'), 'const api_key = "THIS_IS_A_FAKE_SECRET_VALUE_0123456789";\n');
  const agentsPath = join(root, 'AGENTS.md');
  writeFileSync(agentsPath, readFileSync(agentsPath, 'utf8').replace('"baseBranch": "main"', '"baseBranch": "task"'));
  const secretScanner: typeof scanAddedText = (changes, dependencies) => scanAddedText(changes, { ...dependencies, probe: () => ({ available: false, backend: 'builtin', reason: 'Gitleaks is not installed.' }) });
  const result = await runPreflight({ worktree: root, secretScanner });
  assert.equal(result.checks.find(check => check.id === 'base-context')?.status, 'block');
  assert.equal(result.checks.find(check => check.id === 'path-policy')?.status, 'block', 'implicit policy source stays pinned to the trusted remote default ref');
});

test('invalid trusted policy is inconclusive before checks and custom policy options reject conflicts', async () => {
  const root = projectRepo({ forbiddenPathGlobs: [] });
  writeFileSync(join(root, '.harness', 'preflight.json'), '{broken');
  git(root, 'add', '.harness/preflight.json'); git(root, 'commit', '-q', '-m', 'invalid trusted policy');
  git(root, 'update-ref', 'refs/heads/main', 'HEAD');
  const invalid = await runPreflight({ worktree: root, base: 'main' });
  assert.ok(invalid.checks.every(check => check.status === 'inconclusive'));
  assert.ok(invalid.checks.every(check => check.evidence[0]?.includes('Project preflight policy is invalid')));
  const explicit = await runPreflight({ worktree: root, base: 'main', sensitivePathGlobs: [], secretExceptions: [] });
  assert.equal(explicit.approved, true, 'explicit trusted policy options remain usable when they replace invalid base policy files');

  const conflict = await runPreflight({ worktree: root, checks: [], sensitivePathGlobs: [] });
  assert.equal(conflict.checks[0]?.status, 'inconclusive');
  assert.match(conflict.checks[0]?.evidence[0] ?? '', /cannot be combined/);
});
