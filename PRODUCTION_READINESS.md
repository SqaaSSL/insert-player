# Production Readiness

This is the launch checklist for making Insert Player playable across devices with Clerk auth, tiered pricing, Worker-side API keys, rate limiting, R2/D1 persistence, and community sharing. `AI Street Fighter` remains the internal repository name only.

`AI Street Fighter` is the internal project name only. The selected external brand is `Insert Player`, first game `Insert Player: Fight`, short name `P1`, target domain `https://insertplayer.ai`. The owner-directed launch record was completed on 2026-08-19; see `BRANDING.md` and ignored `.brand-clearance.json`.

## Required Live Services

- Cloudflare Worker: hosts the API proxy, auth-protected fighter routes, billing routes, community routes, stats, and asset reads.
- Cloudflare Workflow: owns authenticated new-fighter generation, tier upgrades, animation Retry, and canonical Pro source Retry. D1-backed progress, immutable per-artifact checkpoints, and response-backed idempotent provider-request records let the UI reconnect or resume a partial run without duplicating a charge, provider write, source view, or approved animation.
- Cloudflare Container: runs the existing TypeScript image/generation pipeline for the Workflow. The browser starts and observes jobs; server-side code alone releases an untouched reservation or commits it at the first billable provider attempt.
- Cloudflare D1: stores Clerk users, fighter metadata, sprite records, content-hashed source/sprite version archives, credit ledger, checkout sessions, generation charges, provider sessions, artifact runs/checkpoints, atomic monthly provider-spend accounting, permanent per-call cost events, atomic rate-limit counters, community moderation reports, matches, and leaderboard rows. Aggregate spend is observable but does not globally disable paid generation.
- Cloudflare R2: stores versioned source views, sprite sheets, raw sprite sheets, cloned community assets, and future intro/stage assets.
- Worker-served R2 temp assets: `/proxy/upload-temp` requires an active provider session before reading or decoding its body, counts bytes while streaming before multipart parsing, stores short-lived provider input images under the `temp/` prefix, preserves PNG/JPEG/WebP/GIF MIME types, and returns unguessable `/temp-assets/*` URLs. `/proxy/image` stays image-only; `/proxy/media` is used for generated image/video result downloads. Both result proxies require an active provider session after URL validation, handle redirects manually with revalidation on every hop, only allow HTTPS upstream result URLs, block private/special IPv4 and all IPv6 literals, require a supported MIME type, cap response bytes while streaming, and use bounded upstream timeouts. Proxied result/temp responses include `X-Content-Type-Options: nosniff`.
- Worker upload guards: authenticated source/sprite uploads enforce PNG/JPEG/WebP byte signatures, bounded file sizes, and sane sprite frame metadata before writing to R2; temp provider uploads also enforce a 12 MB cap before decode/storage.
- Provider request guards: POST bodies forwarded to Gemini are capped at 48 MB while streaming; Ludo, Freepik, Runway, and FAL bodies are capped at 24 MB. Declared oversize is rejected before fetch and chunked oversize is aborted as soon as the cap is crossed.
- Operational retention: Stripe webhook bodies are reduced to non-PII event/account/object/payment summaries. A daily `0 4 * * *` Cron Trigger releases only still-unused reservations for cloud jobs stalled for four days; jobs with committed provider spend remain consumed and enter the repair/support path. It removes technical provider-response replay blobs one day after terminal completion, drops terminal job telemetry after seven days, then removes unreferenced old provider sessions, expired rate limits/webhook markers, abandoned checkouts, and closed moderation reports on their schedules. It never deletes credit history, users, tombstones, fighters, generated source/sprite/RAW versions, or user asset history.
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

Release status on 2026-08-24: the full Pages app, Clerk Production, dedicated Google OAuth, live Stripe configuration, and production API `0.18.0` are active. Production and QA both run migrations through `0024` with isolated Workflows and Containers; protected `main` and `develop` are byte-for-byte aligned. Production Actions `32767504225` / `32769749516` and development Actions `32767773857` / `32770040565` passed checks, migrations, Worker/Container/Workflow deploys, API smokes, Pages deploys, and readiness with the durable account-owned Cloudflare token. Authenticated sandbox Action `32768251105` passed the disposable two-user Clerk/D1/R2/privacy/deletion flow. Runtime source, the compiled processor bundle, and the Container build fail closed on unapproved BFL/FLUX/Klein endpoints or imports; the operator seeder also verifies the deployed Container contract before touching Arcade inventory, pinning canonical sources and visible Champion output to the approved Gemini models.

