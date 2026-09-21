// Auth module — /api/v1/auth/*. See docs/04-auth.md for the full flow
// diagrams; this file is just HTTP wiring around modules/auth/service.ts.

import {
  changePasswordRequestSchema,
  deviceFingerprintSchema,
  emailVerifyRequestSchema,
  loginRequestSchema,
  loginResponseSchema,
  logoutRequestSchema,
  mfaEnrollConfirmSchema,
  mfaEnrollResponseSchema,
  mfaVerifyRequestSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  refreshRequestSchema,
  refreshResponseSchema,
  registerRequestSchema,
  registerResponseSchema,
  resendVerificationRequestSchema,
} from '@sl/shared';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { resolveCookieAttrs, type ResolvedCookieAttrs } from '../../lib/cookie-options.js';
import { AppErrors } from '../../lib/errors.js';

import * as service from './service.js';

import type { AuthContext } from './service.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

function ctx(fastify: FastifyInstance): AuthContext {
  if (!fastify.config.JWT_PRIVATE_KEY)
    throw AppErrors.internal('JWT_PRIVATE_KEY is not configured.');
  return {
    db: fastify.db,
    redis: fastify.redis,
    entitlements: fastify.entitlements,
    mailer: fastify.mailer,
    jwtPrivateKey: fastify.config.JWT_PRIVATE_KEY,
    cookieSecret: fastify.config.COOKIE_SECRET,
    log: fastify.log,
    // Defect #5 fix (docs/12-testing.md "Defects found"): same two env vars
    // `plugins/rate-limit.ts` already reads for this route's HTTP-level
    // limiter (`loginRateLimit` below, `config: { rateLimit: ... }`) — one
    // vocabulary for "how many login attempts per window", not two.
    loginRateLimit: {
      max: fastify.config.RATE_LIMIT_LOGIN_MAX,
      windowMs: fastify.config.RATE_LIMIT_LOGIN_WINDOW_MS,
    },
  };
}

function clientIp(request: FastifyRequest): string | null {
  return request.ip ?? null;
}

/** Dashboard clients get httpOnly cookies; the extension gets the tokens in
 * the JSON body. Both are always returned in the body (the extension needs
 * that; the dashboard's fetch wrapper ignores the body and relies on the
 * cookie) — this keeps one response shape for both client types, matching
 * `loginResponseSchema`. */
function setSessionCookies(
  reply: FastifyReply,
  accessToken: string,
  refreshToken: string,
  cookieAttrs: ResolvedCookieAttrs,
  accessTokenMaxAgeSeconds: number,
) {
  reply.setCookie('sl_at', accessToken, {
    httpOnly: true,
    sameSite: cookieAttrs.sameSite,
    secure: cookieAttrs.secure,
    path: '/',
    // Matches the JWT's own `exp` (shorter for an admin session — see
    // lib/tokens.ts's `accessTokenTtlSeconds`) so the cookie never outlives
    // the token it carries.
    maxAge: accessTokenMaxAgeSeconds,
  });
  reply.setCookie('sl_rt', refreshToken, {
    httpOnly: true,
    sameSite: cookieAttrs.sameSite,
    secure: cookieAttrs.secure,
    path: '/api/v1/auth',
    maxAge: 30 * 24 * 60 * 60,
  });
}

function clearSessionCookies(reply: FastifyReply) {
  reply.clearCookie('sl_at', { path: '/' });
  reply.clearCookie('sl_rt', { path: '/api/v1/auth' });
}

