// Types for the self-contained Codex role launcher (codex-role-launcher.mjs), which ships as plain JavaScript.
export const mcpMarker: RegExp;
export const securityKeys: readonly string[];
export function parseProfile(text: string): Map<string, string>;
export function buildRoleInvocation(options: {
  role: string;
  profileText: string;
  mcpServers: readonly string[];
  mcpAllowed: boolean;
  resumeId?: string | undefined;
  task: string;
  schemaPath: string;
  resultPath: string;
}): string[];
export function findCodexBinary(env?: NodeJS.ProcessEnv): string;
export function main(argv?: string[], env?: NodeJS.ProcessEnv): number;
