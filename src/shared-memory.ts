import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type MemoryEntry = {
  source: string;
  scope: string;
  confirmation: string;
  fact: string;
};

export type BootstrapContext = {
  projectRoot: string;
  baseBranch: string;
  worktreeDirectory: string;
  memoryPath: string;
};

export type BootstrapReadiness = {
  status: 'ready' | 'blocked';
  reasons: string[];
};

export type RuleDispositionType = 'promote' | 'keep-memory' | 'discard';

export type RuleDisposition = {
  type: RuleDispositionType;
  entry: MemoryEntry;
  targetRuleText?: string;
};

export type RulePromotionPlan = {
  dispositions: RuleDisposition[];
  promotedCount: number;
  keptCount: number;
  discardedCount: number;
  diff: string;
  updatedAgentsText: string;
};

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9_]{20,}/i,
  /github_pat_[A-Za-z0-9_]{20,}/i,
  /sk-[A-Za-z0-9_-]{20,}/i,
  /bearer\s+[A-Za-z0-9_\-.]{20,}/i,
  /-----\s*begin\s+(?:(?:rsa|openssh|dsa|ec|encrypted)\s+)?private\s+key\s*-----/i,
  /(?:api[_-]?key|password|secret|token)\s*[:=]\s*(?:['"][^\s'"]{8,}['"]|[^\s,;]{8,})/i,
  /[a-zA-Z]+:\/\/[^/\s:@]+:[^/\s:@]+@[^/\s]+/i,
];

const LOCAL_PATH_PATTERNS = [
  /(?:[a-zA-Z]:\\|\/)(?:Users|home)[\\/][^\\/\s]+[\\/](?:Projects[\\/])?(?:advanced-harness-(?:worktrees|data)|[^\\/\s]*(?:worktree|worktrees)[^\\/\s]*|worktrees?)[\\/]/i,
  /\.opencode[\\/]harness\.[a-z0-9.]+/i,
];

function inside(path: string, directory: string): boolean {
  const child = relative(resolve(directory), resolve(path));
  return child === '' || (!child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && child !== '..' && !isAbsolute(child));
}

function validBranch(value: string): boolean {
  return !!value && value !== '@' && !/\s|[\x00-\x1f\x7f~^:?*\[\\]|\.\.|@\{|\/\/|^[-/]|\/$|\.$|\.lock(?:\/|$)|(?:^|\/)\./.test(value);
}

export function validateBootstrapContext(value: unknown): BootstrapContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Bootstrap context must be an object.');
  }
  const obj = value as Record<string, unknown>;
  const { projectRoot, baseBranch, worktreeDirectory, memoryPath } = obj;

  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) {
    throw new Error('projectRoot must be an absolute path.');
  }
  if (typeof baseBranch !== 'string' || !validBranch(baseBranch)) {
    throw new Error(`Invalid baseBranch: "${baseBranch}".`);
  }
  if (typeof worktreeDirectory !== 'string' || !isAbsolute(worktreeDirectory)) {
    throw new Error('worktreeDirectory must be an absolute path.');
  }
  if (typeof memoryPath !== 'string' || !isAbsolute(memoryPath)) {
    throw new Error('memoryPath must be an absolute path.');
  }

  const root = resolve(projectRoot);
  const wtDir = resolve(worktreeDirectory);
  const mem = resolve(memoryPath);

  if (inside(wtDir, root) || inside(root, wtDir)) {
    throw new Error('Worktree parent directory must be outside the project checkout and cannot contain it.');
  }
  if (inside(mem, root) || inside(root, dirname(mem))) {
    throw new Error('Shared memory must be outside the project checkout and cannot contain it.');
  }
  if (basename(mem) !== 'MEMORY.md') {
    throw new Error('Shared memory path must end in MEMORY.md.');
  }
  if (inside(mem, wtDir)) {
    throw new Error('Shared memory must not be inside the worktree parent directory.');
  }

  return {
    projectRoot: root,
    baseBranch,
    worktreeDirectory: wtDir,
    memoryPath: mem,
  };
}

