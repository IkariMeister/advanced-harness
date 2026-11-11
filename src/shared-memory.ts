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

export type RuleDispositionType = 'promote' | 'keep-memory' | 'discard' | 'personal';

export type PruningKind = 'redundant' | 'contradicted' | 'obsolete';

export type PruningCandidate = {
  entry: MemoryEntry;
  kind: PruningKind;
  reason: string;
  evidence: string;
};

export type PruningDispositionType = 'promote' | 'personal' | 'keep' | 'discard';

export type PruningDisposition = {
  entry: MemoryEntry;
  disposition: PruningDispositionType;
  targetRuleText?: string;
};

export type MemoryPruningPlan = {
  candidates: PruningCandidate[];
  dispositions: PruningDisposition[];
  updatedMemoryEntries: MemoryEntry[];
  promotedToAgents: string[];
  promotedToPersonal: string[];
  keptCount: number;
  discardedCount: number;
  updatedAgentsText?: string | undefined;
  agentsDiff?: string | undefined;
};

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
  personalCount: number;
  diff: string;
  updatedAgentsText: string;
  personalRulesToAdd: string[];
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

export function validatePromotedRuleText(ruleText: string): void {
  const text = ruleText.trim();
  if (!text) throw new Error('Promoted rule cannot be empty.');
  if (/[\r\n]/.test(text)) throw new Error('Promoted rule must not contain raw newlines.');
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error('Promoted rule contains potential secret/token patterns. Rejecting promotion.');
    }
  }
  for (const pattern of LOCAL_PATH_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error('Promoted rule contains machine-local worktree or operational paths. Rejecting promotion into AGENTS.md.');
    }
  }
  if (/(?:^|[^\w])(?:[a-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+|\\\\[^\\]+\\[^\\]+|\/(?:Users|home)\/[^/\s]+)(?:[\\/]|[\s.,;:!?)]|$)/i.test(text)) {
    throw new Error('Promoted rule contains machine-local worktree or operational paths. Rejecting promotion into AGENTS.md.');
  }
  if (text.length > 2000) {
    throw new Error('Promoted rule exceeds maximum length (2000 characters).');
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
  let personalCount = 0;
  const promotedRules: string[] = [];
  const personalRulesToAdd: string[] = [];

  for (const disp of options.dispositions) {
    validateMemoryEntry(disp.entry);

    if (disp.type === 'promote') {
      const ruleText = (disp.targetRuleText ?? disp.entry.fact).trim();
      validatePromotedRuleText(ruleText);
      promotedRules.push(`- ${ruleText}`);
      promotedCount++;
    } else if (disp.type === 'personal') {
      const ruleText = (disp.targetRuleText ?? disp.entry.fact).trim();
      validatePersonalRuleText(ruleText);
      personalRulesToAdd.push(ruleText);
      personalCount++;
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
    personalCount,
    diff,
    updatedAgentsText,
    personalRulesToAdd,
  };
}

export function resolvePersonalRulesPath(memoryPath: string): string {
  const resolved = resolve(memoryPath);
  return join(dirname(resolved), 'AGENTS.personal.md');
}

export function parsePersonalRules(text: string): string[] {
  const lines = text.split(/\r\n|\n/);
  if (lines[0]?.startsWith('\uFEFF')) lines[0] = lines[0].slice(1);
  const rules: string[] = [];
  let headerSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.includes('\r')) throw new Error(`Unsupported AGENTS.personal.md content on line ${i + 1}.`);
    if (!line.trim()) continue;
    if (line.trim() === '# Personal Project Rules' && !headerSeen && rules.length === 0) {
      headerSeen = true;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('-')) {
      const rule = trimmed.replace(/^-\s*/, '').trim();
      if (!rule) throw new Error(`Invalid AGENTS.personal.md rule on line ${i + 1}.`);
      validatePersonalRuleText(rule);
      rules.push(rule);
      continue;
    }
    throw new Error(`Unsupported AGENTS.personal.md content on line ${i + 1}.`);
  }
  return rules;
}

