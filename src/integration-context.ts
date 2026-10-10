import { parseConfiguration, type Ask } from './native-installer.ts';
import { checkGh, checkMcpConnections, nativeToolDiscoveryGuidance, normalizedServer, parseIntegrations, validateEndpoint, type ConnectionCheck, type GhCheck, type ServerChoice } from './integration-setup.ts';
import { cliQuery, type Query, type RuntimeOptions } from './native-diagnostics.ts';

type McpSelection = { server: string };
type GithubSelection = { backend: 'gh'; hostname: string } | { backend: 'mcp'; server: string };
type DesignSelection = { kind: 'figma' | 'stitch'; server: string };
export type GlobalIntegrations = { version: 1; github: GithubSelection | null; jira: McpSelection | null; design: DesignSelection | null };
export type ProjectIntegrations = {
  version: 2;
  github: (GithubSelection & { repository: string }) | null;
  jira: (McpSelection & { projectKey: string; destinations: { ready: string | null; inProgress: string | null; inReview: string | null; done: string | null } }) | null;
  design: DesignSelection | null;
  verification: 'unverified';
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const hostname = (value: unknown): value is string => typeof value === 'string' && /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value) && !value.includes('..');
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
const stages = ['ready', 'inProgress', 'inReview', 'done'] as const;

export function emptyGlobalIntegrations(): GlobalIntegrations { return { version: 1, github: null, jira: null, design: null }; }

export function validateGlobalIntegrations(value: unknown): GlobalIntegrations {
  if (!object(value) || value.version !== 1 || !keys(value, ['version', 'github', 'jira', 'design'])) throw new Error('Invalid global integration preferences.');
  validateSelections(value, false);
  return value as GlobalIntegrations;
}

function validateSelections(value: Record<string, unknown>, project: boolean): void {
  if (value.github !== null) {
    const github = value.github;
    if (!object(github)) throw new Error('Select GitHub gh/MCP or explicitly none.');
    if (github.backend === 'gh') {
      if (!hostname(github.hostname) || !keys(github, ['backend', 'hostname', ...(project ? ['repository'] : [])])) throw new Error('Invalid GitHub CLI selection.');
    } else if (github.backend === 'mcp') {
      if (typeof github.server !== 'string' || !keys(github, ['backend', 'server', ...(project ? ['repository'] : [])])) throw new Error('Invalid GitHub MCP selection.');
      normalizedServer(github.server);
    } else throw new Error('Unknown GitHub backend.');
    if (project && (typeof github.repository !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(github.repository))) throw new Error('Supply GitHub owner/repository or skip GitHub.');
  }
  if (value.jira !== null) {
    const jira = value.jira;
    if (!object(jira) || typeof jira.server !== 'string' || !keys(jira, ['server', ...(project ? ['projectKey', 'destinations'] : [])])) throw new Error('Select Jira MCP or explicitly none.');
    normalizedServer(jira.server);
    if (project) {
      if (typeof jira.projectKey !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(jira.projectKey) || !object(jira.destinations) || !keys(jira.destinations, [...stages])) throw new Error('Invalid project Jira context.');
      for (const stage of stages) if (jira.destinations[stage] !== null && !text(jira.destinations[stage])) throw new Error('Jira destinations must be explicit or unconfigured.');
    }
  }
  if (value.design !== null) {
    const design = value.design;
    if (!object(design) || !keys(design, ['kind', 'server']) || !['figma', 'stitch'].includes(String(design.kind)) || typeof design.server !== 'string') throw new Error('Select one design source or explicitly none.');
    normalizedServer(design.server);
  }
}

export function validateProjectIntegrations(value: unknown): ProjectIntegrations {
  if (!object(value) || value.version !== 2 || value.verification !== 'unverified' || !keys(value, ['version', 'github', 'jira', 'design', 'verification'])) throw new Error('Invalid project integration context.');
  validateSelections(value, true);
  return value as ProjectIntegrations;
}

