import { basename, dirname, join, resolve } from 'node:path';
import { chooseConfiguration, discoverConfigurations, projectConfiguration } from './native-installer.ts';
import type { HostId } from './host-registry.ts';

export type UninstallTargetOptions = {
  scope?: string;
  project?: string;
  config?: string;
  host?: HostId;
  home: string;
  cwd: string;
  xdgConfigHome?: string;
};

// Receipt-keyed file per host: Claude Code keys on <project>/.claude/settings.json (project only);
// Antigravity keys on <project>/.agents/hooks.json or <home>/.gemini/config/hooks.json (global).
function selectHostTarget(host: Exclude<HostId, 'opencode'>, options: UninstallTargetOptions): string {
  if (options.config) throw new Error(`--config is supported only with --host opencode; ${host} uninstall targets its own receipt file.`);
  if (host === 'claude-code') {
    const scope = options.scope ?? 'project';
    if (scope !== 'project') throw new Error('Claude Code harness is project-scoped; --scope global is not supported.');
    if (!options.project) throw new Error('--project is required with --scope project.');
    return join(resolve(options.cwd, options.project), '.claude', 'settings.json');
  }
  const scope = options.scope ?? (options.project ? 'project' : 'global');
  if (!['global', 'project'].includes(scope)) throw new Error('--scope must be global or project.');
  if (scope === 'project') {
    if (!options.project) throw new Error('--project is required with --scope project.');
    return join(resolve(options.cwd, options.project), '.agents', 'hooks.json');
  }
  if (options.project) throw new Error('--project cannot be combined with --scope global.');
  return join(options.home, '.gemini', 'config', 'hooks.json');
}

export function selectUninstallTarget(options: UninstallTargetOptions): string {
  if (options.host && options.host !== 'opencode') return selectHostTarget(options.host, options);
  const scope = options.scope ?? (options.project ? 'project' : options.config ? undefined : 'global');
  if (scope && !['global', 'project'].includes(scope)) throw new Error('--scope must be global or project.');
  if (scope === 'project' && !options.project) throw new Error('--project is required with --scope project.');
  if (scope === 'global' && options.project) throw new Error('--project cannot be combined with --scope global.');

  const globalDirectory = resolve(join(options.xdgConfigHome ?? join(options.home, '.config'), 'opencode'));
  const project = options.project ? resolve(options.cwd, options.project) : undefined;
  const target = options.config
    ? resolve(options.cwd, options.config)
    : scope === 'project'
      ? projectConfiguration(project!, discoverConfigurations(project, globalDirectory))
      : chooseConfiguration(globalDirectory);
  if (!['opencode.json', 'opencode.jsonc'].includes(basename(target))) throw new Error('Target must be opencode.json or opencode.jsonc.');

  if (options.config && scope) {
    const allowedDirectories = scope === 'global' ? [globalDirectory] : [project!, join(project!, '.opencode')];
    const targetDirectory = dirname(target);
    if (!allowedDirectories.some(directory => process.platform === 'win32' ? resolve(directory).toLowerCase() === targetDirectory.toLowerCase() : resolve(directory) === targetDirectory)) {
      throw new Error('--config must select opencode.json/jsonc inside the chosen project (or its .opencode folder), or the global OpenCode directory.');
    }
  }
  return target;
}

/** Directory that bounds empty-directory pruning for a host target: the project root, or the Antigravity global config directory. */
export function uninstallPruneRoot(host: HostId, target: string, home: string): string | undefined {
  if (host === 'opencode') return undefined;
  if (host === 'antigravity' && resolve(target) === resolve(join(home, '.gemini', 'config', 'hooks.json'))) return dirname(target);
  return dirname(dirname(target));
}
