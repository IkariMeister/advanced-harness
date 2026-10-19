import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { assertSafeFilesystemPath } from './installation-receipt.ts';
import type { ManagedFileEvidence } from './receipt-lineage.ts';

export const canonicalWorkflowCommands = [
  'address-pr-feedback.md',
  'assess-debt.md',
  'grill-me.md',
  'report-defect.md',
  'review-pr.md',
  'start-issue.md',
] as const;

export type WorkflowCommandName = typeof canonicalWorkflowCommands[number];

export type LoadedCommand = {
  filename: WorkflowCommandName;
  content: string;
};

export type CommandFilePlan = {
  filename: WorkflowCommandName;
  targetPath: string;
  status: 'new' | 'identical' | 'differs';
  currentContent?: string;
  newContent: string;
};

export type CommandDeploymentPlan = {
  destinationDirectory: string;
  files: CommandFilePlan[];
  hasDiffers: boolean;
  hasWrites: boolean;
};

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function loadWorkflowCommands(sourceDirectory: string): LoadedCommand[] {
  assertSafeFilesystemPath(sourceDirectory, 'directory');
  return canonicalWorkflowCommands.map(filename => {
    const fullPath = join(sourceDirectory, filename);
    assertSafeFilesystemPath(fullPath, 'file');
    if (!existsSync(fullPath)) {
      throw new Error(`Canonical workflow command template missing: ${filename} at ${fullPath}`);
    }
    const content = readFileSync(fullPath, 'utf8');
    return { filename, content };
  });
}

export function planCommandDeployment(
  commands: readonly LoadedCommand[],
  destinationDirectory: string
): CommandDeploymentPlan {
  const safeDestDir = assertSafeFilesystemPath(destinationDirectory, 'directory');
  const files: CommandFilePlan[] = commands.map(cmd => {
    const targetPath = assertSafeFilesystemPath(join(safeDestDir, cmd.filename), 'file');
    const exists = existsSync(targetPath);
    if (!exists) {
      return {
        filename: cmd.filename,
        targetPath,
        status: 'new',
        newContent: cmd.content,
      };
    }
    const currentContent = readFileSync(targetPath, 'utf8');
    if (currentContent === cmd.content) {
      return {
        filename: cmd.filename,
        targetPath,
        status: 'identical',
        currentContent,
        newContent: cmd.content,
      };
    }
    return {
      filename: cmd.filename,
      targetPath,
      status: 'differs',
      currentContent,
      newContent: cmd.content,
    };
  });

  const hasDiffers = files.some(f => f.status === 'differs');
  const hasWrites = files.some(f => f.status === 'new' || f.status === 'differs');

  return {
    destinationDirectory: safeDestDir,
    files,
    hasDiffers,
    hasWrites,
  };
}

export function filterCommandPlanForExecution(
  plan: CommandDeploymentPlan,
  overwriteDiffers: boolean
): {
  filesToWrite: CommandFilePlan[];
  managedEvidence: ManagedFileEvidence[];
} {
  const filesToWrite: CommandFilePlan[] = [];
  const managedEvidence: ManagedFileEvidence[] = [];

  for (const f of plan.files) {
    if (f.status === 'identical') {
      continue;
    }
    if (f.status === 'differs' && !overwriteDiffers) {
      continue;
    }
    filesToWrite.push(f);
    if (f.status === 'new') {
      managedEvidence.push({
        path: f.targetPath,
        kind: 'commands',
        before: { absent: true },
        after: { content: f.newContent, digest: hash(f.newContent) },
      });
    } else if (f.status === 'differs' && overwriteDiffers) {
      managedEvidence.push({
        path: f.targetPath,
        kind: 'commands',
        before: { content: f.currentContent!, digest: hash(f.currentContent!) },
        after: { content: f.newContent, digest: hash(f.newContent) },
      });
    }
  }

  return { filesToWrite, managedEvidence };
}

export function applyCommandDeployment(
  filesToWrite: readonly CommandFilePlan[],
  destinationDirectory: string
): { writtenPaths: string[] } {
  assertSafeFilesystemPath(destinationDirectory, 'directory');
  if (!existsSync(destinationDirectory)) {
    mkdirSync(destinationDirectory, { recursive: true, mode: 0o755 });
  }

  const writtenPaths: string[] = [];
  for (const f of filesToWrite) {
    assertSafeFilesystemPath(f.targetPath, 'file');
    // Pre-flight check: verify destination has not changed concurrently from reviewed plan
    const exists = existsSync(f.targetPath);
    if (f.status === 'new' && exists) {
      throw new Error(`File was created concurrently before deployment: ${f.targetPath}`);
    }
    if (f.status === 'differs') {
      if (!exists) {
        throw new Error(`File was removed concurrently before deployment: ${f.targetPath}`);
      }
      const current = readFileSync(f.targetPath, 'utf8');
      if (current !== f.currentContent) {
        throw new Error(`File changed concurrently before deployment: ${f.targetPath}`);
      }
    }
    writeFileSync(f.targetPath, f.newContent, 'utf8');
    writtenPaths.push(f.targetPath);
  }

  return { writtenPaths };
}
