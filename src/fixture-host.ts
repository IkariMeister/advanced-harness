import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { createController } from './controller.ts';
import { startAgentIpcHost } from './host-ipc.ts';
import { snapshotDirectory } from './snapshot.ts';

export const fixtureApprovedContent = 'APPROVED_BY_HOST\n';
const markerSchema = z.strictObject({ schema: z.literal(1), kind: z.literal('advanced-harness-agent-test') });

export function fixtureHostPaths(projectDirectory: string) {
  const project = resolve(projectDirectory);
  const key = createHash('sha256').update(project.toLowerCase()).digest('hex').slice(0, 16);
  const state = join(homedir(), '.advanced-harness', 'smoke-tests', key);
  return Object.freeze({ project, fixture: join(project, 'fixture'), state, database: join(state, 'state.sqlite'), ipc: join(state, 'ipc') });
}

/** Starts the deliberately narrow disposable-fixture host. No approval API is returned. */
export async function startFixtureHost(projectDirectory: string) {
  const paths = fixtureHostPaths(projectDirectory);
  const marker = join(paths.project, '.harness-test-fixture.json');
  if (!existsSync(marker)) throw new Error(`Refusing unmarked project: ${marker}`);
  markerSchema.parse(JSON.parse(readFileSync(marker, 'utf8')));
  if (!existsSync(paths.fixture)) throw new Error(`Fixture directory does not exist: ${paths.fixture}`);
  const greeting = join(paths.fixture, 'greeting.txt');
  if (!existsSync(greeting)) throw new Error(`Fixture greeting does not exist: ${greeting}`);
  mkdirSync(paths.state, { recursive: true });

  const controller = createController({
    database: paths.database,
    project: paths.project,
    feature: 'opencode-host-smoke-test',
    worktree: paths.fixture,
    snapshot: () => snapshotDirectory(paths.fixture),
    handlers: {
      'edit-code': {
        input: z.strictObject({ file: z.literal('greeting.txt'), content: z.literal(fixtureApprovedContent) }),
        async execute() {
          writeFileSync(greeting, fixtureApprovedContent);
          return { status: 'passed', summary: 'Updated only the marked disposable greeting fixture' };
        },
      },
    },
  });
  try {
    const ipc = await startAgentIpcHost({ controller, directory: paths.ipc });
    let closed = false;
    return Object.freeze({
      paths,
      human: controller.human,
      endpoints: ipc.endpoints,
      async close() {
        if (closed) return;
        closed = true;
        await ipc.close();
        controller.close();
      },
    });
  } catch (error) {
    controller.close();
    throw error;
  }
}
