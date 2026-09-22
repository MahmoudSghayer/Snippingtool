-- Runs once, on first container start against an empty data directory (the
-- postgres image's own entrypoint only runs files under
-- /docker-entrypoint-initdb.d/ when the data volume is fresh). POSTGRES_DB
-- (sniper_ledger) is already created by the base image from the
-- POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD env vars in compose; this adds
-- the second database the API's test suites need (see
-- apps/api/src/config/env.ts's TEST_DATABASE_URL /
-- packages/db/src/test-utils.ts's getTestDatabaseUrl, both of which default
-- to "<DATABASE_URL's db>_test").
CREATE DATABASE sniper_ledger_test OWNER sl;
