import type { Step } from './sandbox.ts';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Answers the prompt containing `fragment` once its full line (ending in ": ") has been printed. */
export const ask = (fragment: string, answer = ''): Step => ({ prompt: new RegExp(`${escape(fragment)}[^\\n]*: $`), answer });

export const roles = ['lead', 'operator', 'external', 'researcher', 'planner', 'implementer', 'reviewer', 'qa'] as const;

/** OpenCode installer: accept every suggested model/variant, keep defaults, then confirm or cancel. */
export const openCodeInstall = (confirmation: string, project?: string): Step[] => [
  ...(project === undefined ? [] : [ask('Project directory', project)]),
  ask('Query the live OpenCode model catalog', 'no'),
  ...roles.flatMap(role => [ask(`${role}: model ID`), ask(`${role}: reasoning variant`)]),
  ask('Make Lead the default agent'),
  ask('Also set the root default model'),
  ask('Install workflow slash commands'),
  ask('Type install to apply', confirmation),
];

/** Claude Code install/update: Enter keeps each role model, then confirm or cancel. */
export const claudeCodeInstall = (confirmation: string): Step[] => [
  ...roles.map(role => ask(`${role}: Claude Code model`)),
  ask('Type yes to install the Claude Code harness', confirmation),
];

export const antigravityInstall = (confirmation: string): Step[] => [
  ...roles.filter(role => role !== 'lead').map(role => ask(`${role}: Antigravity model tier`)),
  ...roles.map(role => ask(`${role}: desired model preference`)),
  ask('Type yes to install the Antigravity', confirmation),
];

/** harness:setup in project scope: configure only the build check, accept the remaining suggestions, then confirm or cancel. */
export const setupSteps = (build: string, confirmation: string, gates: [string, string][] = []): Step[] => [
  ask('Command shell', 'bash'),
  ask('Base branch'),
  ask('build: confirm command', build),
  ask('lint: confirm command'),
  ask('unit: confirm command'),
  ask('roborazzi: confirm command'),
  ask('runtime: confirm command'),
  ask('e2e: confirm command'),
  ...gates.flatMap(([name, command]) => [ask('Additional required project gate name', name), ask(`${name}: command`, command)]),
  ask('Additional required project gate name'),
  ask('Device preference', 'emulator'),
  ask('Optional device serial'),
  ask('Parent directory for future worktrees'),
  ask('Shared MEMORY.md path'),
  ask('Full preview: type save', confirmation),
];
