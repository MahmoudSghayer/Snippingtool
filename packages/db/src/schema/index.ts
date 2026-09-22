// Barrel export for every domain schema file, re-exported as the flat
// `schema` object drizzle() expects, plus everything individually for
// direct imports (`import { users } from '@sl/db'`).

export * from './common.js';
export * from './users.js';
export * from './auth.js';
export * from './admin.js';
export * from './subscriptions.js';
export * from './billing.js';
export * from './activity.js';
export * from './trading.js';
export * from './market.js';
export * from './settings.js';
export * from './system.js';
export * from './types.js';

import * as activity from './activity.js';
import * as admin from './admin.js';
import * as auth from './auth.js';
import * as billing from './billing.js';
import * as common from './common.js';
import * as market from './market.js';
import * as settings from './settings.js';
import * as subscriptions from './subscriptions.js';
import * as system from './system.js';
import * as trading from './trading.js';
import * as users from './users.js';

export const schema = {
  ...common,
  ...users,
  ...auth,
  ...admin,
  ...subscriptions,
  ...billing,
  ...activity,
  ...trading,
  ...market,
  ...settings,
  ...system,
};
