import { basename, dirname, join, resolve } from 'node:path';
import { chooseConfiguration, discoverConfigurations, projectConfiguration } from './native-installer.ts';

export type UninstallTargetOptions = {
  scope?: string;
  project?: string;
  config?: string;
  home: string;
  cwd: string;
  xdgConfigHome?: string;
};

export function selectUninstallTarget(options: UninstallTargetOptions): string {
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
