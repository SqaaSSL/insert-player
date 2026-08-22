# Production Readiness

This is the launch checklist for making Insert Player playable across devices with Clerk auth, tiered pricing, Worker-side API keys, rate limiting, R2/D1 persistence, and community sharing. `AI Street Fighter` remains the internal repository name only.

`AI Street Fighter` is the internal project name only. The selected external brand is `Insert Player`, first game `Insert Player: Fight`, short name `P1`, target domain `https://insertplayer.ai`. The owner-directed launch record was completed on 2026-08-19; see `BRANDING.md` and ignored `.brand-clearance.json`.

## Required Live Services

- Cloudflare Worker: hosts the API proxy, auth-protected fighter routes, billing routes, community routes, stats, and asset reads.
- Cloudflare D1: stores Clerk users, fighter metadata, sprite records, content-hashed source/sprite version archives, credit ledger, checkout sessions, generation charges, provider sessions, atomic monthly provider-spend counters, atomic rate-limit counters, community moderation reports, matches, and leaderboard rows.
- Cloudflare R2: stores versioned source views, sprite sheets, raw sprite sheets, cloned community assets, and future intro/stage assets.
- Worker-served R2 temp assets: `/proxy/upload-temp` requires an active provider session before reading or decoding its body, counts bytes while streaming before multipart parsing, stores short-lived provider input images under the `temp/` prefix, preserves PNG/JPEG/WebP/GIF MIME types, and returns unguessable `/temp-assets/*` URLs. `/proxy/image` stays image-only; `/proxy/media` is used for generated image/video result downloads. Both result proxies require an active provider session after URL validation, handle redirects manually with revalidation on every hop, only allow HTTPS upstream result URLs, block private/special IPv4 and all IPv6 literals, require a supported MIME type, cap response bytes while streaming, and use bounded upstream timeouts. Proxied result/temp responses include `X-Content-Type-Options: nosniff`.
- Worker upload guards: authenticated source/sprite uploads enforce PNG/JPEG/WebP byte signatures, bounded file sizes, and sane sprite frame metadata before writing to R2; temp provider uploads also enforce a 12 MB cap before decode/storage.
- Provider request guards: POST bodies forwarded to Gemini are capped at 48 MB while streaming; Ludo, Freepik, Runway, and FAL bodies are capped at 24 MB. Declared oversize is rejected before fetch and chunked oversize is aborted as soon as the cap is crossed.
- Operational retention: Stripe webhook bodies are reduced to non-PII event/account/object/payment summaries. A daily `0 4 * * *` Cron Trigger removes expired rate limits, old provider sessions and webhook markers, abandoned checkout rows, and dismissed/actioned moderation reports after one year; it never deletes credit history, users, tombstones, fighters, generated versions, or R2 assets.
- Rate limits stay in D1: a single atomic UPSERT admits or rejects each request, expired windows are pruned opportunistically, and Clerk user ids are used instead of IPs when signed in. Do not move this spending boundary to eventually consistent KV.
- Generation authorization, provider proxy calls, checkout creation, fighter writes, community clones/reports, moderation actions, R2 uploads, and match reports are rate-limited by Clerk user id, with pseudonymized network fallback where applicable. Signed-out Rookie additionally requires a managed Turnstile token that the Worker validates against Siteverify, the `anonymous_rookie` action, an explicit production-hostname allowlist, and the connecting IP before minting any provider session. Tokens are single-use and production fails closed if Turnstile is unavailable or misconfigured. Anonymous Rookie authorization is capped at one attempt per pseudonymized network identity/day. Expensive provider POSTs require a short-lived D1-backed provider session scoped to the operation, routes, GA Gemini models, call budget, and conservative cost ceiling needed by its purpose/tier.
- Clerk: isolated Insert Player frontend sign-in/up, Worker JWT verification, and signed user lifecycle webhooks for profile sync/account deletion.
- Stripe: credit pack Checkout Sessions and signed webhook delivery.

## Brand Gate

Status: complete by owner-directed risk acceptance on 2026-08-19.

- Public name: `Insert Player`; first game: `Insert Player: Fight`; short name: `P1`.
- `BRANDING.md` records the USPTO/TMview, domain, store, handle, and broad-web screen. No outside legal opinion was commissioned; the owner accepts the documented moderate residual risk.
- Ignored `.brand-clearance.json` records `cleared_for_launch`, the matching production origin, concrete evidence, and the owner review. Refresh it if the name, jurisdiction scope, or launch date materially changes.
- Public surfaces in `index.html`, `public/site.webmanifest`, `public/assets/*`, `src/ui/shared/communityShare.ts`, and Worker share metadata use Insert Player. `npm run brand:apply` and `npm run brand:rasterize` reproduce the static assets.
- Reserve `@playinsertplayer` campaign handles before promotion; this is a distribution task, not a substitute for the recorded name screen.

`npm run check:launch` requires the local brand record, rejects internal `Street Fighter` wording in public surfaces, and passes `ASF_PUBLIC_APP_NAME` to frontend smoke so metadata checks follow the approved brand.

## Cloudflare Setup

Current live resources:

- Worker diagnostics URL: `https://ai-street-fighter-api.shellbot.workers.dev`; public API: `https://api.insertplayer.ai`.
- Worker `0.16.0`, version `98270002-24fc-427d-8467-67b6374a4d3d`, deployed with the production proxy/auth/billing/storage code, observability, operation-specific credit reservations, durable provider cost events, exact apex+`www` CORS/Turnstile allowlists, fixed `clerk.insertplayer.ai` issuer, dedicated Insert Player Stripe account pin, Clerk account-lifecycle handling, HMAC-pseudonymized anonymous identifiers, versioned generation/checkout consent, streaming upload/provider-request limits, atomic D1 billing/rate-limit writes, transactionally versioned direct uploads/community copies, authenticated report intake, admin-only audited moderation, account-pinned Stripe catalog checks, automatic tax and reusable per-user Stripe Customers, bounded/idempotently retried Stripe requests, out-of-order-safe refund/dispute wallet reconciliation, provider-session-protected job polling/temp uploads, purpose/tier route and GA Gemini model allowlists, per-session cost ceilings, a `$500/month` global provider reserve, hardened result redirects/downloads, non-PII Stripe event storage, operational retention, and the isolated D1/R2 bindings. Private fighter manifests expose current and archived source/processed/RAW hashes so clients upload only missing blobs and can promote known versions without re-uploading bytes. AI arena sessions are additionally limited to one Flash call / 10¢, five per free signed-in account/day, and one client-cached result per arena theme.
- Pages project: `insert-player`; Pages URL `https://insert-player.pages.dev/`. `insertplayer.ai` and `www.insertplayer.ai` are active custom domains with certificates. Deployment `b75eaf8f` serves the credential-free legal prelaunch surface; it is not the launch app and must be replaced by `npm run deploy:frontend` after the owner-approved production promotion.
- Cloudflare zone: `insertplayer.ai` (`24154d7072f2d94c9f69a26cc01f9541`), delegated to `maisie.ns.cloudflare.com` and `sean.ns.cloudflare.com`. Always Use HTTPS, strict SSL, TLS 1.2 minimum, TLS 1.3, HTTP/3, Brotli, and Browser Integrity Check are enabled.
- D1: `insert-player-db` (`aa9e6ba6-8a7f-4261-ac31-986e6cf44659`, EU jurisdiction, EEUR primary region, automatic read replication, Time Travel bookmark verified)
- D1 migrations: `0001` through `0017` applied; remote legal-consent, Stripe Customer/payment adjustment, `stripe_events.user_id`, moderation, retention, asset lookup indexes, per-session/monthly/rolling provider-spend schema, and permanent per-call provider cost ledger verified
- R2: `insert-player-assets` (EU jurisdiction)
- R2 lifecycle: `expire-temp-assets` deletes `temp/` objects after 1 day
- R2 exposure: public `r2.dev` URL disabled; no direct custom domains or bucket CORS policy
- Worker provider secrets set: Gemini, FAL, Runway, Freepik, Ludo
- Isolated QA Worker: `https://insert-player-api-sandbox.shellbot.workers.dev`, version `0.16.0`, deployed automatically from protected `develop`, `ENVIRONMENT=sandbox`, `$50/month` provider reserve, production-origin CORS denied, Clerk Development configured, and dedicated test-mode Stripe billing configured. Provider secrets are present for authenticated QA, while `ANONYMOUS_ROOKIE_ENABLED=false` blocks public provider-session minting before cost; the deployed route returns `403 anonymous_rookie_disabled`.
- Isolated QA D1: `insert-player-sandbox-db` (`f60b6e22-d262-4e46-a7d9-ca095e49d102`, EU jurisdiction, EEUR primary region), with migrations `0001` through `0017` applied
- Isolated QA R2: `insert-player-sandbox-assets` (EU jurisdiction), with `temp/` objects expiring after 1 day; provider secrets and a unique anonymization secret are installed on the sandbox Worker
- Isolated QA Pages project: `insert-player-sandbox`; stable URL `https://insert-player-sandbox.pages.dev/`, deployed automatically from protected `develop`
- `npm run smoke:sandbox` passes D1/R2, provider and budget health, CORS, signed-out auth, tier-cost, privacy, and live-Stripe-absence checks
- Production dependency audit: zero known vulnerabilities as of 2026-08-19.
- The sandbox v2 Stripe catalog and purchase path pass twice: each €14.99 Starter purchase granted exactly 11 credits once, moving the wallet from 6 to 17 to 28 while preserving the historical 6-credit purchase and every ledger row.
- Separate Chrome and in-app-browser storage origins loaded the same signed-in 28-credit wallet, match history, and Champion fighter from D1/R2. A fresh origin exposed the fighter after the 11 best playable sprites arrived in `4.776s`; all 48 cloud sprite versions plus RAW assets then hydrated in the background, and the next Gallery entry reached `Ready` in `3.037s`. This is strong cross-browser persistence evidence, but a physical second-device pass remains required.
- Still missing before full launch: Clerk Production plus two launch users, live Insert Player Stripe credentials/catalog/webhook and purchase smoke, replacement of the legal prelaunch build with the full production app, real-phone QA, and two-device validation. Real provider generation, cloud archival, and the authenticated Stripe purchase/webhook path have passed in isolated QA.
- Support delivery is also launch-critical: routing, MX, SPF, and explicit `privacy@insertplayer.ai` / `support@insertplayer.ai` routes are active, and the SMTP edge accepted both recipients with `250`. Send and receive one real external test through each alias and verify reply identity. Do not launch with dead legal/support addresses.

### Isolated QA environment

Production and QA use different Workers, Pages projects, D1 databases, R2 buckets, Stripe key modes, webhooks, Clerk instances, and local env files. Never switch the production Worker to test Stripe mode.

```bash
npm run db:migrate:sandbox
npm run deploy:worker:sandbox
npm run smoke:sandbox
# After Clerk development + Stripe sandbox values exist in .env.sandbox.local:
npm run config:sandbox
npm run deploy:frontend:sandbox
```

`worker/wrangler.sandbox.toml` is the only Wrangler config for QA. `.env.sandbox.local` is the only local source for sandbox Clerk/Stripe config; `.env.production.local` is the only local source for live Clerk/Stripe config. `npm run config:sandbox` validates Clerk JWKS, the test Stripe account and fixed catalog, denylisted account ids, authorized parties, and webhook origin before atomically uploading sandbox secrets, migrating, deploying, and smoking the sandbox Worker. `scripts/check-production.mjs` fails if the two Wrangler configs share D1/R2 resources or if the Stripe/bootstrap/frontend paths cross origins, key modes, env files, or Pages projects.