export function checkBootstrapReadiness(options: {
  context: unknown;
  targetBranch?: string;
  targetWorktreePath?: string;
  existingBranches?: readonly string[];
  existingWorktrees?: readonly string[];
}): BootstrapReadiness {
  const reasons: string[] = [];
  let validContext: BootstrapContext | undefined;

  try {
    validContext = validateBootstrapContext(options.context);
  } catch (err) {
    reasons.push(err instanceof Error ? err.message : String(err));
  }

  const targetBranch = options.targetBranch?.trim();
  if (targetBranch) {
    if (!validBranch(targetBranch)) {
      reasons.push(`Target branch "${targetBranch}" is invalid.`);
    } else if (options.existingBranches?.includes(targetBranch)) {
      reasons.push(`Target branch "${targetBranch}" already exists.`);
    }
  }

  const targetWorktree = options.targetWorktreePath?.trim();
  if (targetWorktree && validContext) {
    const resolvedTarget = resolve(targetWorktree);
    if (!inside(resolvedTarget, validContext.worktreeDirectory)) {
      reasons.push(`Target worktree "${resolvedTarget}" is not inside configured worktree parent "${validContext.worktreeDirectory}".`);
    } else if (existsSync(resolvedTarget)) {
      reasons.push(`Target worktree directory "${resolvedTarget}" already exists.`);
    } else if (options.existingWorktrees?.some(wt => resolve(wt) === resolvedTarget)) {
      reasons.push(`Target worktree path "${resolvedTarget}" is already registered in Git worktrees.`);
    }
  }

  return {
    status: reasons.length === 0 ? 'ready' : 'blocked',
    reasons,
  };
}

export function validateMemoryEntry(entry: MemoryEntry): void {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Memory entry must be an object.');
  }
  for (const [label, value] of [['source', entry.source], ['scope', entry.scope], ['confirmation', entry.confirmation], ['fact', entry.fact]] as const) {
    if (typeof value === 'string' && /[\r\n]/.test(value)) {
      throw new Error(`Memory entry ${label} must not contain raw newlines.`);
    }
  }
  const source = entry.source?.trim();
  const scope = entry.scope?.trim();
  const confirmation = entry.confirmation?.trim();
  const fact = entry.fact?.trim();

  if (!source) throw new Error('Memory entry source cannot be empty.');
  if (!scope) throw new Error('Memory entry scope cannot be empty.');
  if (!confirmation) throw new Error('Memory entry confirmation cannot be empty.');
  if (!fact) throw new Error('Memory entry fact cannot be empty.');
  for (const [label, value] of [['source', source], ['scope', scope], ['confirmation', confirmation]] as const) {
    if (/[\r\n;\]]/.test(value)) throw new Error(`Memory entry ${label} contains unsupported delimiters or raw newlines.`);
  }
  const combined = `${source} ${scope} ${confirmation} ${fact}`;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(combined)) {
      throw new Error('Memory entry contains potential secret or credential tokens. Rejecting write.');
    }
  }

  if (/[\r\n]/.test(fact)) {
    throw new Error('Memory entry fact must be a single line without raw newlines.');
  }
  if (fact.length > 2000) {
    throw new Error('Memory entry fact exceeds maximum length (2000 characters). Operational log dumps are not permitted in MEMORY.md.');
  }
}

export function parseMemoryEntryLine(line: string): MemoryEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('-')) return undefined;
  const match = trimmed.match(/^-\s*\[Source:\s*([^;]+?)\s*;\s*scope:\s*([^;]+?)\s*;\s*confirmation:\s*([^\]]+?)\s*\]\s+(.+)$/);
  if (!match) return undefined;
  const entry: MemoryEntry = {
    source: match[1]!.trim(),
    scope: match[2]!.trim(),
    confirmation: match[3]!.trim(),
    fact: match[4]!.trim(),
  };
  validateMemoryEntry(entry);
  return entry;
}

export function parseSharedMemory(text: string): MemoryEntry[] {
  const lines = text.split(/\r\n|\n/);
  if (lines[0]?.startsWith('\uFEFF')) lines[0] = lines[0].slice(1);
  const entries: MemoryEntry[] = [];
  let headerSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.includes('\r')) throw new Error(`Unsupported shared MEMORY.md content on line ${i + 1}.`);
    if (!line.trim()) continue;
    if (line.trim() === '# Shared Operator memory' && !headerSeen && entries.length === 0) {
      headerSeen = true;
      continue;
    }
    try {
      const entry = parseMemoryEntryLine(line);
      if (entry) {
        entries.push(entry);
        continue;
      }
    } catch {
      throw new Error(`Invalid shared MEMORY.md entry on line ${i + 1}.`);
    }
    throw new Error(`Unsupported shared MEMORY.md content on line ${i + 1}.`);
  }
  return entries;
}

