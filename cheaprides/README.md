# 406 Cheap Rides

Paid cheap-car deal alerts for `cheaprides.406truckdrops.com`. This folder is its own Cloudflare Pages project. It does not use the 406 Truck Drops worker, schema, or D1 databases.

Static files plus `public/_worker.js`. No build step and no runtime npm packages. Stripe is called with `fetch` (form-encoded POSTs). Webhook signatures use WebCrypto. Tests run with `node --test`.

## What is here

| Path | Role |
| --- | --- |
| `public/` | Pages output. Upload this directory. |
| `public/_worker.js` | API routes and email/Stripe helpers |
| `schema.sql` | D1 schema |
| `wrangler.toml` | Pages config and the `DB` binding |
| `INGEST.md` | Contract for the listing scanner |
| `test/` | `node --test` suite (dev only) |

## 1. Create the database

From this directory:

```bash
npx wrangler d1 create cheaprides-db
```

The test project already has its database id in `wrangler.toml`: `a38c0aa7-d691-405c-a08a-7dcbfef70989`. The binding name is `DB` and the database name is `cheaprides-db`. Do not point it at a Truck Drops database. A brand new database still comes from `wrangler d1 create`, and you would paste that id in place of the one above.

Apply the schema:

```bash
npx wrangler d1 execute cheaprides-db --remote --file=schema.sql
npx wrangler d1 execute cheaprides-db --local --file=schema.sql
```

Tables: `subscribers`, `stripe_events` (webhook idempotency), `login_tokens`, `sessions`, `listings`, `price_history`, `alert_sends` (one row per subscriber, listing, and event so alert retries do not double-send).

If this database was created before `alert_sends` existed, apply the follow-up file instead of re-running the whole schema:

```bash
npx wrangler d1 execute cheaprides-db --remote --file=migrations/0002_alert_sends.sql
```

## 2. Create the Pages project

```bash
npx wrangler pages project create 406-cheap-rides --production-branch=main
```

## 3. Configure vars and secrets

Plain vars live in `wrangler.toml` and can be overridden in the Pages dashboard:

| Name | Example | Notes |
| --- | --- | --- |
| `APP_URL` | `https://406-cheap-rides.pages.dev` | No trailing slash. Checkout and email links use it. This is the test host for now. Swap in `https://cheaprides.406truckdrops.com` when that domain is attached. |
| `EMAIL_FROM` | `406CheapRides <alerts@406truckdrops.com>` | Resend from address. |
| `EMAIL_ALLOWLIST` | `you@example.com,partner@example.com` | Comma-separated. Used whenever real sends are off. |
| `ALLOW_REAL_SENDS` | `false` | Must be the exact string `true` to email people outside the allowlist. Leave it `false`. |
| `SMS_ENABLED` | `false` | Must be the exact string `true` to show the SMS price and accept `plan=sms` at checkout. Off by default. |

Secrets (never commit these):

```bash
npx wrangler pages secret put STRIPE_SECRET_KEY --project-name 406-cheap-rides
npx wrangler pages secret put STRIPE_WEBHOOK_SECRET --project-name 406-cheap-rides
npx wrangler pages secret put INGEST_TOKEN --project-name 406-cheap-rides
npx wrangler pages secret put RESEND_API_KEY --project-name 406-cheap-rides
npx wrangler pages secret put SESSION_SECRET --project-name 406-cheap-rides
```

Use a Stripe **test mode** secret key (`sk_test_...`) until you are ready for live charges. `SESSION_SECRET` should be a long random string.

For local `wrangler pages dev`, copy `.dev.vars.example` to `.dev.vars` and fill the same names. Set `APP_URL=http://localhost:8788` so checkout returns to your machine. `.dev.vars` is gitignored.

## 4. Stripe prices and webhook

In Stripe test mode, create three recurring prices and set the lookup key on each price:

| Lookup key | Amount | Plan |
| --- | --- | --- |
| `cheaprides_monthly` | $7 USD / month | `monthly` |
| `cheaprides_yearly` | $49 USD / year | `yearly` |
| `cheaprides_sms_monthly` | $12 USD / month | `sms` |

Checkout looks up the price by that key. It does not hardcode price ids.

Add a webhook endpoint:

- URL: `https://406-cheap-rides.pages.dev/api/stripe-webhook` (use the custom domain once it is attached)
- Events:
  - `checkout.session.completed`
  - `invoice.paid`
  - `invoice.payment_failed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`

Put the signing secret in `STRIPE_WEBHOOK_SECRET`.

For local webhook forwarding, point the Stripe CLI at `http://localhost:8788/api/stripe-webhook` and use the CLI signing secret as `STRIPE_WEBHOOK_SECRET`.

## 5. Deploy

This repo change does not deploy anything. When you are ready:

```bash
npx wrangler pages deploy public --project-name 406-cheap-rides
```

Run that from the `cheaprides/` directory. Attach the custom domain `cheaprides.406truckdrops.com` in the Pages project after the first upload.

## Local dev

```bash
npx wrangler d1 execute cheaprides-db --local --file=schema.sql
npx wrangler pages dev
```

`pages_build_output_dir` is `./public`, so `wrangler pages dev` serves that folder and routes `/api/*` through `_worker.js`.

## Email safety

Every outbound message goes through `sendEmail` in `public/_worker.js` (login links, confirm emails, and instant paid alerts).

