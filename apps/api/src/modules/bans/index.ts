// This module has no user-facing HTTP routes of its own — bans are entirely
// admin-driven (`modules/admin-bans`) and enforced via the exported
// `checkBans()`/`revokeAllSessionsForBan()` service functions
// (`docs/05-subscriptions.md` §8, "Cross-agent touchpoints": the auth
// module's login path imports `checkBans` from `modules/bans/service.js`).
// `index.ts` still exists (registering zero routes) so this folder follows
// the mandatory one-folder-per-module convention and nothing else in
// `service.ts` is orphaned from the module system.

import fp from 'fastify-plugin';

import type { FastifyInstance } from 'fastify';

export default fp(async function bansModule(_fastify: FastifyInstance) {}, { name: 'module:bans' });
