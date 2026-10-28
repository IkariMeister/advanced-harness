// Launches the opencode stub in one of two ways:
// - POSIX: `node opencode-stub-entry.mjs <args>` from a generated shell wrapper.
// - Windows: preloaded through NODE_OPTIONS into a copy of node named opencode.exe,
//   because execFile cannot run .cmd/.bat shims without a shell. In that mode Node
//   has already parsed the first argument ("api") as a script path.
import { basename } from 'node:path';

const asOpenCodeExecutable = basename(process.execPath).toLowerCase().startsWith('opencode');
const asScript = process.argv[1] && basename(process.argv[1]) === 'opencode-stub-entry.mjs';
if (asOpenCodeExecutable || asScript) {
  const args = asOpenCodeExecutable ? [basename(process.argv[1] ?? ''), ...process.argv.slice(2)] : process.argv.slice(2);
  const { runOpenCodeStub } = await import('./opencode-stub.ts');
  process.exit(runOpenCodeStub(args));
}
