import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createController } from '../src/controller.ts';
import { agentIpcDispatch, startAgentIpcHost } from '../src/host-ipc.ts';
import { reviewPlanInConsole } from '../src/host-console.ts';
import { snapshotDirectory } from '../src/snapshot.ts';

const tempRoot = process.platform === 'win32' ? join(homedir(), 'AppData', 'Local', 'Temp', 'opencode') : tmpdir();
mkdirSync(tempRoot, { recursive: true });
const root = mkdtempSync(join(tempRoot, 'harness-host-demo-'));
const worktree = join(root, 'fixture');
mkdirSync(worktree);
const file = join(worktree, 'greeting.txt');
writeFileSync(file, 'Before approval\n');

const controller = createController({
  database: join(root, 'local-state.sqlite'), project: root, feature: 'host-demo', worktree,
  snapshot: () => snapshotDirectory(worktree),
  handlers: {
    'edit-code': {
      input: z.strictObject({ content: z.string() }),
      async execute(input) {
        const { content } = z.strictObject({ content: z.string() }).parse(input);
        writeFileSync(file, content);
        return { status: 'passed', summary: 'Updated isolated host-demo fixture' };
      },
    },
  },
});

let host: Awaited<ReturnType<typeof startAgentIpcHost>> | undefined;
try {
  host = await startAgentIpcHost({ controller, directory: join(root, 'private-ipc') });
  const planner = host.endpoints.planner;
  const implementer = host.endpoints.implementer;
  await agentIpcDispatch(planner, 'harness.propose-plan', 'Replace the isolated demo greeting. No remote actions.');
  const action = { id: 'host-demo-edit', action: 'edit-code', input: { content: 'Approved through host console\n' } };
  try { await agentIpcDispatch(implementer, 'harness.action', action); }
  catch (error) { console.log(`Before host approval: ${(error as Error).message}`); }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('Non-interactive run: no human approval was performed; no fixture edit was authorized.');
    process.exitCode = 2;
  } else if (await reviewPlanInConsole(controller.human)) {
    console.log(await agentIpcDispatch(implementer, 'harness.action', action));
    console.log(readFileSync(file, 'utf8'));
  }
  console.log(`Isolated fixture, IPC sockets, and state DB: ${root}`);
} finally {
  await host?.close();
  controller.close();
}
