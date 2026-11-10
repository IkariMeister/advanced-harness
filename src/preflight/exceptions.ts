export type SecretException = { path: string; rule: string; justification: string; line?: number; origin?: 'committed' | 'staged' | 'unstaged' | 'untracked' };

export function normalizeExceptionPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function validateSecretExceptions(exceptions: readonly SecretException[]): void {
  for (const exception of exceptions) {
    const path = exception?.path;
    const rule = exception?.rule;
    const justification = exception?.justification;
    if (typeof path !== 'string' || !path || typeof rule !== 'string' || !rule.trim() || typeof justification !== 'string' || !justification.trim() || (exception.line !== undefined && (!Number.isSafeInteger(exception.line) || exception.line < 1 || !['committed', 'staged', 'unstaged', 'untracked'].includes(exception.origin ?? ''))) || /[\u0000-\u001f\u007f]/.test(path) || /[\u0000-\u001f\u007f]/.test(rule)) throw new Error('Secret exceptions require a safe exact path/rule, optional positive line with scan origin, and nonblank justification.');
    const normalized = normalizeExceptionPath(path);
    if (!normalized.trim()) throw new Error('Secret exception paths must be nonempty repository-relative paths.');
    if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').includes('..')) throw new Error('Secret exception paths must be exact repository-relative paths.');
  }
}