export function parseGlobalIntegrations(text: string): GlobalIntegrations {
  try { parseConfiguration(text, 'global integration preferences'); return validateGlobalIntegrations(JSON.parse(text)); }
  catch { throw new Error('Invalid global integration preferences. Unknown fields are not discarded.'); }
}

/** Explicit migration input only: the old file is never written/deleted. */
export function legacyIntegrationContext(text: string): ProjectIntegrations {
  const old = parseIntegrations(text);
  return validateProjectIntegrations({ version: 2, github: old.github.backend === 'gh' ? old.github : { ...old.github, backend: 'mcp' }, jira: old.jira, design: null, verification: 'unverified' });
}

export function selectedMcp(settings: GlobalIntegrations | ProjectIntegrations): { service: string; name: string }[] {
  return [
    ...(settings.github?.backend === 'mcp' ? [{ service: 'github', name: settings.github.server }] : []),
    ...(settings.jira ? [{ service: 'jira', name: settings.jira.server }] : []),
    ...(settings.design ? [{ service: settings.design.kind, name: settings.design.server }] : []),
  ];
}

async function choice(ask: Ask, question: string, options: string[], defaultValue: string): Promise<string> {
  for (;;) { const answer = (await ask(question, defaultValue)).trim() || defaultValue; if (options.includes(answer)) return answer; }
}

async function askSelections(servers: Record<string, Record<string, unknown>>, previous: GlobalIntegrations, ask: Ask, allowNew: boolean): Promise<{ settings: GlobalIntegrations; choices: ServerChoice[] }> {
  const available = { ...servers };
  const selected = new Map<string, ServerChoice>();
  const selectServer = async (service: string, suggested: string | undefined): Promise<string | null> => {
    for (;;) {
      const names = Object.keys(available).sort();
      const answer = (await ask(`${service}: alias (or numbered list), ${allowNew ? 'new, ' : ''}or none`, suggested ?? 'none')).trim() || suggested || 'none';
      if (answer === 'none') return null;
      const name = /^\d+$/.test(answer) ? names[Number(answer) - 1] : answer;
      if (name && Object.hasOwn(available, name)) { if (!selected.has(name)) selected.set(name, { name }); return name; }
      if (name !== 'new' || !allowNew) continue;
      const alias = (await ask(`${service}: new unique alias`, service)).trim() || service;
      if (!/^[a-zA-Z0-9_-]+$/.test(alias) || Object.hasOwn(available, alias)) continue;
      try { normalizedServer(alias); } catch { continue; }
      let url: string;
      try { url = validateEndpoint((await ask(`${service}: supplied remote MCP URL (no secrets)`)).trim()); } catch { continue; }
      const create = { type: 'remote' as const, url, disabled: true as const };
      available[alias] = create;
      selected.set(alias, { name: alias, create });
      return alias;
    }
  };
  const backend = await choice(ask, 'GitHub backend: gh, mcp, or none', ['gh', 'mcp', 'none'], previous.github?.backend ?? 'none');
  let github: GlobalIntegrations['github'] = null;
  if (backend === 'gh') {
    let host = previous.github?.backend === 'gh' ? previous.github.hostname : 'github.com';
    for (;;) { const answer = (await ask('GitHub hostname for gh', host)).trim() || host; if (hostname(answer)) { host = answer; break; } }
    github = { backend: 'gh', hostname: host };
  } else if (backend === 'mcp') {
    const server = await selectServer('github', previous.github?.backend === 'mcp' ? previous.github.server : undefined);
    if (server) github = { backend: 'mcp', server };
  }
  const jiraServer = await selectServer('jira', previous.jira?.server);
  const designKind = await choice(ask, 'Design source: figma, stitch, or none (never silently combine)', ['figma', 'stitch', 'none'], previous.design?.kind ?? 'none');
  let design: GlobalIntegrations['design'] = null;
  if (designKind !== 'none') {
    const server = await selectServer(designKind, previous.design?.server);
    if (server) design = { kind: designKind as 'figma' | 'stitch', server };
  }
  return { settings: validateGlobalIntegrations({ version: 1, github, jira: jiraServer ? { server: jiraServer } : null, design }), choices: [...selected.values()] };
}

