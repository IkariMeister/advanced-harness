import test from 'node:test';
import assert from 'node:assert/strict';
import { isGhPrMergeCommand, evaluatePreToolUse } from '../scripts/antigravity-merge-guard.ts';

test('isGhPrMergeCommand accurately detects gh pr merge variants and evasions', () => {
  // Direct calls
  assert.equal(isGhPrMergeCommand('gh pr merge'), true);
  assert.equal(isGhPrMergeCommand('gh pr merge 42'), true);
  assert.equal(isGhPrMergeCommand('gh pr merge 42 --auto --squash'), true);
  assert.equal(isGhPrMergeCommand('gh.exe pr merge 42'), true);
  assert.equal(isGhPrMergeCommand('GH PR MERGE'), true);

  // Flags before or between subcommands
  assert.equal(isGhPrMergeCommand('gh -R owner/repo pr merge 123'), true);
  assert.equal(isGhPrMergeCommand('gh --repo owner/repo pr merge'), true);
  assert.equal(isGhPrMergeCommand('gh pr --repo owner/repo merge 45'), true);

  // Chained commands
  assert.equal(isGhPrMergeCommand('git push origin main && gh pr merge 12'), true);
  assert.equal(isGhPrMergeCommand('echo done; gh pr merge'), true);
  assert.equal(isGhPrMergeCommand('test 1 || gh.exe pr merge'), true);

  // Safe commands that must NOT be detected as merge
  assert.equal(isGhPrMergeCommand('gh pr view 42'), false);
  assert.equal(isGhPrMergeCommand('gh pr create --title "test"'), false);
  assert.equal(isGhPrMergeCommand('gh pr list'), false);
  assert.equal(isGhPrMergeCommand('gh pr diff'), false);
  assert.equal(isGhPrMergeCommand('gh issue view 44'), false);
  assert.equal(isGhPrMergeCommand('git merge feature/branch'), false);
  assert.equal(isGhPrMergeCommand('echo "gh pr merge is cool"'), false);
});

test('evaluatePreToolUse produces correct Antigravity PreToolUse decision', () => {
  // Blocked run_command
  const blocked = evaluatePreToolUse({
    toolCall: {
      name: 'run_command',
      args: {
        CommandLine: 'gh pr merge 123 --squash',
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
