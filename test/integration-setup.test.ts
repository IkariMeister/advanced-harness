import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { askIntegrations, checkConnections, checkGh, configuredServers, discoveryPrompt, normalizedServer, parseIntegrations, updateConnectionConfig, updateIntegrationConfig, validateEndpoint, validateIntegrations, type IntegrationDraft, type IntegrationProfile } from '../src/integration-setup.ts';
import { loadNativeDefinitions, nativeRoles, parseConfiguration, type ConfigSource } from '../src/native-installer.ts';

const definitions = loadNativeDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));
function source(value: Record<string, unknown>, path = 'global.jsonc'): ConfigSource { return { path, value, text: JSON.stringify(value) }; }
function fixture() {
  const github = { type: 'remote', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer {env:GITHUB_MCP_KEY}' }, oauth: false };
  const jira = { type: 'local', command: ['company-jira-server'], environment: { SECRET: '{env:JIRA_KEY}' }, disabled: true };
  const value = { agents: definitions, model: 'original/model', providers: { p: { settings: { apiKey: 'EXISTING_SECRET' } } }, plugins: ['keep-plugin'], mcp: { servers: { 'GitHub Team': github, atlassian: jira, unrelated: { type: 'remote', url: 'https://other.test/mcp' } } } };
  const profile = { version: 1, github: { server: 'GitHub Team', repository: 'company/app' }, jira: { server: 'atlassian', projectKey: 'APP', destinations: { ready: null, inProgress: 'In Progress', inReview: '10005', done: null } }, verification: 'unverified' } satisfies IntegrationProfile;
  const draft: IntegrationDraft = { profile, choices: [{ name: 'GitHub Team' }, { name: 'atlassian' }] };
  return { value, profile, draft, sources: [source(value)] };
}

test('configuration discovery uses whole-server replacement, preserves secret fields without printing them', () => {
  const { value, sources } = fixture();
  const servers = configuredServers(sources);
  assert.deepEqual(servers['GitHub Team'], value.mcp.servers['GitHub Team']);
  const later = source({ mcp: { servers: { atlassian: { type: 'remote', url: 'https://replacement.test/mcp' } } } });
  const merged = configuredServers([...sources, later]);
  assert.deepEqual(merged.atlassian, { type: 'remote', url: 'https://replacement.test/mcp' });
  assert.equal(Object.hasOwn(merged.atlassian!, 'environment'), false);
});

test('normalized MCP names and overlapping prefixes fail closed before changing permissions', () => {
  assert.equal(normalizedServer('GitHub Team'), 'GitHub_Team');
  assert.equal(normalizedServer('jira.company/mcp'), 'jira_company_mcp');
  for (const name of ['__proto__', 'bad\nname', '']) assert.throws(() => normalizedServer(name));
  for (const pair of [['jira.team', 'jira/team'], ['jira', 'jira_team']]) {
    assert.throws(() => configuredServers([source({ mcp: { servers: Object.fromEntries(pair.map(name => [name, { type: 'remote' }])) } })]), /collide|overlap/);
  }
  assert.throws(() => configuredServers([source({ mcp: { servers: [] } })]), /mcp.servers/);
});

test('endpoint validation rejects secrets, insecure nonlocal URLs, and non-HTTP transports', () => {
  assert.equal(validateEndpoint('https://company.test/mcp'), 'https://company.test/mcp');
  assert.equal(validateEndpoint('http://127.0.0.1:8080/mcp'), 'http://127.0.0.1:8080/mcp');
  for (const url of ['relative/path', 'http://company.test/mcp', 'https://user:secret@company.test/mcp', 'https://company.test/mcp?token=secret', 'https://company.test/#secret', 'file:///secret']) assert.throws(() => validateEndpoint(url));
});

test('integration profiles require explicit unverified mappings; unknown data is not silently discarded', () => {
  const { profile } = fixture();
  assert.equal(validateIntegrations(profile), profile);
  assert.deepEqual(parseIntegrations(JSON.stringify(profile)), profile);
  for (const patch of [{ verification: 'passed' }, { version: 2 }, { extra: 'preserve me' }, { github: { ...profile.github, repository: 'https://github.test/company/app' } }, { jira: { ...profile.jira, projectKey: 'bad key' } }, { jira: { ...profile.jira, destinations: { ready: null } } }]) assert.throws(() => validateIntegrations({ ...profile, ...patch }));
  assert.throws(() => parseIntegrations(JSON.stringify(profile).replace('"version":1', '"version":2,"version":1')), /Invalid existing/);
});

test('reusing configured servers preserves JSONC, model assignments, credentials, MCP, plugins, and all role fields', () => {
  const { value, sources, draft } = fixture();
  const original = '\uFEFF{\r\n// Keep existing config\r\n' + JSON.stringify(value).slice(1, -1) + ',\r\n}\r\n';
  const updated = updateIntegrationConfig(original, sources, draft);
  assert.ok(updated.startsWith('\uFEFF'));
  assert.ok(updated.includes('// Keep existing config'));
  assert.ok(!updated.replaceAll('\r\n', '').includes('\n'));
  const after = parseConfiguration(updated, 'test');
  for (const key of ['mcp', 'model', 'providers', 'plugins']) assert.deepEqual(after[key], value[key as keyof typeof value]);
  const agents = after.agents as Record<string, Record<string, unknown>>;
  for (const role of nativeRoles) {
    assert.equal(agents[role]!.model, definitions[role].model);
    assert.equal(agents[role]!.system, definitions[role].system);
    const permissions = agents[role]!.permissions as { action: string; effect: string; resource: string }[];
    assert.deepEqual(permissions.slice(0, definitions[role].permissions.length), definitions[role].permissions);
    for (const action of ['GitHub_Team_*', 'atlassian_*']) assert.equal(permissions.filter(rule => rule.action === action).at(-1)?.effect, role === 'external' ? 'ask' : 'deny');
  }
  assert.equal(updateIntegrationConfig(updated, [source(after)], draft), updated);
});

test('project overrides add only permission fields and disabled new servers, never copy global secrets or models', () => {
  const { sources, draft } = fixture();
  const next: IntegrationDraft = { profile: { ...draft.profile, github: { repository: draft.profile.github.repository, server: 'gh' } }, choices: [{ name: 'gh', create: { type: 'remote', url: 'https://real.test/mcp', disabled: true } }, { name: 'atlassian' }] };
  const updated = updateIntegrationConfig(JSON.stringify({ agents: definitions }), sources, next);
  const value = parseConfiguration(updated, 'test');
  assert.deepEqual((value.mcp as { servers: unknown }).servers, { gh: { type: 'remote', url: 'https://real.test/mcp', disabled: true } });
  assert.equal(value.model, undefined);
  assert.equal(value.providers, undefined);
  assert.ok(!updated.includes('EXISTING_SECRET'));
  assert.ok(!updated.includes('apiKey'));
  for (const [role, agent] of Object.entries(value.agents as Record<string, unknown>)) assert.ok(Object.keys(agent as object).includes('permissions'), role);
});

test('existing server replacement, missing roles, duplicate new servers and malformed permissions are refused', () => {
  const { value, sources, draft } = fixture();
  assert.throws(() => updateIntegrationConfig(JSON.stringify({ agents: definitions }), sources, { ...draft, choices: [{ name: 'GitHub Team', create: { type: 'remote', url: 'https://bad.test/mcp', disabled: true } }, { name: 'atlassian' }] }), /replace/);
  assert.throws(() => updateIntegrationConfig('{}', [source({ agents: definitions, mcp: value.mcp })], draft), /role "lead".*inline agent object/);
  assert.throws(() => updateIntegrationConfig(JSON.stringify({ agents: definitions }), [source({ ...value, agents: { ...definitions, external: { ...definitions.external, disabled: true } } })], draft), /all eight/);
  assert.throws(() => updateIntegrationConfig(JSON.stringify({ agents: { ...definitions, external: { ...definitions.external, permissions: ['invalid'] } } }), [source(value)], draft), /role "external".*explicit native permissions array/);
  assert.throws(() => updateIntegrationConfig('{}', sources, { ...draft, choices: [{ name: 'missing' }, { name: 'atlassian' }] }), /choices/);
  const duplicate: IntegrationDraft = { profile: { ...draft.profile, github: { repository: draft.profile.github.repository, server: 'both' }, jira: { ...draft.profile.jira, server: 'both' } }, choices: [{ name: 'both', create: { type: 'remote', url: 'https://one.test/mcp', disabled: true } }, { name: 'both', create: { type: 'remote', url: 'https://two.test/mcp', disabled: true } }] };
  assert.throws(() => updateIntegrationConfig('{}', sources, duplicate), /defined twice/);
});

test('permission additions require every destination role inline with an explicit valid permissions array', () => {
  const { value, sources, draft } = fixture();
  const base = JSON.parse(JSON.stringify(value)) as typeof value;
  for (const [role, mutate, expected] of [
    ['lead', (agents: Record<string, unknown>) => { delete agents.lead; }, /role "lead".*inline agent object/],
    ['operator', (agents: Record<string, unknown>) => { agents.operator = { ...definitions.operator, permissions: undefined }; }, /role "operator".*explicit native permissions array/],
    ['external', (agents: Record<string, unknown>) => { agents.external = { ...definitions.external, permissions: { inherited: true } }; }, /role "external".*explicit native permissions array/],
    ['reviewer', (agents: Record<string, unknown>) => { agents.reviewer = { ...definitions.reviewer, permissions: [null] }; }, /role "reviewer".*explicit native permissions array/],
  ] as const) {
    const agents = { ...base.agents } as Record<string, unknown>;
    mutate(agents);
    assert.throws(() => updateIntegrationConfig(JSON.stringify({ agents: agents }), [source({ ...base, agents })], draft), expected, role);
  }
  const empty = { ...base, agents: Object.fromEntries(nativeRoles.map(role => [role, { ...definitions[role], permissions: [] }])) };
  const output = updateIntegrationConfig(JSON.stringify({ agents: definitions }), [source(empty)], draft);
  const agents = parseConfiguration(output, 'test').agents as Record<string, { permissions: unknown[] }>;
  for (const role of nativeRoles) assert.ok(agents[role]!.permissions.length > 0);
});

test('MCP and gh permission additions reject non-string permission effects before producing an update', () => {
  const { value, sources, draft } = fixture();
  for (const effect of [['deny'], 1, null]) {
    const agents = { ...definitions, lead: { ...definitions.lead, permissions: [{ action: 'read', resource: '*', effect }] } };
    const original = JSON.stringify({ agents });
    assert.throws(() => updateIntegrationConfig(original, sources, draft), /role "lead".*explicit native permissions array/);
    const ghDraft: IntegrationDraft = { ...draft, profile: { ...draft.profile, github: { backend: 'gh', hostname: 'github.com', repository: 'company/app' } }, choices: [{ name: 'atlassian' }] };
    assert.throws(() => updateIntegrationConfig(original, sources, ghDraft), /role "lead".*explicit native permissions array/);
    assert.equal(original, JSON.stringify({ agents }));
  }
});

test('switching aliases preserves prior grants and unrelated role settings without silently revoking them', () => {
  const { sources, draft } = fixture();
  const first = parseConfiguration(updateIntegrationConfig(JSON.stringify({ agents: definitions }), sources, draft), 'test');
  const next: IntegrationDraft = { profile: { ...draft.profile, github: { repository: draft.profile.github.repository, server: 'gh-new' } }, choices: [{ name: 'gh-new', create: { type: 'remote', url: 'https://new.test/mcp', disabled: true } }, { name: 'atlassian' }] };
  const second = parseConfiguration(updateIntegrationConfig(JSON.stringify(first), [...sources, source(first, 'project.jsonc')], next), 'test');
  const permissions = (second.agents as Record<string, { permissions: { action: string; effect: string }[] }>).external!.permissions;
  assert.ok(permissions.some(rule => rule.action === 'GitHub_Team_*' && rule.effect === 'ask'));
  assert.ok(permissions.some(rule => rule.action === 'gh-new_*' && rule.effect === 'ask'));
});

test('interactive setup selects existing list aliases, records pending mapping without service requests', async () => {
  const { sources } = fixture();
  // Sort order: GitHub Team, atlassian, unrelated.
  const responses = ['mcp', '1', 'company/app', '2', 'APP', '-', 'In Progress', '10005', '-'];
  const draft = await askIntegrations(configuredServers(sources), undefined, async () => { assert.ok(responses.length); return responses.shift()!; });
  assert.equal(responses.length, 0);
  assert.deepEqual(draft.choices, [{ name: 'GitHub Team' }, { name: 'atlassian' }]);
  assert.equal(draft.profile.jira.destinations.done, null);
  assert.equal(draft.profile.verification, 'unverified');
});

test('new server prompts require supplied URLs and keep both servers disabled', async () => {
  const responses = ['mcp', 'new', 'gh', 'not a URL', 'https://supplied.test/gh', 'company/app', 'new', 'jira', 'https://supplied.test/jira', 'APP', '-', '-', '-', '-'];
  const draft = await askIntegrations({}, undefined, async () => { assert.ok(responses.length); return responses.shift()!; });
  assert.equal(responses.length, 0);
  assert.deepEqual(draft.choices.map(choice => choice.create?.disabled), [true, true]);
  assert.deepEqual(draft.choices.map(choice => choice.create?.url), ['https://supplied.test/gh', 'https://supplied.test/jira']);
});

test('connection status distinguishes connected/auth/disabled/failed/missing and redacts raw errors', async () => {
  const { profile } = fixture();
  const directory = process.cwd();
  for (const status of ['connected', 'needs_auth', 'disabled', 'pending', 'failed']) {
    const paths: string[] = [];
    const result = await checkConnections({ directory }, profile, async path => {
      paths.push(path);
      return { location: { directory }, data: [{ name: profile.github.server, status: { status, error: 'PRIVATE_TOKEN_AND_CONTENT' } }] };
    });
    assert.deepEqual(paths, ['/api/mcp']);
    assert.equal(result[0]!.status, status);
    assert.equal(result[1]!.status, 'missing');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
    if (status === 'needs_auth') assert.match(result[0]!.message, /\/mcps/);
    if (status === 'connected') assert.match(result[0]!.message, /still need/);
  }
});

test('malformed or wrong-location statuses are inconclusive and no mutations/inference endpoints are called', async () => {
  const { profile } = fixture();
  const directory = process.cwd();
  for (const response of [{}, { location: { directory: '/' }, data: [] }, { location: { directory }, data: [{ name: 'gh', status: { status: 'unknown' } }] }]) await assert.rejects(checkConnections({ directory }, profile, async () => response), /inconclusive/);
});

test('discovery prompt requires catalog-only discovery followed by separately approved access checks', () => {
  const { profile } = fixture();
  const prompt = discoveryPrompt(profile);
  assert.match(prompt, /catalog search only/);
  assert.match(prompt, /Do not invoke any service tools yet/);
  assert.match(prompt, /wait for human approval/);
  assert.match(prompt, /do not authorize lifecycle updates/);
  assert.match(prompt, /Native shell is separate from the Code Mode catalog/);
  assert.match(prompt, /actual authorized invocation\/error or captured offered-tool evidence/);
  assert.match(prompt, /availability as unverified/);
  assert.match(prompt, /keeping ASK prompts intact/);
});

test('integration CLI help and piped-input refusal cause no API calls or config changes', () => {
  const script = fileURLToPath(new URL('../scripts/configure-integrations.ts', import.meta.url));
  assert.match(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }), /New remote MCP entries stay disabled/);
  assert.throws(() => execFileSync(process.execPath, [script, '--project', process.cwd()], { input: 'integrations\n', stdio: 'pipe' }), /interactive terminal/);
  assert.throws(() => execFileSync(process.execPath, [script, '--check'], { input: 'inspect\n', stdio: 'pipe' }), /interactive terminal/);
});