- Worker diagnostics URL: `https://ai-street-fighter-api.shellbot.workers.dev`; public API: `https://api.insertplayer.ai`.
- The approved `0.18.0` release from protected `main` is deployed and live-validated. It preserves the production proxy/auth/billing/storage code, server-owned `FIGHTER_GENERATION` Workflow, EU `IMAGE_PROCESSOR` Container, response-backed provider cache, immutable source/sprite checkpoints, resumable partial runs, operation-specific credit reservations, first-provider charge commitment with no automatic restoration after billable inference, exact apex+`www` CORS/Turnstile allowlists, fixed `clerk.insertplayer.ai` issuer, dedicated Insert Player Stripe account pin, Clerk account lifecycle, HMAC-pseudonymized anonymous identifiers, versioned consent, streaming request limits, transactional asset versioning, audited moderation, Stripe reconciliation, purpose/tier route and GA Gemini model allowlists, conservative per-session call/cost ceilings, atomic unbounded monthly accounting, and permanent per-call provider cost events. AI arena sessions remain limited to one Flash call / 10¢, five per free signed-in account/day, and one client-cached result per arena theme.
- Pages project: `insert-player`; Pages URL `https://insert-player.pages.dev/`. The protected `main` Pages branch was deployed by Actions `32767504225` and `32769749516`; preview and canonical frontend smoke passed, followed by live readiness. `insertplayer.ai` and `www.insertplayer.ai` are active custom domains with certificates and serve the full product app. The credential-free prelaunch build remains a checked emergency/holding artifact, not the current public surface.
- Cloudflare zone: `insertplayer.ai` (`24154d7072f2d94c9f69a26cc01f9541`), delegated to `maisie.ns.cloudflare.com` and `sean.ns.cloudflare.com`. Always Use HTTPS, strict SSL, TLS 1.2 minimum, TLS 1.3, HTTP/3, Brotli, and Browser Integrity Check are enabled.
- D1: `insert-player-db` (`aa9e6ba6-8a7f-4261-ac31-986e6cf44659`, EU jurisdiction, EEUR primary region, automatic read replication, Time Travel bookmark verified)
- D1 migrations: production and QA have `0001` through `0024`. Migrations `0018`/`0019` add durable generation/retry jobs, progress events, idempotent provider-request records, and exact retry targets. Migrations `0020`-`0022` add official Arcade state/prompt provenance and provider-capacity windows. Migration `0023` backfills immutable artifact runs/checkpoints and resumable job lineage while preserving every existing source/sprite version and provider response; migration `0024` adds resumable, audited asset deletion without erasing provider-cost history.
- R2: `insert-player-assets` (EU jurisdiction)
- R2 lifecycle: `expire-temp-assets` deletes `temp/` objects after 1 day
- R2 exposure: public `r2.dev` URL disabled; no direct custom domains or bucket CORS policy
- Worker provider secrets set: Gemini, FAL, Runway, Freepik, Ludo
- Isolated QA Worker: `https://insert-player-api-sandbox.shellbot.workers.dev`. The approved `0.18.0` release from protected `develop` was deployed and smoke-tested by Actions `32767773857`, `32770040565`, and `32768251105`. `ENVIRONMENT=sandbox`, production-origin CORS is denied, Clerk Development is configured, and dedicated test-mode Stripe billing is configured. The matching Pages branch is `develop`; preview and canonical smoke both passed. The QA Workflow is `insert-player-fighter-generation-sandbox`; the image-processor Container is isolated from production. Provider secrets are present for authenticated QA, while `ANONYMOUS_ROOKIE_ENABLED=false` blocks public provider-session minting before cost.
- Isolated QA D1: `insert-player-sandbox-db` (`f60b6e22-d262-4e46-a7d9-ca095e49d102`, EU jurisdiction, EEUR primary region), with migrations `0001` through `0024` applied
- Isolated QA R2: `insert-player-sandbox-assets` (EU jurisdiction), with `temp/` objects expiring after 1 day; provider secrets and a unique anonymization secret are installed on the sandbox Worker
- Isolated QA Pages project: `insert-player-sandbox`; stable URL `https://insert-player-sandbox.pages.dev/`, deployed automatically from protected `develop`
- `npm run smoke:sandbox` passes D1/R2, provider accounting/session-limit health, disabled-global-cap health, CORS, signed-out auth, tier-cost, privacy, and live-Stripe-absence checks
- Production dependency audit: zero known vulnerabilities as of 2026-08-19.
- The sandbox v2 Stripe catalog and purchase path pass twice: each €14.99 Starter purchase granted exactly 11 credits once, moving the wallet from 6 to 17 to 28 while preserving the historical 6-credit purchase and every ledger row.
- A real Champion Victory Retry and a Pro Upright-source Retry ran as QA Workflows, continued after leaving Gallery, reconnected on return, committed exactly one credit each, and preserved all previous clean/RAW/source versions. The Victory job used three Flash calls with a conservative 24¢ cost; the Upright source job used one Pro call with a conservative 15¢ cost.
- Separate Chrome and in-app-browser storage origins loaded the same signed-in 28-credit wallet, match history, and Champion fighter from D1/R2. A fresh origin exposed the fighter after the 11 best playable sprites arrived in `4.776s`; all 48 cloud sprite versions plus RAW assets then hydrated in the background, and the next Gallery entry reached `Ready` in `3.037s`. This is strong cross-browser persistence evidence, but a physical second-device pass remains required.
- Cost-integrity recovery is deployed without new inference: failed Champion job `f3b6c650cbb2e1bf796eebb79edff5c7` is a partial run whose side, upright, crouch, idle, walk, high_punch, and high_kick checkpoints all resolve to preserved clean/RAW R2 blobs. Its first pending stage is `sprite:low_punch`; resume reuses those seven checkpoints and the 101 response-backed provider-cache entries instead of regenerating them. The `$8.85` figure attached to the job is a conservative internal estimate, not a provider invoice. Do not resume it or run official roster generation until the owner separately approves paid inference.
- Still missing before calling the beta production-ready: finish and activate the QA-approved Arcade roster; verify support-address delivery/reply; run real-phone QA; and complete physical two-device validation. Durable GitHub Cloudflare auth, both branch deployment workflows, the disposable Clerk Development smoke, the real production Turnstile success/replay check, and the authenticated production smoke are complete. Real provider generation, cloud archival, durable reconnect, and the authenticated Stripe purchase/webhook path have passed in isolated QA. Live Stripe is validated through account/catalog/webhook configuration and API-level readiness; a real-money Checkout is not a CI/CD, smoke, or prelaunch requirement.
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
npx wrangler secret put GENERATION_JOB_SIGNING_SECRET
npx wrangler secret put CLERK_BACKEND_AUTH_BRIDGE_SECRET
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
CLERK_BACKEND_AUTH_BRIDGE_SECRET=replace_with_a_distinct_random_value_of_at_least_32_characters
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

