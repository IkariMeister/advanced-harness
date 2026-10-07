import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roles } from '../src/protocol.ts';

// No global configuration or credentials are copied or modified.
const parent = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'harness-agent-test-'));
const agents = join(root, '.opencode', 'agents');
mkdirSync(agents, { recursive: true });
// V2 docs specify agents/; the tested 2.0.24 CLI discovers agent/ instead.
const compatibilityAgents = join(root, '.opencode', 'agent');
mkdirSync(compatibilityAgents, { recursive: true });
mkdirSync(join(root, 'fixture'));
for (const role of roles) {
  const template = readFileSync(new URL(`../spike/opencode/agents/${role}.md`, import.meta.url), 'utf8');
  const fixture = join(root, 'fixture').replaceAll('\\', '/');
  const definition = template.replaceAll('__HARNESS_FIXTURE__', fixture);
  writeFileSync(join(agents, `${role}.md`), definition);
  writeFileSync(join(compatibilityAgents, `${role}.md`), definition);
}
writeFileSync(join(root, 'fixture', 'greeting.txt'), 'HELLO_FROM_DISPOSABLE_FIXTURE\n');
writeFileSync(join(root, '.harness-test-fixture.json'), JSON.stringify({ schema: 1, kind: 'advanced-harness-agent-test' }, null, 2));
writeFileSync(join(root, '.opencode', 'opencode.jsonc'), JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  default_agent: 'lead',
  model: 'openai/gpt-6-astra',
  permissions: [{ action: '*', resource: '*', effect: 'deny' }],
}, null, 2));
writeFileSync(join(root, 'TEST-PROMPT.txt'), readFileSync(new URL('../spike/opencode/agent-smoke-prompt.txt', import.meta.url)));
console.log(`Disposable project: ${root}`);
console.log('No host adapter is loaded: this tests Markdown agent restrictions only.');
console.log('Open this directory in OpenCode, start a NEW session, select lead and GPT-6 Astra / medium.');
console.log('Paste TEST-PROMPT.txt. Do not reuse this broad-tool coding session.');
console.log('Verify actual permission results; model statements alone do not prove enforcement.');
