import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { combineProcedureSkillArtifacts, compileProcedureSkills, emitProcedureSkill, emittedProcedureSkillName, loadProcedureSkill, type ProcedureSkillHost } from '../src/procedure-skills.ts';
import { compileWorkflowArtifacts, workflowCommandIds } from '../src/workflow-commands.ts';

const source = new URL('../skills/documentation-impact/', import.meta.url);
const hosts: ProcedureSkillHost[] = ['opencode', 'claude-code', 'antigravity', 'codex'];

test('seed skill compiles deterministic native frontmatter and prescribed four host paths', () => {
  const skill = loadProcedureSkill(fileURLToPath(new URL('.', source)));
  const expectedPaths = [
    '.opencode/skills/harness-procedure-documentation-impact/SKILL.md',
    '.claude/skills/harness-procedure-documentation-impact/SKILL.md',
    '.agents/skills/harness-procedure-documentation-impact/SKILL.md',
    '.agents/skills/harness-procedure-documentation-impact/SKILL.md',
  ];
  for (const [index, host] of hosts.entries()) {
    const [artifact] = emitProcedureSkill(skill, host);
    assert.equal(artifact!.relativePath, expectedPaths[index]);
    const match = /^---\n([\s\S]*?)\n---\n/.exec(artifact!.content as string)!;
    const header = parseDocument(match[1]!).toJSON();
    assert.deepEqual(Object.keys(header).sort(), ['description', 'name']);
    assert.equal(header.name, 'harness-procedure-documentation-impact');
    assert.match(artifact!.content as string, /advisory only/);
    assert.match(artifact!.content as string, /no permissions/);
    assert.match(artifact!.content as string, /no approval or decision authority/);
    assert.match(artifact!.content as string, /not enforced role discovery/);
    assert.doesNotMatch(match[1]!, /allowed-tools|permissions/i);
  }
});

test('multi-source compiler is stable under source/host reorder and duplicate shared host outputs coalesce', async t => {
  const directory = fileURLToPath(new URL('.', source));
  const parent = await mkdtemp(join(tmpdir(), 'procedure-skills-multi-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const second = join(parent, 'architecture-review');
  await mkdir(second);
  await writeFile(join(second, 'SKILL.md'), '---\nschemaVersion: 1\nname: architecture-review\ndescription: Review architecture decisions.\nintendedRoles: [planner, reviewer]\n---\nAssess tradeoffs.\n');
  const expected = compileProcedureSkills([directory, second], hosts);
  assert.deepEqual(compileProcedureSkills([second, directory], [...hosts].reverse()), expected);
  assert.deepEqual(compileProcedureSkills([directory], ['codex', 'antigravity', 'codex']), compileProcedureSkills([directory], ['antigravity', 'codex']));
  assert.ok(expected.some(file => file.relativePath.includes('harness-procedure-architecture-review')));
});

test('schema boundaries reject invalid names, versions, fields, roles, body, and YAML', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'procedure-skill-schema-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const write = async (name: string, front: string, body = 'Body.'): Promise<string> => {
    const target = join(dir, name);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), `---\n${front}\n---\n${body}`);
    return target;
  };
  const good = 'schemaVersion: 1\nname: okay-name\ndescription: a description\nintendedRoles: [lead]';
  assert.equal(loadProcedureSkill(await write('okay-name', good)).name, 'harness-procedure-okay-name');
  const mismatch = await write('different-dir', good);
  assert.throws(() => loadProcedureSkill(mismatch));
  for (const [name, front, body] of [
    ['bad', good.replace('okay-name', 'bad').replace('schemaVersion: 1', 'schemaVersion: 2'), 'Body.'],
    ['unknown', `${good}\nextra: nope`, 'Body.'],
    ['dupkey', `${good}\nname: dupkey`, 'Body.'],
    ['dup-role', good.replace('okay-name', 'dup-role').replace('[lead]', '[lead, lead]'), 'Body.'],
    ['unknown-role', good.replace('okay-name', 'unknown-role').replace('[lead]', '[admin]'), 'Body.'],
    ['empty-role', good.replace('okay-name', 'empty-role').replace('[lead]', '[]'), 'Body.'],
    ['empty-desc', good.replace('okay-name', 'empty-desc').replace('a description', '  '), 'Body.'],
    ['long-desc', good.replace('okay-name', 'long-desc').replace('a description', 'x'.repeat(1025)), 'Body.'],
    ['empty-body', good, '  '],
    ['bad-yaml', 'schemaVersion: [', 'Body.'],
  ] as const) {
    const target = await write(name, name === 'bad-yaml' || name === 'dupkey' ? front : front.replaceAll('okay-name', name), body);
    assert.throws(() => loadProcedureSkill(target));
  }
  assert.throws(() => emittedProcedureSkillName('x'.repeat(51)));
  assert.equal(emittedProcedureSkillName('x'.repeat(46)).length, 64);
  assert.throws(() => emittedProcedureSkillName('x'.repeat(47)));
  assert.throws(() => emittedProcedureSkillName('Bad_name'));
  assert.throws(() => emittedProcedureSkillName('x'.repeat(65)));
});