test('gh selection asks no GitHub MCP endpoint and stores hostname/repository while Jira keeps MCP', async () => {
  const { sources } = fixture();
  const responses = ['gh', 'https://invalid.host/mcp', 'github.com', 'company/app', 'atlassian', 'APP', '-', '-', '-', '-'];
  const prompts: string[] = [];
  const draft = await askIntegrations(configuredServers(sources), undefined, async question => { prompts.push(question); assert.ok(responses.length); return responses.shift()!; });
  assert.equal(responses.length, 0);
  assert.deepEqual(draft.profile.github, { backend: 'gh', hostname: 'github.com', repository: 'company/app' });
  assert.deepEqual(draft.choices, [{ name: 'atlassian' }]);
  assert.ok(!prompts.some(question => question.startsWith('github:')));
});

test('gh backend appends External-only shell ownership, adds no GitHub MCP, and preserves existing servers', () => {
  const { profile, sources } = fixture();
  const draft: IntegrationDraft = { profile: { ...profile, github: { backend: 'gh', hostname: 'github.com', repository: 'company/app' } }, choices: [{ name: 'atlassian' }] };
  const updated = updateIntegrationConfig(JSON.stringify({ agents: definitions }), sources, draft);
  const value = parseConfiguration(updated, 'test');
  assert.equal(value.mcp, undefined);
  assert.ok(!updated.includes('GitHub_Team_*'));
  const agents = value.agents as Record<string, { permissions: { action: string; resource: string; effect: string }[] }>;
  for (const role of nativeRoles) for (const resource of ['gh *', 'gh.exe *']) assert.equal(agents[role]!.permissions.find(rule => rule.resource === resource)?.effect, role === 'external' ? 'ask' : 'deny');
  assert.equal(updateIntegrationConfig(updated, [...sources, source(value)], draft), updated);
  const legacy = parseIntegrations(JSON.stringify(profile));
  assert.equal(legacy.github.backend, undefined);
  for (const hostname of ['https://github.com', 'github.com --show-token', 'user:token@github.com', 'bad..host']) assert.throws(() => validateIntegrations({ ...draft.profile, github: { ...draft.profile.github, hostname } }));
  assert.throws(() => validateIntegrations({ ...draft.profile, github: { backend: 'gh', hostname: 'github.com', repository: 'company/app', server: 'github' } }));
});

