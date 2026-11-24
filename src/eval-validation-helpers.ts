export const SCENARIO_ID_RE = /^EDD-(DEV|VAL)-[0-9]{3,}$/;
export const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
export const ISO_8601_CAPTURE_RE =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:Z|([+-][0-9]{2}):([0-9]{2}))$/;

/** Validates an ISO 8601 timestamp string including calendar date and offset bounds. */
export function isValidIso8601Timestamp(value: string): boolean {
  const match = ISO_8601_CAPTURE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return false;
  }
  if (match[7] !== undefined && match[8] !== undefined) {
    const offHour = Math.abs(Number(match[7]));
    const offMin = Number(match[8]);
    if (offHour > 23 || offMin > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertObject(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value;
}

export function assertAllowedKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in obj)) {
      throw new Error(`${path}.${key} is required.`);
    }
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`${path}.${key} is not an allowed property.`);
    }
  }
}

export function assertNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
}

export function assertRegexString(
  value: unknown,
  pattern: RegExp,
  message: string,
  path: string,
): string {
  const s = assertNonEmptyString(value, path);
  if (!pattern.test(s)) {
    throw new Error(`${path} ${message}.`);
  }
  return s;
}

export function assertSemver(value: unknown, path: string): string {
  const s = assertNonEmptyString(value, path);
  if (!SEMVER_RE.test(s)) {
    throw new Error(`${path} must be a semantic version (MAJOR.MINOR.PATCH).`);
  }
  return s;
}

export function assertScenarioId(value: unknown, path: string): string {
  const s = assertNonEmptyString(value, path);
  if (!SCENARIO_ID_RE.test(s)) {
    throw new Error(`${path} must match EDD-(DEV|VAL)-NNN.`);
  }
  return s;
}

export function assertBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean.`);
  }
  return value;
}

export function assertNonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative finite number.`);
  }
  return value;
}

export function assertInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${path} must be an integer.`);
  }
  return value;
}

export function assertIntegerMin(value: unknown, min: number, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`${path} must be an integer >= ${min}.`);
  }
  return value;
}

export function assertNonNegativeInteger(value: unknown, path: string): number {
  const n = assertInteger(value, path);
  if (n < 0) {
    throw new Error(`${path} must be a non-negative integer.`);
  }
  return n;
}

export function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  const s = assertNonEmptyString(value, path);
  if (!allowed.includes(s as T)) {
    throw new Error(`${path} must be one of: ${allowed.join(', ')}.`);
  }
  return s as T;
}

export function assertStringArray(
  value: unknown,
  path: string,
  options: { minItems?: number } = {},
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  if (options.minItems !== undefined && value.length < options.minItems) {
    throw new Error(`${path} must contain at least ${options.minItems} item(s).`);
  }
  return value.map((item, idx) => assertNonEmptyString(item, `${path}[${idx}]`));
}

export function assertEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value.map((item, idx) => assertEnum(item, allowed, `${path}[${idx}]`));
}

export function assertUniqueEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  minItems = 0,
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  if (value.length < minItems) {
    throw new Error(`${path} must contain at least ${minItems} item(s).`);
  }
  const seen = new Set<T>();
  return value.map((item, idx) => {
    const parsed = assertEnum(item, allowed, `${path}[${idx}]`);
    if (seen.has(parsed)) {
      throw new Error(`${path} contains duplicate item "${parsed}".`);
    }
    seen.add(parsed);
    return parsed;
  });
}
