// Shared text helpers for the agent E2E support modules (BH-034, issue #62). Pure: no I/O, no state.

/**
 * Escapes RegExp metacharacters, and `/`, so the text matches literally inside `new RegExp(...)` (no `u` flag).
 */
export function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * The raw, forward-slash, JSON-escaped, and JSON-escaped forward-slash forms of a path, in that order, without
 * duplicates. Empty input yields no variants.
 */
export function pathVariants(path: string): string[] {
  if (path === '') return [];
  const forward = path.replaceAll('\\', '/');
  return [...new Set([path, forward, JSON.stringify(path).slice(1, -1), JSON.stringify(forward).slice(1, -1)])];
}
