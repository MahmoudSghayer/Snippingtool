// The `authenticate` decorator is the single seam both dashboard (httpOnly
// cookie `sl_at`) and extension (bearer `Authorization: Bearer <token>`)
// clients go through — see docs/04-auth.md "two client shapes, one
// decorator". It verifies the EdDSA access token, then re-checks the
// embedded `ver` claim against the user's *current* `row_version` so a
// force-logout / password change invalidates already-issued access tokens
// immediately rather than waiting out their 15-minute TTL.
//
// `requirePermission(permission)` builds on top of `authenticate`: it also
// requires the caller to be an admin (role='admin' AND an admin_users row)
// whose `admin_role` grants that permission per @sl/shared's PERMISSION_MATRIX,
// and — per PHASE 4 — that the admin's session was itself established with
// 2FA (admin login always requires TOTP, enforced in modules/auth, so simply
// requiring role==='admin' here is sufficient; no separate step-up needed
// mid-session).

import { eq } from 'drizzle-orm';
import fp from 'fastify-plugin';

import { adminUsers, users } from '@sl/db';
import { hasPermission, isAdminRole, type Permission } from '@sl/shared';

import { AppErrors } from '../lib/errors.js';
import { verifyAccessToken, type AccessTokenClaims } from '../lib/tokens.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface AuthUser {
  id: string;
  role: 'user' | 'admin';
  plan: string | null;
  sessionId: string;
  deviceId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    authMethod?: 'bearer' | 'cookie';
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (permission: Permission) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function extractToken(request: FastifyRequest): { token: string; method: 'bearer' | 'cookie' } | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return { token: header.slice('Bearer '.length), method: 'bearer' };
  }
  const cookieToken = request.cookies?.sl_at;
  if (cookieToken) {
    return { token: cookieToken, method: 'cookie' };
  }
  return null;
}

export default fp(
  async function authPlugin(fastify: FastifyInstance) {
    fastify.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply) => {
      const found = extractToken(request);
      if (!found) throw AppErrors.tokenInvalid('Missing credentials.');

      let claims: AccessTokenClaims;
      try {
        const publicKey = fastify.config.JWT_PUBLIC_KEY;
        if (!publicKey) throw AppErrors.internal('JWT_PUBLIC_KEY is not configured.');
        claims = await verifyAccessToken(found.token, publicKey);
      } catch (err) {
        if (err instanceof Error && err.name === 'JWTExpired') throw AppErrors.tokenExpired();
        if (err && typeof err === 'object' && 'status' in err) throw err;
        throw AppErrors.tokenInvalid();
      }

      const user = await fastify.db.query.users.findFirst({ where: eq(users.id, claims.sub) });
      if (!user || user.deletedAt) throw AppErrors.tokenInvalid('Account no longer exists.');
      if (user.status === 'banned' || user.status === 'suspended') throw AppErrors.forbidden('Account is not active.');
      if (user.rowVersion !== claims.ver) throw AppErrors.sessionRevoked();

      request.authUser = {
        id: user.id,
        role: user.role,
        plan: claims.plan,
        sessionId: claims.sid,
        deviceId: claims.did,
      };
      request.authMethod = found.method;
    });

    fastify.decorate('requireAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
      await fastify.authenticate(request, reply);
      if (request.authUser?.role !== 'admin') throw AppErrors.forbidden('Admin access required.');
    });

    fastify.decorate('requirePermission', (permission: Permission) => {
      return async (request: FastifyRequest, reply: FastifyReply) => {
        await fastify.requireAdmin(request, reply);
        const adminRow = await fastify.db.query.adminUsers.findFirst({
          where: eq(adminUsers.userId, request.authUser!.id),
        });
        if (!adminRow || adminRow.deletedAt || !isAdminRole(adminRow.adminRole) || !hasPermission(adminRow.adminRole, permission)) {
          throw AppErrors.forbidden(`Missing permission: ${permission}`);
        }
      };
    });
  },
  { name: 'auth', dependencies: ['config', 'db', 'cookie'] },
);
