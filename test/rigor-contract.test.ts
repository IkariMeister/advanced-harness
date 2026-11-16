import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileWorkflowArtifacts } from '../src/workflow-commands.ts';

test('Reviewer has the single complete rigor-floor and diff-risk mapping contract', () => {
  const reviewer = readFileSync(new URL('../agents/reviewer.md', import.meta.url), 'utf8');
  const rows = [
    { rigor: 'absent', expected: ['Low', 'Medium', 'High'] },
    { rigor: 'minimal', expected: ['Low', 'Medium', 'High'] },
    { rigor: 'standard', expected: ['Medium', 'Medium', 'High'] },
    { rigor: 'strict', expected: ['High', 'High', 'High'] },
  ];
  const risk = ['Low', 'Medium', 'High'];
  for (const row of rows) {
    for (const [index, riskTier] of risk.entries()) {
      const floor = row.expected[index]!;
      const markdownRigor = row.rigor === 'absent' || row.rigor === 'minimal' ? 'Absent or `minimal`' : `\`${row.rigor}\``;
      const markdownRow = `| ${markdownRigor} | ${row.expected.join(' | ')} |`;
      assert.ok(reviewer.includes(markdownRow), `missing mapping row ${markdownRow}`);
      const rank = { Low: 0, Medium: 1, High: 2 };
      assert.ok(rank[floor as keyof typeof rank] >= rank[riskTier as keyof typeof rank], `floor lowers ${row.rigor}/${riskTier}`);
    }
  }
  assert.match(reviewer, /Apply the higher of the diff-risk tier and the rigor floor/);
  assert.match(reviewer, /Reviewer may raise the tier/);
  const commands = fileURLToPath(new URL('../commands/', import.meta.url));
  const compiled = compileWorkflowArtifacts(commands, ['opencode']);
  for (const id of ['review-pr', 'address-pr-feedback'] as const) {
    const artifact = compiled.artifacts.find(item => item.command === id);
    assert.ok(artifact);
    assert.equal(artifact.relativePath, `.opencode/commands/${id}.md`);
    for (const row of rows) assert.ok(artifact.content.includes(`| ${row.rigor === 'absent' || row.rigor === 'minimal' ? 'Absent or `minimal`' : `\`${row.rigor}\``} | ${row.expected.join(' | ')} |`));
  }
});
