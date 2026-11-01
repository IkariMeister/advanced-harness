import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverConfigurations } from '../src/native-installer.ts';
import { DiagnosticError, expectedAgents, printReport, verifyRuntime, diagnoseHost, printHostDiagnosticReport } from '../src/native-diagnostics.ts';
import { detectInstalledHosts, parseHostSelection, type HostId } from '../src/host-registry.ts';
import { describeHarnessCheckout } from '../src/harness-version.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run harness:doctor -- [--host <opencode|claude-code|antigravity|codex|cursor|all>] [--project <directory>] [--opencode <CLI path>] [--server <URL>]');
  console.log('Inspects config and runtime agent/model catalogs for all specified or detected hosts. May start the OpenCode service; never reloads it, edits config, or sends model requests.');
} else {
  try {
    const options: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      if (!flag || !['--project', '--opencode', '--server', '--host'].includes(flag) || !value || value.startsWith('--') || options[flag]) throw new Error('Unknown, duplicate, or incomplete option. Run --help.');
      options[flag] = value;
    }
    const directory = resolve(options['--project'] ?? process.cwd());
    if (!statSync(directory).isDirectory()) throw new Error('Select an existing project directory.');

    const hosts: HostId[] = options['--host']
      ? parseHostSelection(options['--host'])
      : detectInstalledHosts(directory, homedir(), process.env.XDG_CONFIG_HOME);

    console.log(`Harness checkout: ${describeHarnessCheckout(resolve(fileURLToPath(new URL('..', import.meta.url))))}`);
    console.log(`Checking location: ${directory}`);
    console.log(`Inspecting host(s): ${hosts.join(', ')}`);

    let allOk = true;

    for (const host of hosts) {
      if (host === 'opencode') {
        const global = resolve(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode'));
        const sources = discoverConfigurations(directory, global);
        console.log('\n=== OpenCode V2 Diagnostics ===');
        console.log('Configuration sources (no contents/credentials printed):');
        for (const source of sources) console.log(`  ${source.path}`);
        if (!sources.length) {
          console.log('  None. Install at global scope or in this project.');
        } else {
          try {
            console.log('Querying OpenCode runtime; this may start its service. No reload/restart will be performed.');
            const report = await verifyRuntime({ directory, ...(options['--opencode'] ? { executable: options['--opencode'] } : {}), ...(options['--server'] ? { server: options['--server'] } : {}) }, expectedAgents(sources));
            printReport(report);
            if (!report.ok) allOk = false;
          } catch (err) {
            if (err instanceof DiagnosticError) console.error(err.message);
            console.error('OpenCode runtime check inconclusive.');
            allOk = false;
          }
        }
      } else {
        const diag = await diagnoseHost(host, { project: directory });
        printHostDiagnosticReport(diag);
        if (!diag.ok) allOk = false;
      }
    }

    process.exitCode = allOk ? 0 : 1;
  } catch (error) {
    if (error instanceof DiagnosticError) console.error(error.message);
    // Other raw errors may contain provider/config details and are suppressed.
    console.error('Verification inconclusive. Check project/config validity, CLI path, and OpenCode service/connection. No configuration was changed.');
    process.exitCode = 2;
  }
}
