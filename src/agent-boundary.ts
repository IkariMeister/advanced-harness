import { requireThat } from './protocol.ts';
import type { createController } from './controller.ts';

type AgentPort = ReturnType<ReturnType<typeof createController>['bindAgent']>;

/**
 * Transport-neutral prototype of the adapter boundary, NOT an installed OpenCode plugin.
 * The trusted host binds one port to one authenticated session. Agent payloads cannot
 * select a role/session, access human controls, or reach a generic tool executor.
 */
export function agentBoundary(port: AgentPort) {
  return Object.freeze({
    async dispatch(tool: string, input: unknown): Promise<unknown> {
      switch (tool) {
        case 'harness.action': return port.execute(input);
        case 'harness.status':
          requireThat(input === null, 'Status takes no input');
          return port.status();
        case 'harness.propose-plan':
          requireThat(typeof input === 'string', 'Plan must be text');
          return port.proposePlan(input);
        case 'harness.report-finding': return port.reportFinding(input);
        default: throw new Error(`Tool unavailable in controlled session: ${tool}`);
      }
    },
  });
}
