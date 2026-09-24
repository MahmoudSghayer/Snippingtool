// AppError: the one error type every route/service in this app throws.
// src/plugins/error-handler.ts catches these (and zod validation errors,
// which it maps to VALIDATION_FAILED) and renders the `{ code, message,
// details?, requestId }` envelope from @sl/shared's apiErrorSchema.

import { ERROR_STATUS, type ErrorCode } from '@sl/shared';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

/** Convenience constructors for the most common cases, kept alongside the
 * class so call sites read `throw notFound('device')` rather than spelling
 * out the code every time. */
export const AppErrors = {
  validation: (message: string, details?: Record<string, unknown>) =>
    new AppError('VALIDATION_FAILED', message, details),
  notFound: (entity: string) => new AppError('NOT_FOUND', `${entity} not found`),
  forbidden: (message = 'You do not have permission to do that.') =>
    new AppError('FORBIDDEN', message),
  conflict: (message: string, details?: Record<string, unknown>) =>
    new AppError('CONFLICT', message, details),
  internal: (message = 'Internal server error') => new AppError('INTERNAL', message),
  invalidCredentials: () => new AppError('AUTH_INVALID_CREDENTIALS', 'Invalid email or password.'),
  emailNotVerified: () =>
    new AppError('AUTH_EMAIL_NOT_VERIFIED', 'Please verify your email before logging in.'),
  mfaRequired: () => new AppError('AUTH_MFA_REQUIRED', 'Two-factor authentication is required.'),
  mfaInvalid: () => new AppError('AUTH_MFA_INVALID', 'Invalid two-factor code.'),
  accountLocked: (retryAfterSeconds: number) =>
    new AppError(
      'AUTH_ACCOUNT_LOCKED',
      'Account temporarily locked due to failed login attempts.',
      {
        retryAfterSeconds,
      },
    ),
  tokenExpired: () => new AppError('AUTH_TOKEN_EXPIRED', 'Token has expired.'),
  tokenInvalid: (message = 'Invalid token.') => new AppError('AUTH_TOKEN_INVALID', message),
  tokenReused: () =>
    new AppError('AUTH_TOKEN_REUSED', 'Refresh token reuse detected; session family revoked.'),
  sessionRevoked: () => new AppError('AUTH_SESSION_REVOKED', 'Session has been revoked.'),
  deviceLimitReached: (devices: unknown) =>
    new AppError('DEVICE_LIMIT_REACHED', 'Device limit reached for your plan.', { devices }),
  deviceNotFound: () => new AppError('DEVICE_NOT_FOUND', 'Device not found.'),
  rateLimited: (retryAfterSeconds?: number) =>
    new AppError(
      'RATE_LIMITED',
      'Too many requests.',
      retryAfterSeconds ? { retryAfterSeconds } : undefined,
    ),
  killSwitchActive: () => new AppError('KILL_SWITCH_ACTIVE', 'The kill switch is active.'),
};

/**
 * `instanceof AppError` alone is not reliable across every module-loading
 * setup this repo runs under: a test runner that transforms/re-evaluates
 * part of a dependency graph (observed with `tests/security`, which loads
 * the built `@sl/api/app` through Vitest's own module runner) can end up
 * with two distinct `AppError` class objects — one this file's own
 * `throw new AppError(...)` call sites construct against, another
 * `error-handler.ts`'s `instanceof` check compares against — even though
 * both come from the same compiled file. When that happens `instanceof`
 * silently returns `false` and a clean 4xx AppError falls through to the
 * generic "Unhandled error" 500 branch, which is worse than a merely
 * cosmetic test failure: it turns an intentional 400/403/404 into a 500 in
 * whatever environment triggers the double-instantiation. This is
 * therefore duck-typed as a fallback: an object is treated as an AppError
 * if `instanceof` doesn't already confirm it AND it has the exact shape
 * this class always produces (`name === 'AppError'` plus a numeric
 * `status` and string `code`, both of which only this class's constructor
 * ever sets together).
 */
export function isAppError(error: unknown): error is AppError {
  if (error instanceof AppError) return true;
  if (!(error instanceof Error) || error.name !== 'AppError') return false;
  const candidate = error as AppError;
  return typeof candidate.status === 'number' && typeof candidate.code === 'string';
}

/** True when `err` is Postgres's unique_violation (23505). drizzle-orm wraps
 * the driver error in a `DrizzleQueryError`, so the code can be on `.code`
 * or on `.cause.code` (same unwrapping as modules/settings and
 * modules/payments/webhooks.ts). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return (e?.code ?? e?.cause?.code) === '23505';
}
