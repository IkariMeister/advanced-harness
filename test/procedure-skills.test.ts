import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { combineProcedureSkillArtifacts, compileProcedureSkills, emitProcedureSkill, emittedProcedureSkillName, loadProcedureSkill, type ProcedureSkillHost } from '../src/procedure-skills.ts';
import { compileWorkflowArtifacts, workflowCommandIds } from '../src/workflow-commands.ts';
import { applyProcedureFiles, canonicalProcedurePath, mergeProcedureManagedEvidence, planProcedureDeployment, procedureManagedEvidence } from '../src/procedure-deployment.ts';
import { createSuccessorReceipt, discoverReceiptChain, finalizeSuccessor, writePendingSuccessor } from '../src/receipt-lineage.ts';
import { assertNoForeignManagedFileClaims } from '../src/procedure-deployment.ts';
import { writeFileSync } from 'node:fs';

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

test('BH-064: meeting-task-extraction procedure skill compiles for every supported host and enforces safety rules', () => {
  const meetingSkillDir = fileURLToPath(new URL('../skills/meeting-task-extraction/', import.meta.url));
  const skill = loadProcedureSkill(meetingSkillDir);
  assert.equal(skill.name, 'harness-procedure-meeting-task-extraction');
  assert.equal(skill.schemaVersion, 1);
  assert.deepEqual(skill.intendedRoles, ['lead', 'planner']);

  const expectedPaths = [
    '.opencode/skills/harness-procedure-meeting-task-extraction/SKILL.md',
    '.claude/skills/harness-procedure-meeting-task-extraction/SKILL.md',
    '.agents/skills/harness-procedure-meeting-task-extraction/SKILL.md',
    '.agents/skills/harness-procedure-meeting-task-extraction/SKILL.md',
  ];

  for (const [index, host] of hosts.entries()) {
    const [artifact] = emitProcedureSkill(skill, host);
    assert.equal(artifact!.relativePath, expectedPaths[index]);
    const match = /^---\n([\s\S]*?)\n---\n/.exec(artifact!.content as string)!;
    const header = parseDocument(match[1]!).toJSON();
    assert.deepEqual(Object.keys(header).sort(), ['description', 'name']);
    assert.equal(header.name, 'harness-procedure-meeting-task-extraction');
    assert.match(artifact!.content as string, /advisory only/);
    assert.match(artifact!.content as string, /no permissions/);
    assert.match(artifact!.content as string, /no approval or decision authority/);
    assert.match(artifact!.content as string, /not enforced role discovery/);
    assert.doesNotMatch(match[1]!, /allowed-tools|permissions/i);
  }

  // Acceptance criteria & safety invariants
  assert.match(skill.body, /untrusted data/i);
  assert.match(skill.body, /never executed or acted upon/i);
  assert.match(skill.body, /links.*must not be followed without explicit human approval/i);
  assert.match(skill.body, /inspect only the specific message/i);
  assert.match(skill.body, /never search, scan, or read across the wider mailbox/i);
  assert.match(skill.body, /never copy full meeting transcripts/i);
  assert.match(skill.body, /minimal supporting quotation/i);
  assert.match(skill.body, /\[missing owner\]/i);
  assert.match(skill.body, /\[missing due date\]/i);
  assert.match(skill.body, /\[inferred\]/i);
  assert.match(skill.body, /accept, edit, or reject proposed tasks one by one/i);
  assert.match(skill.body, /per-task approval/i);
  assert.match(skill.body, /individual task approvals are staged.*without creating any issues/i);
  assert.match(skill.body, /no issues are created until the full review is complete and the human gives final confirmation/i);
  assert.match(skill.body, /cancels.*all staged approvals are discarded and nothing is created/i);
  assert.match(skill.body, /routing creation through external using the confirmed tracker procedure/i);
  assert.match(skill.body, /ask the human when.*unspecified/i);
  assert.match(skill.body, /do not use `?\/start-issue`? to create issues/i);
  assert.doesNotMatch(skill.body, /such as `?\/start-issue`?/i);
  assert.match(skill.body, /operates from a pasted or exported transcript with no integration configured/i);
});

