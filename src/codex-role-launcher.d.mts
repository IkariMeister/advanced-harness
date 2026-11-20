// Types for the self-contained Codex role launcher (codex-role-launcher.mjs), which ships as plain JavaScript.
export const mcpMarker: RegExp;
export const securityKeys: readonly string[];
export const threadIdPattern: RegExp;
export function parseProfile(text: string): Map<string, string>;
export function buildRoleInvocation(options: {
  role: string;
  profileText: string;
  mcpServers: readonly string[];
  mcpAllowed: boolean;
  mcpSelected?: readonly string[] | undefined;
  resumeId?: string | undefined;
  task: string;
  schemaPath: string;
  resultPath: string;
}): string[];
export function listMcpServers(role: string, run: (args: string[]) => string): string[];
export function readSelectedMcpServers(home: string): string[];
export function threadBindingsPath(home: string): string;
export function readThreadBindings(dir: string): Record<string, string>;
export function assertResumable(bindings: Record<string, string>, threadId: string, role: string): void;
export function recordThread(dir: string, threadId: string, role: string): void;
export function boundedStderrTail(text: string | null | undefined): string;
export function reportRun(options: {
  role: string;
  resumeId?: string | undefined;
  bindingsPath: string;
  stdout?: string | null | undefined;
  exitCode: number | null;
  resultText?: string | undefined;
  stderrTail?: string | undefined;
}): { code: number; report: Record<string, unknown> };
export function findCodexBinary(env?: NodeJS.ProcessEnv): string;
export function isEntryPoint(scriptPath: string | undefined, moduleUrl?: string): boolean;
export interface CodexRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}
export interface CodexRunResult {
  status: number | null;
  stdout?: string | null | undefined;
  stderr?: string | null | undefined;
  error?: Error | undefined;
}
export interface CodexRunner {
  list(codex: string, args: string[], options: CodexRunOptions): string;
  exec(codex: string, args: string[], options: CodexRunOptions): CodexRunResult;
}
export const defaultCodexRunner: CodexRunner;
export function main(argv?: string[], env?: NodeJS.ProcessEnv, runner?: CodexRunner): number;
