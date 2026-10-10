import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { modelReference, nativeRoles, type ConfigSource } from './native-installer.ts';

type Row = Record<string, unknown>;
export type Snapshot = { agents: Row[]; models: Row[]; providers: Row[] };
export type Check = { role: string; issues: string[]; model?: string };
export type Report = { checks: Check[]; ok: boolean };
export type RuntimeOptions = { directory: string; executable?: string; server?: string };
export type Query = (path: string) => Promise<unknown>;
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
/** Only controlled, credential-free messages may be shown by the CLIs. */
export class DiagnosticError extends Error {}

export function runtimeModelReference(value: unknown): string | undefined {
  if (object(value) && typeof value.id === 'string') return modelReference({ ...value, model: value.id });
  return modelReference(value);
}

export function expectedAgents(sources: readonly ConfigSource[]): Record<string, Row> {
  const agents: Record<string, Row> = {};
  for (const source of sources) if (object(source.value.agents)) {
    for (const role of nativeRoles) {
      const entry = source.value.agents[role];
      if (object(entry)) agents[role] = { ...agents[role], ...entry };
    }
  }
  return agents;
}

/** Catalog checks only: never makes model requests or claims entitlement validation. */
export function assessRuntime(snapshot: Snapshot, expected: Record<string, Row>): Report {
  const checks = nativeRoles.map(role => {
    const issues: string[] = [];
    const entry = expected[role];
    const agent = snapshot.agents.find(row => row.id === role);
    if (!entry) issues.push('No inline definition in the inspected configuration scope. Check the install target/project.');
    if (entry?.disabled === true) issues.push('Configuration marks this role disabled; review it explicitly before reinstalling.');
    if (!agent) issues.push('Not discovered by this server/location. Check scope, overrides, and stale service configuration.');
    else {
      if (agent.hidden === true) issues.push('Hidden from agent selection/subagent discovery.');
      if (agent.mode !== (role === 'lead' ? 'primary' : 'subagent')) issues.push(`Unexpected mode: ${String(agent.mode)}.`);
    }
    const desired = modelReference(entry?.model);
    if (entry && !desired) issues.push('Inspected configuration has no valid explicit model assignment.');
    const actual = runtimeModelReference(agent?.model);
    if (agent && !actual) issues.push('No explicit runtime model assignment; inheritance is not a verified assignment.');
    if (agent && desired && actual !== desired) issues.push(`Runtime model differs from configuration (${desired}); check overrides or stale service state.`);
    if (actual) {
      const [base, variant] = actual.split('#');
      const slash = base!.indexOf('/');
      const providerID = base!.slice(0, slash);
      const id = base!.slice(slash + 1);
      const provider = snapshot.providers.find(row => row.id === providerID);
      if (!provider || provider.activation === 'disabled') issues.push(`Provider ${providerID} is not active. Connect/enable it in OpenCode.`);
      const model = snapshot.models.find(row => row.providerID === providerID && row.id === id);
      if (!model || model.enabled !== true) issues.push(`Model ${base} is absent or disabled in the runtime catalog. Check /models; no substitution was made.`);
      else if (variant && (!Array.isArray(model.variants) || !model.variants.some(row => object(row) && row.id === variant))) issues.push(`Variant ${variant} is absent from the model catalog. Choose a supported variant explicitly.`);
    }
    return { role, issues, ...(actual ? { model: actual } : {}) };
  });
  return { checks, ok: checks.every(check => check.issues.length === 0) };
}

function samePath(left: string, right: string): boolean {
  const normalize = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return normalize(left) === normalize(right);
}

export function decodeRows(response: unknown, directory: string, kind: keyof Snapshot): Row[] {
  if (!object(response) || !object(response.location) || typeof response.location.directory !== 'string' || !samePath(response.location.directory, directory) || !Array.isArray(response.data)) throw new DiagnosticError(`Unexpected ${kind} API response or location; verification is inconclusive. Check the connected server/project.`);
  const rows = response.data;
  if (!rows.every(row => object(row) && typeof row.id === 'string' && (kind !== 'agents' || (typeof row.mode === 'string' && typeof row.hidden === 'boolean')) && (kind !== 'models' || (typeof row.providerID === 'string' && typeof row.enabled === 'boolean' && Array.isArray(row.variants))) && (kind !== 'providers' || typeof row.activation === 'string'))) throw new DiagnosticError(`Unsupported ${kind} API shape; verification is inconclusive. Check OpenCode V2 compatibility.`);
  return rows;
}

export function findOpenCode(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  // Desktop installs do not always put their bundled CLI on PATH.
  const desktop = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', '@opencodedesktop', 'resources', 'opencode-cli.exe');
  return process.platform === 'win32' && existsSync(desktop) ? desktop : 'opencode';
}

export function cliQuery(options: RuntimeOptions): Query {
  const executable = findOpenCode(options.executable);
  return async path => {
    const args = ['api', ...(options.server ? ['--server', options.server] : []), 'get', `${path}?location[directory]=${encodeURIComponent(resolve(options.directory))}`];
    try {
      const { stdout } = await promisify(execFile)(executable, args, { cwd: options.directory, timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      return JSON.parse(stdout) as unknown;
    } catch {
      // Never echo CLI stderr/stdout: plugin/config errors can contain secrets.
      throw new DiagnosticError('OpenCode API check failed or timed out. Check CLI path (--opencode), service status, and server connection. Raw output suppressed to protect credentials.');
    }
  };
}

export async function verifyRuntime(options: RuntimeOptions, expected: Record<string, Row>, query: Query = cliQuery(options), pause: () => Promise<unknown> = () => setTimeout(1000)): Promise<Report> {
  let report: Report | undefined;
  // These APIs return snapshots that can precede initial plugin settlement.
  // Reuse the same service, rather than restarting a private service per query.
  for (let attempt = 0; attempt < 4; attempt++) {
    const agents = decodeRows(await query('/api/agent'), options.directory, 'agents');
    const [models, providers] = await Promise.all([
      query('/api/model').then(value => decodeRows(value, options.directory, 'models')),
      query('/api/provider').then(value => decodeRows(value, options.directory, 'providers')),
    ]);
    report = assessRuntime({ agents, models, providers }, expected);
    if (report.ok) return report;
    if (attempt < 3) await pause();
  }
  return report!;
}

export function printReport(report: Report): void {
  for (const check of report.checks) {
    console.log(`${check.issues.length ? 'FAIL' : 'PASS'} ${check.role}${check.model ? `: ${check.model}` : ''}`);
    for (const issue of check.issues) console.log(`  ${issue}`);
  }
  console.log(report.ok ? 'Verified: all eight agents are visible with their assigned modes and catalog models/variants.' : 'Not ready: resolve the failures above, then rerun harness:doctor.');
  console.log('Catalog presence is NOT proof of account entitlement or successful inference. No paid model requests were sent.');
  console.log('Select Lead (not "Harness") in a NEW session; only Lead is primary. Existing session agent/model selections are unchanged.');
  console.log('If the UI disagrees with this server, check its project/server connection. Restarting the shared service may interrupt work; do it deliberately, not automatically.');
}