test('BH-050: generic validation procedure skills (unit-tests, static-analysis, evidence-collection) compile for every host and enforce validation boundaries', () => {
  const genericSkills = ['unit-tests', 'static-analysis', 'evidence-collection'] as const;
  const expectedRoles = ['implementer', 'reviewer', 'qa'];

  for (const skillName of genericSkills) {
    const dir = fileURLToPath(new URL(`../skills/${skillName}/`, import.meta.url));
    const skill = loadProcedureSkill(dir);
    assert.equal(skill.name, `harness-procedure-${skillName}`);
    assert.equal(skill.schemaVersion, 1);
    assert.deepEqual(skill.intendedRoles, expectedRoles);

    const expectedPaths = [
      `.opencode/skills/harness-procedure-${skillName}/SKILL.md`,
      `.claude/skills/harness-procedure-${skillName}/SKILL.md`,
      `.agents/skills/harness-procedure-${skillName}/SKILL.md`,
      `.agents/skills/harness-procedure-${skillName}/SKILL.md`,
    ];

    for (const [index, host] of hosts.entries()) {
      const [artifact] = emitProcedureSkill(skill, host);
      assert.equal(artifact!.relativePath, expectedPaths[index]);
      const match = /^---\n([\s\S]*?)\n---\n/.exec(artifact!.content as string)!;
      const header = parseDocument(match[1]!).toJSON();
      assert.deepEqual(Object.keys(header).sort(), ['description', 'name']);
      assert.equal(header.name, `harness-procedure-${skillName}`);
      assert.match(artifact!.content as string, /advisory only/);
      assert.match(artifact!.content as string, /no permissions/);
      assert.match(artifact!.content as string, /no approval or decision authority/);
      assert.match(artifact!.content as string, /not enforced role discovery/);
      assert.doesNotMatch(match[1]!, /allowed-tools|permissions/i);
    }

    // Invariants shared across all generic validation skills
    assert.match(skill.body, /procedural only/i);
    assert.match(skill.body, /does (?:not|\*\*not\*\*) (?:evaluate pass\/fail criteria|decide whether results are acceptable|evaluate findings)/i);
    assert.match(skill.body, /disposable (?:directory|artifact location|scratch locations|or ignored build directories)/i);
  }

  // Skill-specific invariants
  const unitTestsSkill = loadProcedureSkill(fileURLToPath(new URL('../skills/unit-tests/', import.meta.url)));
  assert.match(unitTestsSkill.body, /tree cleanliness/i);
  assert.match(unitTestsSkill.body, /leaves the reviewed source tree unchanged/i);
  assert.match(unitTestsSkill.body, /evidence-collection/i);

  const staticAnalysisSkill = loadProcedureSkill(fileURLToPath(new URL('../skills/static-analysis/', import.meta.url)));
  assert.match(staticAnalysisSkill.body, /non-mutating mode/i);
  assert.match(staticAnalysisSkill.body, /never invoke tools in auto-fix or in-place format mode/i);
  assert.match(staticAnalysisSkill.body, /check-only mode/i);

  const evidenceSkill = loadProcedureSkill(fileURLToPath(new URL('../skills/evidence-collection/', import.meta.url)));
  assert.match(evidenceSkill.body, /unified evidence format/i);
  assert.match(evidenceSkill.body, /re-run/i);
  assert.match(evidenceSkill.body, /judged from evidence only/i);
  assert.match(evidenceSkill.body, /exitStatus/);
  assert.match(evidenceSkill.body, /command:/);
  assert.match(evidenceSkill.body, /artifacts:/);
  assert.match(evidenceSkill.body, /findingsSummary:/);
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

test('deployment planner preserves customized files by default and tracks/restores binary supporting bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'procedure-deploy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = '.opencode/skills/harness-procedure-sample/nested/data.bin';
  const binary = Buffer.from([0, 255, 192, 128, 10, 0]);
  const artifact = [{ host: 'opencode' as const, relativePath: path, content: binary }];
  let plan = planProcedureDeployment(artifact, root);
  assert.equal(plan[0]!.status, 'new');
  const selected = new Set([canonicalProcedurePath(plan[0]!.path)]);
  const evidence = procedureManagedEvidence(plan, selected);
  assert.deepEqual(evidence[0]!.before, { absent: true });
  assert.equal('contentBase64' in evidence[0]!.after && evidence[0]!.after.contentBase64, binary.toString('base64'));
  applyProcedureFiles(plan, selected, join(root, 'backups'));
  assert.deepEqual(await readFile(plan[0]!.path), binary);
  plan = planProcedureDeployment(artifact, root, evidence);
  assert.equal(plan[0]!.status, 'current');
  const revisedBytes = Buffer.from([255, 254, 0, 129]);
  artifact[0]!.content = revisedBytes;
  plan = planProcedureDeployment(artifact, root, evidence);
  assert.equal(plan[0]!.status, 'outdated');
  const updateSelection = new Set([canonicalProcedurePath(plan[0]!.path)]);
  let backupPath = '';
  applyProcedureFiles(plan, updateSelection, join(root, 'backups'), path => { backupPath = path; });
  assert.deepEqual(await readFile(backupPath), binary);
  assert.deepEqual(await readFile(plan[0]!.path), revisedBytes);
  const updatedEvidence = procedureManagedEvidence(plan, updateSelection);
  const customized = Buffer.from([1, 2, 3]);
  await writeFile(plan[0]!.path, customized);
  plan = planProcedureDeployment(artifact, root, updatedEvidence);
  assert.equal(plan[0]!.status, 'customized');
  assert.deepEqual(procedureManagedEvidence(plan), []);
  const replace = new Set([canonicalProcedurePath(plan[0]!.path)]);
  const customizedEvidence = procedureManagedEvidence(plan, replace)[0]!.before;
  assert.ok('content' in customizedEvidence);
  assert.equal(customizedEvidence.content, customized.toString('utf8'));
  await writeFile(plan[0]!.path, Buffer.from([4, 5]));
  assert.throws(() => applyProcedureFiles(plan, replace, join(root, 'backups')), /after confirmation/);
});

test('procedure selection, predecessor lookup, evidence, and execution share platform-aware path identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'procedure-case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = [{ host: 'opencode' as const, relativePath: '.opencode/skills/CaseSkill/SKILL.md', content: Buffer.from('canonical') }];
  const initial = planProcedureDeployment(artifact, root);
  const selected = new Set([canonicalProcedurePath(initial[0]!.path)]);
  const evidence = procedureManagedEvidence(initial, selected);
  applyProcedureFiles(initial, selected, join(root, 'backup'));
  const next = planProcedureDeployment(artifact, root, evidence);
  assert.equal(next[0]!.status, 'current');
  assert.equal(next[0]!.owned, true);
  assert.equal(selected.has(canonicalProcedurePath(next[0]!.path)), true);
  assert.deepEqual(procedureManagedEvidence(next, selected), []);
  if (process.platform !== 'win32') {
    const differentlyCased = planProcedureDeployment([{ ...artifact[0]!, relativePath: '.opencode/skills/caseskill/SKILL.md' }], root, evidence);
    assert.equal(differentlyCased[0]!.status, 'new');
    assert.equal(differentlyCased[0]!.owned, false);
  }
});

