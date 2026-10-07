import { createHash } from 'node:crypto';
import { Plugin } from '@opencode/plugin';
import { Approval } from './rpc.ts';
import { filterToolCatalog, harnessToolNames as names, roleMayUseAction } from './policy.ts';
import { ApprovalChallenges } from './challenge.ts';

/** REJECTED OpenCode RPC approval spike. In-memory demo actions; never gate real work with this plugin. */
export default Plugin.define({
  id: 'advanced-harness.enforcement-spike',
  async setup(ctx) {
    let plan = '';
    let digest = createHash('sha256').update(plan).digest('hex');
    let approved: string | undefined;
    let applied = false;
    const challenges = new ApprovalChallenges();

    const registration = await ctx.rpc.register(Approval, {
      pending: async () => ({ pending: Boolean(plan) && !applied, plan, target: digest, approved: approved === digest }),
      challenge: async input => {
        const { target } = input as { target: string };
        if (!plan || target !== digest || applied) throw new Error('No matching pending plan');
        const nonce = challenges.issue(target);
        return { nonce };
      },
      approve: async input => {
        const { target, nonce } = input as { target: string; nonce: string };
        if (!challenges.consume(target, nonce) || target !== digest || applied) {
          throw new Error('Approval challenge is invalid, expired, or stale');
        }
        approved = digest;
        return { approved: true };
      },
    });

    await ctx.tool.transform(editor => {
      editor.add({
        name: names.status,
        description: 'Show the current demo plan and approval status.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({ content: JSON.stringify({ plan, target: digest, approved: approved === digest, applied }) }),
      });
      editor.add({
        name: names.propose,
        description: 'Propose a demo plan. A human must approve it in the OpenCode CLI before it can be applied.',
        input: {
          type: 'object', properties: { plan: { type: 'string' } },
          required: ['plan'], additionalProperties: false,
        },
        execute: async input => {
          const { plan: next } = input as { plan: string };
          if (!next.trim()) throw new Error('Plan must not be empty');
          plan = next;
          digest = createHash('sha256').update(plan).digest('hex');
          approved = undefined;
          applied = false;
          challenges.clear();
          return { content: JSON.stringify({ plan, target: digest, approval: 'Use the OpenCode CLI palette command “Review harness plan” for explicit human approval.' }) };
        },
      });
      editor.add({
        name: names.apply,
        description: 'Apply the in-memory demo action only after explicit approval of the current exact plan revision.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          if (!plan || approved !== digest || applied) throw new Error('Current plan revision has not been human-approved');
          applied = true;
          return { content: 'Approved demo action applied in memory; no project files changed.' };
        },
      });
    });

    await ctx.session.hook('context', event => {
      filterToolCatalog(event.agent, event.tools);
    });

    await ctx.permission.hook('evaluate', event => {
      if (!roleMayUseAction(event.agent, event.action)) {
        event.effect = 'deny';
        event.message = 'Harness action is not available to this agent role.';
      }
    });

    return () => registration.dispose();
  },
});
