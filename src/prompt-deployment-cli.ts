import type { PromptDeploymentFlowOptions } from './prompt-deployment-flow.ts';

export function parsePromptDeploymentArgs(args: string[]): PromptDeploymentFlowOptions {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !['--scope', '--project', '--config'].includes(flag) || !value || value.startsWith('--') || parsed[flag]) throw new Error('Unknown, duplicate, or incomplete option. Run --help.');
    parsed[flag] = value;
  }
  if (parsed['--scope'] && !['project', 'global'].includes(parsed['--scope'])) throw new Error('--scope must be project or global');
  return {
    ...(parsed['--scope'] ? { scope: parsed['--scope'] } : {}),
    ...(parsed['--project'] ? { project: parsed['--project'] } : {}),
    ...(parsed['--config'] ? { config: parsed['--config'] } : {})
  };
}
