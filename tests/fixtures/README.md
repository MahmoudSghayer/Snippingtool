# tests/fixtures

Empty on purpose. The one fixture this repo's e2e suites need — the mock EA
transfer-market web app (a static page replaying recorded UTAS
`transfermarket` payloads) — already lives at
[`apps/extension/test/fixtures/mock-ea-app`](../../apps/extension/test/fixtures/mock-ea-app/),
owned by the extension agent and used both by
[`apps/extension/test/e2e/extension.spec.ts`](../../apps/extension/test/e2e/extension.spec.ts)
and, read-only, by
[`tests/e2e/specs/b-extension-bootstrap.spec.ts`](../e2e/specs/b-extension-bootstrap.spec.ts)
(see that file's header). Duplicating it here would mean two copies of the
same recorded payloads to keep in sync for no benefit — this directory
exists so `tests/fixtures/**` (this package's declared file ownership) has
somewhere to live if a genuinely new *cross-app* fixture is ever needed that
doesn't belong to one specific app (e.g. a shared Stripe event fixture, or a
recorded OpenAPI response set) — see `tests/e2e/helpers/stripe.ts` for the
one fixture-shaped thing this suite currently generates instead of storing
statically (a signed webhook payload, generated fresh per test run since it
must be signed with that run's own `STRIPE_WEBHOOK_SECRET`).
