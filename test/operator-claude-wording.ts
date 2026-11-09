/**
 * #200 / ADR-005: the Claude Code advisory and fallback paragraphs in agents/operator.md.
 * Single shared source for the tests that pin them. The line arrays are the exact wrapped lines of
 * operator.md (the role-definitions fixture compares whole strings), and the joined text is what
 * whitespace-normalized checks compare against. Change operator.md and this module together.
 */
export const operatorAdvisoryLines: readonly string[] = [
  'Some hosts cannot enforce your shell denies per role (on Claude Code, see ADR-005). `git push`,',
  '`git pull`, `git clone`, and `gh` remain forbidden to you there even though no rule blocks them;',
  'send that work to External through Lead. A permission prompt that would let such a command run',
  'does not authorize it.',
];

export const operatorFallbackLines: readonly string[] = [
  'If your shell tool is not offered, or an authorized worktree command is denied or its prompt is',
  'declined, create nothing, report the exact tool response to Lead, and stop; do not ask another role',
  'to run local Git for you.',
];

/** Whitespace-normalized advisory paragraph, for comparison with normalized operator.md text. */
export const operatorAdvisoryText: string = operatorAdvisoryLines.join(' ');

/** Whitespace-normalized fallback paragraph, for comparison with normalized operator.md text. */
export const operatorFallbackText: string = operatorFallbackLines.join(' ');