export function validatePersonalRuleText(ruleText: string): void {
  const text = ruleText.trim();
  if (!text) throw new Error('Personal rule cannot be empty.');
  if (/[\r\n]/.test(text)) throw new Error('Personal rule must not contain raw newlines.');
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error('Personal rule contains potential secret or credential tokens. Rejecting rule.');
    }
  }
  for (const pattern of LOCAL_PATH_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error('Personal rule contains machine-local worktree or operational paths. Rejecting rule.');
    }
  }
  if (/(?:^|[^\w])(?:[a-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+|\\\\[^\\]+\\[^\\]+|\/(?:Users|home)\/[^/\s]+)(?:[\\/]|[\s.,;:!?)]|$)/i.test(text)) {
    throw new Error('Personal rule contains machine-local worktree or operational paths. Rejecting rule.');
  }
  if (text.length > 2000) {
    throw new Error('Personal rule exceeds maximum length (2000 characters).');
  }
}

export function formatPersonalRules(rules: readonly string[]): string {
  const lines = ['# Personal Project Rules', ''];
  for (const rule of rules) {
    validatePersonalRuleText(rule);
    lines.push(`- ${rule.trim()}`);
  }
  return lines.join('\n') + '\n';
}

export function readPersonalRules(personalRulesPath: string): {
  exists: boolean;
  rules: string[];
  raw: string;
  hash: string;
} {
  const target = resolve(personalRulesPath);
  if (!existsSync(target)) {
    return {
      exists: false,
      rules: [],
      raw: '',
      hash: createHash('sha256').update('').digest('hex'),
    };
  }

  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Personal rules path must be a regular file, not a symlink or directory.');
  }
  if (stat.size > 1024 * 1024) {
    throw new Error('Personal rules file exceeds 1 MiB size limit.');
  }

  const raw = readFileSync(target, 'utf8');
  const hash = createHash('sha256').update(raw).digest('hex');
  const rules = parsePersonalRules(raw);

  return {
    exists: true,
    rules,
    raw,
    hash,
  };
}