test('procedure managed evidence merges canonical-equivalent paths without replacing the earliest before-state', () => {
  const path = resolve('Project', '.opencode', 'skills', 'CaseSkill', 'SKILL.md');
  const alternate = process.platform === 'win32' ? path.toUpperCase() : path;
  const earlier = { path, kind: 'skills' as const, before: { content: 'earliest' }, after: { content: 'prior' } };
  const update = { path: alternate, kind: 'skills' as const, before: { absent: true as const }, after: { content: 'latest' } };
  const merged = [earlier];
  mergeProcedureManagedEvidence(merged, [update]);
  if (canonicalProcedurePath(path) === canonicalProcedurePath(alternate)) {
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]!.before, earlier.before);
    assert.deepEqual(merged[0]!.after, update.after);
  } else {
    assert.equal(merged.length, 2);
  }
});

test('another host active receipt blocks procedure skill overwrite but identical unowned content is not claimed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'procedure-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recovery = join(root, 'recovery');
  const target = join(root, 'claude-settings.json');
  const skillPath = join(root, 'project', '.agents', 'skills', 'harness-procedure-sample', 'SKILL.md');
  const absentClaimPath = join(root, 'project', '.agents', 'skills', 'previously-removed', 'SKILL.md');
  const after = Buffer.from([0, 255, 128]);
  const encode = (bytes: Buffer) => ({ contentBase64: bytes.toString('base64'), digest: createHash('sha256').update(bytes).digest('hex') });
  const snapshot = discoverReceiptChain(recovery, target, 'claude-code');
  const receipt = createSuccessorReceipt(snapshot, undefined, '{}', {}, undefined, { host: 'claude-code', managedFiles: [
    { path: skillPath, kind: 'skills', before: { absent: true }, after: encode(after) },
    { path: absentClaimPath, kind: 'skills', before: { content: 'previously owned' }, after: { absent: true } },
  ] });
  const pending = writePendingSuccessor(snapshot, receipt);
  assert.throws(() => assertNoForeignManagedFileClaims(recovery, 'antigravity', [skillPath]), /Pending/);
  writeFileSync(target, '{}');
  await mkdir(join(root, 'project', '.agents', 'skills', 'harness-procedure-sample'), { recursive: true });
  writeFileSync(skillPath, after, { flag: 'w' });
  finalizeSuccessor(pending, '{}');
  assert.throws(() => assertNoForeignManagedFileClaims(recovery, 'antigravity', [skillPath]), /another host's active receipt ownership/);
  assert.doesNotThrow(() => assertNoForeignManagedFileClaims(recovery, 'antigravity', [absentClaimPath]));
  assert.doesNotThrow(() => assertNoForeignManagedFileClaims(recovery, 'antigravity', [join(root, 'other-skill') ]));
  const matching = planProcedureDeployment([{ host: 'antigravity', relativePath: '.agents/skills/harness-procedure-sample/SKILL.md', content: after }], join(root, 'project'));
  assert.equal(matching[0]!.status, 'current');
  assert.deepEqual(procedureManagedEvidence(matching), []);
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
