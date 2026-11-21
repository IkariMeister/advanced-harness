// Types for the self-contained Codex role launcher (codex-role-launcher.mjs), which ships as plain JavaScript.
export const mcpMarker: RegExp;
export const securityKeys: readonly string[];
export const threadIdPattern: RegExp;
export const launcherRuntime: {
  execFileSync: (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; encoding: 'utf8'; windowsHide: boolean; stdio?: readonly string[]; timeout?: number; maxBuffer?: number }) => string;
  spawnSync: (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; encoding: 'utf8'; windowsHide: boolean; maxBuffer: number; stdio: readonly string[] }) => { status: number | null; stdout: string | null; stderr: string | null };
};
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
  workspaceRoot?: string | undefined;
}): string[];
export function listMcpServers(role: string, run: (args: string[]) => string): string[];
export function readSelectedMcpServers(home: string): string[];
export function threadBindingsPath(home: string): string;
export function readThreadBindings(dir: string): Record<string, string | { role: string; worktree?: string; gitDir?: string; commonDir?: string }>;
export function assertResumable(bindings: Record<string, string | { role: string }>, threadId: string, role: string): void;
export function recordThread(dir: string, threadId: string, role: string, identity?: { top: string; gitDir: string; commonDir: string }): void;
export function reportRun(options: {
  role: string;
  resumeId?: string | undefined;
  bindingsPath: string;
  stdout?: string | null | undefined;
  exitCode: number | null;
  resultText?: string | undefined;
  identity?: { top: string; gitDir: string; commonDir: string } | undefined;
}): { code: number; report: Record<string, unknown> };
export function validateGitIdentity(identity: unknown): boolean;
export function findCodexBinary(env?: NodeJS.ProcessEnv): string;
export function isEntryPoint(scriptPath: string | undefined, moduleUrl?: string): boolean;
export function main(argv?: string[], env?: NodeJS.ProcessEnv): number;
