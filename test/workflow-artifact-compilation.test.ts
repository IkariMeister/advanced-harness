import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { compileWorkflowArtifacts, workflowCommandIds, type WorkflowArtifactHost } from '../src/workflow-commands.ts';

const commandsDirectory = fileURLToPath(new URL('../commands/', import.meta.url));
const hosts: WorkflowArtifactHost[] = ['opencode', 'claude-code', 'antigravity', 'codex', 'cursor'];
const bindings = Object.fromEntries(workflowCommandIds.map(id => [id, id === 'report-defect'
  ? { parent: 'issue-42', description: 'complete report description with $ARGUMENTS and $2 text' }
  : `whole input for ${id}: $ARGUMENTS must remain literal`
])) as Parameters<typeof compileWorkflowArtifacts>[2];

test('compiler emits deterministic documented artifact formats for six commands across all hosts', () => {
  const result = compileWorkflowArtifacts(commandsDirectory, hosts, bindings);
  assert.equal(result.artifacts.length, 30);
  assert.equal(result.runtimeVerified, false);
  assert.equal(result.deploymentReady, false);
  assert.ok(result.diagnostics.some(item => item.includes('issue #43')));
  assert.ok(result.diagnostics.some(item => item.includes('issue #44')));
  assert.ok(result.diagnostics.some(item => item.includes('issue #45')));
  assert.ok(result.diagnostics.some(item => item.includes('issue #46')));
  assert.deepEqual(compileWorkflowArtifacts(commandsDirectory, hosts, bindings), result);
  for (const host of hosts) {
    const artifacts = result.artifacts.filter(item => item.host === host);
    assert.equal(artifacts.length, 6, host);
    for (const artifact of artifacts) {
      if (host === 'opencode') {
        assert.equal(artifact.format, 'command-markdown');
        assert.equal(artifact.binding, 'native-template');
        assert.equal(artifact.relativePath, `.opencode/commands/${artifact.command}.md`);
      } else {
        assert.equal(artifact.binding, 'caller-bound');
        if (host === 'claude-code') {
          assert.equal(artifact.format, 'command-markdown');
          assert.match(artifact.relativePath, /^\.claude\/commands\/[a-z0-9-]+\.md$/);
        } else {
          assert.equal(artifact.format, 'skill-markdown');
          assert.match(artifact.relativePath, /\/SKILL\.md$/);
          assert.match(artifact.content, /^---\nname: [a-z0-9-]+\ndescription: .+\n/);
        }
      }
    }
  }
  const claude = result.artifacts.find(item => item.host === 'claude-code' && item.command === 'start-issue')!;
  assert.match(claude.content, /\$ARGUMENTS/);
  assert.equal(claude.format, 'command-markdown');
  const defect = result.artifacts.find(item => item.host === 'claude-code' && item.command === 'report-defect')!;
  assert.match(defect.content, /issue-42/);
  assert.match(defect.content, /complete report description with \$ARGUMENTS and \$2 text/);
  assert.match(defect.content, /Description: complete report description with \$ARGUMENTS and \$2 text/);
  const cursor = result.artifacts.find(item => item.host === 'cursor')!;
  assert.match(cursor.content, /disable-model-invocation: true/);
  assert.ok(result.artifacts.filter(item => item.host === 'codex' && item.command !== 'report-defect').every(item => item.content.includes(`whole input for ${item.command}: $ARGUMENTS must remain literal`)));
});

test('compiler omits caller-bound artifacts until suitable inputs exist and never converts failures into ready outputs', () => {
  const empty = compileWorkflowArtifacts(commandsDirectory, hosts.filter(host => host !== 'opencode'));
  assert.equal(empty.deploymentReady, false);
  assert.equal(empty.runtimeVerified, false);
  assert.ok(empty.diagnostics.some(item => item.includes('caller-bound parent and complete description')));
  assert.ok(empty.artifacts.every(item => item.command !== 'report-defect'));
  const incomplete = compileWorkflowArtifacts(commandsDirectory, ['codex'], { 'report-defect': { parent: 'issue-42' } });
  assert.ok(!incomplete.artifacts.some(item => item.command === 'report-defect'));
  assert.ok(incomplete.diagnostics.some(item => item.includes('both parent and complete description')));
  const malformed = [undefined, null, 'parent description', { parent: null, description: 'description' }, { parent: 42, description: 'description' }, { parent: 'p', description: null }, { parent: 'p', description: ['description'] }, { parent: 'p', description: 'description', extra: true }];
  for (const value of malformed) {
    const result = compileWorkflowArtifacts(commandsDirectory, ['codex'], { 'report-defect': value } as never);
    assert.ok(!result.artifacts.some(item => item.command === 'report-defect'), `invalid input ${String(value)}`);
    assert.ok(result.diagnostics.some(item => item.includes('both parent and complete description')));
  }
  const badContainer = compileWorkflowArtifacts(commandsDirectory, ['codex'], null as never);
  assert.equal(badContainer.deploymentReady, false);
  assert.ok(badContainer.diagnostics.some(item => item.includes('must be an object')));
});

test('non-OpenCode YAML metadata safely roundtrips adversarial descriptions while OpenCode output bytes stay canonical', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-yaml-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of await readdir(commandsDirectory)) await writeFile(join(directory, name), await readFile(join(commandsDirectory, name)));
  const file = join(directory, 'start-issue.md');
  const original = await readFile(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(original)!;
  const header = parseDocument(match[1]!).toJSON() as Record<string, unknown>;
  const hostile = 'value: # comment & anchor [flow] {yaml} *alias';
  header.description = hostile;
  await writeFile(file, `---\n${stringify(header).trimEnd()}\n---\n${match[2]}`);
  for (const host of ['opencode', 'antigravity', 'claude-code'] as const) {
    const result = compileWorkflowArtifacts(directory, [host], host === 'antigravity' ? { 'start-issue': 'complete caller input' } : {});
    const artifact = result.artifacts.find(item => item.command === 'start-issue')!;
    const yaml = /^---\n([\s\S]*?)\n---\n/.exec(artifact.content)![1]!;
    assert.equal(parseDocument(yaml).toJSON().description, hostile, host);
  }
  assert.equal(compileWorkflowArtifacts(commandsDirectory, ['opencode']).artifacts.find(item => item.command === 'start-issue')!.content,
    await readFile(new URL('../.opencode/commands/start-issue.md', import.meta.url), 'utf8'));
});

test('OpenCode-only compilation retains native argument templates and is deployment-ready but runtime-unverified', () => {
  const result = compileWorkflowArtifacts(commandsDirectory, ['opencode']);
  assert.equal(result.artifacts.length, 6);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.deploymentReady, true);
  assert.equal(result.runtimeVerified, false);
  const defect = result.artifacts.find(item => item.command === 'report-defect')!;
  assert.match(defect.content, /\$1/);
  assert.match(defect.content, /\$2/);
});