test('support file hierarchy preserves bytes and rejects unsafe entries and case collisions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'procedure-skill-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'safe');
  await mkdir(join(root, 'nested'), { recursive: true });
  await writeFile(join(root, 'SKILL.md'), '---\nschemaVersion: 1\nname: safe\ndescription: Safe\nintendedRoles: [lead]\n---\nBody.');
  const bytes = Buffer.from([0, 255, 1, 128]);
  await writeFile(join(root, 'nested', 'binary.dat'), bytes);
  const skill = loadProcedureSkill(root);
  assert.deepEqual(skill.supportingFiles[0]!.content, bytes);
  assert.deepEqual(emitProcedureSkill(skill, 'codex')[1]!.content, bytes);
  const outside = join(dir, 'outside');
  await writeFile(outside, 'outside');
  const canonical = join(root, 'SKILL.md');
  const original = await readFile(canonical);
  await rm(canonical);
  let canonicalLinkCreated = false;
  try {
    await symlink(outside, canonical, 'file');
    canonicalLinkCreated = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.diagnostic('Canonical symlink assertion unavailable: this Windows environment denied symlink creation (EPERM).');
    await writeFile(canonical, original);
  }
  if (canonicalLinkCreated) assert.throws(() => loadProcedureSkill(root), /symbolic link/i);
  await rm(canonical, { force: true });
  await mkdir(canonical);
  assert.throws(() => loadProcedureSkill(root), /regular file, not a symbolic link/);
  await rm(canonical, { recursive: true });
  await writeFile(canonical, original);

  const supportLink = join(root, 'nested', 'external-link');
  let supportLinkCreated = false;
  try {
    await symlink(outside, supportLink, 'file');
    supportLinkCreated = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.diagnostic('Supporting-file symlink assertion unavailable: this Windows environment denied symlink creation (EPERM).');
  }
  if (supportLinkCreated) {
    assert.throws(() => loadProcedureSkill(root), /symlink/i);
    await rm(supportLink);
  }

  // Windows forbids some path components at creation time; exercise loader validation where the FS permits them.
  let unsafeCreated = false;
  try { await writeFile(join(root, 'unsafe?.txt'), 'x'); unsafeCreated = true; } catch (error) {
    if (!['EINVAL', 'EPERM', 'EACCES', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    t.diagnostic(`Unsafe filename fixture unavailable on this platform (${(error as NodeJS.ErrnoException).code}).`);
  }
  if (unsafeCreated) {
    assert.throws(() => loadProcedureSkill(root), /Unsafe procedure skill support path/);
    await rm(join(root, 'unsafe?.txt'));
  }

  await writeFile(join(root, 'nested', 'case.txt'), 'a');
  let collisionCreated = false;
  try { await writeFile(join(root, 'nested', 'CASE.txt'), 'b'); collisionCreated = true; } catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  const entries = await readdir(join(root, 'nested'));
  if (collisionCreated && entries.some(name => name === 'CASE.txt') && entries.some(name => name === 'case.txt')) {
    assert.throws(() => loadProcedureSkill(root), /case-insensitive.*collision/i);
  } else {
    t.diagnostic('Case-collision loader fixture unavailable: filesystem does not retain two case-distinct sibling names.');
  }
});

test('artifacts coalesce identical shared files deterministically and reject content and path conflicts', () => {
  const common = { relativePath: '.agents/skills/same/file.bin', content: Buffer.from([1, 2]) };
  const artifacts = combineProcedureSkillArtifacts([
    [{ ...common, host: 'codex' }],
    [{ ...common, host: 'antigravity' }],
  ]);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]!.host, 'antigravity');
  assert.throws(() => combineProcedureSkillArtifacts([[{ ...common, host: 'codex' }], [{ ...common, content: Buffer.from([9]), host: 'antigravity' }]]), /conflicting/i);
  assert.throws(() => combineProcedureSkillArtifacts([[{ ...common, host: 'codex' }, { relativePath: `${common.relativePath}/child`, content: 'x', host: 'codex' }]]), /conflict/i);
  assert.throws(() => combineProcedureSkillArtifacts([[{ ...common, host: 'codex' }, { ...common, relativePath: common.relativePath.toUpperCase(), host: 'antigravity' }]]), /collision/i);
  assert.throws(() => combineProcedureSkillArtifacts([[{ ...common, relativePath: '../escape', host: 'codex' }]]), /unsafe/i);
  assert.throws(() => combineProcedureSkillArtifacts([[{ ...common, relativePath: '.agents/skills/CON.txt', host: 'codex' }]]), /unsafe/i);
  const skill = loadProcedureSkill(fileURLToPath(new URL('.', source)));
  const antigravity = emitProcedureSkill(skill, 'antigravity');
  const codex = emitProcedureSkill(skill, 'codex');
  assert.deepEqual(combineProcedureSkillArtifacts([[...antigravity, ...codex]]), combineProcedureSkillArtifacts([[...codex, ...antigravity]]));
  assert.equal(combineProcedureSkillArtifacts([[...antigravity, ...codex]]).length, antigravity.length);
});

test('workflow compilation retains unchanged behavior and command output excludes the reserved skill namespace', async () => {
  const result = compileWorkflowArtifacts(fileURLToPath(new URL('../commands/', import.meta.url)), ['opencode']);
  assert.equal(result.artifacts.length, 6);
  assert.equal(result.artifacts[0]!.relativePath, '.opencode/commands/start-issue.md');
  const canonical = await readFile(new URL('../.opencode/commands/start-issue.md', import.meta.url), 'utf8');
  assert.equal(result.artifacts[0]!.content, canonical);
  assert.ok(workflowCommandIds.every(id => !id.startsWith('harness-procedure-')));
  const mixed = combineProcedureSkillArtifacts([[...result.artifacts, ...emitProcedureSkill(loadProcedureSkill(fileURLToPath(new URL('.', source))), 'opencode')]]);
  assert.equal(mixed.length, result.artifacts.length + 1);
  assert.ok(mixed.some(item => item.relativePath === '.opencode/commands/start-issue.md'));
});
