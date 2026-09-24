# Go-live runbook: Nova Trade

Takes the audit, payments and Nova Trade work live. There are two sides.
The website (landing page, account area, admin) is on Vercel and deploys
from GitHub `main`. The API, worker, database and backups run on the VM
(`46.62.142.29`), from images built on the VM.

Budget about 30 minutes, most of it waiting on builds.

## 1. What goes live

- **Website:** the Nova Trade landing page at `/`, the Terms and Refund
  Policy, sign-up that requires accepting the Terms, and the customer account
  page `/account` (pass, extension download, PayPal payment, devices,
  security). The dashboard becomes admin-only, with a new Payments queue.
- **API:**
  - PayPal payment claims with admin approval (Stripe is not used)
  - the pass catalogue: Monthly $9.99, with Monthly + Mobile $13.99 and
    Season $24.99 coming soon
  - the extension download
  - Discord notices for new payments
  - bans that reach open sessions
  - fixes for races on trades, profits and trials
  - rate limits on the lookup endpoints
- **Database:** migrations `0031_payment_claims` and `0032` (from the
  security branch). Both are additive; see §6.
- **Operations:**
  - Alertmanager, which sends alerts to Discord
  - the `BackupNotOffsite` alert
  - memory limits on the monitoring containers

## 2. Before you start

| Item                                                                | Where                                                                                                                        | Needed?                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `DASHBOARD_ORIGIN=https://snippingtool-eta.vercel.app`              | `infra/.env.production`                                                                                                      | Yes (already set)                                                 |
| `BACKUP_S3_REMOTE`, `BACKUP_S3_BUCKET`, `AWS_*` (R2)                | `infra/.env.production`                                                                                                      | Yes (already set)                                                 |
| `ALERT_DISCORD_WEBHOOK_URL`: private `#alerts` channel webhook      | `infra/.env.production`                                                                                                      | Recommended; without it alerts go nowhere                         |
| `PAYMENTS_DISCORD_WEBHOOK_URL`: private `#payments` channel webhook | `infra/.env.production`                                                                                                      | Recommended; without it you must check `/admin/payments` yourself |
| Discord invite link                                                 | replace `<!-- DISCORD_INVITE -->` / "coming soon" in `apps/dashboard/index.html`, `terms/`, `refund-policy/`, `docs/legal/*` | Optional for launch                                               |
| The release pull request is green in CI                             | GitHub                                                                                                                       | Yes                                                               |
| The live EA market check for the adapter                            | an account with the market open                                                                                              | Before selling automation                                         |

To create a Discord webhook: Channel settings → Integrations → Webhooks → New
Webhook → Copy Webhook URL.

## 3. Order, and why

**Deploy the VM first, then merge the pull request.** The new website sends
`acceptTerms` when someone registers, and the old API rejects it. The new API
requires it, and the old website doesn't send it. So sign-ups fail for the
few minutes between the two deploys whichever order you choose. Doing the VM
first makes that window "until Vercel finishes", about 2 minutes, instead of
"until someone rebuilds the VM".

## 4. Steps

### 4.1 Deploy the VM from the release branch

```sh
cd /opt/sniper-ledger
git fetch origin
git status                 # only the untracked files you expect
git checkout <release-branch>   # the pull request's branch
git pull
infra/scripts/vm-deploy.sh
```

`vm-deploy.sh` does the following, in order:

1. checks the configuration
2. takes a backup (uploaded to R2)
3. tags the running images for rollback
4. builds
5. migrates
6. starts the new version
7. checks that the API is healthy and that the plans show "Monthly"

It prints a rollback stamp. Keep it.

### 4.2 Merge the pull request

Merge it on GitHub with a merge commit, so `main` has exactly the tree the
VM is running. Vercel deploys `main` automatically; wait until the
deployment shows **Ready**.

Then point the VM's checkout at `main`. There's nothing to rebuild, because
it's the same code:

