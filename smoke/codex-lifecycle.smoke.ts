// SMK-CX: Codex installation is gated (issue #45 requires strict per-role isolation, which Codex lacks).
// The real harness:* CLIs must refuse install and update without prompting for Codex answers or writing
// anything, while harness:doctor stays available. Adapter behavior is covered by test/codex-adapter.test.ts.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSandbox, realHomeFingerprintOf, tree, type Sandbox } from './support/sandbox.ts';

describe('SMK-CX Codex install gate (non-TTY piped answers)', () => {
  let box: Sandbox;
  let pristine: Map<string, string>;
  const projectArgs = (host = 'codex') => ['--host', host, '--scope', 'project', '--project', box.project];
  before(() => {
    box = createSandbox('codex');
    const config = join(box.project, '.codex', 'config.toml');
    mkdirSync(join(box.project, '.codex'), { recursive: true });
    writeFileSync(config, '# smoke-owned original\r\n\r\n[mcp_servers."fixture.server"] # keep this comment\r\nenabled = true\r\n');
    pristine = tree(box.project);
  });
  after(() => box.dispose());

  it('CX-01 install is blocked with the #45 reason and changes nothing', async () => {
    const result = await box.run('install-native-harness.ts', projectArgs());
    assert.equal(result.code, 2, result.transcript);
    assert.deepEqual(result.unansweredSteps, []);
    assert.match(result.stderr, /Installation blocked: OpenAI Codex native installation is gated: issue #45 requires strict per-role isolation/);
    assert.deepEqual(tree(box.project), pristine);
    assert.equal(existsSync(box.recoveryDirectory), false);
  });

  it('CX-02 update is blocked with the #45 reason and changes nothing', async () => {
    const result = await box.run('update-native-harness.ts', projectArgs());
    assert.equal(result.code, 2, result.transcript);
    assert.match(result.stderr, /Update blocked: OpenAI Codex native installation is gated: issue #45/);
    assert.deepEqual(tree(box.project), pristine);
    assert.equal(existsSync(box.recoveryDirectory), false);
  });

  it('CX-03 global scope is blocked and leaves the sandbox home and the real home untouched', async () => {
    // realHomeFingerprintOf joins each entry onto homedir(), so watched paths must be home-relative. Only
    // harness-written paths are watched: the rest of a real ~/.codex (sessions, logs, databases) is live.
    const watched = ['.codex/config.toml', '.codex/agents', '.codex/rules', '.codex/.advanced-harness-state.json', '.agents/skills', 'Projects/advanced-harness-backups'];
    // Prove the guard resolves and hashes a real directory (and never returns its contents) by pointing
    // homedir() at a fixture that holds a secret-like file.
    const homeVariable = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const fixtureHome = join(box.root, 'fingerprint-home');
    mkdirSync(join(fixtureHome, '.codex'), { recursive: true });
    writeFileSync(join(fixtureHome, '.codex', 'auth.json'), 'SECRET-LIKE-SENTINEL-do-not-log');
    const savedHome = process.env[homeVariable];
    process.env[homeVariable] = fixtureHome;
    let fixtureFingerprint: string | undefined;
    try { fixtureFingerprint = realHomeFingerprintOf(['.codex']).get('.codex'); }
    finally { if (savedHome === undefined) delete process.env[homeVariable]; else process.env[homeVariable] = savedHome; }
    assert.match(fixtureFingerprint ?? '', /^directory:auth\.json:file:\d+:[a-f0-9]{64}$/);
    assert.doesNotMatch(fixtureFingerprint ?? '', /SECRET-LIKE-SENTINEL/);

    const before = realHomeFingerprintOf(watched);
    const homeBefore = tree(box.home);
    for (const script of ['install-native-harness.ts', 'update-native-harness.ts']) {
      const result = await box.run(script, ['--host', 'codex', '--scope', 'global']);
      assert.equal(result.code, 2, result.transcript);
      assert.match(result.stderr, /issue #45/);
    }
    assert.deepEqual(tree(box.home), homeBefore);
    assert.equal(existsSync(join(box.home, '.codex')), false);
    assert.equal(existsSync(join(box.home, '.agents')), false);
    assert.deepEqual(realHomeFingerprintOf(watched), before, 'real-home harness paths remain unchanged');
  });

  it('CX-04 doctor stays available and reports the missing installation', async () => {
    const result = await box.run('diagnose-native-harness.ts', ['--host', 'codex', '--project', box.project]);
    assert.notEqual(result.code, 0, result.transcript);
    assert.match(result.transcript, /Codex/);
    assert.deepEqual(tree(box.project), pristine);
  });
});