test('External permissions allow only scoped publishing commands and keep merge/admin/fallback ask', () => {
  const { profile, sources } = fixture();
  const draft: IntegrationDraft = { profile: { ...profile, github: { backend: 'gh', hostname: 'github.com', repository: 'company/app' } }, choices: [{ name: 'atlassian' }] };
  const value = parseConfiguration(updateIntegrationConfig(JSON.stringify({ agents: definitions }), sources, draft), 'test');
  const permissions = (value.agents as Record<string, { permissions: { action: string; resource: string; effect: string }[] }>).external!.permissions;
  const effect = (command: string) => permissions.filter(rule => rule.action === 'shell' && (rule.resource === command || (rule.resource.endsWith('*') && command.startsWith(rule.resource.slice(0, -1))))).at(-1)?.effect;

  for (const executable of ['gh', 'gh.exe']) {
    for (const action of ['pr create', 'pr edit', 'pr comment', 'pr review', 'issue create', 'issue edit', 'issue comment', 'workflow run', 'run rerun', 'run cancel']) {
      for (const invocation of [`${executable} ${action}`, `${executable} ${action} --help`]) assert.equal(effect(invocation), 'allow', invocation);
    }
    for (const invocation of [`${executable} pr merge`, `${executable} pr merge 42`]) assert.equal(effect(invocation), 'deny', invocation);
    assert.equal(effect(`${executable} api repos/org/repo`), 'ask');
    for (const invocation of [`${executable} auth status`, `${executable} secret list`, `${executable} release create v1`]) assert.equal(effect(invocation), 'ask', invocation);
  }
  assert.equal(effect('git push'), 'allow');
  assert.equal(effect('git push --force origin feature'), 'allow');
  assert.equal(effect('git push origin --delete old-feature'), 'allow');
  assert.equal(effect('git status'), 'ask');
  assert.equal(effect('git fetch origin'), 'ask');
  assert.equal(permissions.filter(rule => rule.action === 'execute').at(-1)?.effect, 'allow');
});

