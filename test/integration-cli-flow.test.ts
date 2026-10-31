import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRoot } from './temp-directory.ts';
import { runIntegrationFlow } from '../src/integration-cli-flow.ts';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { nativeRoles } from '../src/native-installer.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = makeTempRoot('integration-flow-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project); mkdirSync(join(project, '.git'));
  return { root, project };
}

test('injected production integration flow saves selected project context and preserves other project files', async t => {
  const { root, project } = fixture(t); const asked: string[] = [];
  const answer = (question: string) => {
    asked.push(question);
    if (question.startsWith('GitHub backend')) return 'none';
    if (question.startsWith('jira: alias')) return 'none';
    if (question.startsWith('Design source')) return 'none';
    if (question.startsWith('Type integrations')) return 'integrations';
    throw new Error(`Unexpected question: ${question}`);
  };
  const output: string[] = [];
  await runIntegrationFlow({ scope: 'project', project }, { ask: async question => answer(question), output: text => output.push(text), error: text => output.push(text), home: root, recoveryDirectory: join(root, 'recovery') });
  const agents = readFileSync(join(project, 'AGENTS.md'), 'utf8');
  assert.match(agents, /advanced-harness:integrations:start/);
  assert.ok(asked.some(question => question.startsWith('Type integrations')));
  assert.ok(output.some(text => text.includes('project integration settings saved')));
  assert.equal(existsSync(join(project, '.opencode', 'harness.integrations.json')), false);
});

test('injected production integration cancellation leaves project context and recovery untouched', async t => {
  const { root, project } = fixture(t); const original = '# Existing project guidance\n';
  const path = join(project, 'AGENTS.md'); const { writeFileSync } = await import('node:fs'); writeFileSync(path, original);
  const answer = (question: string) => {
    if (question.startsWith('GitHub backend')) return 'none';
    if (question.startsWith('jira: alias')) return 'none';
    if (question.startsWith('Design source')) return 'none';
    if (question.startsWith('Type integrations')) return 'cancel';
    throw new Error(`Unexpected question: ${question}`);
  };
  await runIntegrationFlow({ scope: 'project', project }, { ask: async question => answer(question), output: () => {}, error: () => {}, home: root, recoveryDirectory: join(root, 'recovery') });
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(existsSync(join(root, 'recovery')), false);
});

test('integration cancellation preserves alternate context and unrelated files under paths with spaces', async t => {
  const root = makeTempRoot('integration flow spaces ');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project with spaces');
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(project, 'docs'), { recursive: true });
  const agents = join(project, 'AGENTS.md');
  const unrelated = join(project, 'unrelated config.json');
  const context = join(project, 'docs', 'Alternate context.md');
  const originalAgents = '# Existing project guidance\n';
  const originalUnrelated = '{"untouched":true}\n';
  const originalContext = '# Alternate context\n';
  writeFileSync(agents, originalAgents);
  writeFileSync(unrelated, originalUnrelated);
  writeFileSync(context, originalContext);
  const recovery = join(root, 'recovery with spaces');
  const ask = async (question: string) => {
    if (question.startsWith('GitHub backend')) return 'none';
    if (question.startsWith('jira: alias')) return 'none';
    if (question.startsWith('Design source')) return 'none';
    if (question.startsWith('Type integrations')) return 'cancel';
    throw new Error(`Unexpected prompt: ${question}`);
  };
  await runIntegrationFlow({ scope: 'project', project, context: 'docs/Alternate context.md' }, {
    ask, output: () => {}, error: () => {}, home: root, recoveryDirectory: recovery, environment: {},
  });
  assert.equal(readFileSync(agents, 'utf8'), originalAgents);
  assert.equal(readFileSync(unrelated, 'utf8'), originalUnrelated);
  assert.equal(readFileSync(context, 'utf8'), originalContext);
  assert.equal(existsSync(recovery), false);
});

