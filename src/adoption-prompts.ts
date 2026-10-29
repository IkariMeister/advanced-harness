export type Prompt = (message: string) => Promise<string>;

const roles = ['lead','operator','external','researcher','planner','implementer','reviewer','qa'];

export function adoptionPreviewAction(change: { path: string[]; before: unknown }, removedPaths: string[] = []): string {
  if (removedPaths.includes(change.path.join('.'))) return `${change.path.join('.')}: remove explicitly adopted field; prior state unknown`;
  if (Object.hasOwn(change.before as object, 'absent')) return `${change.path.join('.')}: restore evidence-backed prior absence on later uninstall`;
  const value = (change.before as {value: unknown}).value;
  const summary = Array.isArray(value) ? `<array, ${value.length} entries>` : typeof value === 'string' ? `<string, ${value.length} chars>` : value && typeof value === 'object' ? `<object, ${Object.keys(value).length} keys>` : `<${typeof value}>`;
  return `${change.path.join('.')}: restore same-path supplied evidence ${summary} on later uninstall`;
}

export async function selectAdoptionFields(present: string[], hasEvidence: boolean, prompt: Prompt, warn: (message: string) => void = console.log) {
  const selected: string[] = [], removed: string[] = [], acknowledged: string[] = [];
  const bulk = (await prompt('Adopt all detected agent fields for removal? [y/N] ')).trim().toLowerCase();
  if (bulk === 'y' || bulk === 'yes') {
    const group = present.filter(key => key.startsWith('agents.'));
    warn('WARNING: ownership and history of these agent fields are unknown; explicitly adopted fields will be removed, and prior state remains unknown.');
    if (group.length && (await prompt('Acknowledge unknown history for all selected agent fields? Type acknowledge: ')).trim() === 'acknowledge') {
      removed.push(...group);
      acknowledged.push(...group);
    }
    if (hasEvidence) warn('Supplied evidence will be used only for same-path values; absent prior fields can be restored only when evidence supports that exact path.');
  } else {
    for (const role of roles) {
      const group = present.filter(key => key.startsWith(`agents.${role}.`));
      if (!group.length) continue;
      warn(`Detected ${role}: ${group.map(key => key.split('.').at(-1)).join(', ')}`);
      const answer = (await prompt(`For ${role}, keep unmanaged, adopt for removal, or restore evidenced prior values? [keep] `)).trim().toLowerCase();
      if (answer === 'restore') { if (hasEvidence) selected.push(...group); else warn('No before-config evidence supplied; keeping this agent unmanaged.'); }
      else if (answer === 'adopt' || answer === 'remove') {
        warn(`WARNING: history for ${role} is unknown; explicitly adopted fields will be removed, and prior state remains unknown.`);
        if ((await prompt(`Acknowledge unknown history for ${role}? Type acknowledge: `)).trim() === 'acknowledge') { removed.push(...group); acknowledged.push(...group); }
      }
    }
  }
  // Root defaults are never part of bulk adoption, and always get their own prompt.
  for (const key of ['default_agent','model']) {
    if (!present.includes(key)) continue;
    const answer = (await prompt(`Root setting ${key}: keep unmanaged, adopt for removal, or restore evidenced prior value? [keep] `)).trim().toLowerCase();
    if (answer === 'restore') { if (hasEvidence) selected.push(key); else warn('No before-config evidence supplied; keeping this root setting unmanaged.'); }
    else if (answer === 'adopt' || answer === 'remove') {
      warn(`WARNING: history for ${key} is unknown; explicitly adopted field will be removed, and prior state remains unknown.`);
      if ((await prompt(`Acknowledge unknown history for ${key}? Type acknowledge: `)).trim() === 'acknowledge') { removed.push(key); acknowledged.push(key); }
    }
  }
  return { selected, removed, acknowledged };
}
