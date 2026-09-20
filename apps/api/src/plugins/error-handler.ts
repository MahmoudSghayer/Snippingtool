// Normalises every error into the `{ code, message, details?, requestId }`
// envelope (@sl/shared apiErrorSchema). AppError carries its own status/code;
// zod validation errors (thrown by fastify-type-provider-zod when a
// request fails schema validation) map to VALIDATION_FAILED; anything else
// is logged and reported as INTERNAL without leaking internals.

import fp from 'fastify-plugin';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

import { recordError } from '../lib/error-rate.js';
import { AppError, isAppError } from '../lib/errors.js';

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export default fp(async function errorHandlerPlugin(fastify: FastifyInstance) {
  fastify.setErrorHandler((error: FastifyError | AppError, request: FastifyRequest, reply: FastifyReply) => {
    if (isAppError(error)) {
      if (error.status >= 500) {
        request.log.error({ err: error, code: error.code }, error.message);
        void recordError(fastify.redis).catch(() => undefined);
      } else {
        request.log.info({ err: error, code: error.code }, error.message);
      }
      return reply.status(error.status).send({
        code: error.code,
        message: error.message,
        details: error.details,
        requestId: request.id,
      });
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        details: { issues: error.validation },
        requestId: request.id,
      });
    }

    // @fastify/rate-limit and other plugins may throw plain errors carrying a
    // statusCode; respect 4xx ones as client errors without leaking a stack.
    const status = typeof (error as { statusCode?: number }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;

    if (status < 500) {
      request.log.info({ err: error }, error.message);
      return reply.status(status).send({
        code: status === 429 ? 'RATE_LIMITED' : status === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED',
        message: error.message || 'Request failed.',
        requestId: request.id,
      });
    }

    request.log.error({ err: error }, 'Unhandled error');
    void recordError(fastify.redis).catch(() => undefined);
    return reply.status(500).send({
      code: 'INTERNAL',
      message: 'Internal server error.',
      requestId: request.id,
    });
  });

  fastify.setNotFoundHandler((request, reply) => {
    const error = new AppError('NOT_FOUND', `Route ${request.method} ${request.url} not found.`);
    return reply.status(error.status).send({
      code: error.code,
      message: error.message,
      requestId: request.id,
    });
  });
});
