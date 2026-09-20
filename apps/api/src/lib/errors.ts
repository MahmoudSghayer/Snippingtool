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
  forbidden: (message = 'You do not have permission to do that.') => new AppError('FORBIDDEN', message),
  conflict: (message: string, details?: Record<string, unknown>) => new AppError('CONFLICT', message, details),
  internal: (message = 'Internal server error') => new AppError('INTERNAL', message),
  invalidCredentials: () => new AppError('AUTH_INVALID_CREDENTIALS', 'Invalid email or password.'),
  emailNotVerified: () => new AppError('AUTH_EMAIL_NOT_VERIFIED', 'Please verify your email before logging in.'),
  mfaRequired: () => new AppError('AUTH_MFA_REQUIRED', 'Two-factor authentication is required.'),
  mfaInvalid: () => new AppError('AUTH_MFA_INVALID', 'Invalid two-factor code.'),
  accountLocked: (retryAfterSeconds: number) =>
    new AppError('AUTH_ACCOUNT_LOCKED', 'Account temporarily locked due to failed login attempts.', {
      retryAfterSeconds,
    }),
  tokenExpired: () => new AppError('AUTH_TOKEN_EXPIRED', 'Token has expired.'),
  tokenInvalid: (message = 'Invalid token.') => new AppError('AUTH_TOKEN_INVALID', message),
  tokenReused: () => new AppError('AUTH_TOKEN_REUSED', 'Refresh token reuse detected; session family revoked.'),
  sessionRevoked: () => new AppError('AUTH_SESSION_REVOKED', 'Session has been revoked.'),
  deviceLimitReached: (devices: unknown) =>
    new AppError('DEVICE_LIMIT_REACHED', 'Device limit reached for your plan.', { devices }),
  deviceNotFound: () => new AppError('DEVICE_NOT_FOUND', 'Device not found.'),
  rateLimited: (retryAfterSeconds?: number) =>
    new AppError('RATE_LIMITED', 'Too many requests.', retryAfterSeconds ? { retryAfterSeconds } : undefined),
  killSwitchActive: () => new AppError('KILL_SWITCH_ACTIVE', 'The kill switch is active.'),
};

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
