## What & why

<!-- What does this change, and why? Link an issue/roadmap item if there is one. -->

## How was this tested?

<!-- Unit/integration tests added or updated? Manually verified how? -->

## Checklist

- [ ] `pnpm -r lint && pnpm -r typecheck` pass locally
- [ ] `pnpm -r test` passes locally (or CI is green)
- [ ] Docs updated if this changes an API route, env var, DB schema, or deploy step
- [ ] No secrets, API keys, or `.env` files committed
- [ ] No raw SQL string interpolation (Drizzle's `sql` tag / query builder only — see `docs/09-security.md`)
- [ ] Extension change: `ledger` build still contains no reference to `autobuyer` (CI's grep check enforces this, but double-check for M2/M3 boundary crossings)
- [ ] Breaking changes called out explicitly, with a migration/rollback note