The live gate currently has a production-shaped app to inspect. It fetches Clerk JWKS and requires keys to be present; health must report production environment, configured CORS, Clerk auth, `accountLifecycle: "clerk_webhook"`, live Stripe billing, Turnstile, D1/R2 bindings, configured providers, durable generation, `providerAccounting: "durable"`, `providerSessionLimits: "configured"`, and `providerGlobalCaps: "disabled"` after the `0.18.0` promotion. `CLERK_JWKS_URL` may override key fetching, but `CLERK_ISSUER` remains mandatory so issuer validation cannot be skipped. A test-mode Stripe key reports `billing: "stripe_test"` and fails readiness. The gate also fetches `/`, `/menu`, Checkout success/cancel routes, and `/community?fighter=readiness` from the production frontend origin and requires the full app shell.

The local production verifier also replays D1 migrations and behavior-tests Stripe checkout/session idempotency at the schema level: checkout rows are pre-reserved before Stripe is called, webhooks can reconcile by Stripe id or local `session_token`, the Stripe event's user/pack/credits/amount/currency must match the local checkout row, mismatched amounts do not claim a row, first claim wins, duplicate claim returns no rows, duplicate ledger insert is ignored, duplicate Stripe event insert is ignored, and the credit grant advances through a single D1 batch from `crediting` to `paid`. It verifies that persisted webhook summaries exclude customer PII and that scheduled retention cannot target durable user data. The Worker rejects checkout with a clean `503` before writing a D1 checkout row when Stripe is not configured, and refuses test-mode Stripe checkout on the production Worker.

