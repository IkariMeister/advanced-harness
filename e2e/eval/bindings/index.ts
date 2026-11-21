// The approved deterministic bindings (U2, issue #226): exactly these four development scenarios. Adding a binding is a
// scoped change: the scenario must be approved, the binding file must record its verification, and
// test/eval-bindings.test.ts must cover it. No validation (holdout) scenario is bound.

import type { ScenarioBinding } from '../binding-support.ts';
import { binding as edd003 } from './EDD-DEV-003.ts';
import { binding as edd004 } from './EDD-DEV-004.ts';
import { binding as edd008 } from './EDD-DEV-008.ts';
import { binding as edd010 } from './EDD-DEV-010.ts';

export const BINDINGS: readonly ScenarioBinding[] = [edd003, edd004, edd008, edd010];

/** The binding for a scenario ID, or undefined when the scenario is unbound (it is then skipped). */
export function findBinding(scenarioIdentifier: string): ScenarioBinding | undefined {
  return BINDINGS.find(candidate => candidate.scenarioId === scenarioIdentifier);
}
