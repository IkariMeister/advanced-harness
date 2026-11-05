import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseProcedureSkills } from '../src/procedure-skill-diagnostics.ts';
import { emitProcedureSkill, loadProcedureSkill } from '../src/procedure-skills.ts';
import type { HostId } from '../src/host-registry.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-procedure-doctor-'));
  const skills = join(root, 'canonical');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const globalDirectory = join(root, 'global');
  mkdirSync(join(skills, 'my-procedure'), { recursive: true });
  mkdirSync(project); mkdirSync(home); mkdirSync(globalDirectory);
  writeFileSync(join(skills, 'my-procedure', 'SKILL.md'), '---\nschemaVersion: 1\nname: my-procedure\ndescription: Do a useful procedure.\nintendedRoles: [implementer, reviewer]\n---\nCanonical body.\n');
  const options = { skillsDirectory: skills, project, home, globalDirectory };
  return { root, skills, project, home, globalDirectory, options, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('canonical source validates and missing installed skill only fails with installation footprint', t => {
  const f = fixture(); t.after(f.cleanup);
  assert.deepEqual(diagnoseProcedureSkills({ ...f.options, host: 'opencode' }).issues, []);
  assert.equal(diagnoseProcedureSkills({ ...f.options, host: 'opencode' }).status, 'not-installed');
  mkdirSync(join(f.project, '.opencode'), { recursive: true });
  writeFileSync(join(f.project, '.opencode', 'opencode.json'), '{"agents":{"lead":{},"implementer":{}}}');
  const result = diagnoseProcedureSkills({ ...f.options, host: 'opencode' });
  assert.equal(result.status, 'installed');
  assert.match(result.issues.join(' '), /missing/);
});

test('valid emitted artifact and customized body pass; malformed metadata and guidance fail', t => {
  const f = fixture(); t.after(f.cleanup);
  const canonical = loadProcedureSkill(join(f.skills, 'my-procedure'));
  const dir = join(f.project, '.opencode', 'skills', canonical.name);
  mkdirSync(dir, { recursive: true });
  const artifact = emitProcedureSkill(canonical, 'opencode')[0]!;
  const valid = String(artifact.content).replace('Canonical body.', 'Customized local body.');
  writeFileSync(join(dir, 'SKILL.md'), valid);
  assert.deepEqual(diagnoseProcedureSkills({ ...f.options, host: 'opencode' }).issues, []);
  writeFileSync(join(dir, 'SKILL.md'), valid.replace('name: harness-procedure-my-procedure', 'name: wrong-name'));
  assert.match(diagnoseProcedureSkills({ ...f.options, host: 'opencode' }).issues.join(' '), /unexpected name/);
  writeFileSync(join(dir, 'SKILL.md'), valid.replace('Intended roles (advisory only): implementer, reviewer.', 'Intended roles are unspecified.'));
  assert.match(diagnoseProcedureSkills({ ...f.options, host: 'opencode' }).issues.join(' '), /advisory guidance/);
  writeFileSync(join(dir, 'SKILL.md'), 'not frontmatter');
  assert.match(diagnoseProcedureSkills({ ...f.options, host: 'opencode' }).issues.join(' '), /malformed/);
});

test('canonical malformed source, unsupported hosts, scope isolation, and unrelated skills are reported without writes', t => {
  const f = fixture(); t.after(f.cleanup);
  const unrelated = join(f.project, '.opencode', 'skills', 'third-party-skill');
  mkdirSync(unrelated, { recursive: true });
  writeFileSync(join(unrelated, 'SKILL.md'), 'third party');
  const before = readdirSync(unrelated).join(',') + readFileSync(join(unrelated, 'SKILL.md'), 'utf8');
  assert.equal(diagnoseProcedureSkills({ ...f.options, host: 'codex' }).status, 'unsupported');
  assert.equal(diagnoseProcedureSkills({ ...f.options, host: 'cursor' }).status, 'unsupported');
  assert.equal(diagnoseProcedureSkills({ ...f.options, host: 'opencode', scope: 'global' }).status, 'not-installed');
  writeFileSync(join(f.skills, 'my-procedure', 'SKILL.md'), 'bad');
  assert.match(diagnoseProcedureSkills({ ...f.options, host: 'opencode' }).issues.join(' '), /Canonical procedure skill/);
  assert.equal(readdirSync(unrelated).join(',') + readFileSync(join(unrelated, 'SKILL.md'), 'utf8'), before);
});

test('all five hosts expose explicit deployment status without inferring unsupported deployments', t => {
  const f = fixture(); t.after(f.cleanup);
  const expected: Record<string, string> = { opencode: 'not-installed', 'claude-code': 'not-installed', antigravity: 'not-installed', codex: 'unsupported', cursor: 'unsupported' };
  for (const [host, status] of Object.entries(expected)) assert.equal(diagnoseProcedureSkills({ ...f.options, host: host as HostId }).status, status);
});

test('expected artifact path that is not a real skill directory fails closed', t => {
  const f = fixture(); t.after(f.cleanup);
  const skill = loadProcedureSkill(join(f.skills, 'my-procedure'));
  const root = join(f.project, '.opencode', 'skills');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, skill.name), 'not a directory');
  const result = diagnoseProcedureSkills({ ...f.options, host: 'opencode' });
  assert.match(result.issues.join(' '), /malformed or unsafe/);
});

test('default scope checks project and global artifacts independently; explicit project scope excludes global', t => {
  const f = fixture(); t.after(f.cleanup);
  const skill = loadProcedureSkill(join(f.skills, 'my-procedure'));
  const projectThirdParty = join(f.project, '.opencode', 'skills', 'unrelated-skill');
  mkdirSync(projectThirdParty, { recursive: true });
  writeFileSync(join(projectThirdParty, 'SKILL.md'), 'third party');
  const globalSkill = join(f.globalDirectory, 'skills', skill.name);
  mkdirSync(globalSkill, { recursive: true });
  writeFileSync(join(globalSkill, 'SKILL.md'), 'malformed global artifact');
  const withoutScope = diagnoseProcedureSkills({ ...f.options, host: 'opencode' });
  assert.match(withoutScope.issues.join(' '), /malformed/);
  const projectOnly = diagnoseProcedureSkills({ ...f.options, host: 'opencode', scope: 'project' });
  assert.equal(projectOnly.status, 'not-installed');
  assert.deepEqual(projectOnly.issues, []);
  const globalOnly = diagnoseProcedureSkills({ ...f.options, host: 'opencode', scope: 'global' });
  assert.match(globalOnly.issues.join(' '), /malformed/);
});

test('linked .opencode ancestor is rejected before expected installed artifacts are read', t => {
  const f = fixture(); t.after(f.cleanup);
  const outside = join(f.root, 'outside');
  mkdirSync(join(outside, 'skills'), { recursive: true });
  const skill = loadProcedureSkill(join(f.skills, 'my-procedure'));
  const externalSkill = join(outside, 'skills', skill.name);
  mkdirSync(externalSkill, { recursive: true });
  writeFileSync(join(externalSkill, 'SKILL.md'), 'malformed');
  try {
    symlinkSync(outside, join(f.project, '.opencode'), 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Directory symlinks are unavailable in this environment.'); return; }
    throw error;
  }
  const result = diagnoseProcedureSkills({ ...f.options, host: 'opencode', scope: 'project' });
  assert.match(result.issues.join(' '), /symbolic-link ancestor/);
  assert.doesNotMatch(result.issues.join(' '), /malformed or unsafe SKILL\.md/);
});
