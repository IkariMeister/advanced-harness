import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isGhPrMergeCommand, evaluatePreToolUse } from '../scripts/antigravity-merge-guard.ts';
import { getAntigravityMergeGuardMjsSource } from '../src/antigravity-compiler.ts';
import { makeTempRoot } from './temp-directory.ts';
import { join } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';

test('isGhPrMergeCommand accurately detects gh pr merge variants and evasions', () => {
  // Direct calls
  assert.equal(isGhPrMergeCommand('gh pr merge'), true);
  assert.equal(isGhPrMergeCommand('gh pr merge 42'), true);
  assert.equal(isGhPrMergeCommand('gh pr merge 42 --auto --squash'), true);
  assert.equal(isGhPrMergeCommand('gh.exe pr merge 42'), true);
  assert.equal(isGhPrMergeCommand('GH PR MERGE'), true);

  // Quoted executable and subcommands
  assert.equal(isGhPrMergeCommand('"gh" pr merge 42'), true);
  assert.equal(isGhPrMergeCommand('\'gh\' pr merge 42'), true);
  assert.equal(isGhPrMergeCommand('"gh.exe" pr merge 42'), true);
  assert.equal(isGhPrMergeCommand('"C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 42'), true);
  assert.equal(isGhPrMergeCommand('\'/usr/local/bin/gh\' pr merge 42'), true);
  assert.equal(isGhPrMergeCommand('gh "pr" "merge" 42'), true);
  assert.equal(isGhPrMergeCommand('gh \'pr\' \'merge\' 42'), true);
  assert.equal(isGhPrMergeCommand('"gh" "pr" "merge" 42'), true);

  // PowerShell call operator & and wrappers
  assert.equal(isGhPrMergeCommand('& "gh" pr merge 42'), true);
  assert.equal(isGhPrMergeCommand('& \'C:\\Program Files\\GitHub CLI\\gh.exe\' pr merge 42'), true);
  assert.equal(isGhPrMergeCommand('. "gh" pr merge 42'), true);
  assert.equal(isGhPrMergeCommand('env "gh" pr merge 42'), true);
  assert.equal(isGhPrMergeCommand('command "gh" pr merge 42'), true);
  assert.equal(isGhPrMergeCommand('GH_TOKEN=xyz "gh" pr merge 42'), true);
  assert.equal(isGhPrMergeCommand('(gh pr merge 42)'), true);

  // Flags before or between subcommands
  assert.equal(isGhPrMergeCommand('gh -R owner/repo pr merge 123'), true);
  assert.equal(isGhPrMergeCommand('gh --repo owner/repo pr merge'), true);
  assert.equal(isGhPrMergeCommand('gh pr --repo owner/repo merge 45'), true);
  assert.equal(isGhPrMergeCommand('gh -R "owner/repo" pr merge 123'), true);

  // Chained commands
  assert.equal(isGhPrMergeCommand('git push origin main && gh pr merge 12'), true);
  assert.equal(isGhPrMergeCommand('echo done; gh pr merge'), true);
  assert.equal(isGhPrMergeCommand('test 1 || gh.exe pr merge'), true);
  assert.equal(isGhPrMergeCommand('echo "a && b" && "gh" pr merge 42'), true);

  // Safe commands that must NOT be detected as merge
  assert.equal(isGhPrMergeCommand('gh pr view 42'), false);
  assert.equal(isGhPrMergeCommand('gh pr create --title "test"'), false);
  assert.equal(isGhPrMergeCommand('gh pr list'), false);
  assert.equal(isGhPrMergeCommand('gh pr diff'), false);
  assert.equal(isGhPrMergeCommand('gh issue view 44'), false);
  assert.equal(isGhPrMergeCommand('git merge feature/branch'), false);
  assert.equal(isGhPrMergeCommand('echo "gh pr merge is cool"'), false);
  assert.equal(isGhPrMergeCommand('git commit -m "gh pr merge should not trigger"'), false);
  assert.equal(isGhPrMergeCommand('node -e "console.log(\'gh pr merge\')"'), false);
});

test('evaluatePreToolUse produces correct Antigravity PreToolUse decision', () => {
  // Blocked run_command
  const blocked = evaluatePreToolUse({
    toolCall: {
      name: 'run_command',
      args: {
        CommandLine: '"gh" pr merge 123 --squash',
      },
    },
  });
  assert.equal(blocked.decision, 'deny');
  assert.match(blocked.reason ?? '', /denied by policy/i);

  // Allowed run_command
  const allowed = evaluatePreToolUse({
    toolCall: {
      name: 'run_command',
      args: {
        CommandLine: 'gh pr view 123',
      },
    },
  });
  assert.equal(allowed.decision, 'allow');

  // Other tools
  const otherTool = evaluatePreToolUse({
    toolCall: {
      name: 'read_file',
      args: {
        Path: 'README.md',
      },
    },
  });
  assert.equal(otherTool.decision, 'allow');
});

test('standalone antigravity-merge-guard.mjs runs cleanly via node CLI', () => {
  const tempDir = makeTempRoot('merge-guard-cli-test-');
  const scriptPath = join(tempDir, 'antigravity-merge-guard.mjs');
  writeFileSync(scriptPath, getAntigravityMergeGuardMjsSource());

  try {
    // 1. Test deny execution on stdin
    const denyPayload = {
      toolCall: {
        name: 'run_command',
        args: { CommandLine: '"gh" pr merge 42' },
      },
    };
    const denyRun = spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify(denyPayload),
      encoding: 'utf8',
    });
    assert.equal(denyRun.status, 0);
    const parsedDeny = JSON.parse(denyRun.stdout.trim());
    assert.equal(parsedDeny.decision, 'deny');

    // 2. Test allow execution on stdin
    const allowPayload = {
      toolCall: {
        name: 'run_command',
        args: { CommandLine: 'gh pr view 42' },
      },
    };
    const allowRun = spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify(allowPayload),
      encoding: 'utf8',
    });
    assert.equal(allowRun.status, 0);
    const parsedAllow = JSON.parse(allowRun.stdout.trim());
    assert.equal(parsedAllow.decision, 'allow');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
