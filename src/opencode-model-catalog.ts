import { DiagnosticError, cliQuery, decodeRows, type Query, type RuntimeOptions } from './native-diagnostics.ts';
import { configuredModels, type Ask, type ConfigSource, type ModelChoices } from './native-installer.ts';

export type ModelDiscovery = (options: RuntimeOptions) => Promise<string[]>;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Reads the runtime model catalog only: never sends model requests or claims entitlement. */
export async function discoverOpenCodeModels(options: RuntimeOptions, query: Query = cliQuery(options)): Promise<string[]> {
  const models = new Set<string>();
  for (const row of decodeRows(await query('/api/model'), options.directory, 'models')) {
    if (row.enabled !== true) continue;
    const base = `${row.providerID}/${row.id}`;
    models.add(base);
    for (const variant of row.variants as unknown[]) if (object(variant) && typeof variant.id === 'string') models.add(`${base}#${variant.id}`);
  }
  return [...models].sort();
}

/**
 * Lists model choices for per-role assignment, from the live catalog when the user agrees to query it.
 * Unavailable discovery falls back to configured IDs with an explicit notice; it never selects a model.
 */
export async function chooseModelCatalog(sources: readonly ConfigSource[], runtime: RuntimeOptions, ask: Ask, output: (message: string) => void, discover: ModelDiscovery = discoverOpenCodeModels): Promise<ModelChoices> {
  const query = /^(y|yes)$/i.test((await ask('Query the live OpenCode model catalog? (read-only; may start the OpenCode service; sends no model requests)', 'yes')).trim() || 'yes');
  if (query) {
    try {
      const choices = await discover(runtime);
      output('\nLive OpenCode catalog models (listed by OpenCode; not proof of account entitlement or successful access):');
      choices.forEach((model, index) => output(`  ${index + 1}. ${model}`));
      if (!choices.length) output('  None enabled. Any model you enter will need explicit confirmation.');
      output('Each role requires your choice. Enter a listed number or provider/model#variant; Enter accepts the shown suggestion.');
      output('A model or variant absent from this catalog is saved only if you type keep; nothing is substituted.');
      return { choices, live: new Set(choices) };
    } catch (error) {
      output(`\nLive model discovery unavailable: ${error instanceof DiagnosticError ? error.message : 'the OpenCode catalog could not be read.'}`);
      output('Falling back to configured model IDs; selections cannot be checked against the live catalog.');
    }
  } else {
    output('\nLive model discovery skipped; selections cannot be checked against the live catalog.');
  }
  const choices = configuredModels(sources);
  output('Configured model IDs (not proof of account access):');
  choices.forEach((model, index) => output(`  ${index + 1}. ${model}`));
  if (!choices.length) output('  None declared. Enter IDs verified in OpenCode /models.');
  output('Each role requires your choice. Enter a listed number or provider/model#variant; Enter accepts the shown suggestion.');
  output('Unknown account access/variants must be checked in /models. Spark previously failed with the tested ChatGPT account.');
  return { choices };
}
