#!/bin/sh
# Entrypoint for the db-migrator image: applies every pending @sl/db
# migration, then optionally seeds. One-shot container — exits 0 on success,
# non-zero on any failure (migrate.ts already exits non-zero on error, and
# `set -e` below stops before seeding if migration failed).
set -eu

echo "[db-migrator] DATABASE_URL target: $(node -e "try{const u=new URL(process.env.DATABASE_URL);console.log(u.protocol+'//'+u.hostname+':'+u.port+u.pathname)}catch{console.log('(unparseable)')}" )"

echo "[db-migrator] applying migrations..."
node dist/migrate.js up

if [ "${RUN_SEED:-false}" = "true" ]; then
  echo "[db-migrator] RUN_SEED=true, seeding..."
  node dist/seed.js
else
  echo "[db-migrator] RUN_SEED not set to true, skipping seed."
fi

echo "[db-migrator] done."
