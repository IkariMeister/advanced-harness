import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { agentBoundary } from './agent-boundary.ts';
import { roles, type Role } from './protocol.ts';
import type { createController } from './controller.ts';

const maxFrameBytes = 1024 * 1024;
const requestSchema = z.strictObject({ id: z.string().uuid(), tool: z.string().min(1), input: z.json() });
const responseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ id: z.string().uuid(), ok: z.literal(true), result: z.json() }),
  z.strictObject({ id: z.string().uuid(), ok: z.literal(false), error: z.string() }),
]);
type AgentPort = ReturnType<ReturnType<typeof createController>['bindAgent']>;

export type AgentIpcHost = Readonly<{
  endpoints: Readonly<Record<Role, string>>;
  close(): Promise<void>;
}>;

export function agentIpcEndpoint(directory: string, role: Role): string {
  if (process.platform === 'win32') {
    const key = createHash('sha256').update(resolve(directory)).digest('hex').slice(0, 24);
    return `\\\\.\\pipe\\advanced-harness-${key}-${role}`;
  }
  return join(directory, `agent-${role}.sock`);
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolveListen(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

function send(socket: Socket, response: z.infer<typeof responseSchema>): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

function serveConnection(socket: Socket, boundary: ReturnType<typeof agentBoundary>): void {
  socket.setEncoding('utf8');
  socket.on('error', () => { /* connection failures are isolated to this client */ });
  socket.setTimeout(30_000, () => socket.destroy(new Error('Agent IPC request timed out')));
  let buffer = '';
  let handled = false;
  socket.on('data', async chunk => {
    if (handled) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > maxFrameBytes) {
      handled = true;
      send(socket, { id: randomUUID(), ok: false, error: 'Request exceeds the IPC frame limit' });
      return;
    }
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    handled = true;
    try {
      const request = requestSchema.parse(JSON.parse(buffer.slice(0, newline)));
      const result = await boundary.dispatch(request.tool, request.input);
      send(socket, { id: request.id, ok: true, result: z.json().parse(result ?? null) });
    } catch (error) {
      let id: string = randomUUID();
      try { id = requestSchema.parse(JSON.parse(buffer.slice(0, newline))).id; } catch { /* malformed request */ }
      send(socket, { id, ok: false, error: error instanceof Error ? error.message : 'Unknown host error' });
    }
  });
}

/**
 * Starts role-specific local IPC endpoints. Caller identity is bound by the endpoint,
 * not supplied in the message. No endpoint exposes the controller's human API.
 * This is an experimental transport; production ACLs/sandboxing remain unproven.
 */
export async function startAgentIpcHost(options: {
  controller: ReturnType<typeof createController>;
  directory: string;
}): Promise<AgentIpcHost> {
  const directory = resolve(options.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
  const lockPath = join(directory, '.agent-ipc.lock');
  const lockFd = openSync(lockPath, 'wx', 0o600);
  writeSync(lockFd, JSON.stringify({ pid: process.pid, token: randomUUID() }));

  const servers: Server[] = [];
  const ownedEndpoints: string[] = [];
  const endpoints = {} as Record<Role, string>;
  try {
    for (const role of roles) {
      const endpoint = agentIpcEndpoint(directory, role);
      const boundary = agentBoundary(options.controller.bindAgent(role));
      const server = createServer(socket => serveConnection(socket, boundary));
      await listen(server, endpoint);
      if (process.platform !== 'win32') chmodSync(endpoint, 0o600);
      endpoints[role] = endpoint;
      ownedEndpoints.push(endpoint);
      servers.push(server);
    }
  } catch (error) {
    await Promise.all(servers.map(server => new Promise<void>(resolveClose => server.close(() => resolveClose()))));
    if (process.platform !== 'win32') {
      for (const endpoint of ownedEndpoints) rmSync(endpoint, { force: true });
    }
    closeSync(lockFd);
    rmSync(lockPath, { force: true });
    throw error;
  }

  let closed = false;
  return Object.freeze({
    endpoints: Object.freeze(endpoints),
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(servers.map(server => new Promise<void>((resolveClose, reject) => {
        server.close(error => error ? reject(error) : resolveClose());
      })));
      if (process.platform !== 'win32') {
        for (const endpoint of ownedEndpoints) rmSync(endpoint, { force: true });
      }
      closeSync(lockFd);
      rmSync(lockPath, { force: true });
    },
  });
}

export async function agentIpcDispatch(endpoint: string, tool: string, input: unknown): Promise<unknown> {
  const request = requestSchema.parse({ id: randomUUID(), tool, input });
  const payload = `${JSON.stringify(request)}\n`;
  requireThatFrameLimit(payload);
  return new Promise((resolveResponse, reject) => {
    const socket = createConnection(endpoint);
    socket.setEncoding('utf8');
    socket.setTimeout(30_000, () => socket.destroy(new Error('Host IPC response timed out')));
    let buffer = '';
    socket.once('connect', () => socket.write(payload));
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > maxFrameBytes) {
        socket.destroy(new Error('Host IPC response exceeds the frame limit'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      try {
        const response = responseSchema.parse(JSON.parse(buffer.slice(0, newline)));
        if (response.id !== request.id) throw new Error('Host IPC response ID mismatch');
        if (!response.ok) throw new Error(response.error);
        resolveResponse(response.result);
      } catch (error) { reject(error); }
    });
    socket.once('error', reject);
    socket.once('close', () => {
      if (!buffer.includes('\n')) reject(new Error('Host closed IPC without a response'));
    });
  });
}

function requireThatFrameLimit(payload: string): void {
  if (Buffer.byteLength(payload, 'utf8') > maxFrameBytes) throw new Error('Request exceeds the IPC frame limit');
}

/** Default per-user IPC directory; production installation must verify ownership and ACLs. */
export function defaultAgentIpcDirectory(): string {
  return join(homedir(), '.advanced-harness', 'ipc');
}
