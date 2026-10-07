import { setTimeout as delay } from 'node:timers/promises';
import { reviewPlanInConsole } from '../src/host-console.ts';
import { startFixtureHost } from '../src/fixture-host.ts';

const project = process.argv[2];
const headless = process.argv.includes('--headless');
if (!project) throw new Error('Usage: node examples/fixture-host-runner.ts <disposable-project> [--headless]');
if (!headless && (!process.stdin.isTTY || !process.stdout.isTTY)) {
  throw new Error('Fixture host approval mode requires an interactive terminal');
}

const host = await startFixtureHost(project);
let stopping = false;
const stop = () => { stopping = true; };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

console.log(`HARNESS_FIXTURE_HOST_READY ${JSON.stringify({ project: host.paths.project, ipc: host.paths.ipc, pid: process.pid, headless })}`);
console.log(headless
  ? 'Headless verification mode: no human decision path is active.'
  : 'Waiting for Planner. Approval is accepted only as the exact revision token typed in this terminal. Press Ctrl+C to stop.');

const reviewed = new Set<string>();
try {
  while (!stopping) {
    if (!headless) {
      const status = host.human.status();
      if (status.plan.revision > 0 && status.planApproval !== status.planTarget && !reviewed.has(status.planTarget)) {
        reviewed.add(status.planTarget);
        try { await reviewPlanInConsole(host.human); }
        catch (error) { console.error(`Plan decision failed: ${(error as Error).message}`); }
      }
    }
    await delay(200);
  }
} finally {
  await host.close();
  console.log('HARNESS_FIXTURE_HOST_STOPPED');
}