export default fp(
  async function authModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();
    const cookieAttrs = resolveCookieAttrs(fastify.config);
    const loginRateLimit = {
      max: fastify.config.RATE_LIMIT_LOGIN_MAX,
      timeWindow: fastify.config.RATE_LIMIT_LOGIN_WINDOW_MS,
    };

    app.post(
      '/api/v1/auth/register',
      {
        config: { rateLimit: loginRateLimit },
        schema: {
          tags: ['auth'],
          body: registerRequestSchema,
          response: { 201: registerResponseSchema },
        },
      },
      async (request, reply) => {
        const result = await service.register(ctx(fastify), request.body);
        reply.status(201);
        return result;
      },
    );

    app.post(
      '/api/v1/auth/verify-email',
      {
        schema: {
          tags: ['auth'],
          body: emailVerifyRequestSchema,
          response: { 200: z.object({ verified: z.literal(true) }) },
        },
      },
      async (request) => {
        await service.verifyEmail(ctx(fastify), request.body.token);
        return { verified: true as const };
      },
    );

    app.post(
      '/api/v1/auth/resend-verification',
      {
        config: { rateLimit: loginRateLimit },
        schema: {
          tags: ['auth'],
          body: resendVerificationRequestSchema,
          response: { 200: z.object({ sent: z.literal(true) }) },
        },
      },
      async (request) => {
        await service.resendVerification(ctx(fastify), request.body.email.trim().toLowerCase());
        return { sent: true as const };
      },
    );

    app.post(
      '/api/v1/auth/login',
      {
        config: { rateLimit: loginRateLimit },
        schema: {
          tags: ['auth'],
          body: loginRequestSchema,
          response: { 200: loginResponseSchema },
        },
      },
      async (request, reply) => {
        const result = await service.login(
          ctx(fastify),
          request.body,
          clientIp(request),
          request.headers['user-agent'] ?? null,
        );
        if (result.status === 'ok')
          setSessionCookies(
            reply,
            result.accessToken,
            result.refreshToken,
            cookieAttrs,
            result.expiresIn,
          );
        return result;
      },
    );

    app.post(
      '/api/v1/auth/mfa/verify',
      {
        config: { rateLimit: loginRateLimit },
        schema: {
          tags: ['auth'],
          body: mfaVerifyRequestSchema,
          response: { 200: loginResponseSchema.options[0] },
        },
      },
      async (request, reply) => {
        const result = await service.mfaVerify(ctx(fastify), request.body);
        setSessionCookies(
          reply,
          result.accessToken,
          result.refreshToken,
          cookieAttrs,
          result.expiresIn,
        );
        return result;
      },
    );

    app.post(
      '/api/v1/auth/refresh',
      {
        schema: {
          tags: ['auth'],
          body: refreshRequestSchema.partial(),
          response: { 200: refreshResponseSchema },
        },
      },
      async (request, reply) => {
        const token = request.body.refreshToken ?? request.cookies.sl_rt;
        if (!token) throw AppErrors.tokenInvalid('No refresh token provided.');
        const result = await service.refresh(ctx(fastify), token, {
          userAgent: request.headers['user-agent'] ?? null,
          device: request.body.device ?? null,
        });
        setSessionCookies(
          reply,
          result.accessToken,
          result.refreshToken,
          cookieAttrs,
          result.expiresIn,
        );
        return result;
      },
    );

    app.post(
      '/api/v1/auth/logout',
      {
        schema: {
          tags: ['auth'],
          body: logoutRequestSchema.partial(),
          response: { 200: z.object({ ok: z.literal(true) }) },
        },
      },
      async (request, reply) => {
        const token = request.body.refreshToken ?? request.cookies.sl_rt;
        if (request.body.allDevices) {
          const decoded = await fastify.tryAuthenticate(request);
          if (decoded) await service.logoutAll(ctx(fastify), decoded.id);
        } else {
          await service.logout(ctx(fastify), token);
        }
        clearSessionCookies(reply);
        return { ok: true as const };
      },
    );

    app.post(
      '/api/v1/auth/logout-all',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        schema: { tags: ['auth'], response: { 200: z.object({ ok: z.literal(true) }) } },
      },
      async (request, reply) => {
        await service.logoutAll(ctx(fastify), request.authUser!.id);
        clearSessionCookies(reply);
        return { ok: true as const };
      },
    );

    app.post(
      '/api/v1/auth/password/reset-request',
      {
        config: { rateLimit: loginRateLimit },
        schema: {
          tags: ['auth'],
          body: passwordResetRequestSchema,
          response: { 200: z.object({ sent: z.literal(true) }) },
        },
      },
      async (request) => {
        await service.requestPasswordReset(ctx(fastify), request.body.email, clientIp(request));
        return { sent: true as const };
      },
    );

    app.post(
      '/api/v1/auth/password/reset-confirm',
      {
        schema: {
          tags: ['auth'],
          body: passwordResetConfirmSchema,
          response: { 200: z.object({ ok: z.literal(true) }) },
        },
      },
      async (request) => {
        await service.confirmPasswordReset(ctx(fastify), request.body.token, request.body.password);
        return { ok: true as const };
      },
    );

    app.post(
      '/api/v1/auth/password/change',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['auth'],
          body: changePasswordRequestSchema,
          response: { 200: z.object({ ok: z.literal(true) }) },
        },
      },
      async (request) => {
        await service.changePassword(
          ctx(fastify),
          request.authUser!.id,
          request.body.currentPassword,
          request.body.newPassword,
        );
        return { ok: true as const };
      },
    );

    // --- TOTP enrollment ---------------------------------------------------
    // Accepts EITHER an authenticated session (a normal user opting into
    // 2FA) OR an `mfaTicket` in the body (an admin bootstrapping mandatory
    // 2FA before their first login can complete — see docs/04-auth.md,
    // "admin 2FA enrollment").

    const enrollStartBody = z.object({ mfaTicket: z.string().min(1).optional() });

    app.post(
      '/api/v1/auth/totp/enroll',
      {
        schema: {
          tags: ['auth'],
          body: enrollStartBody,
          response: { 200: mfaEnrollResponseSchema },
        },
      },
      async (request) => {
        const authUser = await fastify.tryAuthenticate(request);
        const userId = await service.resolveEnrollmentSubject(
          ctx(fastify),
          authUser?.id,
          request.body.mfaTicket,
        );
        const user = await fastify.db.query.users.findFirst({
          where: (u, { eq }) => eq(u.id, userId),
        });
        if (!user) throw AppErrors.notFound('user');
        return service.beginTotpEnrollment(ctx(fastify), userId, user.email);
      },
    );

    const enrollConfirmBody = mfaEnrollConfirmSchema.extend({
      mfaTicket: z.string().min(1).optional(),
    });

    app.post(
      '/api/v1/auth/totp/enroll/confirm',
      {
        schema: {
          tags: ['auth'],
          body: enrollConfirmBody,
          response: {
            200: z.object({
              enabled: z.literal(true),
              tokens: z
                .object({
                  accessToken: z.string(),
                  refreshToken: z.string(),
                  expiresIn: z.number(),
                })
                .optional(),
            }),
          },
        },
      },
      async (request, reply) => {
        const authUser = await fastify.tryAuthenticate(request);
        const userId = await service.resolveEnrollmentSubject(
          ctx(fastify),
          authUser?.id,
          request.body.mfaTicket,
        );
        const result = await service.confirmTotpEnrollment(
          ctx(fastify),
          userId,
          request.body.code,
          request.body.mfaTicket,
        );
        if (result.tokens)
          setSessionCookies(
            reply,
            result.tokens.accessToken,
            result.tokens.refreshToken,
            cookieAttrs,
            result.tokens.expiresIn,
          );
        return { enabled: true as const, tokens: result.tokens };
      },
    );

    app.post(
      '/api/v1/auth/totp/disable',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['auth'],
          body: z.object({ currentPassword: z.string().min(1), code: z.string().min(6).max(64) }),
          response: { 200: z.object({ disabled: z.literal(true) }) },
        },
      },
      async (request) => {
        await service.disableTotp(
          ctx(fastify),
          request.authUser!.id,
          request.body.currentPassword,
          request.body.code,
        );
        return { disabled: true as const };
      },
    );

    // Device registration is folded into login/mfa-verify per the device
    // fingerprint carried in loginRequestSchema/registerRequestSchema; this
    // extra endpoint covers re-registering/refreshing a device's metadata
    // from an already-authenticated session without a full re-login
    // (extension calls it after a token refresh if its fingerprint inputs
    // changed, e.g. a browser update).
    app.post(
      '/api/v1/auth/device/register',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['auth'],
          body: deviceFingerprintSchema,
          response: { 200: z.object({ deviceId: z.string().uuid() }) },
        },
      },
      async (request) => {
        const { findOrRegisterDevice } = await import('../../lib/devices.js');
        const { id } = await findOrRegisterDevice(
          fastify.db,
          fastify.entitlements,
          request.authUser!.id,
          request.body,
          clientIp(request),
        );
        return { deviceId: id };
      },
    );
  },
  { name: 'module:auth', dependencies: ['auth', 'db', 'redis', 'entitlements', 'mailer', 'csrf'] },
);
