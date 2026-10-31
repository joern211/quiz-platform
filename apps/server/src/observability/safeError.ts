const TYPED_ERRORS = new Set(['CoreRuleError', 'RoomError', 'InvalidGameAction', 'GameStateConflictError', 'ConfigSnapshotError']);
const SAFE_IDENTIFIER = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Stable machine identifiers only: wire message keys, error codes. */
export const isSafeIdentifier = (value: string): boolean => SAFE_IDENTIFIER.test(value);

/**
 * Diagnostic-safe description of a failure for the server log. Typed application errors
 * carry a stable code as their message; for anything else (database, library, runtime) only
 * the class name and a short machine code are kept. Their messages and enumerable extra fields
 * (`meta`, `args`, `response`, `cause`, …) can embed query arguments, paths, tokens or answers,
 * and "only in the server log" is no excuse.
 */
export function describeInternal(detail: unknown): Record<string, unknown> {
  if (!(detail instanceof Error)) return { type: typeof detail };
  const { code } = detail as { code?: unknown };
  const kind = detail.constructor?.name ?? detail.name;
  return {
    name: kind,
    ...(typeof code === 'string' && SAFE_IDENTIFIER.test(code) ? { code } : {}),
    ...(TYPED_ERRORS.has(kind) && SAFE_IDENTIFIER.test(detail.message) ? { message: detail.message } : {}),
  };
}

const ERROR_KEYS = new Set(['error', 'err', 'cause']); // internalDetail is already a description (appError.ts)

/**
 * JSON for a log line. Error objects anywhere in the metadata — and anything an error-named
 * key holds — are replaced by their safe description, so no call site can put a raw exception
 * (with its nested fields) into the log by passing `{ error }`.
 */
export function serializeLogMeta(meta: unknown): string {
  try {
    return JSON.stringify(meta, (key, value) =>
      value instanceof Error || (ERROR_KEYS.has(key) && value !== null && typeof value === 'object') ? describeInternal(value) : value) ?? '';
  } catch {
    return '"[unserializable metadata]"';
  }
}