test('integration setup adds approved External git-push exceptions to legacy permissions, idempotently', () => {
  const { profile, sources } = fixture();
  const draft: IntegrationDraft = { profile: { ...profile, github: { backend: 'gh', hostname: 'github.com', repository: 'company/app' } }, choices: [{ name: 'atlassian' }] };
  const legacyAgents = JSON.parse(JSON.stringify(definitions)) as Record<string, { permissions: { action: string; resource: string; effect: string }[] }>;
  legacyAgents.external!.permissions = legacyAgents.external!.permissions.filter(rule => !(rule.action === 'shell' && (rule.resource === 'git push' || rule.resource === 'git push *')));
  assert.ok(!legacyAgents.external!.permissions.some(rule => rule.action === 'shell' && rule.resource.startsWith('git push')));
  const original = JSON.stringify({ agents: legacyAgents });
  assert.equal(updateConnectionConfig(original, sources, [], false), original);
  const output = updateIntegrationConfig(original, sources, draft);
  const value = parseConfiguration(output, 'test');
  const agents = value.agents as Record<string, { permissions: { action: string; resource: string; effect: string }[] }>;
  const effective = (permissions: { action: string; resource: string; effect: string }[], command: string) => permissions.filter(rule => rule.action === 'shell' && (rule.resource === command || (rule.resource.endsWith('*') && command.startsWith(rule.resource.slice(0, -1))))).at(-1)?.effect;

  assert.equal(effective(agents.external!.permissions, 'git push'), 'allow');
  assert.equal(effective(agents.external!.permissions, 'git push --force origin feature'), 'allow');
  assert.equal(effective(agents.external!.permissions, 'git push origin --delete old-feature'), 'allow');
  assert.equal(effective(agents.external!.permissions, 'git fetch origin'), 'ask');
  for (const role of nativeRoles.filter(role => role !== 'external')) {
    const permissions = agents[role]!.permissions;
    assert.ok(!permissions.some(rule => rule.action === 'shell' && rule.resource.startsWith('git push') && rule.effect === 'allow'), role);
  }
  assert.equal(updateIntegrationConfig(output, [...sources, source(value)], draft), output);
});