It also requires Node >=22.12.0, runs `npm run check:tiers` to keep frontend tier labels/costs, Worker credit and estimated costs, tier pipeline/model/background-removal settings, and Pro source-view env docs in sync, bounds live curl/Wrangler/fetch checks with timeouts so launch gates fail instead of hanging, and behavior-tests the D1 rate-limit fallback and provider-session budgets: active counters increment to the anonymous limit, return a blocked state at the threshold, expired windows are ignored, provider sessions spend one call per expensive provider POST, Rookie sessions have smaller budgets than refined paid tiers, and exhausted sessions stop before upstream. Live `429` abuse smoke remains opt-in via `ASF_SMOKE_RATE_LIMIT=1` and passed against the production Worker on 2026-05-16.

8. After deploy, run the Worker smoke test:

```bash
ASF_WORKER_URL=https://api.insertplayer.ai \
ASF_FRONTEND_ORIGIN=https://insertplayer.ai \
npm run smoke:live
```

`npm run smoke:live` is the unauthenticated public Worker smoke. It verifies the deployed public API surface and health, but it is deliberately insufficient for launch because it cannot prove per-user storage, publish/clone boundaries, authenticated billing authorization, or two-device behavior.

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

The automated GitHub smoke uses Clerk Agent Tasks, whose backend-created session tokens omit `azp`. Store a distinct `CLERK_BACKEND_AUTH_BRIDGE_SECRET` in both the matching GitHub environment and Worker. The smoke sends it only from the Node runner; the Worker does not expose that header through CORS and still rejects every token carrying a wrong `azp`. Manual browser JWTs remain origin-bound and do not need the bridge.

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

The unauthenticated smoke checks health, allowed-origin CORS, unconfigured-origin non-reflection, provider-session browser preflight, tiers, billing packs, protected checkout/fighter/stat routes, Rookie-vs-paid generation policy, public community cache headers without account names/emails, internal/Clerk owner ids, owner-scoped R2 paths, photo hashes, or Clerk profile photos, neutral `Player` attribution, private-host image/media proxy blocking, provider proxy allowlisting, broad result-list blocking, provider-session enforcement, and R2 temp assets; with `ASF_SMOKE_RATE_LIMIT=1` it also verifies proxy rate limiting. The authenticated smoke creates a disposable fighter with an intentionally long/control-character name to verify Worker normalization, reserves and releases an untouched Rookie generation idempotently, verifies paid-tier credit gating or pre-provider reservation release if the smoke account has credits, retries the same source and sprite uploads to prove content-addressed idempotency, verifies owner-gated private assets, verifies partial fighters cannot publish, uploads the full launch animation set before publishing, verifies opaque/revocable community asset privacy and neutral attribution, optionally creates an unfinished same-photo fighter under a second Clerk account and verifies community clone merges playable public assets into it without exposing raw/original assets, verifies generation authorization and match reporting reject that second account's fighter id for the first account, records an unranked match, checks stats history and signed-in record updates, and deletes disposable fighters.

Public smoke passed on 2026-08-17 against Worker `0.15.0`, version `770313f4-9f1b-491d-bffb-ef3ad1c090af`, at `https://ai-street-fighter-api.shellbot.workers.dev` with `ASF_FRONTEND_ORIGIN=https://insert-player.pages.dev`. Its historical health contract reported `providerBudget: "configured"`; candidate `0.18.0` replaces that with durable-accounting, per-session-limit, and disabled-global-cap assertions. The smoke covered production bindings, allowed-origin CORS and unconfigured-origin non-reflection, tiers/packs, public community and leaderboard privacy, protected signed-out routes including community report/admin moderation endpoints, invalid-bearer handling, Rookie-vs-paid generation policy, deterministic private-host image/media blocking, provider allowlisting/session enforcement including polling, temporary upload authorization before R2 writes, malformed route handling, and nonce-based missing-share-page security headers. Local release tests additionally cover versioned legal consent, Stripe automatic-tax/catalog/customer binding, partial/full refunds, disputes, duplicate and out-of-order payment events, community report deduplication/admin review/manual unpublish, provider model allowlisting, conservative per-session ceilings, unbounded atomic monthly accounting, daily AI-arena account limits, chunked multipart/provider-request overflow, redirect-to-private rejection, required result MIME, redirect limits, streamed result-size enforcement, upstream timeout/error mapping, Stripe PII minimization, HMAC pseudonymization, and safe operational retention. Public share-page metadata smoke is also wired and runs automatically when `/api/community` has at least one public fighter in the feed.

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
- `config:sandbox --require-complete` and live config validate the activation and public profile fields Stripe exposes from `/v1/account`: details submitted, charges and payouts enabled, Insert Player name, website, and a public support contact. Checkout explicitly sends `consent_collection[terms_of_service]=none` to avoid a redundant generic Stripe checkbox. The authenticated sandbox purchase is the authoritative proof for payment, price, automatic tax, customer address collection, legal evidence, webhook fulfillment, and idempotency. Live launch evidence is read-only account/catalog/webhook validation; never create a real-money payment from CI/CD, smoke tests, or prelaunch validation.
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

