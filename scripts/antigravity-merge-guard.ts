#!/usr/bin/env node

/**
 * Antigravity PreToolUse Lifecycle Hook: gh pr merge guard
 *
 * Reads PreToolUse JSON payload from stdin.
 * If the tool is `run_command` and attempts `gh pr merge` (or `gh.exe pr merge`),
 * responds with a hard DENY decision.
 * Otherwise responds with ALLOW.
 */

import { readFileSync } from 'node:fs';

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

export function isGhPrMergeCommand(commandLine: string): boolean {
  if (!commandLine || typeof commandLine !== 'string') {
    return false;
  }

  // Tokenize commands split by &&, ||, ;, |, newline
  const subCommands = commandLine.split(/(?:&&|\|\||[;\n|])/);

  for (const rawSub of subCommands) {
    const sub = rawSub.trim();
    if (!sub) continue;

    // Split words by whitespace
    const tokens = sub.split(/\s+/);
    let ghIdx = -1;

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]?.toLowerCase();
      if (t === 'gh' || t === 'gh.exe' || t?.endsWith('/gh') || t?.endsWith('\\gh') || t?.endsWith('/gh.exe') || t?.endsWith('\\gh.exe')) {
        ghIdx = i;
        break;
      }
    }

    if (ghIdx === -1) continue;

    // Look for positional verbs after gh
    const verbs: string[] = [];
    let skipNext = false;

    for (let i = ghIdx + 1; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok) continue;

      if (skipNext) {
        skipNext = false;
        continue;
      }

      // If token is a flag with value like -R owner/repo or --repo owner/repo
      if (tok === '-R' || tok === '--repo' || tok === '-h' || tok === '--hostname') {
        skipNext = true;
        continue;
      }

      // If token is an option with '=' like --repo=owner/repo
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