export async function askGlobalIntegrations(servers: Record<string, Record<string, unknown>>, previous: GlobalIntegrations, ask: Ask) {
  return askSelections(servers, previous, ask, true);
}

export async function askProjectIntegrations(servers: Record<string, Record<string, unknown>>, defaults: GlobalIntegrations, previous: ProjectIntegrations | undefined, ask: Ask): Promise<ProjectIntegrations> {
  const suggestions = previous ? validateGlobalIntegrations({ version: 1, github: previous.github ? (previous.github.backend === 'gh' ? { backend: 'gh', hostname: previous.github.hostname } : { backend: 'mcp', server: previous.github.server }) : null, jira: previous.jira ? { server: previous.jira.server } : null, design: previous.design }) : defaults;
  const { settings } = await askSelections(servers, suggestions, ask, false);
  let github: ProjectIntegrations['github'] = null;
  if (settings.github) {
    let repository: string;
    do { repository = (await ask('Project GitHub owner/repository (or none to skip)', previous?.github?.repository ?? 'none')).trim() || previous?.github?.repository || 'none'; } while (repository !== 'none' && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository));
    if (repository !== 'none') github = { ...settings.github, repository };
  }
  let jira: ProjectIntegrations['jira'] = null;
  if (settings.jira) {
    let projectKey: string;
    do { projectKey = (await ask('Project Jira key (or none to skip)', previous?.jira?.projectKey ?? 'none')).trim() || previous?.jira?.projectKey || 'none'; } while (projectKey !== 'none' && !/^[A-Z][A-Z0-9_]*$/.test(projectKey));
    if (projectKey !== 'none') {
      const destinations = {} as NonNullable<ProjectIntegrations['jira']>['destinations'];
      for (const stage of stages) {
        for (;;) { const answer = (await ask(`Jira ${stage}: exact status name/ID, or - for UNCONFIGURED`, previous?.jira?.destinations[stage] ?? '-')).trim() || previous?.jira?.destinations[stage] || '-'; if (answer === '-' || text(answer)) { destinations[stage] = answer === '-' ? null : answer; break; } }
      }
      jira = { ...settings.jira, projectKey, destinations };
    }
  }
  return validateProjectIntegrations({ version: 2, github, jira, design: settings.design, verification: 'unverified' });
}

export async function checkSelectedIntegrations(options: RuntimeOptions, settings: GlobalIntegrations | ProjectIntegrations, query: Query = cliQuery(options), ghCheck: GhCheck = checkGh): Promise<ConnectionCheck[]> {
  if (settings.version === 2) validateProjectIntegrations(settings); else validateGlobalIntegrations(settings);
  const checks = await checkMcpConnections(options, selectedMcp(settings), query);
  if (settings.github?.backend === 'gh') checks.unshift(await ghCheck(settings.github.hostname));
  return checks; // All-none returns [] without calling OpenCode or gh.
}

export function optionalDiscoveryPrompt(settings: GlobalIntegrations | ProjectIntegrations): string {
  const services = selectedMcp(settings).map(row => `${row.service}: ${row.name}`).join(', ') || 'none';
  return `Read this project's AGENTS.md and referenced context files. Optional MCP selections: ${services}. GitHub backend: ${settings.github?.backend ?? 'none'}. Only External owns service/GitHub CLI work. For selected MCP servers, discover exact tool names using catalog search only; do not invoke service tools or gh yet. ${nativeToolDiscoveryGuidance} Propose separately approved read-only access checks. Ask about an absent integration only when the task needs it; do not treat none as a setup blocker or silently enable/fallback. Repository/Jira mappings in project context remain unverified; saving preferences does not authorize lifecycle writes, publishing, or merging.`;
}
