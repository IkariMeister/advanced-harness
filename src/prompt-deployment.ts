import { applyEdits, modify } from 'jsonc-parser';
import { loadNativeDefinitions, nativeRoles, parseConfiguration, type NativeDefinition, type NativeRole } from './native-installer.ts';
import { createSuccessorReceipt, discoverReceiptChain, finalizeSuccessor, recoverFailedSuccessor, revalidatePendingSuccessor, writePendingSuccessor, type ReceiptSnapshot, type V2Receipt } from './receipt-lineage.ts';
import { saveInstallation } from './native-installer.ts';
import { readFileSync, existsSync } from 'node:fs';

export type PromptDeployTarget = {
  target: string;
  originalText?: string;
};

export type PromptDeploymentPlan = {
  target: string;
  roles: {
    role: NativeRole;
    descriptionChanged: boolean;
    systemChanged: boolean;
  }[];
  updatedText: string;
  hasChanges: boolean;
};

export function planPromptDeployment(
  original: string,
  definitions: Record<NativeRole, NativeDefinition>,
  targetPath: string
): PromptDeploymentPlan {
  const value = parseConfiguration(original, targetPath);
  if (!value.agents || typeof value.agents !== 'object' || Array.isArray(value.agents)) {
    throw new Error(`Target configuration at ${targetPath} has no native agents object. Install native harness first.`);
  }

  const existingAgents = value.agents as Record<string, unknown>;
  for (const role of nativeRoles) {
    if (!existingAgents[role] || typeof existingAgents[role] !== 'object' || Array.isArray(existingAgents[role])) {
      throw new Error(`Native role '${role}' is missing from agents in ${targetPath}. Run installer first.`);
    }
  }

  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
  let text = bom ? original.slice(1) : original;
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: original.includes('\r\n') ? '\r\n' : '\n' } };
  const set = (path: string[], content: unknown) => { text = applyEdits(text, modify(text, path, content, options)); };

  const rolesPlan: PromptDeploymentPlan['roles'] = [];

  for (const role of nativeRoles) {
    const existing = existingAgents[role] as Record<string, unknown>;
    const currentDesc = typeof existing.description === 'string' ? existing.description : undefined;
    const currentSystem = typeof existing.system === 'string' ? existing.system : undefined;

    const newDesc = definitions[role].description;
    const newSystem = definitions[role].system;

    const descriptionChanged = currentDesc !== newDesc;
    const systemChanged = currentSystem !== newSystem;

    if (descriptionChanged) {
      set(['agents', role, 'description'], newDesc);
    }
    if (systemChanged) {
      set(['agents', role, 'system'], newSystem);
    }

    rolesPlan.push({
      role,
      descriptionChanged,
      systemChanged
    });
  }

  const updatedText = bom + text;
  parseConfiguration(updatedText, targetPath);

  const hasChanges = rolesPlan.some(r => r.descriptionChanged || r.systemChanged);

  return {
    target: targetPath,
    roles: rolesPlan,
    updatedText,
    hasChanges
  };
}

export interface PromptDeployDependencies {
  save?: typeof saveInstallation;
  writePending?: typeof writePendingSuccessor;
  finalize?: typeof finalizeSuccessor;
  loadDefinitions?: typeof loadNativeDefinitions;
}

export function deployPrompts(
  target: string,
  backupParent: string,
  options: {
    definitionsDirectory?: string;
    deps?: PromptDeployDependencies;
  } = {}
): { updated: boolean; backup?: string | undefined; receiptPath?: string | undefined } {
  if (!existsSync(target)) {
    throw new Error(`Configuration target not found: ${target}`);
  }
  const original = readFileSync(target, 'utf8');
  const loadDefs = options.deps?.loadDefinitions ?? loadNativeDefinitions;
  const definitions = loadDefs(options.definitionsDirectory ?? 'agents');

  const plan = planPromptDeployment(original, definitions, target);
  if (!plan.hasChanges) {
    return { updated: false };
  }

  const history = discoverReceiptChain(backupParent, target);
  const receipt = createSuccessorReceipt(history, original, plan.updatedText, {});

  const writePending = options.deps?.writePending ?? writePendingSuccessor;
  const pending = writePending(history, receipt);
  const receiptPath = pending.path;

  let backup: string | undefined;
  const save = options.deps?.save ?? saveInstallation;
  try {
    revalidatePendingSuccessor(pending);
    backup = save(target, original, plan.updatedText, backupParent);
  } catch (err) {
    if (recoverFailedSuccessor(pending, original) !== 'cleared') {
      // Pending evidence preserved
    }
    throw err;
  }

  const finalize = options.deps?.finalize ?? finalizeSuccessor;
  try {
    finalize(pending, plan.updatedText);
  } catch (err) {
    throw new Error(`Configuration saved but receipt finalization failed; pending evidence at ${receiptPath}: ${String(err)}`);
  }

  return { updated: true, backup, receiptPath };
}
