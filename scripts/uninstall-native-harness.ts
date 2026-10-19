import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { adoptExisting, assertSafeFilesystemPath, configurationField, persistAdoptionReceipt, readInstallationReceipt, planUninstall, effectiveReceiptHost } from '../src/installation-receipt.ts';
import { chooseConfiguration, discoverConfigurations, projectConfiguration, saveInstallation } from '../src/native-installer.ts';
import { adoptionPreviewAction, selectAdoptionFields } from '../src/adoption-prompts.ts';
import { runUninstallFlow } from '../src/uninstall-cli-flow.ts';
import { discoverReceiptChain, readReceiptForRestore, revalidateRestoreReceipt } from '../src/receipt-lineage.ts';
import { parseHostSelection, type HostId } from '../src/host-registry.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run harness:uninstall -- [--scope global|project] [--project <directory>] [--config <opencode.json|opencode.jsonc>] [--receipt <receipt>] [--host <host>] | --adopt-existing [--before-config <known-before-config>]');
} else {
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (['--adopt-existing'].includes(arg)) { if (options[arg]) throw new Error(`Duplicate ${arg}`); options[arg] = true; }
    else if (['--scope', '--project', '--config', '--receipt', '--before-config', '--host'].includes(arg)) {
      if (options[arg] || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error(`Missing or duplicate value for ${arg}`);
      options[arg] = args[++i]!;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options['--scope'] && !['global', 'project'].includes(String(options['--scope']))) throw new Error('--scope must be global or project.');
  if (options['--scope'] === 'project' && !options['--project']) throw new Error('--project is required with --scope project.');
  if (options['--scope'] === 'global' && options['--project']) throw new Error('--project cannot be combined with --scope global.');
  if (options['--adopt-existing'] && options['--receipt']) throw new Error('--adopt-existing is a separate mode and cannot be combined with --receipt.');
  if (options['--before-config'] && !options['--adopt-existing']) throw new Error('--before-config requires --adopt-existing.');
  const selectedHosts = options['--host'] ? parseHostSelection(String(options['--host'])) : undefined;
  if (selectedHosts && selectedHosts.length !== 1) throw new Error('--host must select exactly one host for uninstall.');
  const home = homedir();
  const globalDirectory = resolve(join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode'));
  const project = options['--project'] ? resolve(String(options['--project'])) : undefined;
  const scope = String(options['--scope'] ?? (project ? 'project' : 'global'));
  const sources = discoverConfigurations(project, globalDirectory);
  const target = options['--config']
    ? resolve(String(options['--config']))
    : scope === 'project'
      ? projectConfiguration(project!, sources)
      : chooseConfiguration(globalDirectory);
  if (!['opencode.json', 'opencode.jsonc'].includes(basename(target))) throw new Error('Target must be opencode.json or opencode.jsonc.');
  const targetDirectory = dirname(target);
  const allowedDirectories = scope === 'global' ? [globalDirectory] : [project!, join(project!, '.opencode')];
  if (!allowedDirectories.some(directory => process.platform === 'win32' ? resolve(directory).toLowerCase() === targetDirectory.toLowerCase() : resolve(directory) === targetDirectory)) throw new Error('--config must select opencode.json/jsonc inside the chosen project (or its .opencode folder), or the global OpenCode directory.');
   if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive terminal required; no writes made.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    assertSafeFilesystemPath(target, 'file');
    if (!existsSync(target) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) throw new Error('Target must exist as a regular non-symlink file.');
    const current = readFileSync(target, 'utf8');
    const backupParent = process.env.ADVANCED_HARNESS_RECOVERY_DIR || join(home, 'Projects', 'advanced-harness-backups');
    let receiptPath = String(options['--receipt'] ?? '');
    let receipt: ReturnType<typeof readInstallationReceipt> | undefined;
    if (options['--adopt-existing']) {
      const beforePath = options['--before-config'] ? resolve(String(options['--before-config'])) : undefined;
      if (beforePath) assertSafeFilesystemPath(beforePath, 'file');
      if (beforePath && (!existsSync(beforePath) || !lstatSync(beforePath).isFile() || lstatSync(beforePath).isSymbolicLink())) throw new Error('Before-config must be a regular non-symlink file.');
      const before = beforePath ? readFileSync(beforePath, 'utf8') : undefined;
       const roles = ['lead','operator','external','researcher','planner','implementer','reviewer','qa'];
      const fields = ['description','mode','model','permissions','system'];
      const keys = [...roles.flatMap(role => fields.map(field => `agents.${role}.${field}`)), 'default_agent','model'];
      const present = keys.filter(key => configurationField(current, key.split('.')) !== undefined);
       console.log(`Adoption inventory; evidence: ${beforePath ?? 'none (restore choices unavailable)'}. Only detected supported fields on the eight known harness roles and present root defaults are eligible. Custom agents, other agent fields, absent fields, and unrelated settings are excluded and untouched.`);
       console.log('WARNING: adoption cannot establish installation ownership or historical authorship. “Adopt all” records only supported detected agent fields for removal; it does not change configuration or uninstall anything.');
       const { selected, removed, acknowledged } = await selectAdoptionFields(present, Boolean(beforePath), message => terminal.question(message), message => console.log(message));
      const adoption = adoptExisting(target, current, before, selected, removed, acknowledged);
       const actions = adoption.changes.map(change => adoptionPreviewAction(change, removed));
      console.log(`\nAdoption preview: ${selected.length} restore selections, ${removed.length} explicit unknown-history removals.`);
      for (const action of actions) console.log(`  ${action}`);
      if (!adoption.changes.length) console.log('No fields selected; no receipt or configuration write created.');
      else if ((await terminal.question('Type adopt to record this provenance only (configuration remains unchanged): ')).trim() !== 'adopt') console.log('Cancelled; no files written.');
      else {
        receiptPath = persistAdoptionReceipt(backupParent, adoption, current, beforePath, before, true)!;
        console.log(`Adoption recorded at ${receiptPath}. Configuration unchanged; no uninstall was performed.`);
      }
    } else {
      if (receiptPath) receipt = readReceiptForRestore(receiptPath, target);
      else {
        const requestedHost = selectedHosts?.[0];
        const snapshot = discoverReceiptChain(backupParent, target, requestedHost);
        if (!snapshot.head) throw new Error('No active installation receipt was found for this target and host; pass --receipt or use --adopt-existing for an unmanaged installation.');
        receiptPath = join(snapshot.directory, snapshot.head.file);
        receipt = readReceiptForRestore(receiptPath, target);
        console.log(`Using active receipt: ${receiptPath}`);
      }
      const effectiveHost = effectiveReceiptHost(receipt);
      if (options['--host']) {
        const expectedHost = parseHostSelection(String(options['--host']))[0];
        if (effectiveHost !== expectedHost) {
          throw new Error(`Receipt host mismatch: receipt belongs to host "${effectiveHost}", but --host "${expectedHost}" was specified.`);
        }
      }
    }
    if (!options['--adopt-existing']) {
      const status = await runUninstallFlow({
        receipt: receipt!, current,
        backupParent,
        host: effectiveReceiptHost(receipt!),
        confirm: message => terminal.question(message),
        output: message => console.log(message),
        error: message => console.error(message),
        save: updated => {
          const latest = readInstallationReceipt(receiptPath, target);
          if (JSON.stringify(latest) !== JSON.stringify(receipt)) throw new Error('Receipt changed during uninstall review; no write permitted.');
          revalidateRestoreReceipt(receipt!);
          const backup = saveInstallation(target, current, updated, backupParent);
          console.log(`Uninstall complete. Backup retained: ${backup ?? '(target did not previously exist)'}`);
        },
      });
      if (status) process.exitCode = status;
    }
  } finally { terminal.close(); }
}
