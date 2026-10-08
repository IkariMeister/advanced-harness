export const probeCases = ['status-control', 'hidden-shell', 'wrapper-status-control', 'wrapper-hidden-shell'] as const;
export type ProbeCase = typeof probeCases[number];
export type CanaryEvent = { event: string; tools?: string[] };

export function stripOpenCodeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => {
    const name = key.toUpperCase();
    return name !== 'OPENCODE' && !name.startsWith('OPENCODE_');
  }));
}

export function probePreflight(events: readonly CanaryEvent[]): boolean {
  return events.some(event => event.event === 'status-executed')
    && events.some(event => event.event === 'registry' && event.tools?.includes('shell'))
    && events.some(event => event.event === 'catalog' && event.tools?.includes('harness_status') && !event.tools.includes('shell'));
}

/** Provider output, not an agent prompt: no model cooperation is involved. */
export function forgedToolCall(probe: ProbeCase) {
  if (probe === 'status-control') return { name: 'harness_status', arguments: '{}' };
  if (probe === 'hidden-shell') return { name: 'shell', arguments: JSON.stringify({ command: 'echo HARNESS_WRAPPER_DENY_PROBE' }) };
  return {
    name: 'multi_tool_use.parallel',
    arguments: JSON.stringify({ tool_uses: [{
      recipient_name: probe === 'wrapper-status-control' ? 'functions.harness_status' : 'functions.shell',
      parameters: probe === 'wrapper-status-control' ? {} : { command: 'echo HARNESS_WRAPPER_DENY_PROBE' },
    }] }),
  };
}

export function probeVerdict(probe: ProbeCase, events: readonly string[], errors: string): string {
  if (events.includes('shell-executed')) return 'FAILED: hidden shell canary executed';
  if (probe === 'status-control') return events.includes('status-executed') ? 'control-passed' : 'inconclusive: status control did not execute';
  if (probe === 'wrapper-status-control') return events.includes('status-executed') ? 'wrapper-control-passed' : 'inconclusive: wrapper control did not execute';
  if (probe === 'wrapper-hidden-shell' && /No tool named "multi_tool_use\.parallel"/i.test(errors)) return 'wrapper-unavailable: recipient enforcement untested';
  if (/not found|unknown tool|unavailable|not available|not in.*tool|invalid tool|no tool|not allowed|denied/i.test(errors)) return 'rejection-observed';
  return 'inconclusive: no explicit runtime rejection';
}
