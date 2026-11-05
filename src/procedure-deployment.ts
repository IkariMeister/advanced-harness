import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { assertSafeFilesystemPath } from './installation-receipt.ts';
import { compileProcedureSkills, type ProcedureSkillArtifact, type ProcedureSkillHost } from './procedure-skills.ts';
import type { ManagedFileEvidence } from './receipt-lineage.ts';
import { discoverReceiptChain } from './receipt-lineage.ts';
import { isSupportedHost, type HostId } from './host-registry.ts';

export type ProcedureFilePlan = {
  path: string;
  content: Buffer;
  current?: Buffer;
  status: 'new' | 'current' | 'outdated' | 'customized';
  owned: boolean;
};
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
export const canonicalProcedurePath = canonical;
const stateBytes = (state: ManagedFileEvidence['after']): Buffer | undefined => {
  if ('absent' in state) return undefined;
  if (state.contentBase64 !== undefined) return Buffer.from(state.contentBase64, 'base64');
  if (state.content !== undefined) return Buffer.from(state.content, 'utf8');
  return undefined;
};
export function discoverProcedureSkills(root: string, host: ProcedureSkillHost): ProcedureSkillArtifact[] {
  const source = assertSafeFilesystemPath(root, 'directory');
  const directories = readdirSync(source, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(source, entry.name)).sort();
  return compileProcedureSkills(directories, [host]);
}
export function planProcedureDeployment(artifacts: readonly ProcedureSkillArtifact[], root: string, prior: readonly ManagedFileEvidence[] = [], globalLayout = false): ProcedureFilePlan[] {
  const base = assertSafeFilesystemPath(root, 'directory');
  const priorMap = new Map(prior.filter(file => file.kind === 'skills').map(file => [canonical(file.path), file]));
  const seen = new Set<string>();
  return artifacts.map(artifact => {
    const relativePath = globalLayout ? artifact.relativePath.replace(/^\.[^/]+\//, '') : artifact.relativePath;
    const target = assertSafeFilesystemPath(join(base, ...relativePath.split('/')), 'file');
    const key = canonical(target);
    if ([...seen].some(existing => existing === key || existing.startsWith(`${key}${sep}`) || key.startsWith(`${existing}${sep}`))) throw new Error(`Duplicate or overlapping procedure skill destination: ${target}`);
    seen.add(key);
    const sourceBytes = Buffer.isBuffer(artifact.content) ? Buffer.from(artifact.content) : Buffer.from(artifact.content, 'utf8');
    const current = existsSync(target) ? (assertSafeFilesystemPath(target, 'file'), readFileSync(target)) : undefined;
    const old = priorMap.get(key);
    const expected = old ? stateBytes(old.after) : undefined;
    const priorDigest = old && !('absent' in old.after) ? old.after.digest : undefined;
    const owned = old !== undefined && current !== undefined && (expected?.equals(current) ?? (priorDigest !== undefined && digest(current) === priorDigest));
    const status = current === undefined ? 'new' : current.equals(sourceBytes) ? 'current' : owned ? 'outdated' : 'customized';
    return { path: target, content: sourceBytes, ...(current ? { current } : {}), status, owned };
  });
}
export function procedureManagedEvidence(files: readonly ProcedureFilePlan[], replaceCustomized: ReadonlySet<string> = new Set()): ManagedFileEvidence[] {
  return files.filter(file => file.status === 'new' || file.status === 'outdated' || file.status === 'customized' && replaceCustomized.has(canonical(file.path))).map(file => {
    const encode = (bytes: Buffer) => {
      const text = bytes.toString('utf8');
      return Buffer.from(text, 'utf8').equals(bytes) ? { content: text, digest: digest(bytes) } : { contentBase64: bytes.toString('base64'), digest: digest(bytes) };
    };
    const old = file.current;
    return { path: file.path, kind: 'skills', before: old === undefined ? { absent: true } : encode(old), after: encode(file.content) };
  });
}
export function mergeProcedureManagedEvidence(into: ManagedFileEvidence[], updates: readonly ManagedFileEvidence[]): void {
  for (const update of updates) {
    const existing = into.find(file => canonical(file.path) === canonical(update.path));
    if (existing) existing.after = structuredClone(update.after);
    else into.push(structuredClone(update));
  }
}
export function assertNoForeignManagedFileClaims(recoveryDirectory: string, host: HostId, paths: readonly string[]): void {
  if (!existsSync(recoveryDirectory)) return;
  const candidates = readdirSync(recoveryDirectory).filter(name => /^native-install-.*\.json$/.test(name));
  const targets = new Map<string, Set<HostId>>();
  for (const name of candidates) {
    const receiptPath = join(recoveryDirectory, name);
    const raw: unknown = JSON.parse(readFileSync(assertSafeFilesystemPath(receiptPath, 'file'), 'utf8'));
    if (!raw || typeof raw !== 'object' || typeof (raw as {target?: unknown}).target !== 'string') throw new Error(`Invalid recovery receipt ${name}; resolve it before deploying procedure skills.`);
    const target = resolve((raw as {target: string}).target);
    const rawHost = (raw as {version?: unknown; host?: unknown}).version === 2 ? (raw as {host?: unknown}).host : undefined;
    const receiptHost: HostId = rawHost && isSupportedHost(rawHost) ? rawHost : 'opencode';
    const entry = targets.get(target) ?? new Set<HostId>();
    entry.add(receiptHost); targets.set(target, entry);
  }
  const protectedPaths = new Set<string>();
  for (const [target, hosts] of targets) for (const owner of hosts) {
    if (owner === host) continue;
    const chain = discoverReceiptChain(recoveryDirectory, target, owner);
    for (const file of chain.head?.receipt.version === 2 ? chain.head.receipt.managedFiles ?? [] : []) {
      if (!('absent' in file.after && file.after.absent)) protectedPaths.add(canonical(file.path));
    }
  }
  const collisions = paths.filter(path => protectedPaths.has(canonical(path)));
  if (collisions.length) throw new Error(`Procedure skill deployment conflicts with another host's active receipt ownership: ${collisions.join(', ')}. Resolve the other host receipt first.`);
}
export function applyProcedureFiles(files: readonly ProcedureFilePlan[], selected: ReadonlySet<string>, backupParent: string, onBackup: (path: string) => void = () => {}): string[] {
  const chosen = files.filter(file => selected.has(canonical(file.path)) && file.status !== 'current');
  preflightProcedureFiles(chosen);
  const written: string[] = [];
  const backups: string[] = [];
  const backupDirectory = join(backupParent, `procedure-skills-${randomUUID()}`);
  try {
    for (const file of chosen) {
      const parent = assertSafeFilesystemPath(dirname(file.path), 'directory');
      mkdirSync(parent, { recursive: true, mode: 0o755 });
      assertSafeFilesystemPath(file.path, 'file');
      const current = existsSync(file.path) ? readFileSync(file.path) : undefined;
      if (current === undefined ? file.current !== undefined : file.current === undefined || !current.equals(file.current)) throw new Error(`Procedure skill changed during deployment: ${file.path}`);
      if (file.current !== undefined) {
        assertSafeFilesystemPath(backupParent, 'directory');
        mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
        assertSafeFilesystemPath(backupDirectory, 'directory');
        const backupPath = join(backupDirectory, `${digest(Buffer.from(resolve(file.path))).slice(0, 16)}-${basename(file.path)}`);
        writeFileSync(assertSafeFilesystemPath(backupPath, 'file'), file.current, { flag: 'wx', mode: 0o600 });
        backups.push(backupPath);
        onBackup(backupPath);
      }
      writeFileSync(file.path, file.content);
      written.push(file.path);
    }
    return written;
  } catch (error) {
    throw new Error(`Procedure skill deployment may be partial; written: ${written.join(', ') || '(none)'}. Backups: ${backups.join(', ') || '(none)'}. Cause: ${String(error)}`);
  }
}
export function preflightProcedureFiles(files: readonly ProcedureFilePlan[]): void {
  for (const file of files) {
    assertSafeFilesystemPath(file.path, 'file');
    const current = existsSync(file.path) ? readFileSync(file.path) : undefined;
    if (current === undefined ? file.current !== undefined : file.current === undefined || !current.equals(file.current)) throw new Error(`Procedure skill changed after confirmation: ${file.path}`);
  }
}
