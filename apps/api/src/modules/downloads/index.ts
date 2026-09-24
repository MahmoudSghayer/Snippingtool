// /api/v1/downloads/extension — the Nova Trade extension (`ledger-auto`, the
// build with the autobuyer), as a zip to load unpacked in Chrome. It isn't on
// the Chrome Web Store, so this is how a paying user installs it. Only an
// account whose pass includes the autobuyer can download it. See
// lib/extension-download.ts for how the zip is built for this deployment.

import fp from 'fastify-plugin';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { AppError, AppErrors } from '../../lib/errors.js';
import {
  ExtensionKeyUnavailableError,
  getExtensionPackage,
  type ExtensionPackage,
} from '../../lib/extension-download.js';

import type { FastifyInstance } from 'fastify';

const REQUIRED_FEATURE = 'automation.autobuyer';

export default fp(
  async function downloadsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    /** The zip, `null` without a template build, or `'no-key'` when there
     * is no usable Ed25519 ENTITLEMENT_PUBLIC_KEY to put in it (logged as an
     * error: the operator has to fix the configuration). */
    let keyErrorLogged = false;
    const loadPackage = (log: FastifyInstance['log']): ExtensionPackage | null | 'no-key' => {
      try {
        return getExtensionPackage({
          templateDir: fastify.config.EXTENSION_TEMPLATE_DIR,
          apiOrigin: fastify.config.APP_ORIGIN,
          dashboardOrigin: fastify.config.DASHBOARD_ORIGIN,
          entitlementPublicKeyPem: fastify.config.ENTITLEMENT_PUBLIC_KEY,
        });
      } catch (err) {
        if (!(err instanceof ExtensionKeyUnavailableError)) throw err;
        // Once per process at error level (the operator must fix the
        // configuration); /info is polled by every account page, so after
        // that only at debug.
        if (!keyErrorLogged) {
          keyErrorLogged = true;
          log.error({ err }, err.message);
        } else {
          log.debug({ err }, err.message);
        }
        return 'no-key';
      }
    };

    const isEntitled = async (userId: string) =>
      (await fastify.entitlements.getEntitlements(userId)).features.includes(REQUIRED_FEATURE);

    app.get(
      '/api/v1/downloads/extension/info',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['downloads'],
          summary: 'Whether the extension can be downloaded, and which version.',
          response: {
            200: z.object({
              available: z.boolean(),
              entitled: z.boolean(),
              version: z.string().nullable(),
              sizeBytes: z.number().int().nullable(),
            }),
          },
        },
      },
      async (request) => {
        const loaded = loadPackage(request.log);
        const pkg = loaded === 'no-key' ? null : loaded;
        return {
          available: pkg !== null,
          entitled: await isEntitled(request.authUser!.id),
          version: pkg?.version ?? null,
          sizeBytes: pkg?.zip.byteLength ?? null,
        };
      },
    );

    app.get(
      '/api/v1/downloads/extension',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['downloads'],
          summary: 'Download the Nova Trade extension (zip). Requires an active pass.',
        },
      },
      async (request, reply) => {
        if (!(await isEntitled(request.authUser!.id))) {
          throw AppErrors.forbidden('Downloading the extension needs an active pass.');
        }
        const pkg = loadPackage(request.log);
        if (pkg === 'no-key') {
          throw new AppError(
            'SERVICE_UNAVAILABLE',
            'The extension download is not configured on this server yet.',
          );
        }
        if (!pkg) throw AppErrors.notFound('extension download');

        return reply
          .header('content-type', 'application/zip')
          .header('content-disposition', `attachment; filename="${pkg.fileName}"`)
          .header('cache-control', 'private, no-store')
          .send(Buffer.from(pkg.zip));
      },
    );
  },
  { name: 'module:downloads', dependencies: ['auth', 'config', 'entitlements'] },
);