- Keep the Stripe endpoint subscribed to all events (`*`), as configured for the isolated account. The Worker acts on `checkout.session.completed`, `charge.refunded`, `refund.created`, `refund.failed`, `charge.dispute.created`, and `charge.dispute.closed`; unsupported signed event types are acknowledged with `200` and retained only as bounded non-PII audit markers. These handlers do not initiate refunds: they adjust the wallet only after Stripe or a bank has already reversed or disputed funds. A won dispute restores only the held credits, while already-spent reversed value may leave a negative balance. Bootstrap and production checks must preserve/require the wildcard subscription.
- Store the webhook signing secret as `STRIPE_WEBHOOK_SECRET`; `--create-webhook` writes a newly returned sandbox secret to `.env.sandbox.local` or live secret to `.env.production.local` without printing it. Existing endpoint secrets must already be present because Stripe never returns them again.
- Any future Checkout regression test must run only against the isolated deployed sandbox Worker, whose `ENVIRONMENT=sandbox` accepts `sk_test_...`. The bootstrap rejects a live key for the sandbox, rejects a test key for live, requires `--allow-live` for live mutation, and pins each target to its own webhook origin. The production Worker intentionally refuses test-mode Stripe events and Checkout. The two completed sandbox purchases already close this launch gate; do not repeat them solely for prelaunch evidence.
- The existing sandbox Checkout evidence verifies:
  - Stripe success/cancel redirects scrub `checkout` and `session_id` from the browser URL, return to the `/menu` wallet, and refresh credits after webhook crediting without a manual reload.
  - `checkout_sessions.status` becomes `paid`.
  - A repeated delivery of the same Checkout Session does not add credits twice.
  - `stripe_events` has exactly one row for the event id.
  - `users.credits_balance` increases once.
  - `credit_ledger` has one positive `stripe_credit_pack:*` row with `stripe_session_id`.

## Launch Smoke Tests

Run these with a fresh browser profile and then repeat on a second device:

Local/sandbox prelaunch evidence: on 2026-08-17 a real Rookie generated all four Pro canonical views plus all 11 animations without retries and entered a playable desktop match. Processing v4 detected that the provider returned a `4x4` subject grid for a requested `4x2` sheet, rebuilt the active playable versions from preserved RAW blobs, and retained every prior version. On 2026-08-19 the same authenticated fighter completed Contender and Champion upgrades; measured completed sessions were Rookie 17 calls / `$1.43`, Contender 165 / `$7.88`, and Champion 123 / `$12.64`. Two interrupted Champion attempts restored their reservations under the superseded pre-launch policy; launch code now commits at the first billable provider attempt and never restores that spend automatically. Every tier retained all 11 cloud animations and prior versions. A later Champion WALK Retry completed with 33 calls / `$2.64`; processing v5 preserved the face and reduced severe green-edge contamination from `43.704%` to `0.276%`. All 11 current Champion animations were reconstructed from preserved RAW sheets without provider calls, incrementally synced with exactly 12 total uploads across the Retry and migration, retained every older cloud version, and entered a completed fight. The initial Rookie charge and zero-delta ledger were backfilled to the cloud fighter, and future clients persist that purchase id until idempotent sync linkage succeeds. Mobile-browser emulation at `390x844` kept all eight controls in view and real touch events moved and attacked. A full Attract Mode match also completed two rounds, reached the result state, exposed accessible Run It Back / Remix / Menu controls, and restarted cleanly through Run It Back. This closes the real all-tier provider/billing/storage path but does not replace production authentication or physical-device checks below.

