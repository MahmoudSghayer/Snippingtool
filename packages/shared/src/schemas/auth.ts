import { z } from 'zod';

/** Deliberately conservative: 12+ chars, at least one letter and one digit.
 * A breached-password check (HIBP k-anonymity) is applied server-side and is
 * feature-flagged, not encoded here — this schema is the client-visible
 * floor. */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(256)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a digit');

export const emailSchema = z.string().trim().toLowerCase().email().max(320);

export const deviceFingerprintSchema = z.object({
  fingerprint: z.string().min(16).max(256),
  name: z.string().min(1).max(120).optional(),
  browser: z.string().min(1).max(60).optional(),
  os: z.string().min(1).max(60).optional(),
  extensionVersion: z.string().min(1).max(30).optional(),
});
export type DeviceFingerprint = z.infer<typeof deviceFingerprintSchema>;

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  timezone: z.string().min(1).max(64).optional(),
  referralCode: z.string().min(1).max(40).optional(),
  device: deviceFingerprintSchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
  device: deviceFingerprintSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Returned by `/auth/login` when the account has TOTP enabled: no tokens
 * yet, just a short-lived ticket that must be exchanged via `mfaVerify`. */
export const loginResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresIn: z.number().int().positive(),
  }),
  z.object({
    status: z.literal('mfa_required'),
    mfaTicket: z.string().min(1),
    expiresIn: z.number().int().positive(),
  }),
]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const mfaVerifyRequestSchema = z.object({
  mfaTicket: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code').or(z.string().min(8).max(64)), // digit code or recovery code
});
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequestSchema>;

export const mfaEnrollResponseSchema = z.object({
  secret: z.string().min(1),
  otpauthUrl: z.string().url(),
  recoveryCodes: z.array(z.string().min(8)).length(10),
});
export type MfaEnrollResponse = z.infer<typeof mfaEnrollResponseSchema>;

export const mfaEnrollConfirmSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});
export type MfaEnrollConfirm = z.infer<typeof mfaEnrollConfirmSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const refreshResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
});
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

export const passwordResetRequestSchema = z.object({
  email: emailSchema,
});
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});
export type PasswordResetConfirm = z.infer<typeof passwordResetConfirmSchema>;

export const emailVerifyRequestSchema = z.object({
  token: z.string().min(1),
});
export type EmailVerifyRequest = z.infer<typeof emailVerifyRequestSchema>;

export const logoutRequestSchema = z.object({
  refreshToken: z.string().min(1).optional(), // omit to only clear the local session
  allDevices: z.boolean().default(false),
});
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
