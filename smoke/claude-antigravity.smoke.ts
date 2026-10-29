// SMK-CC / SMK-AG: Claude Code and Antigravity project install → doctor (→ uninstall gap) in an isolated home.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSandbox, tree, type Sandbox } from './support/sandbox.ts';
import { antigravityInstall, ask, roles } from './support/steps.ts';

const commands = ['address-pr-feedback', 'assess-debt', 'grill-me', 'report-defect', 'review-pr', 'start-issue'];

describe('SMK-CC Claude Code project lifecycle (non-TTY piped answers)', () => {
  let box: Sandbox;
  let pristine: Map<string, string>;
  const args = () => ['--host', 'claude-code', '--scope', 'project', '--project', box.project];
  before(() => { box = createSandbox('claude'); pristine = tree(box.project); });
  after(() => box.dispose());

  it('SMK-CC-01 Enter at the install confirmation cancels with no writes', async () => {
    const result = await box.run('install-native-harness.ts', args(), { steps: [ask('Type yes to install the Claude Code harness')] });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Installation canceled by user\. No files written\./);
    assert.deepEqual(tree(box.project), pristine);
    assert.equal(existsSync(box.recoveryDirectory), false);
  });

  it('SMK-CC-02 install deploys CLAUDE.md, settings, eight agents, and six commands; AGENTS.md preserved', async () => {
    const result = await box.run('install-native-harness.ts', args(), { steps: [ask('Type yes to install the Claude Code harness', 'yes')] });
    assert.equal(result.code, 0, result.transcript);
    assert.match(readFileSync(join(box.project, 'CLAUDE.md'), 'utf8'), /advanced-harness:lead:start/);
    const settings = JSON.parse(readFileSync(join(box.project, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.agent, 'lead');
    assert.ok(JSON.stringify(settings.permissions?.deny ?? []).includes('gh pr merge'), 'gh pr merge is denied');
    for (const role of roles) assert.ok(existsSync(join(box.project, '.claude', 'agents', `${role}.md`)), role);
    for (const command of commands) assert.ok(existsSync(join(box.project, '.claude', 'commands', `${command}.md`)), command);
    assert.equal(readFileSync(join(box.project, 'AGENTS.md'), 'utf8'), pristine.get('AGENTS.md'));
    assert.deepEqual(box.openCodeCalls(), []);
  });

  it('SMK-CC-03 doctor reports the Claude Code footprint as healthy', async () => {
    const result = await box.run('diagnose-native-harness.ts', ['--host', 'claude-code', '--project', box.project]);
    assert.equal(result.code, 0, result.transcript);
    assert.match(result.stdout, /Status: HEALTHY \(Installed: Yes\)/);
  });

  it('SMK-CC-04 receipt-backed uninstall removes the Claude Code footprint and restores AGENTS.md', async () => {
    const result = await box.run('uninstall-native-harness.ts', args(), { steps: [ask('Type uninstall to continue', 'uninstall')] });
    assert.equal(result.code, 0, result.transcript);
    for (const role of roles) assert.equal(existsSync(join(box.project, '.claude', 'agents', `${role}.md`)), false, role);
    for (const command of commands) assert.equal(existsSync(join(box.project, '.claude', 'commands', `${command}.md`)), false, command);
    assert.equal(existsSync(join(box.project, '.claude', 'settings.json')), false, 'settings.json');
    assert.equal(existsSync(join(box.project, 'CLAUDE.md')), false, 'CLAUDE.md');
    assert.equal(readFileSync(join(box.project, 'AGENTS.md'), 'utf8'), pristine.get('AGENTS.md'));
  });
});

describe('SMK-AG Antigravity project lifecycle (non-TTY piped answers)', () => {
  let box: Sandbox;
  let pristine: Map<string, string>;
  const args = () => ['--host', 'antigravity', '--scope', 'project', '--project', box.project];
  before(() => { box = createSandbox('antigravity'); pristine = tree(box.project); });
  after(() => box.dispose());

  it('SMK-AG-01 answering no at the install confirmation cancels with no writes', async () => {
    const result = await box.run('install-native-harness.ts', args(), { steps: antigravityInstall('no') });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Installation canceled by user\. No files written\./);
    assert.deepEqual(tree(box.project), pristine);
  });

  it('SMK-AG-02 Enter at the confirmation (default no) cancels with no writes', async () => {
    const result = await box.run('install-native-harness.ts', args(), { steps: antigravityInstall('') });
    assert.equal(result.code, 1, result.transcript);
    assert.match(result.stdout, /\(yes\/no\) \[no\]: /);
    assert.match(result.stdout, /Installation canceled by user\. No files written\./);
    assert.deepEqual(tree(box.project), pristine);
  });

  it('SMK-AG-03 install deploys rules, skills, merge guard hook, and MCP config; preferences go to AGENTS.md', async () => {
    const result = await box.run('install-native-harness.ts', args(), { steps: antigravityInstall('yes') });
    assert.equal(result.code, 0, result.transcript);
    const agents = join(box.project, '.agents');
    assert.ok(existsSync(join(agents, 'rules', 'advanced-harness-lead.md')));
    for (const command of commands) assert.ok(existsSync(join(agents, 'skills', command, 'SKILL.md')), command);
    assert.ok(existsSync(join(agents, 'scripts', 'antigravity-merge-guard.mjs')));
    assert.match(readFileSync(join(agents, 'hooks.json'), 'utf8'), /antigravity-merge-guard/);
    assert.ok(readFileSync(join(box.project, 'AGENTS.md'), 'utf8').startsWith(pristine.get('AGENTS.md')!.trimEnd()), 'original AGENTS.md content preserved');
  });

  it('SMK-AG-04 doctor reports the Antigravity footprint as installed', async () => {
    const result = await box.run('diagnose-native-harness.ts', ['--host', 'antigravity', '--project', box.project]);
    assert.equal(result.code, 0, result.transcript);
    assert.match(result.stdout, /Installed: Yes/);
  });

  it('SMK-AG-05 receipt-backed uninstall removes the Antigravity footprint and restores AGENTS.md', async () => {
    const result = await box.run('uninstall-native-harness.ts', args(), { steps: [ask('Type uninstall to continue', 'uninstall')] });
    assert.equal(result.code, 0, result.transcript);
    const agents = join(box.project, '.agents');
    assert.equal(existsSync(join(agents, 'rules', 'advanced-harness-lead.md')), false, 'lead rule');
    for (const command of commands) assert.equal(existsSync(join(agents, 'skills', command, 'SKILL.md')), false, command);
    assert.equal(existsSync(join(agents, 'scripts', 'antigravity-merge-guard.mjs')), false, 'merge guard script');
    assert.equal(existsSync(join(agents, 'hooks.json')), false, 'hooks.json');
    assert.equal(existsSync(join(agents, 'mcp_config.json')), false, 'mcp_config.json');
    assert.equal(readFileSync(join(box.project, 'AGENTS.md'), 'utf8'), pristine.get('AGENTS.md'));
  });
});
