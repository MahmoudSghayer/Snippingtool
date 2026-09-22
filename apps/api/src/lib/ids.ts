// Time-ordered UUIDv7 id generation, used for every application-generated
// primary key (the DB column default `gen_random_uuid()` is only a safety
// net for direct SQL/seed inserts — see packages/db/docs/02-database.md §1).

import { uuidv7 } from 'uuidv7';

export function newId(): string {
  return uuidv7();
}
