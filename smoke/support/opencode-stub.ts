// Deterministic stand-in for `opencode api [--server <url>] get <path>?location[directory]=<dir>`.
// It mirrors the installed configuration back as a healthy runtime catalog so smoke
// journeys can exercise harness:doctor end to end without a model connection, a
// running OpenCode service, or network access. Every call is appended to SMOKE_OPENCODE_LOG.
import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discoverConfigurations, modelReference } from '../../src/native-installer.ts';
import { expectedAgents } from '../../src/native-diagnostics.ts';

export function runOpenCodeStub(args: string[]): number {
  const log = process.env.SMOKE_OPENCODE_LOG;
  if (log) appendFileSync(log, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
  const rest = args[0] === 'api' ? args.slice(1) : undefined;
  if (rest?.[0] === '--server') rest.splice(0, 2);
  if (!rest || rest[0] !== 'get' || !rest[1]) {
    process.stderr.write(`opencode-stub: unsupported invocation: ${args.join(' ')}\n`);
    return 64;
  }
  const url = new URL(rest[1], 'http://stub.invalid');
  const directory = url.searchParams.get('location[directory]');
  if (!directory) { process.stderr.write('opencode-stub: missing location[directory]\n'); return 64; }
  const globalDirectory = resolve(join(process.env.XDG_CONFIG_HOME ?? '', 'opencode'));
  const agents = expectedAgents(discoverConfigurations(directory, globalDirectory));
  const references = Object.values(agents).map(entry => modelReference(entry.model)).filter((ref): ref is string => !!ref);
  const models = new Map<string, { providerID: string; id: string; variants: Set<string> }>();
  for (const reference of references) {
    const [base, variant] = reference.split('#') as [string, string | undefined];
    const slash = base.indexOf('/');
    const key = base;
    const row = models.get(key) ?? { providerID: base.slice(0, slash), id: base.slice(slash + 1), variants: new Set<string>() };
    if (variant) row.variants.add(variant);
    models.set(key, row);
  }
  const location = { directory };
  let data: unknown[];
  switch (url.pathname) {
    case '/api/agent':
      data = Object.entries(agents).map(([id, entry]) => ({ id, mode: entry.mode ?? 'subagent', hidden: false, model: entry.model }));
      break;
    case '/api/model':
      data = [...models.values()].map(row => ({ id: row.id, providerID: row.providerID, enabled: true, variants: [...row.variants].map(id => ({ id })) }));
      break;
    case '/api/provider':
      data = [...new Set([...models.values()].map(row => row.providerID))].map(id => ({ id, activation: 'enabled' }));
      break;
    case '/api/mcp':
      data = [];
      break;
    default:
      process.stderr.write(`opencode-stub: unknown path ${url.pathname}\n`);
      return 64;
  }
  process.stdout.write(JSON.stringify({ location, data }));
  return 0;
}
