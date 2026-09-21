// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Validates the committed OpenAPI document (apps/api/openapi/openapi.json,
// produced by `pnpm --filter @sl/api openapi` from `src/scripts/
// generate-openapi.ts`): that it's a structurally valid OpenAPI 3 document
// (via @apidevtools/swagger-parser, resolving every $ref), and that it is
// not stale — every route the real, fully-autoloaded app actually
// registers appears in it, and vice versa (no path/method the spec claims
// exists but the app doesn't serve).
//
// The freshly-generated spec (`app.swagger()`) is the same call
// generate-openapi.ts itself uses to write the committed file, so comparing
// the committed file's path set against a live rebuild is a direct
// "did anyone add/rename a route and forget to regenerate the spec" check.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import SwaggerParser from '@apidevtools/swagger-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(__dirname, '..', '..', '..', '..', 'openapi', 'openapi.json');

// Minimal local shape — avoids pulling in `openapi-types` as an extra
// dependency just for this test file's type annotations.
interface MinimalOpenApiDoc {
  paths?: Record<string, Record<string, unknown> | undefined>;
}

function pathMethodSet(spec: MinimalOpenApiDoc): Set<string> {
  const set = new Set<string>();
  for (const [routePath, methods] of Object.entries(spec.paths ?? {})) {
    if (!methods) continue;
    for (const method of Object.keys(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(method)) continue;
      set.add(`${method.toUpperCase()} ${routePath}`);
    }
  }
  return set;
}

describe('OpenAPI spec (apps/api/openapi/openapi.json)', () => {
  let committedSpec: MinimalOpenApiDoc;

  beforeAll(() => {
    committedSpec = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as MinimalOpenApiDoc;
  });

  it('is committed to the repo and non-empty', () => {
    expect(committedSpec.paths).toBeDefined();
    expect(Object.keys(committedSpec.paths ?? {}).length).toBeGreaterThan(50);
  });

  it('is a structurally valid OpenAPI 3 document (every $ref resolves)', async () => {
    // SwaggerParser.validate mutates its input in place while dereferencing;
    // pass a fresh parse so `committedSpec` above is untouched for the next test.
    const copy = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'));
    await expect(SwaggerParser.validate(copy)).resolves.toBeDefined();
  });

  describe('matches the live app (not stale)', () => {
    let app: FastifyInstance;
    let liveSpec: MinimalOpenApiDoc;

    beforeAll(async () => {
      process.env.NODE_ENV = 'test';
      const { buildApp } = await import('../../../app.js');
      app = await buildApp({ logger: false });
      await app.ready();
      liveSpec = app.swagger() as MinimalOpenApiDoc;
    });

    afterAll(async () => {
      await app.close();
    });

    it('every route the app actually registers is present in the committed spec', () => {
      const live = pathMethodSet(liveSpec);
      const committed = pathMethodSet(committedSpec);
      const missing = [...live].filter((entry) => !committed.has(entry));
      expect(
        missing,
        `routes registered by the app but missing from committed openapi.json (run \`pnpm --filter @sl/api openapi\`):\n${missing.join('\n')}`,
      ).toEqual([]);
    });

    it('the committed spec has no path/method the app does not actually serve', () => {
      const live = pathMethodSet(liveSpec);
      const committed = pathMethodSet(committedSpec);
      const stale = [...committed].filter((entry) => !live.has(entry));
      expect(
        stale,
        `routes in committed openapi.json that the app no longer serves (stale spec):\n${stale.join('\n')}`,
      ).toEqual([]);
    });
  });
});