- If `ALLOW_REAL_SENDS` is not exactly `true`, mail is sent only to addresses in `EMAIL_ALLOWLIST`.
- Everyone else is skipped. The worker logs `skipped allowlist` and does not call Resend.
- The default in `wrangler.toml` is `ALLOW_REAL_SENDS = "false"` and `EMAIL_ALLOWLIST = "zaylynbyoung@gmail.com"`. A deploy from this folder keeps that allowlist and does not mail anyone else.

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/config` | Public | `{sms_enabled}`. True only when `SMS_ENABLED` is exactly `true`. |
| `POST` | `/api/checkout` | Public | `{email, plan}` with `plan` of `monthly`, `yearly`, or `sms`. `sms` is HTTP 400 unless `SMS_ENABLED` is exactly `true`. Creates a Stripe Checkout Session (`mode=subscription`, 7-day trial, `payment_method_collection=always`). Reuses the Stripe customer when we already have one. Returns `{url}`. Stripe failures log `type` and `code` (no secrets) and return the Stripe message, or a generic line if that message contains a key. |
| `POST` | `/api/stripe-webhook` | `Stripe-Signature` | Verifies HMAC-SHA256 over `{timestamp}.{raw body}`, 5 minute tolerance, constant-time compare. Idempotent on event id. Updates `paid_until` from the subscription period end, or from `trial_end` while status is `trialing`. A deleted subscription drops the row to the free plan. |
| `GET` | `/api/portal` | Session cookie | 303 redirect to a Stripe Billing Portal session. |
| `POST` | `/api/login` | Public | Emails a one-time sign-in link (30 minutes). |
| `GET` | `/api/auth?token=` | Link | Sets an HttpOnly `cr_session` cookie and redirects to `/account`. |
| `POST` | `/api/logout` | Session | Clears the session. |
| `GET` | `/api/me` | Session | Plan, status, trial end, paid until. |
| `POST` | `/api/subscribe` | Public | Free double opt-in. Confirm link plus unsubscribe link. |
| `GET` | `/api/confirm?token=` | Link | Marks the email confirmed. |
| `GET` | `/api/unsubscribe?token=` | Link | Opts the address out of alert email. Does not cancel Stripe. Alert mail uses `?email=&sig=` (HMAC of the address) instead of a stored token. |
| `POST` | `/api/ingest` | `Bearer` `INGEST_TOKEN` | Scanner upsert. See `INGEST.md`. A successful `new` or `price_drop` also fans out instant email to active paid subscribers via `ctx.waitUntil`. |
| `GET` | `/api/listings` | Optional session | Public feed. `feed=latest` (default) or `feed=price_drops`. Anonymous and free sessions are delayed 24 hours. Active paid sessions (`monthly`, `yearly`, `sms` with `paid_until` in the future) are instant. |

Pages: `/`, `/pricing`, `/categories`, `/account`, `/checkout/success`, `/checkout/cancel`, `/terms`, `/privacy`. Terms and privacy are plain-English drafts. The note `Draft, pending review` is an HTML comment only. Unknown non-API paths return an HTML 404. The SMS card on `/pricing` stays hidden until `SMS_ENABLED` is `true`. `robots.txt`, `sitemap.xml`, `llms.txt`, and `llms-full.txt` are static files in `public/` and are not API routes. Canonical tags use `https://cheaprides.406truckdrops.com`.

## Tests

From the repo root or from `cheaprides/`:

```bash
node --test cheaprides/test/*.test.js
```

No npm install. The suite stubs `fetch` for Stripe and Resend and uses the built-in `node:sqlite` module as a stand-in for D1. Covered:

- Webhook signatures: valid, tampered, expired timestamp
- `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, `customer.subscription.updated`
- Webhook idempotency
- Ingest auth, validation, upsert, and price-drop history
- 24 hour feed delay versus a paid session
- Email allowlist guard, including login, subscribe, and instant alert fan-out (dedupe on `alert_sends`)
- SMS checkout gate and checkout error logging
- HTML 404 for unknown pages

## Manual test plan (Stripe test mode)

1. Start `wrangler pages dev` with `.dev.vars` filled and the local schema applied.
2. Put your own address in `EMAIL_ALLOWLIST`. Leave `ALLOW_REAL_SENDS` as `false`.
3. Open `/`, submit the free signup, and confirm the link in that inbox. A different address should produce a skip log and no Resend call.
4. Open `/pricing`, enter the same email, and start the monthly trial.
5. Pay with test card `4242 4242 4242 4242`, any future expiry, any CVC, and any ZIP.
6. Stripe sends `checkout.session.completed`. Reload `/account` (after the magic-link sign-in) and confirm plan `Monthly`, status `Active`, and a trial end about 7 days out.
7. In the Stripe dashboard, open the subscription and confirm the trial and the saved card.
8. Send a signed `invoice.paid` test event (or wait for the $0 trial invoice). `paid_until` should match the subscription period end once the subscription is `active`.
9. Use **Manage billing** on `/account`. It should open the Stripe customer portal.
10. Cancel the subscription in the portal or with a `customer.subscription.deleted` event. The row should fall back to plan `free` and lose instant feed access.
11. POST a listing to `/api/ingest` using `INGEST.md`. Anonymous `GET /api/listings` hides it until `seen_at` is 24 hours old. A paid session sees it immediately.
12. With that same address on `EMAIL_ALLOWLIST` and an active paid row, the `new` ingest should send one email. The subject is the deal score line. Posting the same event again should not send a second copy.
13. Failure card `4000 0000 0000 0341` can be used later to exercise `invoice.payment_failed` (status becomes `past_due`).

## Left for a later step

SMS texts are not sent. `sms_phone` is in the schema but not collected, and the SMS plan stays hidden until `SMS_ENABLED` is exactly `true`. Category preferences are stored as JSON and are not edited in the UI yet. Terms and privacy name the operator as 406TruckDrops. Contact mail is support@406truckdrops.com. An HTML comment still marks those pages as drafts pending review.