test('injected global none selection saves preferences only and leaves runtime config untouched', async t => {
  const { root } = fixture(t); const xdg = join(root, 'xdg'); const configDirectory = join(xdg, 'opencode'); mkdirSync(configDirectory, { recursive: true });
  const config = join(configDirectory, 'opencode.json'); const original = '{\n  "model": "custom/root"\n}\n';
  const { writeFileSync } = await import('node:fs'); writeFileSync(config, original);
  const answer = (question: string) => {
    if (question.startsWith('GitHub backend')) return 'none';
    if (question.startsWith('jira: alias')) return 'none';
    if (question.startsWith('Design source')) return 'none';
    if (question.startsWith('Type integrations')) return 'integrations';
    throw new Error(`Unexpected question: ${question}`);
  };
  await runIntegrationFlow({ scope: 'global' }, { ask: async question => answer(question), output: () => {}, error: () => {}, home: root, xdgConfigHome: xdg, recoveryDirectory: join(root, 'recovery') });
  assert.equal(readFileSync(config, 'utf8'), original);
  assert.ok(existsSync(join(configDirectory, 'harness.integrations.json')));
});

test('integration checks return failed/inconclusive status and injected paths use test home/cwd', async t => {
  const { root, project } = fixture(t); const xdg = join(root, 'xdg'); mkdirSync(join(xdg, 'opencode'), { recursive: true });
  const prefs = join(xdg, 'opencode', 'harness.integrations.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(prefs, JSON.stringify({ version: 1, github: { backend: 'gh', hostname: 'github.com' }, jira: null, design: null }));
  const ask = async (question: string) => { if (question.startsWith('Application Git')) return '~/project'; if (question.startsWith('Type inspect')) return 'inspect'; throw new Error(question); };
  assert.equal(await runIntegrationFlow({ scope: 'global', check: true, project: '~/project' }, {
    ask, output: () => {}, error: () => {}, home: root, cwd: join(root, 'fake-cwd'), xdgConfigHome: xdg,
    check: async options => { assert.equal(options.directory, project); return [{ service: 'gh', name: 'auth', status: 'failed', message: 'stub' }]; },
  }), 1);
  assert.equal(await runIntegrationFlow({ scope: 'global', check: true, project: '$HOME/project' }, {
    ask: async question => { if (question.startsWith('Application Git')) return '$HOME/project'; if (question.startsWith('Type inspect')) return 'inspect'; throw new Error(question); },
    output: () => {}, error: () => {}, home: root, cwd: join(root, 'fake-cwd'), xdgConfigHome: xdg,
    check: async options => { assert.equal(options.directory, project); throw new Error('diagnostic unavailable'); },
  }), 2);
  await runIntegrationFlow({ scope: 'project', project: 'project' }, {
    ask: async question => { if (question.startsWith('GitHub backend')) return 'none'; if (question.startsWith('jira: alias')) return 'none'; if (question.startsWith('Design source')) return 'none'; if (question.startsWith('Type integrations')) return 'cancel'; throw new Error(question); },
    output: () => {}, error: () => {}, home: root, cwd: root,
  });
  assert.ok(existsSync(join(project, '.git')));
});

test('global integration production flow adds managed GH sources then repeats without config/receipt churn', async t => {
  const { root } = fixture(t); const xdg = join(root, 'xdg'); const configDir = join(xdg, 'opencode'); mkdirSync(configDir, { recursive: true });
  const config = join(configDir, 'opencode.json'); const recovery = join(root, 'recovery');
  const installerAnswers = async (question: string) => {
    if (question.includes(': model ID')) return 'local/model'; if (question.includes(': reasoning variant')) return '-';
    if (question.startsWith('Install workflow slash commands')) return 'no';
    if (/Replace existing|Make Lead|Also set|Replace customized/.test(question)) return 'no';
    if (question.startsWith('Type install')) return 'install'; throw new Error(`Unexpected installer prompt: ${question}`);
  };
  assert.equal(await runInstallerFlow({ scope: 'global', config }, { ask: installerAnswers, output: () => {}, error: () => {}, home: root, xdgConfigHome: xdg, recoveryDirectory: recovery, verify: async () => ({ ok: true } as never), printReport: () => {} }), 0);
  const choices = async (question: string) => {
    if (question.startsWith('GitHub backend')) return 'gh'; if (question.startsWith('GitHub hostname')) return 'github.com';
    if (question.startsWith('jira: alias')) return 'none'; if (question.startsWith('Design source')) return 'none';
    if (question.startsWith('Remove obsolete')) return 'no'; if (question.startsWith('Type integrations')) return 'integrations';
    throw new Error(`Unexpected integration prompt: ${question}`);
  };
  const preview: string[] = [];
  assert.equal(await runIntegrationFlow({ scope: 'global', config }, { ask: choices, output: text => preview.push(text), error: () => {}, home: root, xdgConfigHome: xdg, recoveryDirectory: recovery }), 0);
  const once = readFileSync(config, 'utf8'); const filesOnce = (await import('node:fs')).readdirSync(recovery).sort();
  const saved = JSON.parse(once); const external = saved.agents.external.permissions as { resource: string; effect: string }[];
  assert.ok(external.some(rule => rule.resource === 'gh pr view' && rule.effect === 'allow'));
  assert.ok(external.some(rule => rule.resource === 'gh pr view *' && rule.effect === 'allow'));
  assert.ok(external.some(rule => rule.resource === 'gh *' && rule.effect === 'ask'));
  assert.ok(!external.some(rule => rule.resource.startsWith('gh api') && rule.effect === 'allow'));
  assert.ok(external.some(rule => rule.resource === 'gh pr create' && rule.effect === 'allow'));
  assert.ok(external.some(rule => rule.resource === 'gh pr merge' && rule.effect === 'deny'));
  assert.ok(preview.some(line => line.includes('external permission preview:') && line.includes('gh pr view')));
  assert.equal(await runIntegrationFlow({ scope: 'global', config }, { ask: choices, output: () => {}, error: () => {}, home: root, xdgConfigHome: xdg, recoveryDirectory: recovery }), 0);
  assert.equal(readFileSync(config, 'utf8'), once);
  assert.deepEqual((await import('node:fs')).readdirSync(recovery).sort(), filesOnce);

  const cancel = async (question: string) => question.startsWith('GitHub backend') ? 'gh'
    : question.startsWith('GitHub hostname') ? 'github.com'
    : question.startsWith('jira: alias') || question.startsWith('Design source') ? 'none'
    : question.startsWith('Remove obsolete') ? 'no'
    : question.startsWith('Type integrations') ? 'cancel'
    : (() => { throw new Error(`Unexpected cancellation prompt: ${question}`); })();
  assert.equal(await runIntegrationFlow({ scope: 'global', config }, { ask: cancel, output: () => {}, error: () => {}, home: root, xdgConfigHome: xdg, recoveryDirectory: recovery }), 0);
  assert.equal(readFileSync(config, 'utf8'), once);
  assert.deepEqual((await import('node:fs')).readdirSync(recovery).sort(), filesOnce);
  assert.equal(nativeRoles.length, 8);
});

test('integration source retirement asks to keep obsolete GH rules or explicitly remove them', async t => {
  for (const remove of [false, true]) {
    const { root } = fixture(t); const xdg = join(root, 'xdg'); const configDir = join(xdg, 'opencode'); mkdirSync(configDir, { recursive: true });
    const config = join(configDir, 'opencode.json'); const recovery = join(root, 'recovery');
    await runInstallerFlow({ scope: 'global', config }, {
      ask: async question => { if (question.includes(': model ID')) return 'local/model'; if (question.includes(': reasoning variant')) return '-'; if (question.startsWith('Install workflow slash commands')) return 'no'; if (/Replace|Make Lead|Also set/.test(question)) return 'no'; if (question.startsWith('Type install')) return 'install'; throw new Error(question); },
      output: () => {}, error: () => {}, home: root, xdgConfigHome: xdg, recoveryDirectory: recovery, verify: async () => ({ ok: true } as never), printReport: () => {},
    });
    const gh = async (question: string) => { if (question.startsWith('GitHub backend')) return 'gh'; if (question.startsWith('GitHub hostname')) return 'github.com'; if (question.startsWith('jira: alias')) return 'none'; if (question.startsWith('Design source')) return 'none'; if (question.startsWith('Type integrations')) return 'integrations'; throw new Error(question); };
    await runIntegrationFlow({ scope: 'global', config }, { ask: gh, output: () => {}, error: () => {}, home: root, xdgConfigHome: xdg, recoveryDirectory: recovery });
    const switchToMcp = async (question: string) => {
      if (question.startsWith('GitHub backend')) return 'mcp';
      if (question.startsWith('github: alias')) return 'new';
      if (question.startsWith('github: new unique alias')) return 'altgh';
      if (question.startsWith('github: supplied remote MCP URL')) return 'https://example.test/mcp';
      if (question.startsWith('jira: alias')) return 'none';
      if (question.startsWith('Design source')) return 'none';
      if (question.startsWith('Remove obsolete owned')) return remove ? 'yes' : 'no';
      if (question.startsWith('Type integrations')) return 'integrations';
      throw new Error(`Unexpected source-switch prompt: ${question}`);
    };
    await runIntegrationFlow({ scope: 'global', config }, { ask: switchToMcp, output: () => {}, error: () => {}, home: root, xdgConfigHome: xdg, recoveryDirectory: recovery });
    const saved = JSON.parse(readFileSync(config, 'utf8'));
    const permissions = saved.agents.lead.permissions as { resource: string; effect: string }[];
    assert.equal(permissions.some(rule => rule.resource === 'gh *' && rule.effect === 'deny'), !remove);
    assert.ok(saved.mcp.servers.altgh.disabled);
  }
});

test('integration production flow retains pending evidence on finalization failure', async t => {
  const { root } = fixture(t); const xdg = join(root, 'xdg'); const configDir = join(xdg, 'opencode'); mkdirSync(configDir, { recursive: true });
  const config = join(configDir, 'opencode.json'); const recovery = join(root, 'recovery');
  await runInstallerFlow({ scope: 'global', config }, {
    ask: async question => { if (question.includes(': model ID')) return 'local/model'; if (question.includes(': reasoning variant')) return '-'; if (question.startsWith('Install workflow slash commands')) return 'no'; if (/Replace|Make Lead|Also set/.test(question)) return 'no'; if (question.startsWith('Type install')) return 'install'; throw new Error(question); },
    output: () => {}, error: () => {}, home: root, xdgConfigHome: xdg, recoveryDirectory: recovery, verify: async () => ({ ok: true } as never), printReport: () => {},
  });
  const ask = async (question: string) => { if (question.startsWith('GitHub backend')) return 'gh'; if (question.startsWith('GitHub hostname')) return 'github.com'; if (question.startsWith('jira: alias')) return 'none'; if (question.startsWith('Design source')) return 'none'; if (question.startsWith('Type integrations')) return 'integrations'; throw new Error(question); };
  await assert.rejects(runIntegrationFlow({ scope: 'global', config }, { ask, output: () => {}, error: () => {}, home: root, xdgConfigHome: xdg, recoveryDirectory: recovery, finalize: () => { throw new Error('finalize failed'); } }), /finalize failed/);
  const receipts = (await import('node:fs')).readdirSync(recovery).filter(name => name.endsWith('.json'));
  assert.equal(receipts.length, 2);
  assert.ok(receipts.some(name => JSON.parse(readFileSync(join(recovery, name), 'utf8')).status === 'pending'));
  assert.match(readFileSync(config, 'utf8'), /gh pr create/);
});

test('integration production flow aborts without config or preference writes when pending receipt write fails', async t => {
  const { root } = fixture(t); const xdg = join(root, 'xdg'); const configDir = join(xdg, 'opencode'); mkdirSync(configDir, { recursive: true });
  const config = join(configDir, 'opencode.json'); const recovery = join(root, 'recovery');
  await runInstallerFlow({ scope: 'global', config }, {
    ask: async question => { if (question.includes(': model ID')) return 'local/model'; if (question.includes(': reasoning variant')) return '-'; if (question.startsWith('Install workflow slash commands')) return 'no'; if (/Replace|Make Lead|Also set/.test(question)) return 'no'; if (question.startsWith('Type install')) return 'install'; throw new Error(question); },
    output: () => {}, error: () => {}, home: root, xdgConfigHome: xdg, recoveryDirectory: recovery, verify: async () => ({ ok: true } as never), printReport: () => {},
  });
  const beforeConfig = readFileSync(config, 'utf8');
  const beforeReceipts = (await import('node:fs')).readdirSync(recovery).sort();
  const scopeReplies = ['invalid', ''];
  const ask = async (question: string) => {
    if (question.startsWith('Configuration scope')) return scopeReplies.shift()!;
    if (question.startsWith('GitHub backend')) return 'gh';
    if (question.startsWith('GitHub hostname')) return 'github.com';
    if (question.startsWith('jira: alias')) return 'none';
    if (question.startsWith('Design source')) return 'none';
    if (question.startsWith('Type integrations')) return 'integrations';
    throw new Error(question);
  };
  await assert.rejects(
    runIntegrationFlow({ config }, { ask, output: () => {}, error: () => {}, home: root, xdgConfigHome: xdg, recoveryDirectory: recovery, writePending: () => { throw new Error('pending write failed'); } }),
    /pending write failed/,
  );
  assert.equal(scopeReplies.length, 0);
  assert.equal(readFileSync(config, 'utf8'), beforeConfig);
  assert.equal(existsSync(join(configDir, 'harness.integrations.json')), false);
  assert.deepEqual((await import('node:fs')).readdirSync(recovery).sort(), beforeReceipts);
});

async function designFixture(t: { after(fn: () => void): void }) {
  const { root, project } = fixture(t); const configDir = join(root, 'xdg', 'opencode'); mkdirSync(configDir, { recursive: true });
  const config = join(configDir, 'opencode.json');
  // Selecting an MCP alias globally reconciles role permissions, so the harness must be installed first.
  await runInstallerFlow({ scope: 'global', config }, {
    ask: async question => { if (question.includes(': model ID')) return 'local/model'; if (question.includes(': reasoning variant')) return '-'; if (question.startsWith('Install workflow slash commands')) return 'no'; if (/Replace|Make Lead|Also set/.test(question)) return 'no'; if (question.startsWith('Type install')) return 'install'; throw new Error(question); },
    output: () => {}, error: () => {}, home: root, xdgConfigHome: join(root, 'xdg'), recoveryDirectory: join(root, 'recovery'), verify: async () => ({ ok: true } as never), printReport: () => {},
  });
  const original = JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), mcp: { servers: { 'figma-company': { type: 'remote', url: 'https://figma.example/mcp', disabled: true }, 'stitch-company': { type: 'remote', url: 'https://stitch.example/mcp', disabled: true } } } }, null, 2) + '\n';
  writeFileSync(config, original);
  const preferences = join(configDir, 'harness.integrations.json'); const originalPreferences = JSON.stringify({ version: 1, github: null, jira: null, design: { kind: 'figma', server: 'figma-company' } }, null, 2) + '\n';
  writeFileSync(preferences, originalPreferences);
  const recovery = join(root, 'recovery');
  return { root, project, xdg: join(root, 'xdg'), config, original, preferences, originalPreferences, recovery, backups: readdirSync(recovery).sort() };
}

