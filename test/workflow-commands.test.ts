import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../.opencode/commands/', import.meta.url);
const commands = ['start-issue', 'review-pr', 'report-defect', 'assess-debt', 'grill-me'];

for (const name of commands) {
  test(`${name} has constrained frontmatter and safety rules`, async () => {
    const source = await readFile(new URL(`${name}.md`, root), 'utf8');
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    assert.ok(match, `${name} has frontmatter`);
    const frontmatter = match?.[1];
    assert.ok(frontmatter, `${name} has captured frontmatter`);
    assert.match(frontmatter, /^description: .+$/);
    assert.equal(frontmatter.split(/\r?\n/).length, 1, `${name} only has description metadata`);
    assert.doesNotMatch(frontmatter, /agent|model|subagent|template/i);
    assert.doesNotMatch(source, /```|<\s*shell\b/i, `${name} has no shell blocks`);
    assert.match(source, /arguments?.*(context|authoriz|approval)|arguments.*not/i);
  });
}

test('workflow commands require explicit human disposition at consequential gates', async () => {
  const startIssue = await readFile(new URL('start-issue.md', root), 'utf8');
  assert.match(startIssue, /waits for explicit human approval before implementation/i);
  assert.match(startIssue, /accept\/discard decisions before fixing/i);
  const review = await readFile(new URL('review-pr.md', root), 'utf8');
  assert.match(review, /choose exactly one disposition: Approve, Just Comment, or Request changes/i);
  assert.match(review, /only after explicit approval of concrete feedback and disposition/i);
  const defect = await readFile(new URL('report-defect.md', root), 'utf8');
  assert.match(defect, /wait for explicit human approval before External creates it/i);
  const debt = await readFile(new URL('assess-debt.md', root), 'utf8');
  assert.match(debt, /approve or discard each proposal individually or in an explicitly listed batch/i);
});

test('workflow commands preserve their expected handoff behavior', async () => {
  assert.match(await readFile(new URL('start-issue.md', root), 'utf8'), /Figma[\s\S]*otherwise Stitch[\s\S]*otherwise Jira/i);
  assert.match(await readFile(new URL('start-issue.md', root), 'utf8'), /assigns[\s\S]*worktree[\s\S]*In Progress/i);
  assert.match(await readFile(new URL('start-issue.md', root), 'utf8'), /smoke plan[\s\S]*approval before implementation/i);
  assert.match(await readFile(new URL('review-pr.md', root), 'utf8'), /Approve, Just Comment, or Request changes/);
  assert.match(await readFile(new URL('review-pr.md', root), 'utf8'), /inline on relevant code lines/);
  const defect = await readFile(new URL('report-defect.md', root), 'utf8');
  assert.match(defect, /\$1/);
  assert.match(defect, /\$2/);
  assert.match(defect, /Separately ask whether investigation is authorized/);
  assert.match(await readFile(new URL('assess-debt.md', root), 'utf8'), /Jira, GitHub, or both/);
  const grill = await readFile(new URL('grill-me.md', root), 'utf8');
  assert.match(grill, /one focused question at a time/);
  assert.match(grill, /Do not automatically invoke a command/);
});

test('BH-010: workflow commands enforce interruption handling and inspect-before-retry rules', async () => {
  const startIssue = await readFile(new URL('start-issue.md', root), 'utf8');
  assert.match(startIssue, /On interruption or context loss, preserve existing local and remote state untouched/);
  assert.match(startIssue, /Operator inspects local Git\/worktree and External inspects remote\/service state read-only/);
  assert.match(startIssue, /marks missing approvals unconfirmed, and waits for explicit human confirmation before resuming/);
  assert.match(startIssue, /record verified completion without repeating the write, or report incomplete\/diverged\/inconclusive state and wait for human confirmation before retrying/);

  const review = await readFile(new URL('review-pr.md', root), 'utf8');
  assert.match(review, /On interruption or uncertain posting, preserve existing state untouched and inspect actual PR comments\/reviews read-only/);
  assert.match(review, /record verified posted feedback without duplicating comments/);
  assert.match(review, /wait for explicit human confirmation before retrying/);

  const defect = await readFile(new URL('report-defect.md', root), 'utf8');
  assert.match(defect, /On interruption or uncertain bug creation\/update, preserve existing state and inspect parent and child issues read-only/);
  assert.match(defect, /record verified created issues without duplicating tickets/);
  assert.match(defect, /wait for explicit human confirmation before retrying/);

  const debt = await readFile(new URL('assess-debt.md', root), 'utf8');
  assert.match(debt, /On interruption or uncertain issue creation, preserve existing state and inspect destination issues read-only/);
  assert.match(debt, /record verified created issues without duplicating tickets/);
  assert.match(debt, /wait for explicit human confirmation before retrying/);

  const grill = await readFile(new URL('grill-me.md', root), 'utf8');
  assert.match(grill, /On interruption or lost context, summarize clarified answers and ask before resuming/);
});
