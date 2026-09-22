/**
 * Every error code the API can return, plus the HTTP status it maps to.
 * Every error response uses the envelope in `schemas/api.ts`:
 * `{ code, message, details?, requestId }`, with `code` always one of these.
 */
export const ERROR_CODES = [
  // Auth
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_EMAIL_NOT_VERIFIED',
  'AUTH_MFA_REQUIRED',
  'AUTH_MFA_INVALID',
  'AUTH_ACCOUNT_LOCKED',
  'AUTH_TOKEN_EXPIRED',
  'AUTH_TOKEN_INVALID',
  'AUTH_TOKEN_REUSED',
  'AUTH_SESSION_REVOKED',
  // Devices / licensing
  'DEVICE_LIMIT_REACHED',
  'DEVICE_NOT_FOUND',
  'LICENSE_INVALID',
  'LICENSE_EXPIRED',
  'LICENSE_REVOKED',
  'SUBSCRIPTION_REQUIRED',
  'FEATURE_NOT_ENTITLED',
  'TRIAL_ABUSE_DETECTED',
  // Cross-cutting
  'RATE_LIMITED',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'FORBIDDEN',
  'CONFLICT',
  'INTERNAL',
  'KILL_SWITCH_ACTIVE',
  'MAINTENANCE_MODE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** HTTP status each error code is served with. Anything not listed here is a
 * bug — `apps/api`'s error handler asserts every thrown `AppError` has a
 * mapped status in its own tests. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_EMAIL_NOT_VERIFIED: 403,
  AUTH_MFA_REQUIRED: 401,
  AUTH_MFA_INVALID: 401,
  AUTH_ACCOUNT_LOCKED: 423,
  AUTH_TOKEN_EXPIRED: 401,
  AUTH_TOKEN_INVALID: 401,
  AUTH_TOKEN_REUSED: 401,
  AUTH_SESSION_REVOKED: 401,
  DEVICE_LIMIT_REACHED: 409,
  DEVICE_NOT_FOUND: 404,
  LICENSE_INVALID: 402,
  LICENSE_EXPIRED: 402,
  LICENSE_REVOKED: 402,
  SUBSCRIPTION_REQUIRED: 402,
  FEATURE_NOT_ENTITLED: 403,
  TRIAL_ABUSE_DETECTED: 403,
  RATE_LIMITED: 429,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  INTERNAL: 500,
  KILL_SWITCH_ACTIVE: 503,
  MAINTENANCE_MODE: 503,
};

export function statusForError(code: ErrorCode): number {
  return ERROR_STATUS[code];
}