1. Signed-out `/menu` loads.
2. Confirm the cleared public brand appears in production HTML title, Open Graph/Twitter metadata, manifest, social-card PNG, app icons, and Worker `/share/:id` metadata, with no internal project name visible.
3. Signed-out Create defaults to Rookie; Contender/Champion are visibly locked and Worker-blocked. Confirm Rookie stays disabled until Turnstile returns a token.
4. Open `/legal`, `/privacy`, `/terms`, and `/refunds`. Confirm legal version `2026-08-23.1`, operator/address/registry details, the visible Cancellations label, and AI-generated labels. Confirm generation consent says credits are consumed when external AI begins, are not automatically restored after provider failure, and preserve mandatory remedies. It must also authorize only processing needed to create and privately save the fighter, reject any publication/reuse licence, say the original is never published, and exclude sale, advertising use, and Insert Player model training. Confirm Publish opens a separate dialog naming the public clean generated sources/playable assets under neutral author `Player` while excluding account name/email, original, Clerk profile photo, RAW intermediates, private hashes, and history. Every generation/retry/upgrade and credit checkout must remain disabled until its current versioned consent is checked.
5. Send separate messages to `privacy@insertplayer.ai` and `support@insertplayer.ai`; confirm both reach the verified operator inbox and that replies use an appropriate product/operator identity.
6. From a signed-in non-owner account, report a public fighter. Repeat the report and confirm the queue keeps one record with an incremented count. Sign in as an `admin`, open `/moderation`, record a note, and manually dismiss or action the report. Verify that `Remove Fighter` unpublishes it and that no report count can trigger automatic removal.
7. Submit one real production Turnstile token and confirm anonymous Rookie authorization succeeds once. Replay that exact token and confirm the Worker returns `403` with no `providerSessionId`.
8. Sign in with Clerk.
9. In one browser profile, create or import a fighter as user A, sign out, and sign in as user B. Confirm B cannot see A's local or cloud roster. Switch back to A and confirm A's local versions are still present. Let a generation or retry remain in flight during one switch and confirm it cannot write into the new account.
10. Create a disposable third Clerk user, sync at least one fighter, then delete the user in Clerk. Confirm the signed webhook purges its R2/D1 data and a pre-deletion token cannot recreate the account.
11. Record the existing isolated Stripe sandbox evidence: versioned purchase terms, automatic tax with the inclusive EUR catalog, one reusable Customer linked to the Clerk user, exactly-once webhook crediting, duplicate-delivery idempotency, and no redundant Stripe Terms checkbox. Do not create another Checkout solely to satisfy launch validation.
12. Generate a Rookie fighter and confirm free quota reservation commits.
13. Generate a Contender fighter and confirm credits reserve, commit, and the fighter syncs to cloud.
14. Generate a Champion fighter and confirm credits reserve, commit, and the fighter syncs to cloud.
15. Force one failure before any provider request and confirm the Workflow releases the untouched reservation server-side. Then force an upstream provider failure and confirm the charge remains committed, the failed cost event remains counted, and no credits return automatically. Retry the identical start request concurrently and confirm only one job and one reservation survive.
16. Start generation, upgrade, animation Retry, and source Retry as applicable, then navigate away and interrupt connectivity. Confirm the job continues in Cloudflare, reopening Create/Gallery reconnects to D1 progress, one credit reservation reaches the correct terminal state, and every previous version remains available. Then open `/gallery` on a second device; the cloud fighter must import and be selectable in `/roster/cpu`. Optional missing source/RAW history must not block playable sprite import, and partial private fighters must fallback-fill runtime animation states instead of showing invisible moves.
17. Rename and delete a synced fighter from Gallery and confirm the cloud copy is renamed/deleted for the same Clerk user. Click Sync Cloud or retry upload for the same generated fighter and confirm it does not create duplicate source or sprite versions for identical content.
18. Publish a fighter, open `/community`, clone it into the same or second account, and verify publishing/share/clone require the full launch animation set and cloned assets load without original uploads, raw source views, or raw sprite sheets. If the target account already has an unfinished same-photo fighter, verify the clone action merges missing playable sprites into that record instead of returning an unplayable shell.
19. Copy a community share link from Gallery or `/community`, verify the shared `/share/:id` page contains fighter-specific Open Graph metadata, open the redirected `/community?fighter=:id` in a fresh browser, and verify the linked fighter is featured and cloneable even if it is not in the first `/api/community` feed page.
20. Confirm owner-scoped `/assets/*` rejects every signed-out/non-owner request and returns `private, no-store` for authenticated owner reads. Confirm community payloads and `/share/:id` contain only `/public-assets/fighters/*` media URLs with no `users/`, Clerk/internal owner id, original upload, RAW sheet, or photo hash; public media must use short revalidating cache headers and become `404`/`no-store` after Unpublish.
21. Confirm Worker rate limits return `429` with `Retry-After` under repeated expensive proxy calls.
22. Confirm `/proxy/upload-temp` returns a `/temp-assets/*` URL and no provider flow depends on a third-party temp file host.
23. Finish a match while signed in and confirm `/api/stats` shows the match in recent history.
24. Confirm source views are generated with Pro model settings regardless of selected tier.
25. Regression-check Refined animations in Gallery: the validated Champion sample must retain intact faces and remain free of visible green edge spill on neutral backgrounds.

