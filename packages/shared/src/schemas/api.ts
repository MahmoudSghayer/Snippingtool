import { z } from 'zod';

import { ERROR_CODES } from '../constants/errors.js';

/** Every error response from `apps/api` uses this envelope. `requestId`
 * mirrors the `x-request-id` response header so a support ticket or a Sentry
 * breadcrumb can be tied back to a specific log line. */
export const apiErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string().min(1),
  details: z.record(z.unknown()).optional(),
  requestId: z.string().min(1),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export function apiErrorEnvelope(error: ApiError): { error: ApiError } {
  return { error };
}
