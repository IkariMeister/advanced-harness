import { Plugin } from '@opencode/plugin';
import { agentToolIpcDispatch, agentIpcEndpoint, defaultAgentIpcDirectory } from './host-ipc-client.ts';
import { filterHostTools, hostAgentRoles, hostToolNames, hostToolOptions, isHostAgentRole } from './host-adapter-policy.ts';

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
    const diagnostic = ctx.options.diagnostic === true;

    await ctx.tool.transform(editor => {
      editor.add({
        name: hostToolNames.status,
        description: 'Read the workflow status from the trusted Advanced Harness host.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        options: hostToolOptions(hostToolNames.status),
        async execute(_input, toolContext) {
          const endpoint = endpointForAgent(directory, toolContext.agent);
          const result = await agentToolIpcDispatch(endpoint, hostToolNames.status, null);
          return { content: JSON.stringify(result) };
        },
      });
      editor.add({
        name: hostToolNames.action,
        description: 'Request an action owned by your role. The trusted host validates permissions and approval gates before execution.',
        input: actionInput,
        options: hostToolOptions(hostToolNames.action),
        async execute(input, toolContext) {
          const endpoint = endpointForAgent(directory, toolContext.agent);
          const result = await agentToolIpcDispatch(endpoint, hostToolNames.action, input);
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
        options: hostToolOptions(hostToolNames.proposePlan),
        async execute(input, toolContext) {
          const { plan } = input as { plan: string };
          const endpoint = endpointForAgent(directory, toolContext.agent);
          const result = await agentToolIpcDispatch(endpoint, hostToolNames.proposePlan, plan);
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
        options: hostToolOptions(hostToolNames.reportFinding),
        async execute(input, toolContext) {
          const finding = input as { id: string; text: string };
          const endpoint = endpointForAgent(directory, toolContext.agent);
          const result = await agentToolIpcDispatch(endpoint, hostToolNames.reportFinding, finding);
          return { content: JSON.stringify(result) };
        },
      });
    });

    if (diagnostic) {
      const registered = await ctx.tool.list();
      console.error(`[advanced-harness] registered tools: ${registered.map(tool => tool.id).join(', ')}`);
    }

    await ctx.session.hook('context', event => {
      if (diagnostic) console.error(`[advanced-harness] ${event.agent} tools before filter: ${Object.keys(event.tools).join(', ')}`);
      filterHostTools(event.agent, event.tools);
      if (diagnostic) console.error(`[advanced-harness] ${event.agent} tools after filter: ${Object.keys(event.tools).join(', ')}`);
    });

    await ctx.session.hook('http.request', async event => {
      if (!diagnostic || event.kind !== 'primary') return;
      try {
        const body = await event.request.clone().json() as { tools?: Array<Record<string, unknown>> };
        const tools = Array.isArray(body.tools) ? body.tools.map(tool => ({
          type: tool.type,
          name: tool.name ?? (tool.function as { name?: unknown } | undefined)?.name,
          parameters: tool.name === 'multi_tool_use.parallel' ? tool.parameters : undefined,
        })) : [];
        console.error(`[advanced-harness] provider tools: ${JSON.stringify(tools)}`);
      } catch (error) {
        console.error(`[advanced-harness] provider tool inspection failed: ${(error as Error).message}`);
      }
    });

    await ctx.session.hook('experimental.ws.send', event => {
      if (!diagnostic || event.kind !== 'primary') return;
      try {
        const root = JSON.parse(event.frame) as unknown;
        const found: unknown[] = [];
        const visit = (value: unknown): void => {
          if (!value || typeof value !== 'object') return;
          if (Array.isArray(value)) { for (const item of value) visit(item); return; }
          for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            if (key === 'tools' && Array.isArray(child)) found.push(...child);
            else visit(child);
          }
        };
        visit(root);
        const tools = found.map(item => {
          const tool = item as Record<string, unknown>;
          return { type: tool.type, name: tool.name ?? (tool.function as { name?: unknown } | undefined)?.name };
        });
        if (tools.length > 0) console.error(`[advanced-harness] websocket provider tools: ${JSON.stringify(tools)}`);
      } catch { /* not every provider frame is JSON */ }
    });

    await ctx.permission.hook('evaluate', event => {
      if (diagnostic) console.error(`[advanced-harness] permission: agent=${event.agent} action=${event.action} resources=${event.resources.join(',')} effect=${event.effect}`);
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
