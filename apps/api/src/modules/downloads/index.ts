// /api/v1/downloads/extension — the Nova Trade extension (`ledger-auto`, the
// build with the autobuyer), as a zip to load unpacked in Chrome. It isn't on
// the Chrome Web Store, so this is how a paying user installs it. Only an
// account whose pass includes the autobuyer can download it. See
// lib/extension-download.ts for how the zip is built for this deployment.
//
// /api/v1/downloads/userscript/... — the same build as a Tampermonkey
// userscript, the optional one-click install. Tampermonkey fetches the
// script and its update checks without the user's session, so those two
// routes take a signed per-user token in the path (lib/userscript-token.ts)
// instead of authentication, and check the pass on every request: when it
// lapses, installs and updates get 403.

import { users } from '@sl/db';
import { and, eq, isNull } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { AppErrors } from '../../lib/errors.js';
import {
  getExtensionPackage,
  getUserscriptPackage,
  userscriptUrls,
} from '../../lib/extension-download.js';
import { signUserscriptToken, verifyUserscriptToken } from '../../lib/userscript-token.js';

import type { FastifyInstance } from 'fastify';

const REQUIRED_FEATURE = 'automation.autobuyer';

export default fp(
  async function downloadsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    const loadPackage = () =>
      getExtensionPackage({
        templateDir: fastify.config.EXTENSION_TEMPLATE_DIR,
        apiOrigin: fastify.config.APP_ORIGIN,
        dashboardOrigin: fastify.config.DASHBOARD_ORIGIN,
        entitlementPublicKeyPem: fastify.config.ENTITLEMENT_PUBLIC_KEY,
      });

    const isEntitled = async (userId: string) =>
      (await fastify.entitlements.getEntitlements(userId)).features.includes(REQUIRED_FEATURE);

    const loadUserscript = () =>
      getUserscriptPackage({
        userscriptTemplateDir: fastify.config.USERSCRIPT_TEMPLATE_DIR,
        apiOrigin: fastify.config.APP_ORIGIN,
        dashboardOrigin: fastify.config.DASHBOARD_ORIGIN,
        entitlementPublicKeyPem: fastify.config.ENTITLEMENT_PUBLIC_KEY,
      });

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
        const pkg = loadPackage();
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
        const pkg = loadPackage();
        if (!pkg) throw AppErrors.notFound('extension download');

        return reply
          .header('content-type', 'application/zip')
          .header('content-disposition', `attachment; filename="${pkg.fileName}"`)
          .header('cache-control', 'private, no-store')
          .send(Buffer.from(pkg.zip));
      },
    );

    app.get(
      '/api/v1/downloads/userscript/link',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['downloads'],
          summary:
            "The signed-in user's Tampermonkey install link. The script behind it is served only while their pass is active.",
          response: { 200: z.object({ installUrl: z.string().url() }) },
        },
      },
      async (request) => {
        const token = signUserscriptToken(request.authUser!.id, fastify.config.COOKIE_SECRET);
        return { installUrl: userscriptUrls(fastify.config.APP_ORIGIN, token).install };
      },
    );

    /** The user a download token belongs to, if it is genuine, the account
     * is live and its pass includes the autobuyer. Throws 403 otherwise. */
    async function authorizeToken(token: string): Promise<void> {
      const userId = verifyUserscriptToken(token, fastify.config.COOKIE_SECRET);
      if (!userId) throw AppErrors.forbidden('This install link is not valid.');
      const user = await fastify.db.query.users.findFirst({
        where: and(eq(users.id, userId), isNull(users.deletedAt)),
        columns: { id: true, status: true },
      });
      if (!user || user.status !== 'active') throw AppErrors.forbidden('This install link is not valid.');
      if (!(await isEntitled(userId))) {
        throw AppErrors.forbidden('The Nova Trade userscript needs an active pass.');
      }
    }

    const tokenParams = z.object({ token: z.string().min(1).max(200) });

    app.get(
      '/api/v1/downloads/userscript/:token/nova-trade.user.js',
      {
        schema: {
          tags: ['downloads'],
          summary:
            'The Nova Trade userscript for Tampermonkey (signed per-user link). Requires an active pass.',
          params: tokenParams,
        },
      },
      async (request, reply) => {
        await authorizeToken(request.params.token);
        const pkg = loadUserscript();
        if (!pkg) throw AppErrors.notFound('userscript download');
        return reply
          .header('content-type', 'text/javascript; charset=utf-8')
          .header('cache-control', 'private, no-store')
          .send(pkg.script(request.params.token));
      },
    );

    app.get(
      '/api/v1/downloads/userscript/:token/nova-trade.meta.js',
      {
        schema: {
          tags: ['downloads'],
          summary:
            "The userscript's header, which Tampermonkey polls for updates (signed per-user link). Requires an active pass.",
          params: tokenParams,
        },
      },
      async (request, reply) => {
        await authorizeToken(request.params.token);
        const pkg = loadUserscript();
        if (!pkg) throw AppErrors.notFound('userscript download');
        return reply
          .header('content-type', 'text/javascript; charset=utf-8')
          .header('cache-control', 'private, no-store')
          .send(pkg.meta(request.params.token));
      },
    );
  },
  { name: 'module:downloads', dependencies: ['auth', 'config', 'entitlements'] },
);
