// Barrel export for every domain schema file, re-exported as the flat
// `schema` object drizzle() expects, plus everything individually for
// direct imports (`import { users } from '@sl/db'`).

export * from './common';
export * from './users';
export * from './auth';
export * from './admin';
export * from './subscriptions';
export * from './billing';
export * from './activity';
export * from './trading';
export * from './settings';
export * from './system';
export * from './types';

import * as common from './common';
import * as users from './users';
import * as auth from './auth';
import * as admin from './admin';
import * as subscriptions from './subscriptions';
import * as billing from './billing';
import * as activity from './activity';
import * as trading from './trading';
import * as settings from './settings';
import * as system from './system';

export const schema = {
  ...common,
  ...users,
  ...auth,
  ...admin,
  ...subscriptions,
  ...billing,
  ...activity,
  ...trading,
  ...settings,
  ...system,
};
