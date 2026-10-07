import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { createController } from '../src/controller.ts';
import { snapshotDirectory } from '../src/snapshot.ts';
import { agentBoundary } from '../src/agent-boundary.ts';

// This terminal is the demo's trusted human surface. It is intentionally not an agent tool.
{
  const tempRoot = process.platform === 'win32' ? join(homedir(), 'AppData', 'Local', 'Temp', 'opencode') : tmpdir();
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(join(tempRoot, 'harness-demo-'));
  const worktree = join(root, 'fixture');
  mkdirSync(worktree);
  const file = join(worktree, 'greeting.txt');
  writeFileSync(file, 'Before approval\n');
  const controller = createController({
    database: join(root, 'local-state.sqlite'), project: root, feature: 'demo', worktree,
    snapshot: () => snapshotDirectory(worktree),
    handlers: {
      'edit-code': {
        input: z.strictObject({ content: z.string() }),
        async execute(input) {
          const { content } = z.strictObject({ content: z.string() }).parse(input);
          writeFileSync(file, content);
          return { status: 'passed', summary: 'Updated the isolated demo fixture' };
        },
      },
    },
  });
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const terminal = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    controller.bindAgent('planner').proposePlan('Replace the isolated demo greeting. No remote actions.');
    const agent = agentBoundary(controller.bindAgent('implementer'));
    const action = { id: 'demo-edit', action: 'edit-code', input: { content: 'Explicitly approved\n' } };
    try { await agent.dispatch('harness.action', action); }
    catch (error) { console.log(`Before approval: ${(error as Error).message}`); }
    const view = controller.human.status();
    console.log(`Plan v${view.plan.revision}: ${view.plan.text}\nRevision: ${view.target}`);
    const expected = `approve ${view.target}`;
    if (!terminal) {
      console.log(`Non-interactive run: approval not performed. To finish safely, run this demo in a terminal and type the exact token: ${expected}`);
    } else if (await terminal.question(`Type "${expected}" to approve, or anything else to cancel:\n`) === expected) {
      controller.human.decide({ kind: 'approve-plan', target: view.target });
      console.log(await agent.dispatch('harness.action', action));
      console.log(readFileSync(file, 'utf8'));
    } else console.log('Cancelled; no edit executed.');
    console.log(`Local fixture and audit database: ${root}`);
  } finally { terminal?.close(); controller.close(); }
}
