import { homedir } from 'node:os';
import { emptyLocationPlan } from './shared-locations.ts';
import { resolveProjectLocations } from './project-setup.ts';

export interface SharedLocationCheck {
  status: 'resolved' | 'not-configured' | 'conflict' | 'invalid';
  notes: string[];
  issues: string[];
}

/**
 * Read-only: reports what agents would resolve from this checkout and where it came from.
 * Missing settings are reported but never fail: agents stop and ask, so nothing can resolve wrongly.
 */
export function diagnoseSharedLocations(project: string, options: { home?: string } = {}): SharedLocationCheck {
  const resolution = resolveProjectLocations(project, options.home ?? homedir());
  if (resolution.status === 'missing') return { status: 'not-configured', notes: ['No shared locations are recorded in project context. Run harness:setup to choose them.'], issues: [] };
  if (resolution.status !== 'resolved') return { status: resolution.status, notes: [], issues: [`${resolution.reason} Run harness:update --change-shared-locations or harness:setup to resolve it.`] };
  const source = resolution.source === 'project' ? 'project section' : 'interim paths section';
  const line = (label: string, stored: string, resolved: string) => `${label}: ${resolved} (source: ${source}${stored === resolved ? ', saved as an absolute path' : `, saved as ${stored}`})`;
  const notes = [
    line('Worktree parent', resolution.stored.worktreeDirectory, resolution.locations.worktreeDirectory),
    line('Shared memory', resolution.stored.memoryPath, resolution.locations.memoryPath),
  ];
  if (!resolution.portable) notes.push('An absolute path is specific to this machine. Enter a $HOME/ path through harness:update --change-shared-locations to make it portable.');
  if (!emptyLocationPlan(resolution.plan)) notes.push('A configured location does not exist yet. Task bootstrap, harness:setup, or harness:update can create it.');
  return { status: 'resolved', notes, issues: [] };
}
