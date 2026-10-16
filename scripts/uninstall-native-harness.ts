import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { adoptExisting, assertSafeFilesystemPath, configurationField, persistAdoptionReceipt, readInstallationReceipt, planUninstall } from '../src/installation-receipt.ts';
import { saveInstallation } from '../src/native-installer.ts';
import { adoptionPreviewAction, selectAdoptionFields } from '../src/adoption-prompts.ts';
import { runUninstallFlow } from '../src/uninstall-cli-flow.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run harness:uninstall -- --config <opencode.json|opencode.jsonc> --receipt <receipt> | --adopt-existing [--before-config <known-before-config>]');
} else {
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (['--adopt-existing'].includes(arg)) { if (options[arg]) throw new Error(`Duplicate ${arg}`); options[arg] = true; }
    else if (['--config', '--receipt', '--before-config'].includes(arg)) {
      if (options[arg] || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error(`Missing or duplicate value for ${arg}`);
      options[arg] = args[++i]!;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options['--before-config'] && !options['--adopt-existing']) throw new Error('--before-config requires --adopt-existing.');
  if (options['--adopt-existing'] && options['--receipt']) throw new Error('--adopt-existing is a separate mode and cannot be combined with --receipt.');
  const target = resolve(String(options['--config'] ?? ''));
  if (!['opencode.json', 'opencode.jsonc'].includes(basename(target))) throw new Error('Target must be opencode.json or opencode.jsonc.');
   if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive terminal required; no writes made.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    assertSafeFilesystemPath(target, 'file');
    if (!existsSync(target) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) throw new Error('Target must exist as a regular non-symlink file.');
    const current = readFileSync(target, 'utf8');
    const backupParent = process.env.ADVANCED_HARNESS_RECOVERY_DIR || join(homedir(), 'Projects', 'advanced-harness-backups');
    let receiptPath = String(options['--receipt'] ?? '');
    let receipt;
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
      if (!receiptPath) throw new Error('A valid receipt is required; use --adopt-existing for unmanaged installations.');
      receipt = readInstallationReceipt(receiptPath, target);
    }
    if (!options['--adopt-existing']) {
      const status = await runUninstallFlow({
        receipt: receipt!, current,
        confirm: message => terminal.question(message),
        output: message => console.log(message),
        error: message => console.error(message),
        save: updated => {
          const backup = saveInstallation(target, current, updated, backupParent);
          console.log(`Uninstall complete. Backup retained: ${backup ?? '(target did not previously exist)'}`);
        },
      });
      if (status) process.exitCode = status;
    }
  } finally { terminal.close(); }
}
