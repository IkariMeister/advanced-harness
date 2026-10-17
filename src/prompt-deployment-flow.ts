import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chooseConfiguration, discoverConfigurations, loadNativeDefinitions, projectConfiguration } from './native-installer.ts';
import { deployPrompts, planPromptDeployment, type PromptDeployDependencies, type PromptDeploymentPlan } from './prompt-deployment.ts';
import type { NativeDefinition } from './native-installer.ts';

export interface PromptDeploymentFlowOptions { scope?: string; project?: string; config?: string }
export interface PromptDeploymentFlowDependencies {
  ask(question: string, defaultValue?: string): Promise<string>;
  output(message: string): void;
  cwd?: string;
  home?: string;
  xdgConfigHome?: string;
  environment?: NodeJS.ProcessEnv;
  definitionsDirectory?: string;
  loadDefinitions?: (directory: string) => Record<string, NativeDefinition>;
  deploy?: typeof deployPrompts;
  deployDependencies?: PromptDeployDependencies;
}

export async function runPromptDeploymentFlow(options: PromptDeploymentFlowOptions, deps: PromptDeploymentFlowDependencies): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? homedir();
  const env = deps.environment ?? process.env;
  const ask = deps.ask;
  let scope = options.scope;
  while (!scope || !['project', 'global'].includes(scope)) scope = (await ask('Deploy scope: project or global', 'project')) || 'project';
  const expand = (path: string) => path.replace(/^(?:~|\$HOME)(?=[/\\]|$)/, home);
  const project = scope === 'project' ? resolve(cwd, expand(options.project ?? ((await ask('Project directory', cwd)) || cwd))) : undefined;
  const globalDirectory = resolve(join(deps.xdgConfigHome ?? env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode'));
  const sources = discoverConfigurations(project, globalDirectory);
  const target = options.config ? resolve(cwd, expand(options.config)) : project ? projectConfiguration(project, sources) : chooseConfiguration(globalDirectory);
  if (!existsSync(target)) throw new Error(`Target configuration not found: ${target}`);
  const definitionsDirectory = deps.definitionsDirectory ?? 'agents';
  const definitions = (deps.loadDefinitions ?? loadNativeDefinitions)(definitionsDirectory) as Parameters<typeof planPromptDeployment>[1];
  const original = readFileSync(target, 'utf8');
  const plan: PromptDeploymentPlan = planPromptDeployment(original, definitions, target);
  deps.output(`\nTarget: ${target}`);
  if (!plan.hasChanges) { deps.output('All installed roles already match the latest source prompt templates.'); return 0; }
  deps.output('Roles to be updated with reviewed source templates:');
  for (const r of plan.roles) if (r.descriptionChanged || r.systemChanged) deps.output(`  - ${r.role}: ${[r.descriptionChanged ? 'description' : null, r.systemChanged ? 'system' : null].filter(Boolean).join(', ')}`); else deps.output(`  - ${r.role}: unchanged`);
  deps.output('\nSafety invariants:');
  deps.output('  - Configured models and reasoning variants will NOT be changed.');
  deps.output('  - Configured permission rules and ordering will NOT be changed.');
  deps.output('  - Pre-save backup and cumulative recovery receipt will be written.');
  if ((await ask('Type deploy to confirm prompt deployment', 'cancel')) !== 'deploy') { deps.output('Cancelled. No configuration files were changed.'); return 0; }
  const backupParent = env.ADVANCED_HARNESS_RECOVERY_DIR ?? join(home, 'Projects', 'advanced-harness-backups');
  const deployDeps = { ...deps.deployDependencies };
  const loadForDeploy = deps.loadDefinitions ?? deployDeps.loadDefinitions;
  if (loadForDeploy) deployDeps.loadDefinitions = loadForDeploy as typeof loadNativeDefinitions;
  const result = (deps.deploy ?? deployPrompts)(target, backupParent, { definitionsDirectory, reviewedPlan: plan, deps: deployDeps });
  if (result.updated) {
    deps.output(`\nPrompts successfully deployed to: ${target}`);
    if (result.backup) deps.output(`Backup: ${result.backup}`);
    if (result.receiptPath) deps.output(`Receipt: ${result.receiptPath}`);
    deps.output('\nStart a new OpenCode session to activate the updated prompts.');
  } else deps.output('No changes were made.');
  return 0;
}