1. Create resources:

```bash
cd worker
npx wrangler d1 create insert-player-db --jurisdiction eu
npx wrangler r2 bucket create insert-player-assets --jurisdiction eu
```

2. Paste the generated D1 id into `worker/wrangler.toml`. Add an R2 lifecycle rule for the `temp/` prefix, deleting objects after 1 day; the Worker also refuses expired temp assets. Rate-limit counters use the same D1 database atomically.

3. Configure Worker vars/secrets:

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put FAL_API_KEY
npx wrangler secret put RUNWAY_API_KEY
npx wrangler secret put FREEPIK_API_KEY
npx wrangler secret put LUDO_API_KEY
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

The preferred handoff path is to create a gitignored `.env.production.local` with the live dashboard values and run the idempotent helper:

```bash
CLERK_ISSUER=https://clerk.insertplayer.ai
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
VITE_TURNSTILE_SITE_KEY=0x4AAAAAA...
# Optional JWKS override. CLERK_ISSUER is still required for issuer validation.
# CLERK_JWKS_URL=https://clerk.insertplayer.ai/.well-known/jwks.json
CORS_ORIGIN=https://insertplayer.ai,https://www.insertplayer.ai
CLERK_AUTHORIZED_PARTIES=https://insertplayer.ai,https://www.insertplayer.ai
CLERK_WEBHOOK_SIGNING_SECRET=whsec_...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
TURNSTILE_SECRET_KEY=0x4AAAAAA...
TURNSTILE_HOSTNAMES=insertplayer.ai,www.insertplayer.ai
```

```bash
npm run config:live
```

That command patches non-secret Worker vars in `worker/wrangler.toml`, updates `.env.production`, uploads Worker secrets without printing values, and redeploys the Worker.
The default `config:live` path refuses placeholder values, local origins, test Clerk publishable keys, and test Stripe secret keys, then runs `npm run check:production` before it mutates Worker config or uploads secrets.

4. Set non-secret vars in `worker/wrangler.toml`:

```toml
CORS_ORIGIN = "https://insertplayer.ai,https://www.insertplayer.ai"
CLERK_ISSUER = "https://clerk.insertplayer.ai"
CLERK_AUTHORIZED_PARTIES = "https://insertplayer.ai,https://www.insertplayer.ai"
TURNSTILE_REQUIRED = "true"
TURNSTILE_ACTION = "anonymous_rookie"
TURNSTILE_HOSTNAMES = "insertplayer.ai,www.insertplayer.ai"
```

5. Apply remote D1 migrations:

```bash
cd worker
npm run db:migrate
```

6. Deploy the Worker from the repo root so the local production gate runs first:

```bash
cd ..
npm run deploy:worker
```

7. From the repo root, run the live gate:

```bash
npm run check:live-readiness
```

Before the production promotion this fails because the deployed Worker still lacks the newly staged Live Stripe secrets/catalog and Pages still serves the holding build. Clerk JWKS is already reachable. Worker health reports the isolated D1/R2 bindings, configured providers, and configured Turnstile, while `auth`, `accountLifecycle`, and `billing` remain incomplete until the staged release deploys. `CLERK_JWKS_URL` may be set as an override, but `CLERK_ISSUER` is required so Clerk JWT issuer validation cannot be skipped. The live gate fetches Clerk JWKS and requires keys to be present; health must report production environment, configured CORS, Clerk auth, `accountLifecycle: "clerk_webhook"`, live Stripe billing, Turnstile, D1/R2 bindings, and configured provider secrets. If a test-mode Stripe key is accidentally installed on the production Worker, `/health` reports `billing: "stripe_test"` and live readiness still fails. The gate also fetches `/`, `/menu`, `/menu?checkout=success&session_id=readiness`, `/menu?checkout=cancelled`, and `/community?fighter=readiness` from the production frontend origin and requires the app shell.

The local production verifier also replays D1 migrations and behavior-tests Stripe checkout/session idempotency at the schema level: checkout rows are pre-reserved before Stripe is called, webhooks can reconcile by Stripe id or local `session_token`, the Stripe event's user/pack/credits/amount/currency must match the local checkout row, mismatched amounts do not claim a row, first claim wins, duplicate claim returns no rows, duplicate ledger insert is ignored, duplicate Stripe event insert is ignored, and the credit grant advances through a single D1 batch from `crediting` to `paid`. It verifies that persisted webhook summaries exclude customer PII and that scheduled retention cannot target durable user data. The Worker rejects checkout with a clean `503` before writing a D1 checkout row when Stripe is not configured, and refuses test-mode Stripe checkout on the production Worker.

It also requires Node >=22.12.0, runs `npm run check:tiers` to keep frontend tier labels/costs, Worker credit and estimated costs, tier pipeline/model/background-removal settings, and Pro source-view env docs in sync, bounds live curl/Wrangler/fetch checks with timeouts so launch gates fail instead of hanging, and behavior-tests the D1 rate-limit fallback and provider-session budgets: active counters increment to the anonymous limit, return a blocked state at the threshold, expired windows are ignored, provider sessions spend one call per expensive provider POST, Rookie sessions have smaller budgets than refined paid tiers, and exhausted sessions stop before upstream. Live `429` abuse smoke remains opt-in via `ASF_SMOKE_RATE_LIMIT=1` and passed against the production Worker on 2026-05-16.

8. After deploy, run the Worker smoke test:

```bash
ASF_WORKER_URL=https://api.insertplayer.ai \
ASF_FRONTEND_ORIGIN=https://insertplayer.ai \
npm run smoke:live
```

`npm run smoke:live` is a public/prelaunch Worker smoke. It verifies the deployed public API surface and warns if `/health` still reports Clerk auth or Stripe billing as unconfigured; do not treat that command alone as launch readiness.

For launch validation, require both a primary signed-in Clerk token and a second-account token so authenticated storage, publish/share, clone privacy, foreign-fighter rejection, and match reporting are all exercised:

```bash
ASF_WORKER_URL=https://api.insertplayer.ai \
ASF_FRONTEND_ORIGIN=https://insertplayer.ai \
ASF_CLERK_JWT=eyJ_account_one... \
ASF_CLERK_JWT_CLONE=eyJ_account_two... \
npm run smoke:live:launch
```

`npm run smoke:live:launch` is the hard-failing launch gate; unlike `npm run smoke:live`, it refuses to skip authenticated D1/R2 smoke or same-photo clone/privacy smoke when the Clerk tokens are missing.
It also fails immediately if the clone token is missing, the clone token is the same JWT or Clerk subject as the primary token, or `/health` does not report Clerk auth and live Stripe billing.

For the final prelaunch pass, use the one-command final launch gate from the repo root:

```bash
ASF_WORKER_URL=https://api.insertplayer.ai \
ASF_FRONTEND_URL=https://insertplayer.ai \
ASF_CLERK_JWT=eyJ_account_one... \
ASF_CLERK_JWT_CLONE=eyJ_account_two... \
npm run check:launch
```

`npm run check:launch` reads `.env.production.local`, `.env.production`, `.env.local`, `.env`, and process env, requires HTTPS Worker and Pages URLs plus two different fresh Clerk JWTs, requires a completed manual validation file copied from `launch-validation.example.json` to the ignored `.launch-validation.json`, then runs `npm run check:production`, `npm run check:live-readiness`, `npm run smoke:frontend-live`, and `npm run smoke:live:launch` with authenticated smoke required. Each launch phase has a bounded outer timeout (`ASF_LAUNCH_CHECK_PRODUCTION_TIMEOUT_MS`, `ASF_LAUNCH_CHECK_LIVE_READINESS_TIMEOUT_MS`, `ASF_LAUNCH_SMOKE_FRONTEND_LIVE_TIMEOUT_MS`, `ASF_LAUNCH_SMOKE_LIVE_LAUNCH_TIMEOUT_MS`) so the final gate fails with a named timeout instead of hanging. The standalone live smoke commands read the same local env files too, so one ignored `.env.production.local` can feed launch readiness, Pages smoke, and Worker smoke. This is the final gate after the manual browser/provider/two-device smoke list below; use `ASF_LAUNCH_VALIDATION_FILE` to point at a different local evidence file.

It also requires `.brand-clearance.json` (or `ASF_BRAND_CLEARANCE_FILE`) with a cleared external public name, matching production origin, recent trademark/domain/handle/public-surface evidence, and public launch files that no longer contain the internal `AI Street Fighter` / `Street Fighter` name.

To intentionally exhaust the anonymous proxy window and verify `429` + `Retry-After`, opt in because this can make repeated smoke runs hit the limit for the rest of the window:

```bash
ASF_SMOKE_RATE_LIMIT=1 npm run smoke:live
```

The unauthenticated smoke checks health, allowed-origin CORS, unconfigured-origin non-reflection, provider-session browser preflight, tiers, billing packs, protected checkout/fighter/stat routes, Rookie-vs-paid generation policy, public community cache headers without internal owner ids or photo hashes, normalized public owner and leaderboard profile fields, private-host image/media proxy blocking, provider proxy allowlisting, broad result-list blocking, provider-session enforcement, and R2 temp assets; with `ASF_SMOKE_RATE_LIMIT=1` it also verifies proxy rate limiting. The authenticated smoke creates a disposable fighter with an intentionally long/control-character name to verify Worker normalization, reserves and refunds a Rookie generation idempotently, verifies paid-tier credit gating or paid-tier refund if the smoke account has credits, retries the same source and sprite uploads to prove content-addressed idempotency, verifies owner-gated private assets, verifies partial fighters cannot publish, uploads the full launch animation set before publishing, verifies community asset privacy and public owner profile normalization, optionally creates an unfinished same-photo fighter under a second Clerk account and verifies community clone merges playable public assets into it without exposing raw/original assets, verifies generation authorization and match reporting reject that second account's fighter id for the first account, records an unranked match, checks stats history and signed-in record updates, and deletes disposable fighters.

Public smoke passed on 2026-08-17 against Worker `0.15.0`, version `770313f4-9f1b-491d-bffb-ef3ad1c090af`, at `https://ai-street-fighter-api.shellbot.workers.dev` with `ASF_FRONTEND_ORIGIN=https://insert-player.pages.dev`. Health reported `privacy: "pseudonymized"` and `providerBudget: "configured"`. The smoke covered production bindings, allowed-origin CORS and unconfigured-origin non-reflection, tiers/packs, public community and leaderboard privacy, protected signed-out routes including community report/admin moderation endpoints, invalid-bearer handling, Rookie-vs-paid generation policy, deterministic private-host image/media blocking, provider allowlisting/session enforcement including polling, temporary upload authorization before R2 writes, malformed route handling, and nonce-based missing-share-page security headers. Local release tests additionally cover versioned legal consent, Stripe automatic-tax/catalog/customer binding, partial/full refunds, disputes, duplicate and out-of-order payment events, community report deduplication/admin review/manual unpublish, provider model allowlisting, per-session/monthly spend ceilings including the daily AI-arena account bound, chunked multipart/provider-request overflow, redirect-to-private rejection, required result MIME, redirect limits, streamed result-size enforcement, upstream timeout/error mapping, Stripe PII minimization, HMAC pseudonymization, and safe operational retention. Public share-page metadata smoke is also wired and runs automatically when `/api/community` has at least one public fighter in the feed.