export function formatSharedMemory(entries: readonly MemoryEntry[]): string {
  const lines = ['# Shared Operator memory', ''];
  for (const entry of entries) {
    validateMemoryEntry(entry);
    lines.push(`- [Source: ${entry.source}; scope: ${entry.scope}; confirmation: ${entry.confirmation}] ${entry.fact}`);
  }
  return lines.join('\n') + '\n';
}

function normalizeKey(str: string): string {
  return str.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function deduplicateMemoryEntries(entries: readonly MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>();
  const result: MemoryEntry[] = [];

  for (const entry of entries) {
    validateMemoryEntry(entry);
    const key = `${normalizeKey(entry.scope)}|${normalizeKey(entry.fact)}|${normalizeKey(entry.confirmation)}|${normalizeKey(entry.source)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  return result;
}

export function detectMemoryConflicts(
  existingEntries: readonly MemoryEntry[],
  newEntry: MemoryEntry,
  agentsText?: string
): { hasConflict: boolean; reason?: string } {
  validateMemoryEntry(newEntry);
  const newScope = normalizeKey(newEntry.scope);
  const newFact = normalizeKey(newEntry.fact);

  // Check if same scope has contradictory fact without replacement confirmation
  for (const existing of existingEntries) {
    const exScope = normalizeKey(existing.scope);
    const exFact = normalizeKey(existing.fact);
    if (exScope === newScope && exFact !== newFact) {
      const isReplacement = /replaces|replacement|updated/i.test(newEntry.confirmation);
      if (!isReplacement && (exFact.includes(newFact) || newFact.includes(exFact) || /not|disabled|enabled|none|gh|mcp/.test(exFact + ' ' + newFact))) {
        return {
          hasConflict: true,
          reason: `Potential conflict in scope "${existing.scope}": existing fact "${existing.fact}" differs from candidate "${newEntry.fact}". A human confirmation of replacement is required.`,
        };
      }
    }
  }

  // Check against AGENTS.md rules
  if (agentsText) {
    // If AGENTS text explicitly forbids something that newEntry claims
    if (/never\s+merge|merging\s+remains\s+human-only/i.test(agentsText) && /auto[_-]?merge|merges?\s+automatically/i.test(newEntry.fact)) {
      return {
        hasConflict: true,
        reason: 'Candidate fact contradicts AGENTS.md instruction (merging is human-only).',
      };
    }
  }

  return { hasConflict: false };
}

export function readSharedMemory(memoryPath: string): {
  exists: boolean;
  entries: MemoryEntry[];
  raw: string;
  hash: string;
} {
  const target = resolve(memoryPath);
  if (!existsSync(target)) {
    return {
      exists: false,
      entries: [],
      raw: '',
      hash: createHash('sha256').update('').digest('hex'),
    };
  }

  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Shared memory path must be a regular file, not a symlink or directory.');
  }
  if (stat.size > 1024 * 1024) {
    throw new Error('Shared memory file exceeds 1 MiB size limit.');
  }

  const raw = readFileSync(target, 'utf8');
  const hash = createHash('sha256').update(raw).digest('hex');
  const entries = parseSharedMemory(raw);

  return {
    exists: true,
    entries,
    raw,
    hash,
  };
}

export function writeSharedMemorySerialized(
  memoryPath: string,
  entries: readonly MemoryEntry[],
  baselineHash: string | undefined
): { success: boolean; hash: string } {
  const target = resolve(memoryPath);
  const parent = dirname(target);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const lockPath = `${target}.lock`;
  let lockFd: number;
  try { lockFd = openSync(lockPath, 'wx'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Concurrent modification detected on shared MEMORY.md. Another writer holds the lock.');
    throw err;
  }
  const tempPath = join(parent, `.MEMORY.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    const current = readSharedMemory(target);
    if (baselineHash !== undefined && current.hash !== baselineHash) {
      throw new Error('Concurrent modification detected on shared MEMORY.md. Baseline hash does not match current file on disk.');
    }
    const deduplicated = deduplicateMemoryEntries(entries);
    const formatted = formatSharedMemory(deduplicated);
    const newHash = createHash('sha256').update(formatted).digest('hex');
    writeFileSync(tempPath, formatted, 'utf8');
    renameSync(tempPath, target);
    return { success: true, hash: newHash };
  } catch (err) {
    if (existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch {}
    }
    throw err;
  } finally {
    closeSync(lockFd);
    try { unlinkSync(lockPath); } catch {}
  }
}

export function planRulePromotion(options: {
  memoryEntries: readonly MemoryEntry[];
  agentsText: string;
  dispositions: readonly RuleDisposition[];
}): RulePromotionPlan {
  const original = options.agentsText;
  let promotedCount = 0;
  let keptCount = 0;
  let discardedCount = 0;
  const promotedRules: string[] = [];

  for (const disp of options.dispositions) {
    validateMemoryEntry(disp.entry);

    if (disp.type === 'promote') {
      const ruleText = (disp.targetRuleText ?? disp.entry.fact).trim();
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(ruleText)) {
          throw new Error('Promoted rule contains potential secret/token patterns. Rejecting promotion.');
        }
      }
      for (const pattern of LOCAL_PATH_PATTERNS) {
        if (pattern.test(ruleText)) {
          throw new Error('Promoted rule contains machine-local worktree or operational paths. Rejecting promotion into AGENTS.md.');
        }
      }
      if (/(?:^|[^\w])(?:[a-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+|\\\\[^\\]+\\[^\\]+|\/(?:Users|home)\/[^/\s]+)(?:[\\/]|[\s.,;:!?)]|$)/i.test(ruleText)) {
        throw new Error('Promoted rule contains machine-local worktree or operational paths. Rejecting promotion into AGENTS.md.');
      }
      promotedRules.push(`- ${ruleText}`);
      promotedCount++;
    } else if (disp.type === 'keep-memory') {
      keptCount++;
    } else if (disp.type === 'discard') {
      discardedCount++;
    }
  }

  let updatedAgentsText = original;
  if (promotedRules.length > 0) {
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const sectionHeader = '## Promoted Project Rules';
    const newRuleBlock = promotedRules.join(eol);
    const lines = original.split(/\r\n|\n/);
    const offsets: number[] = [];
    let offset = 0;
    for (const line of lines) {
      offsets.push(offset);
      const nextBreak = original.indexOf('\n', offset);
      offset = nextBreak < 0 ? original.length + 1 : nextBreak + 1;
      if (line.includes('\r') && nextBreak > 0) offset = nextBreak + 1;
    }
    const starts = new Map<string, number[]>();
    const ends = new Map<string, number[]>();
    const fences: boolean[] = [];
    let fenced = false;
    const eligible: number[] = [];
    const embeddedStack: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*(```+|~~~+)/.test(line)) { fenced = !fenced; fences[i] = true; continue; }
      fences[i] = fenced;
      if (fenced) continue;
      const marker = line.match(/^\s*<!-- advanced-harness:(project|integrations):(start|end) -->\s*$/);
      if (marker) {
        const [, kind, side] = marker;
        const map = side === 'start' ? starts : ends;
        const list = map.get(kind!) ?? []; list.push(i); map.set(kind!, list);
        if (side === 'start') {
          if (embeddedStack.length) throw new Error('Malformed embedded harness section boundaries; refusing rule promotion.');
          embeddedStack.push(kind!);
        } else if (embeddedStack.pop() !== kind) {
          throw new Error('Malformed embedded harness section boundaries; refusing rule promotion.');
        }
        continue;
      }
      if (/^\s*<!-- advanced-harness:/.test(line)) throw new Error('Malformed embedded harness section boundaries; refusing rule promotion.');
      if (!embeddedStack.length && line.trim() === sectionHeader) eligible.push(i);
    }
    if (fenced) throw new Error('Malformed fenced code block; refusing rule promotion.');
    if (embeddedStack.length) throw new Error('Malformed embedded harness section boundaries; refusing rule promotion.');
    for (const kind of ['project', 'integrations']) {
      if ((starts.get(kind)?.length ?? 0) !== (ends.get(kind)?.length ?? 0) || (starts.get(kind)?.length ?? 0) > 1) {
        throw new Error('Malformed embedded harness section boundaries; refusing rule promotion.');
      }
    }
    if (eligible.length > 1) throw new Error('Ambiguous duplicate Promoted Project Rules headings; refusing rule promotion.');

    const protectedLine = (index: number) => fences[index] || lines[index]!.includes('<!-- advanced-harness:');
    if (eligible.length === 1) {
      const headerIndex = eligible[0]!;
      let boundary = lines.length;
      for (let i = headerIndex + 1; i < lines.length; i++) {
        const embeddedStart = /^\s*<!-- advanced-harness:(?:project|integrations):start -->\s*$/.test(lines[i]!);
        if ((!fences[i] && embeddedStart) || (!protectedLine(i) && /^#{1,2}\s/.test(lines[i]!))) { boundary = i; break; }
      }
      let insertAt = boundary;
      while (insertAt > headerIndex + 1 && !lines[insertAt - 1]!.trim()) insertAt--;
      const insertionOffset = offsets[insertAt] ?? original.length;
      const prefix = original.slice(0, insertionOffset);
      const separator = prefix.length > 0 && !prefix.endsWith('\n') ? eol : '';
      const insertion = `${separator}${newRuleBlock}${eol}`;
      updatedAgentsText = prefix + insertion + original.slice(insertionOffset);
    } else {
      const firstEmbedded = lines.findIndex((line, i) => !fences[i] && /^\s*<!-- advanced-harness:(?:project|integrations):start -->\s*$/.test(line));
      const insertionIndex = firstEmbedded >= 0 ? firstEmbedded : lines.length;
      const insertionOffset = offsets[insertionIndex] ?? original.length;
      const prefix = original.slice(0, insertionOffset);
      const leading = prefix.length === 0 || prefix.endsWith(eol + eol) ? '' : prefix.endsWith(eol) ? eol : eol + eol;
      const trailing = insertionIndex < lines.length ? `${eol}${eol}` : eol;
      const block = `${leading}${sectionHeader}${eol}${newRuleBlock}${trailing}`;
      updatedAgentsText = prefix + block + original.slice(insertionOffset);
    }
  }

  // Verify embedded sections were not damaged
  for (const section of ['project', 'integrations']) {
    const start = `<!-- advanced-harness:${section}:start -->`;
    const end = `<!-- advanced-harness:${section}:end -->`;
    const origStarts = original.split(start).length - 1;
    const updStarts = updatedAgentsText.split(start).length - 1;
    const origEnds = original.split(end).length - 1;
    const updEnds = updatedAgentsText.split(end).length - 1;
    if (origStarts !== updStarts || origEnds !== updEnds) {
      throw new Error(`Rule promotion damaged embedded ${section} section markers.`);
    }
  }

  const diff = computeUnifiedDiff(original, updatedAgentsText, 'AGENTS.md');

  return {
    dispositions: [...options.dispositions],
    promotedCount,
    keptCount,
    discardedCount,
    diff,
    updatedAgentsText,
  };
}

export function applyApprovedRulePromotion(plan: RulePromotionPlan, approved: boolean): string {
  if (approved !== true) {
    throw new Error('Rule promotion requires explicit human approval before updating AGENTS.md.');
  }
  return plan.updatedAgentsText;
}

function computeUnifiedDiff(original: string, modified: string, fileName: string): string {
  if (original === modified) return '';
  const origLines = original.split(/\r?\n/);
  const modLines = modified.split(/\r?\n/);
  const diffLines = [`--- a/${fileName}`, `+++ b/${fileName}`];
  let i = 0, j = 0;
  while (i < origLines.length || j < modLines.length) {
    if (i < origLines.length && j < modLines.length && origLines[i] === modLines[j]) {
      i++;
      j++;
    } else if (j < modLines.length && (i >= origLines.length || !origLines.includes(modLines[j]!))) {
      diffLines.push(`+${modLines[j]}`);
      j++;
    } else if (i < origLines.length && (j >= modLines.length || !modLines.includes(origLines[i]!))) {
      diffLines.push(`-${origLines[i]}`);
      i++;
    } else {
      diffLines.push(`-${origLines[i]}`);
      diffLines.push(`+${modLines[j]}`);
      i++;
      j++;
    }
  }
  return diffLines.join('\n');
}
