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
somewhere to live if a genuinely new _cross-app_ fixture is ever needed that
doesn't belong to one specific app (e.g. a recorded OpenAPI response set).