test('switching design source does not suggest the previous kind\'s server, in global and project scope, and cancellation writes nothing', async t => {
  for (const scope of ['global', 'project'] as const) {
    const { root, project, xdg, config, original, preferences, originalPreferences, recovery, backups } = await designFixture(t); const suggestions = new Map<string, string | undefined>();
    const ask = async (question: string, suggested?: string) => {
      if (question.startsWith('GitHub backend') || question.startsWith('jira: alias')) return 'none';
      if (question.startsWith('Design source')) { assert.equal(suggested, 'figma'); return 'stitch'; }
      if (question.startsWith('stitch: alias')) { suggestions.set(scope, suggested); return ''; }
      if (question.startsWith('Type integrations')) return 'cancel';
      throw new Error(`Unexpected prompt: ${question}`);
    };
    const output: string[] = [];
    assert.equal(await runIntegrationFlow({ scope, ...(scope === 'project' ? { project } : {}) }, { ask, output: text => output.push(text), error: text => output.push(text), home: root, xdgConfigHome: xdg, recoveryDirectory: recovery }), 0);
    assert.equal(suggestions.get(scope), 'none');
    assert.ok(output.some(text => text.includes('"design": null')), 'Enter on the stitch prompt must not carry the figma alias over');
    assert.ok(output.some(text => text.includes('Cancelled. No files or connections changed.')));
    assert.equal(readFileSync(config, 'utf8'), original); assert.equal(readFileSync(preferences, 'utf8'), originalPreferences);
    assert.equal(existsSync(join(project, 'AGENTS.md')), false); assert.deepEqual(readdirSync(recovery).sort(), backups);
  }
});

