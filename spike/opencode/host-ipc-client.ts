import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import type { HostAgentRole } from './host-adapter-policy.ts';

const maxFrameBytes = 1024 * 1024;

export function agentIpcEndpoint(directory: string, role: HostAgentRole): string {
  if (process.platform === 'win32') {
    const key = createHash('sha256').update(resolve(directory)).digest('hex').slice(0, 24);
    return `\\\\.\\pipe\\advanced-harness-${key}-${role}`;
  }
  return join(directory, `agent-${role}.sock`);
}

export function defaultAgentIpcDirectory(): string {
  return join(homedir(), '.advanced-harness', 'ipc');
}

export async function agentIpcDispatch(endpoint: string, tool: string, input: unknown): Promise<unknown> {
  const request = { id: randomUUID(), tool, input };
  const payload = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > maxFrameBytes) throw new Error('Request exceeds the IPC frame limit');
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
        const response = JSON.parse(buffer.slice(0, newline)) as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
        if (response.id !== request.id) throw new Error('Host IPC response ID mismatch');
        if (response.ok === false && typeof response.error === 'string') throw new Error(response.error);
        if (response.ok !== true) throw new Error('Malformed host IPC response');
        resolveResponse(response.result);
      } catch (error) { reject(error); }
    });
    socket.once('error', reject);
    socket.once('close', () => {
      if (!buffer.includes('\n')) reject(new Error('Host closed IPC without a response'));
    });
  });
}