After those checks pass, copy `launch-validation.example.json` to `.launch-validation.json` and replace every placeholder with concrete evidence from the actual run. The launch gate verifies the file is recent, matches the Worker/Pages URLs being launched, matches the same public brand as `.brand-clearance.json`, names the same two different Clerk users as `ASF_CLERK_JWT` and `ASF_CLERK_JWT_CLONE`, records generated Rookie/Contender/Champion cloud fighter ids, and includes evidence for each manual checklist item.

`npm run smoke:live:launch` covers the Worker/API portions of tier policy, billing reservations, cloud sync, idempotent uploads, sharing/privacy, match stats, and rate limits when both Clerk tokens are supplied; add `ASF_SMOKE_RATE_LIMIT=1` when you intentionally want to exhaust the anonymous proxy window. The browser/provider portions of this list still need real manual validation and must be recorded in `.launch-validation.json` before `npm run check:launch` can pass.

## Not Yet Done

- Send external test messages to `privacy@insertplayer.ai` and `support@insertplayer.ai`; Cloudflare routing, MX and SPF are configured, but inbox receipt still needs evidence.
- Clerk Development email-code QA, signed-in API loading, webhook delivery, and D1 profile retention passed with two disposable users. The dedicated Insert Player Production instance, live publishable key, issuer, authorized parties, lifecycle webhook secret, and custom-domain certificates are wired; its JWKS responds at `https://clerk.insertplayer.ai/.well-known/jwks.json`. Mailbox, phone, username, password, and Apple sign-in are disabled for the public beta. Google uses a dedicated `insert-player` Google Cloud project, public external consent branding, deployed home/privacy/terms URLs, and a dedicated client for `https://clerk.insertplayer.ai/v1/oauth_callback`. Create two Google launch-test users; Apple is a post-beta provider and must remain disabled until its dedicated credentials and production sign-in have been verified.
- The isolated live account/catalog/wildcard webhook and full production frontend are configured. Keep launch verification read-only in Live; use the isolated Stripe sandbox for Checkout and webhook fulfillment tests.
- Production Turnstile validation completed on 2026-08-24: one real token authorized exactly one `anonymous_rookie` provider session with `200`; replaying the exact token returned `403 turnstile_failed` and no second `providerSessionId`. No fighter, upload, provider request, or inference was started.
- Real Rookie, Contender, Champion, pre-launch failed-upgrade settlement, Retry, cloud-history, and durable navigation/reconnect paths have passed in authenticated sandbox. Revalidate the new first-provider commit/no-restoration boundary without regenerating completed tiers solely to repeat provider spend.
- Real two-device sync requires Clerk browser sign-in and an authenticated smoke token.
- Real-phone touch/gamepad QA is required in portrait and landscape; desktop emulation alone does not close this gate.
- Stripe test-mode webhook delivery and signed duplicate replay are verified. Do not repeat them with a real-money payment as part of CI/CD or prelaunch validation.
- The final `npm run check:launch` gate must pass with two real Clerk users and a completed `.launch-validation.json` after Clerk, read-only Live Stripe configuration, Worker, Pages, provider tier generation, and two-device validation are complete.
- Gallery, Roster, Create, Community, and Moderation are route-lazy and protected by the production checker; the initial app chunk is `101.87 kB` gzip. Phaser remains lazy behind `/fight`, so the product shell is not blocked by the game runtime.
