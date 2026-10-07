import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { createController } from './controller.ts';

type HumanApi = ReturnType<typeof createController>['human'];

/** Host-only interactive plan approval. There is intentionally no wire/API equivalent. */
export async function reviewPlanInConsole(
  human: HumanApi,
  input: Readable & { isTTY?: boolean } = process.stdin,
  output: Writable & { isTTY?: boolean } = process.stdout,
): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) throw new Error('Human approval requires an interactive host TTY');
  const view = human.status();
  if (view.plan.revision < 1) throw new Error('There is no plan to approve');
  output.write(`\nPlan revision ${view.plan.revision}\n${view.plan.text}\n\nCurrent target: ${view.target}\n`);
  const terminal = createInterface({ input, output });
  try {
    const answer = await terminal.question(`Type exactly "approve ${view.target}" to approve this plan, or anything else to cancel:\n`);
    if (answer !== `approve ${view.target}`) {
      output.write('Cancelled; approval state is unchanged.\n');
      return false;
    }
    human.decide({ kind: 'approve-plan', target: view.target });
    output.write(`Approved plan target ${view.target}.\n`);
    return true;
  } finally { terminal.close(); }
}