```sh
git checkout main && git pull
```

### 4.3 Verify: about 10 minutes, in a private window

1. `https://snippingtool-eta.vercel.app/` shows the Nova Trade landing page;
   `/terms` and `/refund-policy` load.
2. **Sign up** with a new email. The Terms checkbox is required. Verify the
   email, then sign in: you land on **My account**.
3. On My account, "Pay with PayPal" opens `paypal.me/MSgaier/9.99USD`. Submit
   a made-up 17-character transaction ID.
   - If `PAYMENTS_DISCORD_WEBHOOK_URL` is set, a message arrives in Discord.
4. As an admin, open **/admin/payments**, find the test claim and **Reject**
   it with a reason. The customer sees the reason on My account.
5. Grant yourself a pass (approve a real payment, or Admin → Subscriptions →
   Activate), then download the extension from My account. The zip's
   `manifest.json` must list your API address under `host_permissions`.
6. Load the extension unpacked, sign in, and open the EA FC web app. The
   panel should say **Nova Trade**.
7. On the VM:
   - `docker exec sniper-ledger-prod-backup-1 /app/pg-backup.sh` ends
     without an upload warning.
   - `docker ps` shows `alertmanager` running.

## 5. Rolling back

```sh
infra/scripts/vm-rollback.sh <stamp>    # api, worker, dashboard images back
```

On Vercel: Deployments, open the previous production deployment, then
**Promote to Production**.

Migrations are not rolled back, and don't need to be (§6). Restore a
database backup only for data loss, never to undo a deploy; see
`docs/11-devops.md` for the restore steps.

## 6. What the migrations change

- `0031_payment_claims`:
  - a new `payment_claims` table
  - two nullable columns on `users` (`terms_version`, `terms_accepted_at`)
  - plans repriced as passes (pro → Monthly $9.99, ultimate → Monthly +
    Mobile $13.99, lifetime → Season $24.99), and `basic` retired
  - Older code ignores the new table and columns, and only displays plan
    names and prices.
- `0032` (security branch): see its migration file's header. It is additive.

## 7. After launch

- Delete the uncommitted `infra/caddy/Caddyfile` change on the VM once the
  Sniping Bot branch has merged. The userscript is now served by the API, so
  the Caddy route is no longer used.
- Roll the R2 key (Cloudflare → R2 → Manage API tokens → Roll), put the new
  pair in `infra/.env.production`, and recreate the backup container.
- Watch `/admin/payments`, and the Discord channels, for the first real
  payments.

## Changing the API address later

If the API moves to a new domain, update it in three places: the
`VITE_API_ORIGIN` default in `vercel.json`'s `buildCommand`, the
`connect-src` of the `Content-Security-Policy` in `vercel.json` (both the
`https://` and `wss://` forms), and `APP_ORIGIN` in `infra/.env.production`.
If the CSP is missed, the website loads but can't reach the API.

## 8. Pull request description (paste into GitHub)

> **Nova Trade launch: audit fixes, PayPal passes, website and account area**
>
> - Security and correctness fixes from the audit: races, ban enforcement,
>   rate limits, telemetry duplicates, SHA-pinned CI, Alertmanager, off-site
>   backups.
> - Payments move from Stripe to PayPal.me. Customers submit their
>   transaction ID and an admin approves it, which issues or extends the
>   pass. The catalogue is now Monthly $9.99 (Monthly + Mobile and Season
>   coming soon).
> - The Nova Trade website: a static landing page, the Terms and Refund
>   Policy, and a required Terms checkbox at sign-up.
> - A customer account page (`/account`); the dashboard becomes admin-only,
>   with a Payments review queue.
> - The extension download, built per deployment, and the extension renamed
>   to Nova Trade.
> - Discord notices for new payments.
>
> Deploy with `docs/runbooks/go-live.md`: the VM first, then merge.
>
> 🤖 Generated with [Claude Code](https://claude.com/claude-code)
