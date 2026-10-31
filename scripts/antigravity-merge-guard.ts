#!/usr/bin/env node

/**
 * Antigravity PreToolUse Lifecycle Hook: gh pr merge and destructive Git guard
 *
 * Reads PreToolUse JSON payload from stdin.
 * If the tool is `run_command` and attempts `gh pr merge` (or `gh.exe pr merge`),
 * `git reset --hard`, `git clean`, or a force push,
 * responds with a hard DENY decision.
 * Otherwise responds with ALLOW.
 */

import { readFileSync } from 'node:fs';
import { isDestructiveGitInvocation } from '../src/security-guardrails.ts';

export interface PreToolUsePayload {
  toolCall?: {
    name?: string;
    args?: {
      CommandLine?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PreToolUseDecision {
  decision: 'allow' | 'deny' | 'ask' | 'force_ask';
  reason?: string;
}

/**
 * Splits a command line into top-level command segments separated by
 * unquoted ;, |, &&, ||, or newlines.
 */
export function splitCommandSegments(commandLine: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i]!;

    if (ch === '\'' && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '\n' || ch === '\r' || ch === ';') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        continue;
      }
      if (ch === '&' && commandLine[i + 1] === '&') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        i++; // skip next &
        continue;
      }
      if (ch === '|' && commandLine[i + 1] === '|') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        i++; // skip next |
        continue;
      }
      if (ch === '|') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

/**
 * Tokenizes a command segment into word tokens, respecting single and double quotes.
 * Strips outer quotes while preserving literal content.
 */
export function tokenizeCommand(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let tokenHasContent = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;

    if (ch === '\'' && !inDouble) {
      inSingle = !inSingle;
      tokenHasContent = true;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      tokenHasContent = true;
      continue;
    }

    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (tokenHasContent || current.length > 0) {
        tokens.push(current);
        current = '';
        tokenHasContent = false;
      }
      continue;
    }

    // Inside single quotes: literal
    // Inside double quotes: backslash escape for " or \
    if (inDouble && ch === '\\' && i + 1 < segment.length) {
      const next = segment[i + 1];
      if (next === '"' || next === '\\') {
        current += next;
        i++;
        tokenHasContent = true;
        continue;
      }
    }

    // Outside quotes: backslash escape for whitespace/quotes
    if (!inSingle && !inDouble && ch === '\\' && i + 1 < segment.length) {
      const next = segment[i + 1];
      if (/\s|['"]/.test(next!)) {
        current += next;
        i++;
        tokenHasContent = true;
        continue;
      }
    }

    current += ch;
    tokenHasContent = true;
  }

  if (tokenHasContent || current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function isGhExecutable(token: string): boolean {
  const normalized = token.toLowerCase().replace(/\\/g, '/');
  const base = normalized.split('/').pop() ?? '';
  return base === 'gh' || base === 'gh.exe';
}

/**
 * Returns each command segment's tokens starting at the executable, after stripping
 * grouping parens and leading shell prefixes/wrappers:
 * - PowerShell call operator & or .
 * - Environment variable assignments like KEY=VAL
 * - Wrappers like env, command, nohup, exec
 */
export function commandInvocations(commandLine: string): string[][] {
  const invocations: string[][] = [];
  for (const segment of splitCommandSegments(commandLine)) {
    let tokens = tokenizeCommand(segment);
    if (!tokens.length) continue;

    // Handle leading subshell / grouping parens if any
    if (tokens[0]!.startsWith('(')) {
      tokens[0] = tokens[0]!.slice(1);
      if (!tokens[0]) tokens.shift();
    }
    if (tokens.length && tokens[tokens.length - 1]!.endsWith(')')) {
      tokens[tokens.length - 1] = tokens[tokens.length - 1]!.slice(0, -1);
      if (!tokens[tokens.length - 1]) tokens.pop();
    }

    let startIdx = 0;
    while (startIdx < tokens.length) {
      const t = tokens[startIdx]!;
      if (t === '&' || t === '.' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || ['env', 'command', 'nohup', 'exec'].includes(t.toLowerCase())) {
        startIdx++;
        continue;
      }
      break;
    }

    if (startIdx < tokens.length) invocations.push(tokens.slice(startIdx));
  }
  return invocations;
}

/** True when any segment directly runs git reset --hard, git clean, or a force push. */
export function isDestructiveGitCommand(commandLine: string): boolean {
  if (!commandLine || typeof commandLine !== 'string') return false;
  return commandInvocations(commandLine).some(isDestructiveGitInvocation);
}

export function isGhPrMergeCommand(commandLine: string): boolean {
  if (!commandLine || typeof commandLine !== 'string') {
    return false;
  }

  for (const tokens of commandInvocations(commandLine)) {
    const startIdx = 0;

    const exeToken = tokens[startIdx]!;
    if (!isGhExecutable(exeToken)) {
      continue;
    }

    // Inspect positional verbs after gh
    const verbs: string[] = [];
    let skipNext = false;

    for (let i = startIdx + 1; i < tokens.length; i++) {
      const tok = tokens[i]!;

      if (skipNext) {
        skipNext = false;
        continue;
      }

      // Flags with separate value
      if (['-R', '--repo', '-h', '--hostname'].includes(tok)) {
        skipNext = true;
        continue;
      }

      // Option with = (e.g. --repo=owner/repo)
      if (tok.startsWith('-')) {
        continue;
      }

      verbs.push(tok.toLowerCase());
    }

    if (verbs.length >= 2 && verbs[0] === 'pr' && verbs[1] === 'merge') {
      return true;
    }
  }

  return false;
}

export function evaluatePreToolUse(payload: PreToolUsePayload): PreToolUseDecision {
  const toolName = payload?.toolCall?.name;
  const cmd = payload?.toolCall?.args?.CommandLine;

  if (toolName === 'run_command' && typeof cmd === 'string') {
    if (isGhPrMergeCommand(cmd)) {
      return {
        decision: 'deny',
        reason: 'Direct merge via "gh pr merge" is denied by policy. A human must merge on GitHub.',
      };
    }
    if (isDestructiveGitCommand(cmd)) {
      return {
        decision: 'deny',
        reason: 'Destructive Git (reset --hard, clean, force push) is denied by policy. A human must run it.',
      };
    }
  }

  return { decision: 'allow' };
}

// CLI execution when run directly
if (process.argv[1] && (process.argv[1].endsWith('antigravity-merge-guard.ts') || process.argv[1].endsWith('antigravity-merge-guard.js') || process.argv[1].endsWith('antigravity-merge-guard.mjs'))) {
  try {
    const input = readFileSync(0, 'utf8');
    const payload = JSON.parse(input) as PreToolUsePayload;
    const result = evaluatePreToolUse(payload);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    // If input is empty or invalid JSON, safely allow
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  }
}