test('keeping the same design source still suggests its previous server', async t => {
  const { root, xdg, recovery } = await designFixture(t); let suggestion: string | undefined;
  const ask = async (question: string, suggested?: string) => {
    if (question.startsWith('GitHub backend') || question.startsWith('jira: alias')) return 'none';
    if (question.startsWith('Design source')) return '';
    if (question.startsWith('figma: alias')) { suggestion = suggested; return ''; }
    if (question.startsWith('Type integrations')) return 'cancel';
    throw new Error(`Unexpected prompt: ${question}`);
  };
  const output: string[] = [];
  await runIntegrationFlow({ scope: 'global' }, { ask, output: text => output.push(text), error: () => {}, home: root, xdgConfigHome: xdg, recoveryDirectory: recovery });
  assert.equal(suggestion, 'figma-company');
  assert.ok(output.some(text => text.includes('"server": "figma-company"')));
});

test('an invalid new MCP URL is reported and re-prompted for the URL, not the alias, and cancellation writes nothing', async t => {
  const { root, xdg, config, original, preferences, originalPreferences, recovery, backups } = await designFixture(t);
  const urls = ['not a url', 'http://design.example/mcp?token=x', 'https://stitch-new.example/mcp']; const asked: string[] = [];
  const ask = async (question: string) => {
    asked.push(question);
    if (question.startsWith('GitHub backend') || question.startsWith('jira: alias')) return 'none';
    if (question.startsWith('Design source')) return 'stitch';
    if (question.startsWith('stitch: alias')) return 'new';
    if (question.startsWith('stitch: new unique alias')) return 'stitch-new';
    if (question.startsWith('stitch: supplied remote MCP URL')) return urls.shift()!;
    if (question.startsWith('Type integrations')) return 'cancel';
    throw new Error(`Unexpected prompt: ${question}`);
  };
  const output: string[] = []; const errors: string[] = [];
  assert.equal(await runIntegrationFlow({ scope: 'global' }, { ask, output: text => output.push(text), error: text => errors.push(text), home: root, xdgConfigHome: xdg, recoveryDirectory: recovery }), 0);
  assert.deepEqual(errors, ['stitch: Supply an absolute MCP endpoint URL.', 'stitch: Use HTTPS (or loopback HTTP), without credentials, query parameters, or fragments.']);
  assert.equal(asked.filter(question => question.startsWith('stitch: alias')).length, 1);
  assert.equal(asked.filter(question => question.startsWith('stitch: new unique alias')).length, 1);
  assert.equal(asked.filter(question => question.startsWith('stitch: supplied remote MCP URL')).length, 3);
  assert.ok(output.some(text => text === 'stitch-new: new disabled endpoint https://stitch-new.example/mcp'));
  assert.ok(output.some(text => text.includes('Cancelled. No files or connections changed.')));
  assert.equal(readFileSync(config, 'utf8'), original); assert.equal(readFileSync(preferences, 'utf8'), originalPreferences);
  assert.deepEqual(readdirSync(recovery).sort(), backups);
});