## Frontend Setup

Copy `.env.production.example` to `.env.production`, then set production frontend env vars before building/deploying:

```bash
VITE_API_BASE_URL=https://api.insertplayer.ai
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
VITE_GEMINI_IMAGE_MODEL_REPOSE=gemini-3-pro-image
VITE_GEMINI_IMAGE_MODEL_UPRIGHT=gemini-3-pro-image
VITE_GEMINI_IMAGE_MODEL_CROUCH=gemini-3-pro-image
VITE_BG_REMOVAL_PROVIDER=fal
VITE_INTRO_VIDEO_PROVIDER=fal-ltx-v2-3-fast
```

Do not set animation model Pro overrides globally; tier code controls animation model selection. Source-view model vars stay Pro.

`npm run check:live-readiness` reads `.env.production.local`, `.env.production`, `.env.local`, `.env`, and process env for these frontend vars. Do not commit real secrets. Like the post-deploy Pages smoke, live readiness waits briefly for the root frontend shell (`ASF_FRONTEND_READY_TIMEOUT_MS`, default 90000) before checking direct routes, which keeps the final gate resilient to Cloudflare Pages propagation. The live config/readiness helpers and package deploy scripts route Wrangler through `scripts/wrangler-workspace-log.mjs`, setting `WRANGLER_LOG_PATH` to the ignored local `.wrangler-logs/` directory so Wrangler diagnostics stay inside the workspace during automated checks.

After Clerk is configured and the live gate passes, deploy the frontend:

```bash
ASF_PAGES_PROJECT_NAME=insert-player \
npm run deploy:frontend
```

`deploy:frontend` first validates `ASF_PAGES_PROJECT_NAME` so the Pages project slug uses the cleared public brand rather than the internal name. It then runs `npm run check:production` and `npm run check:frontend-live`, so it refuses to publish a Pages bundle without the local production hardening gate, live Worker URL, live Clerk publishable key, Pro source-view model vars, and a clean browser env with no provider/Stripe secrets. Before upload it generates an exact live CSP from the decoded Clerk FAPI and production API origin; sandbox uses its own exact pair and neither target may trust the other. After upload, the same command runs `npm run smoke:frontend-live` so a frontend deploy proves the Pages app shell, direct routes, bundle config, headers, and metadata before it is considered done. Direct routes use Pages native SPA rendering: the build intentionally contains neither a top-level `404.html` nor the legacy `/* /index.html 200` rewrite, which current Wrangler rejects as an index loop. The Pages smoke waits briefly for each propagated shell/asset (`ASF_FRONTEND_READY_TIMEOUT_MS`, default 90000), then keeps the route/header/bundle assertions strict.

The frontend live env check also requires `VITE_PUBLIC_APP_NAME` / `VITE_PUBLIC_APP_SHORT_NAME` to match `.brand-clearance.json` and rejects the neutral `Fighter Lab` placeholder, `ASF` / `SF`, the internal project name, the internal Pages domain, and the internal Worker URL. Use a cleared-brand Worker/API URL such as `https://api.your-cleared-domain.example` or a cleared-brand Workers route before deploying. Run `npm run brand:apply` and `npm run brand:rasterize` before deploying.

You can also smoke the deployed Pages app and direct-route fallback directly. The smoke requires the deployed HTTPS frontend URL explicitly so final checks follow the cleared brand/custom domain:

```bash
ASF_FRONTEND_URL=https://insertplayer.ai \
ASF_WORKER_URL=https://api.insertplayer.ai \
npm run smoke:frontend-live
```

This verifies `/menu`, Stripe checkout return URLs on `/menu`, `/gallery`, `/community`, `/community?fighter=...`, and `/roster/cpu` serve the app shell from a direct browser load, confirms the bundle includes the live Worker URL and a live Clerk publishable key, confirms launch metadata/manifest/social card assets are reachable, checks Pages security/cache headers, and confirms the old Gemini test page is not exposed. Set `ASF_FRONTEND_READY_TIMEOUT_MS=0` when you want a fast negative check with no post-deploy wait.

## Clerk Setup

