import { spawn } from 'node:child_process';

/** A listed Codex model and the reasoning efforts it advertises (empty when unknown). */
export type CodexCatalogModel = { id: string; efforts: string[] };
export type CodexModelDiscovery = () => Promise<CodexCatalogModel[]>;
export type CodexRpc = (method: string, params: unknown) => Promise<unknown>;

/** Only controlled, credential-free messages are shown; raw Codex output is never echoed. */
export class CodexDiscoveryError extends Error {}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function findCodex(explicit?: string): string {
  return explicit ?? process.env.CODEX_BIN ?? 'codex';
}

/**
 * Runs one `codex app-server` session over stdio JSON-RPC (the protocol omits the `jsonrpc` header).
 * The process is always terminated afterwards; stderr is discarded.
 */
export async function withCodexAppServer<T>(executable: string, use: (rpc: CodexRpc) => Promise<T>, timeoutMs = 15000, args: readonly string[] = ['app-server']): Promise<T> {
  // npm installs a codex.cmd shim on Windows, which only a shell can start.
  const windows = process.platform === 'win32';
  const child = spawn(windows ? `"${executable}"` : executable, windows ? args.map(arg => `"${arg}"`) : [...args], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: windows });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 1;
  let buffer = '';
  let failure: CodexDiscoveryError | undefined;
  const fail = (error: CodexDiscoveryError) => {
    failure ??= error;
    for (const entry of pending.values()) entry.reject(failure);
    pending.clear();
  };
  child.on('error', () => fail(new CodexDiscoveryError('Codex CLI could not be started. Check that codex is installed (or set CODEX_BIN).')));
  child.on('exit', () => fail(new CodexDiscoveryError('Codex app-server exited before answering.')));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { continue; }
      if (!object(message) || typeof message.id !== 'number' || !pending.has(message.id)) continue;
      const entry = pending.get(message.id)!;
      pending.delete(message.id);
      if (object(message.error)) entry.reject(new CodexDiscoveryError(`Codex app-server rejected the request${typeof message.error.code === 'number' ? ` (code ${message.error.code})` : ''}.`));
      else entry.resolve(message.result);
    }
  });
  const send = (message: Record<string, unknown>) => { child.stdin.write(`${JSON.stringify(message)}\n`); };
  const rpc: CodexRpc = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const timer = setTimeout(() => fail(new CodexDiscoveryError('Codex app-server did not answer in time.')), timeoutMs);
  try {
    await rpc('initialize', { clientInfo: { name: 'advanced-harness', version: '0' } });
    send({ method: 'initialized' });
    return await use(rpc);
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
}

/** Accepts effort entries as strings or objects naming the effort; unknown shapes are ignored. */
function effortsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (typeof entry === 'string') return [entry];
    if (!object(entry)) return [];
    const name = entry.reasoningEffort ?? entry.effort ?? entry.id;
    return typeof name === 'string' ? [name] : [];
  });
}

export function parseCodexModelPage(result: unknown): { models: CodexCatalogModel[]; nextCursor?: string } {
  if (!object(result) || !Array.isArray(result.data)) throw new CodexDiscoveryError('Unsupported model/list response shape; discovery is inconclusive. Check the Codex version.');
  const models: CodexCatalogModel[] = [];
  for (const row of result.data) {
    if (!object(row)) throw new CodexDiscoveryError('Unsupported model/list response shape; discovery is inconclusive. Check the Codex version.');
    if (row.hidden === true) continue;
    const id = typeof row.model === 'string' && row.model ? row.model : typeof row.id === 'string' && row.id ? row.id : undefined;
    if (!id) throw new CodexDiscoveryError('Unsupported model/list response shape; discovery is inconclusive. Check the Codex version.');
    models.push({ id, efforts: effortsOf(row.supportedReasoningEfforts) });
  }
  return { models, ...(typeof result.nextCursor === 'string' && result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
}

/** Lists visible Codex models through `model/list`. Never runs a turn, sends a model request, or claims entitlement. */
export async function listCodexModels(rpc: CodexRpc, maxPages = 20): Promise<CodexCatalogModel[]> {
  const models = new Map<string, CodexCatalogModel>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const { models: rows, nextCursor } = parseCodexModelPage(await rpc('model/list', cursor ? { cursor } : {}));
    for (const row of rows) models.set(row.id, row);
    if (!nextCursor) return [...models.values()];
    cursor = nextCursor;
  }
  throw new CodexDiscoveryError('Codex model/list returned too many pages; discovery is inconclusive.');
}

export function discoverCodexModels(executable?: string): CodexModelDiscovery {
  return () => withCodexAppServer(findCodex(executable), rpc => listCodexModels(rpc));
}

/**
 * Lists the live catalog when discovery is available and the user agrees to query it.
 * Unavailable or declined discovery is reported; typed IDs then stay unchecked, never substituted.
 */
export async function chooseCodexCatalog(discover: CodexModelDiscovery | undefined, ask: (question: string, suggested?: string) => Promise<string>, output: (message: string) => void): Promise<CodexCatalogModel[] | undefined> {
  if (!discover) {
    output('Live Codex model discovery is not available in this run; typed model IDs are not checked against a catalog.');
    return undefined;
  }
  const answer = (await ask('Query the live Codex model catalog? (read-only codex app-server model/list; sends no model requests)', 'yes')).trim() || 'yes';
  if (!/^(y|yes)$/i.test(answer)) {
    output('Live Codex model discovery skipped; typed model IDs are not checked against a catalog.');
    return undefined;
  }
  try {
    const models = await discover();
    output('Live Codex catalog models (listed by Codex; not proof of account entitlement or successful access):');
    models.forEach((model, index) => output(`  ${index + 1}. ${model.id}${model.efforts.length ? ` (efforts: ${model.efforts.join(', ')})` : ''}`));
    if (!models.length) output('  None listed. Any model you enter will need explicit confirmation.');
    output('A model or reasoning effort absent from this catalog is saved only if you type keep; nothing is substituted.');
    return models;
  } catch (error) {
    output(`Live Codex model discovery unavailable: ${error instanceof CodexDiscoveryError ? error.message : 'the Codex catalog could not be read.'}`);
    output('Continuing with typed model IDs; they are not checked against a catalog.');
    return undefined;
  }
}