test('a closed prompt while asking for a new MCP URL aborts the flow instead of re-prompting, and writes nothing', async t => {
  const { root, xdg, config, original, preferences, originalPreferences, recovery, backups } = await designFixture(t);
  let urlPrompts = 0; const errors: string[] = [];
  const ask = async (question: string) => {
    if (question.startsWith('GitHub backend') || question.startsWith('jira: alias')) return 'none';
    if (question.startsWith('Design source')) return 'stitch';
    if (question.startsWith('stitch: alias')) return 'new';
    if (question.startsWith('stitch: new unique alias')) return 'stitch-new';
    // A second URL prompt means the rejection was swallowed; answer so a regression fails instead of hanging.
    if (question.startsWith('stitch: supplied remote MCP URL')) { if (urlPrompts++) return 'https://stitch-new.example/mcp'; throw new Error('readline was closed'); }
    if (question.startsWith('Type integrations')) return 'cancel';
    throw new Error(`Unexpected prompt: ${question}`);
  };
  await assert.rejects(runIntegrationFlow({ scope: 'global' }, { ask, output: () => {}, error: text => errors.push(text), home: root, xdgConfigHome: xdg, recoveryDirectory: recovery }), /readline was closed/);
  assert.equal(urlPrompts, 1); assert.deepEqual(errors, []);
  assert.equal(readFileSync(config, 'utf8'), original); assert.equal(readFileSync(preferences, 'utf8'), originalPreferences);
  assert.deepEqual(readdirSync(recovery).sort(), backups);
});