- Create a dedicated Insert Player Clerk application. It may use the same company/team account as ShellBot, but its consent/sign-in surfaces, keys, users, domains, and branding must be Insert Player-specific so a player never lands on a ShellBot permission screen.
- Use that application's Development instance only for `insert-player-sandbox.pages.dev` and local QA. Put its `pk_test_...`, issuer, and webhook secret in `.env.sandbox.local`, then run `npm run config:sandbox` and `npm run deploy:frontend:sandbox`.
- Create the Production instance from the same Insert Player application only after DNS delegation is active. Put its `pk_live_...`, issuer, and distinct webhook secret in `.env.production.local`; development users and production users remain separate.
- Add the sandbox Pages/local origins to the Development instance and the apex/`www` origins to the Production instance. Keep the application single-domain for v1 rather than sharing ShellBot sessions or permission branding.
- Launch the public beta with social-only authentication: dedicated Google OAuth enabled for sign-up/sign-in, Apple disabled until the Apple Developer team is accessible and dedicated Insert Player credentials exist, Microsoft optional after beta validation, and direct email/password/phone sign-in disabled. OAuth providers may still supply a verified email claim to Clerk, but the production app must not offer mailbox-based authentication. The Development instance may additionally enable email sign-up/sign-in with verification codes and `Require email address` so local and automated QA can use Clerk `+clerk_test` addresses and the fixed test OTP; password, phone, and username remain disabled. Do not carry these Development-only email settings into Production when cloning or recreating instance settings. Development may use Clerk's shared provider credentials; Production uses the dedicated Google OAuth client and consent branding already created for Insert Player. When Apple is added, create a dedicated Apple Services ID/key and enable the provider only after an end-to-end production sign-in succeeds. Keep the Clerk workspace shared with Hilo if convenient, but use a separate Insert Player application, user pool, keys, domains, branding, and provider credentials; never reuse the Hilo/ShellBot application or its OAuth consent surfaces.
- Use the Clerk issuer URL as `CLERK_ISSUER`; `CLERK_JWKS_URL` is optional and does not replace issuer validation.
- The Worker validates Clerk session-token `azp` against `CLERK_AUTHORIZED_PARTIES` or `CORS_ORIGIN`, so keep that list in sync with the production Pages/custom domains.
- In Development Clerk Webhooks, create `https://insert-player-api-sandbox.shellbot.workers.dev/api/clerk/webhook`. In Production, create `https://api.insertplayer.ai/api/clerk/webhook`.
- The Development endpoint may subscribe to the complete event catalog while QA explores Google, Apple, and test-email behavior. The Worker signature-verifies every delivery, acknowledges unsupported event types with `200`, and does not persist their payloads. Production must start with only `user.created`, `user.updated`, and `user.deleted`: those are the events the lifecycle handler consumes, while unused email events may carry verification material, session events add avoidable volume, and an all-events subscription would opt into future payload types without review. Add any production event only alongside an explicit handler, retention purpose, tests, and legal/privacy review. Store each instance's distinct signing secret as `CLERK_WEBHOOK_SIGNING_SECRET` on its matching Worker.
- Confirm Clerk's webhook test succeeds. Duplicate deliveries must return `200` without duplicate users; signature failures must return `400`.
- On the operator launch user, set Clerk **private metadata** to `{ "insert_player_role": "admin" }`, then trigger or resend `user.updated`. The signed lifecycle webhook grants `plan_tier=admin`; removing that private value revokes only the admin grant back to `free` without overwriting any future non-admin paid plan. Never use public or unsafe metadata for moderation authorization. Confirm `/auth/me` reports `planTier: "admin"` and `/moderation` loads for that user, while the second launch user receives `403` from admin routes.
- Delete a disposable third Clerk test user after uploading at least one fighter. Confirm every `users/{clerk_user_id}/` R2 object, owned D1 fighter/account row, related match row, and rate-limit row is gone. A pre-deletion JWT must return `401`; the hashed tombstone must prevent account recreation.
- Confirm signing in after the app is already open refreshes the HomePage wallet, Gallery cloud import, and Roster cloud import without a manual reload.
- Confirm signed-out Create defaults to Rookie and shows paid tiers as sign-in locked.
- Confirm `GET /auth/me` returns the signed-in user's Clerk id, display name, credit balance, and free Rookie count.
- Confirm signed-out calls to protected routes return `401`, not anonymous writes.

## Stripe Setup

- In the Stripe Dashboard, create a dedicated Insert Player account under the same legal entity as ShellBot, then create a dedicated Insert Player sandbox. Keep products, customers, payment data, keys, webhooks, descriptor, and public business branding separate from ShellBot. Stripe account/sandbox creation requires the Dashboard; never copy ShellBot's live secret key into this Worker.
- Complete the platform account's own API-visible public details in Dashboard: customer-facing Insert Player name, `https://insertplayer.ai`, and a public support URL/email/phone. Stripe Dashboard privacy and Terms URLs are optional for this launch flow. Insert Player collects the versioned terms, refund-policy, immediate-delivery, and withdrawal-loss attestations before redirecting to Stripe, persists minimized legal evidence server-side, and sends the same legal version/flags in Checkout and PaymentIntent metadata.
- `config:sandbox --require-complete` and live config validate the activation and public profile fields Stripe exposes from `/v1/account`: details submitted, charges and payouts enabled, Insert Player name, website, and a public support contact. Checkout explicitly sends `consent_collection[terms_of_service]=none` to avoid a redundant generic Stripe checkbox. The authenticated sandbox purchase is the authoritative proof for payment, price, automatic tax, customer address collection, legal evidence, webhook fulfillment, and idempotency; repeat it in live mode before launch.
- Put the sandbox `STRIPE_ACCOUNT_ID` and `sk_test_...` key in ignored `.env.sandbox.local`; put the live account id and `sk_live_...` key in ignored `.env.production.local`. Stripe isolated Sandboxes have their own `acct_...` id, so never assume the sandbox and Live account ids match. Keep `ASF_FORBIDDEN_STRIPE_ACCOUNT_IDS` set to the ShellBot account id in both files so bootstrap fails closed if the wrong account is supplied. The script never falls back from either target to `.env.local` or `.env`.
- Bootstrap the fixed launch catalog and webhook. The script verifies the key belongs to the expected account, creates or reconciles Starter (11 credits, €14.99), Versus (20, €24.99), and Arcade (47 credits, €56.99), deactivates stale active prices, never deletes billing history, and stores Price IDs plus a newly returned webhook secret in the ignored env file:

```bash
# Dedicated Insert Player sandbox/test key and sandbox Worker webhook
npm run stripe:bootstrap:sandbox -- --create-webhook

# Dedicated live key; live mutation requires an explicit acknowledgement
npm run stripe:bootstrap -- --allow-live --create-webhook
```

