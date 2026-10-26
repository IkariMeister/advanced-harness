import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRoot } from './temp-directory.ts';
import { planAntigravityDeployment, installAntigravity, diagnoseAntigravity } from '../src/antigravity-adapter.ts';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import { diagnoseHost } from '../src/native-diagnostics.ts';

const rolesDir = fileURLToPath(new URL('../agents/', import.meta.url));
const commandsDir = fileURLToPath(new URL('../commands/', import.meta.url));

test('planAntigravityDeployment produces expected project footprint', () => {
  const tempProject = makeTempRoot('ag-project-plan-');
  const tempHome = makeTempRoot('ag-home-plan-');

  const plan = planAntigravityDeployment('project', tempProject, tempHome, rolesDir, commandsDir);
  assert.equal(plan.targetConfig, join(tempProject, '.agents', 'hooks.json'));
  assert.ok(plan.filesToDeploy.length >= 8); // 1 lead rule + 6 skills + hooks.json + mcp_config.json

  const leadRule = plan.filesToDeploy.find(f => f.relativePath === '.agents/rules/advanced-harness-lead.md');
  assert.ok(leadRule);
  assert.equal(leadRule.kind, 'rules');

  const hooks = plan.filesToDeploy.find(f => f.relativePath === '.agents/hooks.json');
  assert.ok(hooks);
  assert.equal(hooks.kind, 'config');
});

test('planAntigravityDeployment produces expected global footprint', () => {
  const tempHome = makeTempRoot('ag-home-global-plan-');

  const plan = planAntigravityDeployment('global', undefined, tempHome, rolesDir, commandsDir);
  assert.equal(plan.targetConfig, join(tempHome, '.gemini', 'config', 'hooks.json'));

  const leadRule = plan.filesToDeploy.find(f => f.relativePath === 'rules/advanced-harness-lead.md');
  assert.ok(leadRule);
  assert.equal(leadRule.kind, 'rules');

  const hooks = plan.filesToDeploy.find(f => f.relativePath === 'hooks.json');
  assert.ok(hooks);
  assert.equal(hooks.kind, 'config');
});

test('installAntigravity performs full installation with recovery receipts and backups', async () => {
  const tempProject = makeTempRoot('ag-project-install-');
  const tempHome = makeTempRoot('ag-home-install-');
  const recoveryDir = join(tempHome, 'backups');

  let confirmed = false;
  const outputs: string[] = [];

  const exitCode = await installAntigravity({
    scope: 'project',
    project: tempProject,
    home: tempHome,
    recoveryDirectory: recoveryDir,
    agentsDirectory: rolesDir,
    commandsDirectory: commandsDir,
    ask: async (_q, s) => {
      confirmed = true;
      return s ?? 'yes';
    },
    output: msg => outputs.push(msg),
    error: msg => outputs.push(`ERROR: ${msg}`),
  });

  assert.equal(exitCode, 0);
  assert.equal(confirmed, true);

  // Verify deployed files
  assert.ok(existsSync(join(tempProject, '.agents', 'rules', 'advanced-harness-lead.md')));
  assert.ok(existsSync(join(tempProject, '.agents', 'hooks.json')));
  assert.ok(existsSync(join(tempProject, '.agents', 'mcp_config.json')));
  assert.ok(existsSync(join(tempProject, '.agents', 'skills', 'start-issue', 'SKILL.md')));
  assert.ok(existsSync(join(tempProject, '.agents', 'skills', 'review-pr', 'SKILL.md')));
  assert.ok(existsSync(join(tempProject, '.agents', 'skills', 'address-pr-feedback', 'SKILL.md')));
  assert.ok(existsSync(join(tempProject, '.agents', 'skills', 'report-defect', 'SKILL.md')));
  assert.ok(existsSync(join(tempProject, '.agents', 'skills', 'assess-debt', 'SKILL.md')));
  assert.ok(existsSync(join(tempProject, '.agents', 'skills', 'grill-me', 'SKILL.md')));

  // Verify doctor diagnosis on installed project
  const doctor = await diagnoseAntigravity({ project: tempProject, home: tempHome });
  assert.equal(doctor.ok, true);
  assert.ok(doctor.notes.some(n => n.includes('PreToolUse merge guard hook is configured')));
});

test('runInstallerFlow delegates clean installation for --host antigravity', async () => {
  const tempProject = makeTempRoot('ag-installer-flow-');
  const tempHome = makeTempRoot('ag-home-flow-');
  const outputs: string[] = [];
  const errors: string[] = [];

  const code = await runInstallerFlow(
    {
      host: 'antigravity',
      scope: 'project',
      project: tempProject,
    },
    {
      ask: async (_q, s) => s ?? 'yes',
      output: msg => outputs.push(msg),
      error: msg => errors.push(msg),
      home: tempHome,
      agentsDirectory: rolesDir,
      commandsDirectory: commandsDir,
    }
  );

  assert.equal(code, 0);
  assert.ok(existsSync(join(tempProject, '.agents', 'hooks.json')));
  assert.ok(existsSync(join(tempProject, '.agents', 'rules', 'advanced-harness-lead.md')));
});

test('diagnoseHost antigravity runs through adapter doctor', async () => {
  const tempProject = makeTempRoot('ag-diagnose-flow-');
  const tempHome = makeTempRoot('ag-home-diag-');

  // Before install
  const reportBefore = await diagnoseHost('antigravity', { project: tempProject, home: tempHome });
  assert.equal(reportBefore.installed, false);

  // Install
  await installAntigravity({
    scope: 'project',
    project: tempProject,
    home: tempHome,
    agentsDirectory: rolesDir,
    commandsDirectory: commandsDir,
    ask: async (_q, s) => s ?? 'yes',
    output: () => {},
    error: () => {},
  });

  // After install
  const reportAfter = await diagnoseHost('antigravity', { project: tempProject, home: tempHome });
  assert.equal(reportAfter.installed, true);
  assert.equal(reportAfter.ok, true);
  assert.ok(reportAfter.notes.some(n => n.includes('PreToolUse merge guard hook is configured')));
});
