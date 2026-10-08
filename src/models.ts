import type { NativeRole } from './native-installer.ts';

export type ModelAssignment = Readonly<{ model: string; reasoning: 'low' | 'medium' }>;
export const modelAssignments: Readonly<Record<NativeRole, ModelAssignment>> = Object.freeze({
  lead: Object.freeze({ model: 'openai/gpt-6-astra', reasoning: 'medium' }),
  operator: Object.freeze({ model: 'openai/gpt-5.3-codex-spark', reasoning: 'low' }),
  external: Object.freeze({ model: 'openai/gpt-5.3-codex-spark', reasoning: 'low' }),
  researcher: Object.freeze({ model: 'openai/gpt-6-luna', reasoning: 'medium' }),
  planner: Object.freeze({ model: 'openai/gpt-6.1-sol', reasoning: 'medium' }),
  implementer: Object.freeze({ model: 'openai/gpt-6-luna', reasoning: 'low' }),
  reviewer: Object.freeze({ model: 'openai/gpt-6.1-sol', reasoning: 'low' }),
  qa: Object.freeze({ model: 'openai/gpt-6-luna', reasoning: 'low' }),
});
