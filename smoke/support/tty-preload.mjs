// Smoke-test only: lets the real harness:* scripts pass their interactive-terminal
// guard while answers arrive over a pipe. This is NOT interactive TTY QA; see
// docs/smoke-test-plan.md. Never load this outside the smoke sandbox.
for (const stream of [process.stdin, process.stdout]) {
  Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
}
