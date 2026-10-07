import { Rpc } from '@opencode/plugin/rpc';
import type { Rpc as RpcSchema } from '@opencode/schema/rpc';

const empty = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;
const pendingOutput = {
  type: 'object',
  properties: {
    pending: { type: 'boolean' },
    plan: { type: 'string' },
    target: { type: 'string' },
    approved: { type: 'boolean' },
  },
  required: ['pending', 'plan', 'target', 'approved'],
  additionalProperties: false,
} as const;

export const Approval = Rpc.define({
  id: 'advanced-harness-approval-spike',
  methods: {
    pending: { input: empty, output: pendingOutput },
    challenge: {
      input: {
        type: 'object', properties: { target: { type: 'string' } },
        required: ['target'], additionalProperties: false,
      },
      output: {
        type: 'object', properties: { nonce: { type: 'string' } },
        required: ['nonce'], additionalProperties: false,
      },
    },
    approve: {
      input: {
        type: 'object', properties: { target: { type: 'string' }, nonce: { type: 'string' } },
        required: ['target', 'nonce'], additionalProperties: false,
      },
      output: {
        type: 'object', properties: { approved: { type: 'boolean' } },
        required: ['approved'], additionalProperties: false,
      },
    },
  },
  events: {},
} satisfies RpcSchema.PortableDefinition);
