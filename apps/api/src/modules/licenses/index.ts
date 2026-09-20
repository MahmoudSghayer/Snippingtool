// GET /licenses/me, POST /licenses/regenerate (authenticated user), and
// POST /licenses/validate (device-based — the extension calls this with a
// license key + fingerprint, no user session).

import {
  entitlementSnapshotSchema,
  licenseDtoSchema,
  licenseValidateRequestSchema,
  regenerateLicenseResponseSchema,
} from '@sl/shared';
import fp from 'fastify-plugin';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { AppErrors } from '../../lib/errors.js';

import { findLatestForUser, regenerateForUser, validateLicense, type LicenseRow } from './service.js';

import type { FastifyInstance } from 'fastify';

function toLicenseDto(row: LicenseRow) {
  return {
    keyPrefix: row.keyPrefix,
    status: row.status,
    maxDevices: row.maxDevices,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}

export default fp(
  async function licensesModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/licenses/me',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['licenses'],
          summary: "Current user's license: key prefix + status only, never the full key.",
          response: { 200: licenseDtoSchema.nullable() },
        },
      },
      async (request) => {
        const license = await findLatestForUser(fastify.db, request.authUser!.id);
        return license ? toLicenseDto(license) : null;
      },
    );

    app.post(
      '/api/v1/licenses/regenerate',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['licenses'],
          summary: 'Revoke the current license and issue a new one. Returns the full key exactly once.',
          response: { 200: regenerateLicenseResponseSchema },
        },
      },
      async (request) => {
        const { row, fullKey } = await regenerateForUser(fastify.db, request.authUser!.id);
        return { licenseKey: fullKey, keyPrefix: row.keyPrefix };
      },
    );

    app.post(
      '/api/v1/licenses/validate',
      {
        // No `fastify.authenticate` — this is the extension's device-level
        // check-in, authenticated by the license key + device fingerprint
        // themselves, not a user session (docs/05-subscriptions.md §10).
        schema: {
          tags: ['licenses'],
          summary: 'Validate a license key for a device: status, entitlements, signed blob.',
          body: licenseValidateRequestSchema,
          response: {
            200: z.object({
              status: z.enum(['active', 'expired', 'revoked']),
              entitlements: entitlementSnapshotSchema,
              entitlementJws: z.string(),
            }),
          },
        },
      },
      async (request) => {
        if (!fastify.entitlements) throw AppErrors.internal('Entitlement provider not configured.');
        const result = await validateLicense(fastify.db, fastify.entitlements, {
          licenseKey: request.body.licenseKey,
          device: request.body.device,
        });
        return result;
      },
    );
  },
  { name: 'module:licenses', dependencies: ['auth', 'db', 'entitlements'] },
);
