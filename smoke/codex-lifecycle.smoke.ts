// SMK-CX: Codex installs at global scope in role-process mode (#45): each child role is its own
// codex exec process with a ~/.codex/harness-<role>.config.toml profile. The real harness:* CLIs
// refuse project scope, install into the sandbox home only, pass doctor, and uninstall back to the
// prior home. No real Codex binary is started (the live catalog prompt is answered "no").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSandbox, realHomeFingerprintOf, tree, type Sandbox } from './support/sandbox.ts';
import { ask, codexInstall, roles } from './support/steps.ts';

const childRoles = roles.filter(role => role !== 'lead');
// realHomeFingerprintOf joins each entry onto homedir(), so watched paths must be home-relative. Only
// harness-written paths are watched: the rest of a real ~/.codex (sessions, logs, databases) is live.
const watched = ['.codex/config.toml', '.codex/AGENTS.md', '.codex/advanced-harness', '.codex/agents', '.codex/rules', '.codex/.advanced-harness-state.json', '.agents/skills', 'Projects/advanced-harness-backups',
  ...childRoles.map(role => `.codex/harness-${role}.config.toml`)];

describe('SMK-CX Codex global role-process lifecycle (non-TTY piped answers)', () => {
  let box: Sandbox;
  let pristineProject: Map<string, string>;
  let realHomeBefore: Map<string, string>;
  const userConfig = '# smoke-owned original\n\n[mcp_servers.fixture]\ncommand = "fixture-mcp"\nenabled = true\n';
  const codexHome = () => join(box.home, '.codex');
  before(() => {
    box = createSandbox('codex');
    // A project-level Codex config the harness must never touch.
    mkdirSync(join(box.project, '.codex'), { recursive: true });
    writeFileSync(join(box.project, '.codex', 'config.toml'), '# smoke-owned project original\r\n');
    pristineProject = tree(box.project);
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), 'config.toml'), userConfig);
    realHomeBefore = realHomeFingerprintOf(watched);
  });
  after(() => box.dispose());

  it('CX-01 project-scope install is refused before any prompt and changes nothing', async () => {
    const result = await box.run('install-native-harness.ts', ['--host', 'codex', '--scope', 'project', '--project', box.project]);
    assert.equal(result.code, 2, result.transcript);
    assert.match(result.stderr, /Codex installation is global only/);
    assert.deepEqual(tree(box.project), pristineProject);
    assert.equal(existsSync(box.recoveryDirectory), false);
  });

  it('CX-02 project-scope update is refused before any prompt and changes nothing', async () => {
    const result = await box.run('update-native-harness.ts', ['--host', 'codex', '--scope', 'project', '--project', box.project]);
    assert.equal(result.code, 2, result.transcript);
    assert.match(result.stderr, /Codex update is global only/);
    assert.deepEqual(tree(box.project), pristineProject);
  });

  it('CX-03 Enter at the global install confirmation cancels with no writes', async () => {
    const homeBefore = tree(box.home);
    const result = await box.run('install-native-harness.ts', ['--host', 'codex', '--scope', 'global'], { steps: codexInstall('') });
    assert.equal(result.code, 0, result.transcript);
    assert.deepEqual(result.unansweredSteps, []);
    assert.match(result.stdout, /Cancelled\. No files, backups, or receipts were written\./);
    assert.match(result.stdout, /You approve every launch/);
    assert.deepEqual(tree(box.home), homeBefore);
  });

  it('CX-04 global install writes role profiles, launcher and Lead block only into the sandbox home', async () => {
    const result = await box.run('install-native-harness.ts', ['--host', 'codex', '--scope', 'global'], { steps: codexInstall('install') });
    assert.equal(result.code, 0, result.transcript);
    assert.deepEqual(result.unansweredSteps, []);
    for (const role of childRoles) assert.match(readFileSync(join(codexHome(), `harness-${role}.config.toml`), 'utf8'), /model = "gpt-smoke"/, role);
    assert.ok(existsSync(join(codexHome(), 'advanced-harness', 'codex-role.mjs')));
    assert.equal(existsSync(join(box.home, '.agents', 'skills', 'harness-procedure-documentation-impact', 'SKILL.md')), false, 'Codex procedure artifacts are not deployed by the global lifecycle');
    assert.match(readFileSync(join(codexHome(), 'AGENTS.md'), 'utf8'), /Advanced Harness Lead \(Codex, one process per role\)/);
    assert.match(readFileSync(join(codexHome(), 'config.toml'), 'utf8'), /multi_agent = false/);
    assert.equal(existsSync(join(codexHome(), 'agents')), false, 'no in-process custom agents');
    assert.deepEqual(tree(box.project), pristineProject, 'project .codex is untouched');
    assert.deepEqual(realHomeFingerprintOf(watched), realHomeBefore, 'real-home harness paths remain unchanged');
  });

  it('CX-05 doctor passes for the global install', async () => {
    const empty = join(box.root, 'no-codex-project'); mkdirSync(empty, { recursive: true });
    const result = await box.run('diagnose-native-harness.ts', ['--host', 'codex', '--project', empty]);
    assert.equal(result.code, 0, result.transcript);
    assert.match(result.stdout, /Role-process mode/);
  });

  it('CX-06 uninstall restores the prior home, including config.toml byte for byte', async () => {
    const result = await box.run('uninstall-native-harness.ts', ['--host', 'codex', '--scope', 'global'], { steps: [ask('Type uninstall to continue', 'uninstall')] });
    assert.equal(result.code, 0, result.transcript);
    assert.equal(readFileSync(join(codexHome(), 'config.toml'), 'utf8'), userConfig);
    for (const role of childRoles) assert.equal(existsSync(join(codexHome(), `harness-${role}.config.toml`)), false, role);
    for (const path of ['AGENTS.md', 'advanced-harness', '.advanced-harness-state.json']) assert.equal(existsSync(join(codexHome(), path)), false, path);
    assert.deepEqual(tree(box.project), pristineProject);
    assert.deepEqual(realHomeFingerprintOf(watched), realHomeBefore, 'real-home harness paths remain unchanged');
  });
});