- The Worker requires `STRIPE_ACCOUNT_ID`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_VERSUS`, and `STRIPE_PRICE_ARCADE`. Before creating Checkout it verifies the Stripe account, active EUR amount, and Product pack metadata. Webhooks must carry the same account id in Checkout metadata, preventing accidental cross-account crediting.
- The catalog bootstrap creates or updates a webhook endpoint pointing at:

```text
Sandbox: https://insert-player-api-sandbox.shellbot.workers.dev/api/billing/stripe-webhook
Live:    https://api.insertplayer.ai/api/billing/stripe-webhook
```

- Keep the Stripe endpoint subscribed to all events (`*`), as configured for the isolated account. The Worker acts on `checkout.session.completed`, `charge.refunded`, `refund.created`, `refund.failed`, `charge.dispute.created`, and `charge.dispute.closed`; unsupported signed event types are acknowledged with `200` and retained only as bounded non-PII audit markers. Refunds and disputes adjust the wallet idempotently; a won dispute restores only the held credits, while already-spent refunded value may leave a negative balance. Bootstrap and production checks must preserve/require the wildcard subscription.
- Store the webhook signing secret as `STRIPE_WEBHOOK_SECRET`; `--create-webhook` writes a newly returned sandbox secret to `.env.sandbox.local` or live secret to `.env.production.local` without printing it. Existing endpoint secrets must already be present because Stripe never returns them again.
- Run prelaunch test-mode Checkout only against the isolated deployed sandbox Worker, whose `ENVIRONMENT=sandbox` accepts `sk_test_...`. The bootstrap rejects a live key for the sandbox, rejects a test key for live, requires `--allow-live` for live mutation, and pins each target to its own webhook origin. The production Worker intentionally refuses test-mode Stripe events and Checkout.
- Run test-mode Checkout from the HomePage credit panel and verify:
  - Stripe success/cancel redirects scrub `checkout` and `session_id` from the browser URL, return to the `/menu` wallet, and refresh credits after webhook crediting without a manual reload.
  - `checkout_sessions.status` becomes `paid`.
  - A repeated delivery of the same Checkout Session does not add credits twice.
  - `stripe_events` has exactly one row for the event id.
  - `users.credits_balance` increases once.
  - `credit_ledger` has one positive `stripe_credit_pack:*` row with `stripe_session_id`.

## Launch Smoke Tests

Run these with a fresh browser profile and then repeat on a second device:

Local/sandbox prelaunch evidence: on 2026-08-17 a real Rookie generated all four Pro canonical views plus all 11 animations without retries and entered a playable desktop match. Processing v4 detected that the provider returned a `4x4` subject grid for a requested `4x2` sheet, rebuilt the active playable versions from preserved RAW blobs, and retained every prior version. On 2026-08-19 the same authenticated fighter completed Contender and Champion upgrades; measured completed sessions were Rookie 17 calls / `$1.43`, Contender 165 / `$7.88`, and Champion 123 / `$12.64`. Two interrupted Champion attempts refunded their credit reservations, while every tier retained all 11 cloud animations and prior versions. A later Champion WALK Retry completed with 33 calls / `$2.64`; processing v5 preserved the face and reduced severe green-edge contamination from `43.704%` to `0.276%`. All 11 current Champion animations were reconstructed from preserved RAW sheets without provider calls, incrementally synced with exactly 12 total uploads across the Retry and migration, retained every older cloud version, and entered a completed fight. The initial Rookie charge and zero-delta ledger were backfilled to the cloud fighter, and future clients persist that purchase id until idempotent sync linkage succeeds. Mobile-browser emulation at `390x844` kept all eight controls in view and real touch events moved and attacked. A full Attract Mode match also completed two rounds, reached the result state, exposed accessible Run It Back / Remix / Menu controls, and restarted cleanly through Run It Back. This closes the real all-tier provider/billing/storage path but does not replace production-auth/payment or physical-device checks below.

1. Signed-out `/menu` loads.
2. Confirm the cleared public brand appears in production HTML title, Open Graph/Twitter metadata, manifest, social-card PNG, app icons, and Worker `/share/:id` metadata, with no internal project name visible.
3. Signed-out Create defaults to Rookie; Contender/Champion are visibly locked and Worker-blocked. Confirm Rookie stays disabled until Turnstile returns a token.
4. Open `/legal`, `/privacy`, `/terms`, and `/refunds`. Confirm the current operator/address/registry details and visible AI-generated labels, then confirm every generation/retry/upgrade and credit checkout remains disabled until its current versioned consent is explicitly checked, and that generation records age, photo rights, AI processing, immediate performance, and withdrawal acknowledgement.
5. Send separate messages to `privacy@insertplayer.ai` and `support@insertplayer.ai`; confirm both reach the verified operator inbox and that replies use an appropriate product/operator identity.
6. From a signed-in non-owner account, report a public fighter. Repeat the report and confirm the queue keeps one record with an incremented count. Sign in as an `admin`, open `/moderation`, record a note, and manually dismiss or action the report. Verify that `Remove Fighter` unpublishes it and that no report count can trigger automatic removal.
7. Submit one real production Turnstile token and confirm anonymous Rookie authorization succeeds once. Replay that exact token and confirm the Worker returns `403` with no `providerSessionId`.
8. Sign in with Clerk.
9. In one browser profile, create or import a fighter as user A, sign out, and sign in as user B. Confirm B cannot see A's local or cloud roster. Switch back to A and confirm A's local versions are still present. Let a generation or retry remain in flight during one switch and confirm it cannot write into the new account.
10. Create a disposable third Clerk user, sync at least one fighter, then delete the user in Clerk. Confirm the signed webhook purges its R2/D1 data and a pre-deletion token cannot recreate the account.
11. In the isolated Insert Player Stripe sandbox, accept the app's versioned purchase terms and buy a test credit pack. Confirm Checkout uses automatic tax with the inclusive EUR catalog, one reusable Stripe Customer is linked to the Clerk user, the webhook credits exactly one pack, and duplicate delivery is idempotent. Stripe's duplicate generic Terms checkbox must remain disabled.
12. In the isolated live Insert Player Stripe account, make one real Starter purchase. Confirm exactly 11 credits are granted once and the Dashboard shows the expected EUR tax treatment.
13. Generate a Rookie fighter and confirm free quota reservation commits.
14. Generate a Contender fighter and confirm credits reserve, commit, and the fighter syncs to cloud.
15. Generate a Champion fighter and confirm credits reserve, commit, and the fighter syncs to cloud.
16. Force a generation failure and confirm `/api/billing/generation/complete` refunds the reserved credits.
17. Open `/gallery` on a second device after signing in; the cloud fighter imports and can be selected in `/roster/cpu`. Retry or upgrade that fighter on the first device, then reopen `/gallery` or `/roster/cpu` on the second device and confirm the newer cloud version refreshes without deleting older local versions. If an optional source/raw asset is missing, playable sprite import should still complete and later cloud fighters should still import. If a private imported fighter has only a partial sprite set, the fight runtime should fallback-fill missing animation states instead of showing invisible moves.
18. Rename and delete a synced fighter from Gallery and confirm the cloud copy is renamed/deleted for the same Clerk user. Click Sync Cloud or retry upload for the same generated fighter and confirm it does not create duplicate source or sprite versions for identical content.
19. Publish a fighter, open `/community`, clone it into the same or second account, and verify publishing/share/clone require the full launch animation set and cloned assets load without original uploads, raw source views, or raw sprite sheets. If the target account already has an unfinished same-photo fighter, verify the clone action merges missing playable sprites into that record instead of returning an unplayable shell.
20. Copy a community share link from Gallery or `/community`, verify the shared `/share/:id` page contains fighter-specific Open Graph metadata, open the redirected `/community?fighter=:id` in a fresh browser, and verify the linked fighter is featured and cloneable even if it is not in the first `/api/community` feed page.
21. Confirm `/assets/*` rejects private assets for signed-out users, serves public-facing side/sprite assets for community fighters, does not expose original uploads, raw intermediate sheets, internal owner ids, or photo hashes publicly, returns `private, no-store` for original/raw owner reads, and returns immutable public cache headers for published playable assets.
22. Confirm Worker rate limits return `429` with `Retry-After` under repeated expensive proxy calls.
23. Confirm `/proxy/upload-temp` returns a `/temp-assets/*` URL and no provider flow depends on a third-party temp file host.
24. Finish a match while signed in and confirm `/api/stats` shows the match in recent history.
25. Confirm source views are generated with Pro model settings regardless of selected tier.
26. Regression-check Refined animations in Gallery: the validated Champion sample must retain intact faces and remain free of visible green edge spill on neutral backgrounds.

After those checks pass, copy `launch-validation.example.json` to `.launch-validation.json` and replace every placeholder with concrete evidence from the actual run. The launch gate verifies the file is recent, matches the Worker/Pages URLs being launched, matches the same public brand as `.brand-clearance.json`, names the same two different Clerk users as `ASF_CLERK_JWT` and `ASF_CLERK_JWT_CLONE`, records generated Rookie/Contender/Champion cloud fighter ids, and includes evidence for each manual checklist item.

`npm run smoke:live:launch` covers the Worker/API portions of tier policy, billing reservations, cloud sync, idempotent uploads, sharing/privacy, match stats, and rate limits when both Clerk tokens are supplied; add `ASF_SMOKE_RATE_LIMIT=1` when you intentionally want to exhaust the anonymous proxy window. The browser/provider portions of this list still need real manual validation and must be recorded in `.launch-validation.json` before `npm run check:launch` can pass.

## Not Yet Done

- Send external test messages to `privacy@insertplayer.ai` and `support@insertplayer.ai`; Cloudflare routing, MX and SPF are configured, but inbox receipt still needs evidence.
- Clerk Development email-code QA, signed-in API loading, webhook delivery, and D1 profile retention passed with two disposable users. The dedicated Insert Player Production instance, live publishable key, issuer, authorized parties, lifecycle webhook secret, and custom-domain certificates are wired; its JWKS responds at `https://clerk.insertplayer.ai/.well-known/jwks.json`. Mailbox, phone, username, password, and Apple sign-in are disabled for the public beta. Google uses a dedicated `insert-player` Google Cloud project, public external consent branding, deployed home/privacy/terms URLs, and a dedicated client for `https://clerk.insertplayer.ai/v1/oauth_callback`. Create two Google launch-test users; Apple is a post-beta provider and must remain disabled until its dedicated credentials and production sign-in have been verified.
- Configure the isolated live account/catalog/wildcard webhook, then repeat the validated authenticated purchase flow in live mode.
- The sandbox frontend is deployed and uses Cloudflare's deterministic test widget. Deploy the production frontend after its live Clerk key is available, then validate one real production Turnstile token and reject its replay.
- Real Rookie, Contender, Champion, failed-upgrade refund, Retry, and cloud-history paths have passed in authenticated sandbox. Carry that evidence into the final launch record; do not regenerate solely to repeat provider spend.
- Real two-device sync requires Clerk browser sign-in and an authenticated smoke token.
- Real-phone touch/gamepad QA is required in portrait and landscape; desktop emulation alone does not close this gate.
- Stripe test-mode webhook delivery and signed duplicate replay are verified; repeat the purchase and delivery smoke in live mode.
- The final `npm run check:launch` gate must pass with two real Clerk users and a completed `.launch-validation.json` after Clerk, Stripe, Worker, Pages, provider tier generation, and two-device validation are complete.
- Gallery, Roster, Create, Community, and Moderation are route-lazy and protected by the production checker; the initial app chunk is `101.87 kB` gzip. Phaser remains lazy behind `/fight`, so the product shell is not blocked by the game runtime.
