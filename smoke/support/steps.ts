import type { Step } from './sandbox.ts';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Answers the prompt containing `fragment` once its full line (ending in ": ") has been printed. */
export const ask = (fragment: string, answer = ''): Step => ({ prompt: new RegExp(`${escape(fragment)}[^\\n]*: $`), answer });

export const roles = ['lead', 'operator', 'external', 'researcher', 'planner', 'implementer', 'reviewer', 'qa'] as const;

/** OpenCode installer: accept every suggested model/variant, keep defaults, then confirm or cancel. */
export const openCodeInstall = (confirmation: string, project?: string): Step[] => [
  ...(project === undefined ? [] : [ask('Project directory', project)]),
  ...roles.flatMap(role => [ask(`${role}: model ID`), ask(`${role}: reasoning variant`)]),
  ask('Make Lead the default agent'),
  ask('Also set the root default model'),
  ask('Install workflow slash commands'),
  ask('Type install to apply', confirmation),
];

export const antigravityInstall = (confirmation: string): Step[] => [
  ...roles.map(role => ask(`${role}: desired model preference`)),
  ask('Type yes to install the Antigravity', confirmation),
];