test('gh checks only CLI version/auth status; raw output/tokens are suppressed, failures remain unverified', async () => {
  const calls: string[][] = [];
  const result = await checkGh('github.company.test', async (_exe, args) => { calls.push(args); return { stdout: 'PRIVATE_TOKEN' }; });
  assert.deepEqual(calls, [['--version'], ['auth', 'status', '--hostname', 'github.company.test']]);
  assert.equal(result.status, 'connected');
  assert.match(result.message, /Repository access.*unverified/);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
  const absent = await checkGh('github.com', async () => { throw new Error('ENOENT PRIVATE_TOKEN'); });
  assert.equal(absent.status, 'unavailable');
  let attempts = 0;
  const failedAuth = await checkGh('github.com', async () => { if (++attempts === 2) throw new Error('PRIVATE_TOKEN'); });
  assert.equal(failedAuth.status, 'unverified');
  assert.equal(attempts, 2);
  assert.ok(!JSON.stringify(failedAuth).includes('PRIVATE_TOKEN'));
});

test('gh runtime check queries Jira MCP only and retains backend-specific discovery instructions', async () => {
  const { profile } = fixture();
  const ghProfile: IntegrationProfile = { ...profile, github: { backend: 'gh', hostname: 'github.com', repository: 'company/app' } };
  const directory = process.cwd();
  const result = await checkConnections({ directory }, ghProfile, async path => {
    assert.equal(path, '/api/mcp');
    return { location: { directory }, data: [{ name: 'atlassian', status: { status: 'connected' } }] };
  }, async hostname => { assert.equal(hostname, 'github.com'); return { service: 'github', name: 'gh', status: 'connected', message: 'auth only' }; });
  assert.deepEqual(result.map(row => [row.name, row.status]), [['gh', 'connected'], ['atlassian', 'connected']]);
  assert.match(discoveryPrompt(ghProfile), /GitHub uses gh CLI/);
  assert.match(discoveryPrompt(ghProfile), /Do not run gh yet/);
  assert.ok(!discoveryPrompt(ghProfile).includes('MCP alias undefined'));
});