export function writePersonalRulesSerialized(
  personalRulesPath: string,
  rules: readonly string[],
  baselineHash: string | undefined
): { success: boolean; hash: string } {
  const target = resolve(personalRulesPath);
  const parent = dirname(target);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const lockPath = `${target}.lock`;
  let lockFd: number;
  try { lockFd = openSync(lockPath, 'wx'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Concurrent modification detected on AGENTS.personal.md. Another writer holds the lock.');
    throw err;
  }
  const tempPath = join(parent, `.AGENTS.personal.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    const current = readPersonalRules(target);
    if (baselineHash !== undefined && current.hash !== baselineHash) {
      throw new Error('Concurrent modification detected on AGENTS.personal.md. Baseline hash does not match current file on disk.');
    }
    const deduplicated: string[] = [];
    const seen = new Set<string>();
    for (const r of rules) {
      validatePersonalRuleText(r);
      const key = normalizeKey(r);
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(r.trim());
      }
    }
    const formatted = formatPersonalRules(deduplicated);
    if (Buffer.byteLength(formatted, 'utf8') > 1024 * 1024) {
      throw new Error('Personal rules file exceeds 1 MiB size limit.');
    }
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

export function detectPersonalRuleContradictions(
  personalRules: readonly string[],
  agentsText: string
): { rule: string; contradictionReason: string }[] {
  const contradictions: { rule: string; contradictionReason: string }[] = [];
  const normalizedAgents = agentsText.toLowerCase();

  for (const rule of personalRules) {
    validatePersonalRuleText(rule);
    const normRule = normalizeKey(rule);

    if (/never\s+merge|merging\s+remains\s+human-only/i.test(agentsText) && /auto[_-]?merge|merges?\s+automatically/i.test(rule)) {
      // Split into clauses (by semicolon, comma, or sentence endings) and check the clause(s) mentioning auto-merge
      const clauses = rule.split(/[;,.\n]+/);
      let permitsAutoMerge = false;
      for (const clause of clauses) {
        if (/auto[_-]?merge|merges?\s+automatically/i.test(clause)) {
          const isNegated = /\b(?:never|not?|don't|must not|cannot|should not|no)\b.*?\b(?:auto[_-]?merge|merges?\s+automatically)\b/i.test(clause);
          if (!isNegated) {
            permitsAutoMerge = true;
            break;
          }
        }
      }
      if (permitsAutoMerge) {
        contradictions.push({
          rule,
          contradictionReason: 'Personal rule permits automatic merging, but AGENTS.md specifies merging remains human-only.',
        });
      }
    } else if (normRule.includes('always') || normRule.includes('never') || normRule.includes('do not') || normRule.includes('must not')) {
      // General conflict check if opposite terms appear in agents
      const positive = normRule.replace(/\b(never|do not|don't|must not)\b/g, '').trim();
      if (/never|do not|don't|must not/.test(normRule)) {
        // rule says don't X, does AGENTS say always X?
        if (positive && normalizedAgents.includes(`always ${positive}`)) {
          contradictions.push({
            rule,
            contradictionReason: `Personal rule forbids "${positive}", but AGENTS.md specifies to always do so.`,
          });
        }
      } else if (normRule.includes('always')) {
        const action = normRule.replace(/\balways\b/g, '').trim();
        if (action && (normalizedAgents.includes(`never ${action}`) || normalizedAgents.includes(`do not ${action}`))) {
          contradictions.push({
            rule,
            contradictionReason: `Personal rule specifies to always "${action}", but AGENTS.md forbids it.`,
          });
        }
      }
    }
  }

  return contradictions;
}

export type TriStateResult = 'exists' | 'missing' | 'unknown';

export type PruningExternalChecker = {
  checkIssueExists?: (issueRef: string) => TriStateResult | { status: TriStateResult; evidence: string };
  checkBranchExists?: (branchRef: string) => TriStateResult | { status: TriStateResult; evidence: string };
  checkFileExists?: (filePath: string, rootDir?: string) => TriStateResult | { status: TriStateResult; evidence: string };
  taskWorktreeRoot?: string;
};

export function memoryEntryIdentityKey(entry: MemoryEntry): string {
  return `${normalizeKey(entry.source)}|${normalizeKey(entry.scope)}|${normalizeKey(entry.confirmation)}|${normalizeKey(entry.fact)}`;
}

export function detectPruningCandidates(options: {
  memoryEntries: readonly MemoryEntry[];
  agentsText?: string | undefined;
  personalRules?: readonly string[] | undefined;
  externalChecker?: PruningExternalChecker | undefined;
}): PruningCandidate[] {
  const candidates: PruningCandidate[] = [];
  const rawAgents = options.agentsText ?? '';
  const agentsNorm = rawAgents ? normalizeKey(rawAgents) : '';
  const personalNorm = (options.personalRules ?? [])
    .map((r) => normalizeKey(r))
    .filter((r) => r.length > 0);

  for (let idx = 0; idx < options.memoryEntries.length; idx++) {
    const entry = options.memoryEntries[idx]!;
    validateMemoryEntry(entry);

    const factNorm = normalizeKey(entry.fact);
    if (!factNorm) continue;

    // 1. Check for Redundancy with AGENTS.md or personal rules
    // Require factNorm to be substantial (>= 15 chars or exact whole line/sentence match) to avoid false positives like "node"
    if (agentsNorm && factNorm.length >= 10 && agentsNorm.includes(factNorm)) {
      const evidenceKey = 'agents-rule';
      if (!isAlreadyReviewed(entry, 'redundant', evidenceKey)) {
        candidates.push({
          entry,
          kind: 'redundant',
          reason: 'Covered by an existing rule in AGENTS.md.',
          evidence: 'Fact text is directly contained within AGENTS.md rules.',
        });
        continue;
      }
    }

    const matchedPersonal = personalNorm.find((p) => p.length >= 5 && (p === factNorm || p.includes(factNorm)));
    if (matchedPersonal) {
      const evidenceKey = 'personal-rule';
      if (!isAlreadyReviewed(entry, 'redundant', evidenceKey)) {
        candidates.push({
          entry,
          kind: 'redundant',
          reason: 'Covered by a personal rule in AGENTS.personal.md.',
          evidence: `Matches personal rule: "${matchedPersonal}".`,
        });
        continue;
      }
    }

    // 2. Check for Contradicted or Superseded
    // Contradicted by AGENTS.md instructions
    if (rawAgents) {
      if (/never\s+merge|merging\s+remains\s+human-only/i.test(rawAgents) && /auto[_-]?merge|merges?\s+automatically/i.test(entry.fact)) {
        const isNegated = /\b(?:never|not?|don't|must not|cannot|should not|no)\b.*?\b(?:auto[_-]?merge|merges?\s+automatically)\b/i.test(entry.fact);
        if (!isNegated) {
          const evidenceKey = 'agents-merging';
          if (!isAlreadyReviewed(entry, 'contradicted', evidenceKey)) {
            candidates.push({
              entry,
              kind: 'contradicted',
              reason: 'Contradicted by AGENTS.md instruction (merging is human-only).',
              evidence: 'AGENTS.md mandates merging remains human-only while entry describes auto-merge.',
            });
            continue;
          }
        }
      }
    }

    // Contradicted or superseded by a newer entry in MEMORY.md
    // Limit supersession to explicit marker or shared subject / topic rather than differing text in same scope
    let supersededOrContradictedByNewer = false;
    for (let j = idx + 1; j < options.memoryEntries.length; j++) {
      const newer = options.memoryEntries[j]!;
      if (normalizeKey(newer.scope) === normalizeKey(entry.scope)) {
        const hasExplicitReplacement = /replaces|replacement|updated|supersedes/i.test(newer.confirmation);
        const sharesTopic = sharesSubjectTopic(entry.fact, newer.fact);
        if (hasExplicitReplacement || (sharesTopic && normalizeKey(newer.fact) !== factNorm)) {
          const evidenceKey = `newer-entry:${normalizeKey(newer.fact)}`;
          if (!isAlreadyReviewed(entry, 'contradicted', evidenceKey)) {
            candidates.push({
              entry,
              kind: 'contradicted',
              reason: `Contradicted or superseded by newer memory entry in scope "${entry.scope}".`,
              evidence: `Newer entry: [Source: ${newer.source}; scope: ${newer.scope}; confirmation: ${newer.confirmation}] ${newer.fact}`,
            });
            supersededOrContradictedByNewer = true;
            break;
          }
        }
      }
    }
    if (supersededOrContradictedByNewer) continue;

    // 3. Check for Obsolete (refers to an issue, branch or file that no longer exists)
    if (options.externalChecker) {
      // Check for issue reference, anchored to issue tokens like #123, issue 123, issue #123
      const issueMatch = entry.fact.match(/\b(?:issue\s+#?|issues\/|#)(\d+)\b/i);
      if (issueMatch && options.externalChecker.checkIssueExists) {
        const issueRef = issueMatch[1]!;
        const res = options.externalChecker.checkIssueExists(issueRef);
        const status = typeof res === 'string' ? res : res.status;
        const evidence = typeof res === 'string' ? `Issue #${issueRef} does not exist in tracker.` : res.evidence;
        if (status === 'missing') {
          const evidenceKey = `issue:${issueRef}`;
          if (!isAlreadyReviewed(entry, 'obsolete', evidenceKey)) {
            candidates.push({
              entry,
              kind: 'obsolete',
              reason: `Refers to issue #${issueRef} that no longer exists.`,
              evidence,
            });
            continue;
          }
        }
      }

      // Check for branch reference, anchored to branch tokens
      const branchMatch = entry.fact.match(/\b(?:branch\s+[`']?|refs\/heads\/)([a-zA-Z0-9_\-./]+)(?:[`'\s]|$)/i);
      if (branchMatch && options.externalChecker.checkBranchExists) {
        const branchRef = branchMatch[1]!.replace(/[`']/g, '').trim();
        // Avoid matching plain english words like "protection"
        if (branchRef && !/^(?:protection|name|names|policy|policies|rules?)$/i.test(branchRef)) {
          const res = options.externalChecker.checkBranchExists(branchRef);
          const status = typeof res === 'string' ? res : res.status;
          const evidence = typeof res === 'string' ? `Branch "${branchRef}" does not exist.` : res.evidence;
          if (status === 'missing') {
            const evidenceKey = `branch:${branchRef}`;
            if (!isAlreadyReviewed(entry, 'obsolete', evidenceKey)) {
              candidates.push({
                entry,
                kind: 'obsolete',
                reason: `Refers to branch "${branchRef}" that no longer exists.`,
                evidence,
              });
              continue;
            }
          }
        }
      }

      // Check for file reference, anchored to file tokens
      const fileMatch = entry.fact.match(/\b(?:file\s+[`']?|path\s+[`']?)([\w./\\-]+\.[a-zA-Z0-9]+)[`']?/i);
      if (fileMatch && options.externalChecker.checkFileExists) {
        const fileRef = fileMatch[1]!.trim();
        const rootDir = options.externalChecker.taskWorktreeRoot;
        const res = options.externalChecker.checkFileExists(fileRef, rootDir);
        const status = typeof res === 'string' ? res : res.status;
        const evidence = typeof res === 'string' ? `File "${fileRef}" does not exist.` : res.evidence;
        if (status === 'missing') {
          const evidenceKey = `file:${fileRef}`;
          if (!isAlreadyReviewed(entry, 'obsolete', evidenceKey)) {
            candidates.push({
              entry,
              kind: 'obsolete',
              reason: `Refers to file "${fileRef}" that no longer exists.`,
              evidence,
            });
            continue;
          }
        }
      }
    }
  }

  return candidates;
}

function sharesSubjectTopic(fact1: string, fact2: string): boolean {
  const words1 = normalizeKey(fact1).split(/\s+/).filter((w) => w.length > 3);
  const words2 = new Set(normalizeKey(fact2).split(/\s+/).filter((w) => w.length > 3));
  let common = 0;
  for (const w of words1) {
    if (words2.has(w)) common++;
  }
  return common >= 2;
}

function isAlreadyReviewed(entry: MemoryEntry, kind: PruningKind, evidenceKey: string): boolean {
  const normConf = normalizeKey(entry.confirmation);
  const specificTag = `reviewed-keep:${kind}:${normalizeKey(evidenceKey)}`;
  return normConf.includes(specificTag);
}

export function markEntryReviewed(entry: MemoryEntry, candidate: PruningCandidate): MemoryEntry {
  const evidenceKey = normalizeKey(candidate.evidence.replace(/[^a-zA-Z0-9_\-.:]/g, '-')).slice(0, 50);
  const tag = `reviewed-keep:${candidate.kind}:${evidenceKey}`;
  const confirmation = entry.confirmation.includes(tag) ? entry.confirmation : `${entry.confirmation} (${tag})`;
  return {
    ...entry,
    confirmation,
  };
}

export function planMemoryPruning(options: {
  memoryEntries: readonly MemoryEntry[];
  candidates: readonly PruningCandidate[];
  dispositions: readonly PruningDisposition[];
  agentsText?: string | undefined;
}): MemoryPruningPlan {
  // Validate candidate set and disposition keys
  const candidateKeys = new Set(options.candidates.map((c) => memoryEntryIdentityKey(c.entry)));
  const candidateMap = new Map<string, PruningCandidate>();
  for (const c of options.candidates) {
    candidateMap.set(memoryEntryIdentityKey(c.entry), c);
  }

  const seenDispositions = new Set<string>();
  const dispMap = new Map<string, PruningDisposition>();
  const validDispositions = new Set<PruningDispositionType>(['promote', 'personal', 'keep', 'discard']);

  for (const d of options.dispositions) {
    if (!validDispositions.has(d.disposition)) {
      throw new Error(`Unknown disposition type: "${d.disposition}".`);
    }
    const key = memoryEntryIdentityKey(d.entry);
    if (!candidateKeys.has(key)) {
      throw new Error(`Disposition provided for an entry that is not a recognized pruning candidate: "${d.entry.fact}".`);
    }
    if (seenDispositions.has(key)) {
      throw new Error(`Duplicate disposition provided for candidate: "${d.entry.fact}".`);
    }
    seenDispositions.add(key);
    dispMap.set(key, d);
  }

  const updatedMemory: MemoryEntry[] = [];
  const promotedToAgents: string[] = [];
  const promotedToPersonal: string[] = [];
  let keptCount = 0;
  let discardedCount = 0;

  for (const entry of options.memoryEntries) {
    validateMemoryEntry(entry);
    const key = memoryEntryIdentityKey(entry);
    const disp = dispMap.get(key);

    if (!disp) {
      // Not part of disposition, remains unchanged and preserved exactly without side-effect dedupe
      updatedMemory.push(entry);
      continue;
    }

    if (disp.disposition === 'promote') {
      if (options.agentsText === undefined) {
        throw new Error('Promotion disposition requires agentsText destination to be provided.');
      }
      const ruleText = (disp.targetRuleText ?? entry.fact).trim();
      validatePromotedRuleText(ruleText);
      promotedToAgents.push(ruleText);
      // Leaves MEMORY.md upon promotion
    } else if (disp.disposition === 'personal') {
      const ruleText = (disp.targetRuleText ?? entry.fact).trim();
      validatePersonalRuleText(ruleText);
      promotedToPersonal.push(ruleText);
      // Leaves MEMORY.md upon personal promotion
    } else if (disp.disposition === 'discard') {
      discardedCount++;
      // Leaves MEMORY.md upon discard
    } else if (disp.disposition === 'keep') {
      keptCount++;
      // Kept entry is marked as reviewed for this candidate's specific kind and evidence key
      const candidate = candidateMap.get(key);
      const reviewed = candidate ? markEntryReviewed(entry, candidate) : entry;
      updatedMemory.push(reviewed);
    }
  }

  let updatedAgentsText: string | undefined;
  let agentsDiff: string | undefined;

  if (promotedToAgents.length > 0 && options.agentsText !== undefined) {
    const promotionDispositions: RuleDisposition[] = promotedToAgents.map((ruleText) => ({
      type: 'promote',
      entry: { source: 'Pruning', scope: 'Project', confirmation: 'approved', fact: ruleText },
      targetRuleText: ruleText,
    }));
    const promoPlan = planRulePromotion({
      memoryEntries: options.memoryEntries,
      agentsText: options.agentsText,
      dispositions: promotionDispositions,
    });
    updatedAgentsText = promoPlan.updatedAgentsText;
    agentsDiff = promoPlan.diff;
  }

  return {
    candidates: [...options.candidates],
    dispositions: [...options.dispositions],
    updatedMemoryEntries: updatedMemory,
    promotedToAgents,
    promotedToPersonal,
    keptCount,
    discardedCount,
    updatedAgentsText,
    agentsDiff,
  };
}

export function applyApprovedMemoryPruning(options: {
  plan: MemoryPruningPlan;
  approved: boolean;
  memoryPath: string;
  projectRoot?: string | undefined;
  memoryBaselineHash?: string | undefined;
  personalBaselineHash?: string | undefined;
}): { success: boolean; memoryHash: string; personalHash?: string | undefined; updatedAgentsText?: string | undefined } {
  if (options.approved !== true) {
    throw new Error('Memory pruning requires explicit human approval before executing any writes.');
  }

  const { plan, memoryPath } = options;
  const personalPath = resolvePersonalRulesPath(memoryPath);

  // 1. If personal rules are being added, atomically append to AGENTS.personal.md first
  let personalHash: string | undefined;
  if (plan.promotedToPersonal.length > 0) {
    const existingPersonal = readPersonalRules(personalPath);
    const combinedRules = [...existingPersonal.rules, ...plan.promotedToPersonal];
    const res = writePersonalRulesSerialized(personalPath, combinedRules, options.personalBaselineHash ?? existingPersonal.hash);
    personalHash = res.hash;
  }

  // 2. Update MEMORY.md
  const memRes = writeSharedMemorySerialized(memoryPath, plan.updatedMemoryEntries, options.memoryBaselineHash);

  return {
    success: true,
    memoryHash: memRes.hash,
    personalHash,
    updatedAgentsText: plan.updatedAgentsText,
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
