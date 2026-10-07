import { Plugin } from '@opencode/plugin';
import { agentIpcDispatch, agentIpcEndpoint, defaultAgentIpcDirectory } from '../../src/host-ipc.ts';
import { filterHostTools, hostAgentRoles, hostToolNames, isHostAgentRole } from './host-adapter-policy.ts';

const actionInput = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    action: { type: 'string', enum: [
      'read-context', 'edit-code', 'review', 'build', 'lint', 'unit-test', 'screenshot-test', 'qa',
      'push', 'open-pr', 'sync-ticket', 'local-git-read', 'save-memory',
    ] },
    input: { type: 'object' },
    findings: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'action', 'input'],
  additionalProperties: false,
} as const;

function configuredDirectory(options: Readonly<Record<string, unknown>>): string {
  const directory = options.directory ?? defaultAgentIpcDirectory();
  if (typeof directory !== 'string' || directory.length === 0) throw new Error('OpenCode host adapter requires a valid IPC directory');
  return directory;
}

function endpointForAgent(directory: string, agent: string): string {
  if (!isHostAgentRole(agent)) throw new Error(`No host IPC role is configured for OpenCode agent: ${agent}`);
  return agentIpcEndpoint(directory, agent);
}

/** OpenCode agent surface for the out-of-process host. It deliberately exposes no human decision API. */
export default Plugin.define({
  id: 'advanced-harness.host-agent-adapter',
  async setup(ctx) {
    const directory = configuredDirectory(ctx.options);

    await ctx.tool.transform(editor => {
      editor.add({
        name: hostToolNames.status,
        description: 'Read the workflow status from the trusted Advanced Harness host.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_input, toolContext) {
          const endpoint = endpointForAgent(directory, toolContext.agent);
          const result = await agentIpcDispatch(endpoint, hostToolNames.status, null);
          return { content: JSON.stringify(result) };
        },
      });
      editor.add({
        name: hostToolNames.action,
        description: 'Request an action owned by your role. The trusted host validates permissions and approval gates before execution.',
        input: actionInput,
        async execute(input, toolContext) {
          const endpoint = endpointForAgent(directory, toolContext.agent);
          const result = await agentIpcDispatch(endpoint, 'harness.action', input);
          return { content: JSON.stringify(result) };
        },
      });
      editor.add({
        name: hostToolNames.proposePlan,
        description: 'Submit a concrete implementation plan to the trusted host. This does not approve the plan.',
        input: {
          type: 'object', properties: { plan: { type: 'string' } },
          required: ['plan'], additionalProperties: false,
        },
        async execute(input, toolContext) {
          const { plan } = input as { plan: string };
          const endpoint = endpointForAgent(directory, toolContext.agent);
          const result = await agentIpcDispatch(endpoint, 'harness.propose-plan', plan);
          return { content: JSON.stringify(result) };
        },
      });
      editor.add({
        name: hostToolNames.reportFinding,
        description: 'Report a uniquely identified review, QA, or external-feedback finding to the trusted host.',
        input: {
          type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } },
          required: ['id', 'text'], additionalProperties: false,
        },
        async execute(input, toolContext) {
          const finding = input as { id: string; text: string };
          const endpoint = endpointForAgent(directory, toolContext.agent);
          const result = await agentIpcDispatch(endpoint, 'harness.report-finding', finding);
          return { content: JSON.stringify(result) };
        },
      });
    });

    await ctx.session.hook('context', event => {
      filterHostTools(event.agent, event.tools);
    });

    await ctx.permission.hook('evaluate', event => {
      // A permission event for an unrecognized harness_* action must fail closed.
      if (event.action.startsWith('harness_') && !Object.values(hostToolNames).includes(event.action as typeof hostToolNames[keyof typeof hostToolNames])) {
        event.effect = 'deny';
        event.message = 'Unknown Advanced Harness action is denied.';
      }
      // Ensure all configured role IDs stay aligned with the core controller role map.
      if (event.action === hostToolNames.status && !hostAgentRoles.includes(event.agent as typeof hostAgentRoles[number])) {
        event.effect = 'deny';
        event.message = 'Unrecognized agent role is denied.';
      }
    });
  },
});
