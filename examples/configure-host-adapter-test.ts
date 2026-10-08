import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureHostPaths } from '../src/fixture-host.ts';

const requested = process.argv[2];
if (!requested) throw new Error('Usage: node examples/configure-host-adapter-test.ts <disposable-project>');
const project = resolve(requested);
const marker = `${project}/.harness-test-fixture.json`;
if (!existsSync(marker)) throw new Error(`Refusing unmarked project: ${marker}`);
const parsedMarker = JSON.parse(readFileSync(marker, 'utf8')) as { schema?: unknown; kind?: unknown };
if (parsedMarker.schema !== 1 || parsedMarker.kind !== 'advanced-harness-agent-test') throw new Error('Invalid disposable-project marker');
const configPath = `${project}/.opencode/opencode.jsonc`;
const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
delete config.plugins;
const source = fileURLToPath(new URL('../spike/opencode', import.meta.url));
const adapter = join(project, '.opencode', 'plugins', 'advanced-harness');
mkdirSync(adapter, { recursive: true });
for (const name of ['server.ts', 'host-adapter.ts', 'host-adapter-policy.ts', 'host-ipc-client.ts', 'package.json']) {
  copyFileSync(join(source, name), join(adapter, basename(name)));
}
// Local auto-discovered plugins do not receive configured package options. The
// smoke project therefore receives its own fixed default IPC directory.
const deployedAdapter = join(adapter, 'host-adapter.ts');
const adapterText = readFileSync(deployedAdapter, 'utf8')
  .replace(
    'const directory = configuredDirectory(ctx.options);',
    `const directory = configuredDirectory({ directory: ${JSON.stringify(fixtureHostPaths(project).ipc.replaceAll('\\', '/'))} });`,
  )
  .replace('const diagnostic = ctx.options.diagnostic === true;', 'const diagnostic = true;');
writeFileSync(deployedAdapter, adapterText);
if (!existsSync(join(adapter, 'node_modules', '@opencode', 'plugin'))) {
  const npm = process.platform === 'win32'
    ? join(process.env.ProgramFiles ?? 'C:/Program Files', 'nodejs', 'npm.cmd')
    : 'npm';
  if (!existsSync(npm) && process.platform === 'win32') throw new Error(`npm.cmd not found: ${npm}`);
  execFileSync(npm, ['install', '--ignore-scripts', '--no-audit'], { cwd: adapter, stdio: 'inherit' });
}
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
writeFileSync(`${project}/TEST-HOST-PROMPT.txt`, readFileSync(new URL('../spike/opencode/host-smoke-prompt.txt', import.meta.url)));
console.log(`Configured host-adapter test project: ${project}`);
console.log(`Adapter: ${adapter}`);
console.log(`IPC: ${fixtureHostPaths(project).ipc}`);
console.log('Start the host in a separate interactive terminal before opening a new Desktop session.');
