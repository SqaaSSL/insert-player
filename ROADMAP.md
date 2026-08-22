# Roadmap & handoff

> Living document of where the project is and what's next.
> Read `CLAUDE.md` first for codebase orientation, then this file for current state, then `QUALITY_TIERS.md` for tier details.

---

## Snapshot — 2026-08-22

- **Cloud pull is progressive and content-incremental in real QA**: the browser importer compares version/content hashes and unique animation names, hydrates the best playable sprite per animation first, then serially fills lower-tier/history and RAW assets in the background without deleting or replacing any version. A fresh second browser origin made the 48-version Champion playable in `4.776s` instead of roughly 31 seconds; after background hydration, a second Gallery entry reached `Ready` in `3.037s`. Interrupted history hydration is detected by the persisted remote-version count and resumes on the next visit. Archive-only uploads now advance the fighter timestamp so devices that already imported the fighter discover newly uploaded history.
- **Insert Player has isolated production storage**: D1 `insert-player-db` (`aa9e6ba6-8a7f-4261-ac31-986e6cf44659`) and R2 `insert-player-assets` are in the EU. D1 migrations `0001` → `0017` are applied. Provider spend has atomic monthly and rolling reserves plus a permanent per-call cost ledger keyed by billing operation/outcome; scheduled cleanup cannot delete that ledger, credits, fighters, versions, users, tombstones, or R2 assets. R2 remains private behind the Worker and its `temp/` lifecycle deletes after one day.
- **Cloudflare delivery is prepared**: production Worker `0.16.0`, version `98270002-24fc-427d-8467-67b6374a4d3d`, is deployed at `https://api.insertplayer.ai` with migration `0017`, operation-specific billing, durable provider cost events, isolated EU D1/R2, provider/Turnstile/anonymization secrets, exact production CORS/Turnstile allowlists, provider-session route/model/call/cost guards, bounded downloads, and the verified daily cleanup trigger. Public smoke passes. Pages project `insert-player` still serves the credential-free legal prelaunch until production Clerk and live Stripe are ready.
- **Cloudflare QA is physically isolated and publicly testable**: sandbox Worker `0.16.0` (`ec74e04b-50e5-4c6b-83c4-ae6ecb7fb7a6`) runs at `https://insert-player-api-sandbox.shellbot.workers.dev` with migration `0017`, isolated Clerk/Stripe/provider/anonymization secrets, EU D1/R2, and the separate provider reserves. Pages deployment `13a05984` is live at `https://insert-player-sandbox.pages.dev`. Remote smoke verifies tiers 2/11/18, D1/R2, provider readiness, test Stripe isolation, and public anonymous generation shutdown. A signed-in browser verified the v2 catalog, Champion/source retry labels, and Gallery cloud data.
- **Anonymous generation is protected before cost**: the dedicated managed Turnstile widget and Worker verifier are both restricted to `insertplayer.ai` and `www.insertplayer.ai`; the production Pages preview hostname is intentionally excluded. Signed-out Rookie authorization validates the single-use token, expected `anonymous_rookie` action, Siteverify hostname, and connecting IP before minting a provider session; production fails closed if the protection is missing or unavailable. One authorization per pseudonymized network identity/day remains defense in depth.
- **DNS, certificates, and the legal prelaunch surface are active**: the `.ai` registry and public resolvers delegate `insertplayer.ai` to `maisie.ns.cloudflare.com` and `sean.ns.cloudflare.com`; Cloudflare activated the zone on 2026-08-18. Apex and `www` are attached to Pages with active certificates. Production Pages deployment `b75eaf8f` now serves a deliberately isolated Insert Player holding screen plus `/legal`, `/privacy`, `/terms`, and `/refunds`; its separate 34-module bundle contains no Clerk key, provider/API endpoint, Stripe runtime, or Phaser code, and its CSP trusts no external origin. This removes the prior `522` and makes final Stripe profile URLs verifiable without pretending the full app has launched. `https://api.insertplayer.ai/health` serves the production Worker with valid TLS.
- **Legal/support mail is routed**: Cloudflare Email Routing is `ready`; `privacy@insertplayer.ai` and `support@insertplayer.ai` are enabled as explicit rules to the existing verified corporate ShellBot mailbox, while catch-all remains disabled. Public resolvers return Cloudflare's MX and SPF records, and an SMTP edge probe received `250` for both recipients. Send one real message from an unrelated mailbox to each address, confirm inbox receipt, and test the reply identity before launch.
- **Current legal surfaces are deployed in QA**: legal version `2026-08-19` exposes `/legal`, `/privacy`, `/terms`, and `/refunds`, uses the current BORME registered office and sheet, and discloses AI-generated public fighters in Community and share metadata. The current consolidated LSSI article 9 has been without content since 2007, so domain registration is not a launch task; article 10 operator/contact/registry/price disclosures are the applicable surface. Desktop and `390x844` QA pass, including a mobile auth-dock overlap fix.
- **Billing is economically guarded**: full generation/upgrade costs are Rookie 2, Contender 11, Champion 18 credits; animation retries cost 1/2/4, canonical Pro source retries cost 1, and RAW HD reconstruction is free/local. Launch packs are Starter (11 credits, €14.99), Versus (20, €24.99), and Arcade (47, €56.99). `check:tiers` calculates net revenue after 21% VAT, Stripe EEA-card fees, and Stripe Tax; clean tiers must cover at least 1.30× measured provider cost, retries at least 1.25× conservative cost, and the real failure-heavy `$32.64` QA sequence must remain above 1.10×. A durable `provider_cost_events` ledger attributes attempted upstream writes to operation, model, charge, outcome, and estimated cost.
- **Stripe QA is isolated and validated through the Checkout boundary**: the v2 sandbox catalog is active at 11/20/47 credits for €14.99/€24.99/€56.99; stale v1 prices are inactive but purchase history is preserved. Two signed-in Starter Checkouts completed at €14.99, returned to `/menu`, and moved the wallet from 6 to 17 to 28. Remote D1 records two `paid` 11-credit Checkouts and two distinct `+11` ledger entries alongside the untouched historical `paid` 6-credit purchase. The wildcard webhook remains sandbox-only. Live keys/catalog/webhook and a live purchase remain outstanding.
- **Clerk Development is isolated, connected, and browser-validated**: the dedicated Insert Player application uses issuer `https://right-cricket-1317.clerk.accounts.dev`; its publishable key is wired only into the sandbox frontend, Google and Apple are available, and the sandbox Worker has the matching issuer plus webhook signing secret. Email sign-up/sign-in, verification codes, and `Require email address` are enabled only for QA. Two fresh `+clerk_test` accounts completed the prebuilt sign-up flow with the fixed test OTP; signed-in wallet/stats loaded, both `user.created` deliveries were recorded, and D1 retained the second user's verified email after subsequent sparse-JWT requests. The current Worker preserves authoritative webhook profile fields when Clerk session tokens omit email/name/avatar, with real-D1 regression coverage. Development may receive all events while unsupported payloads are discarded; the lifecycle handler still consumes only `user.created`, `user.updated`, and `user.deleted`. Production Clerk, dedicated production OAuth credentials, and two launch users/JWTs remain outstanding.
- **A real Rookie generation now plays end to end locally**: a fresh fictional portrait produced all four canonical Pro source views and all 11 Rookie animations without retries. The provider returned 16 subjects in a `4x4` sheet despite the requested `4x2`; processing v4 now infers the occupied subject grid, samples the requested frame count in order, and rebuilds playable sheets from preserved RAW blobs without provider calls or deletion of any older version. The repaired fighter rendered correctly in a live desktop match and completed normal movement, damage, and timer updates.
- **Champion background removal and incremental sync are validated with real paid-path output**: an authenticated Champion WALK Retry completed with 33 provider calls and `$2.64` estimated provider cost. The face remained intact, while measured severe green-edge contamination fell from `25,072 / 57,368` edge pixels (`43.704%`) to `176 / 63,805` (`0.276%`). Processing v5 adds connected-component-aware chroma decontamination plus alpha bleed; all 11 current Champion animations were rebuilt from preserved RAW sheets without provider calls and entered a completed match. Cloud sync uploaded exactly one new Retry blob plus 11 processing-v5 reconstructions, retained 37 v4 and 11 v5 archived versions at validation time, and promoted already-known content without sending bytes.
- **Mobile play is implemented and emulation-tested locally**: React coarse-pointer fight controls feed a tested virtual-input bridge, and `InputManager` merges keyboard, gamepad, and touch input. A real mobile-browser emulation pass at `390x844` verified every control stays inside the viewport and CDP touch events move and attack in the live match; a collapsed canvas margin discovered during that pass is fixed. Match completion now replaces the fight controls with accessible React actions for Run It Back, Remix, and Menu instead of exposing keyboard-only instructions; a full Attract Mode match completed two rounds and Run It Back restarted cleanly. Real-device portrait/landscape interaction and safe-area visual QA remain launch checks.
- **Local hardening is green**: `npm test` (153 tests across 30 files), `npm run build`, and `npm run check:production` pass; root and Worker dependency audits report zero known vulnerabilities. The production checker rejects preview Gemini image model ids, decodes each Clerk publishable key, generates target-specific CSP allowlists, and requires the live Frontend API host plus `CLERK_ISSUER` to be exactly `clerk.insertplayer.ai`. Real Miniflare D1/R2 integration tests exercise Clerk profile merging, concurrent identical source/sprite uploads, hash-manifest incremental sync/promotion, resumable progressive cross-device hydration, late generation-purchase fighter linkage, Stripe refund/dispute reconciliation under duplicate and out-of-order delivery, the full community-report/moderation lifecycle, provider model allowlisting, operation-specific billing, and per-session/monthly/rolling-window/durable-event spend accounting. Proxy tests cover chunked multipart/provider-request overflow, redirect-to-private rejection, MIME enforcement, and streamed response overflow. Legal, Stripe profile/tax/customer, anonymous-pseudonymization, moderation, retention, ignored signed Clerk events, Gemini retry policy, DNN fallback, alpha-edge decontamination, exact provider-rate-limit boundaries, cross-environment CSP isolation, and the credential-free prelaunch bundle prove the launch controls and that scheduled maintenance cannot delete durable user data. Node is pinned to 22.23.2 and current Wrangler is used. Gallery, Roster, Create, Community, and Moderation are route-lazy behind a production structural guard; Phaser remains a separate lazy fight chunk and does not block the product shell.
- **Final launch blockers**: one real receipt/reply test for each routed support address, production Clerk, isolated live Stripe configuration, replacement of the legal holding build with the production app bundle, a real production Turnstile token + replay check, authenticated two-user API smoke, live Stripe payment and webhook smoke, real-phone QA, and two-device sign-in/import/play validation. Real provider generation for all three tiers and the authenticated Stripe purchase/webhook path are complete in isolated QA; the owner-reviewed `Insert Player` brand record is complete.

## Historical snapshot — end of session 2026-05-13

### Foundation log — 2026-05-14 (resource names below are superseded)

- **Cloudflare backend is now live**: Wrangler OAuth is authenticated, D1 `ai-street-fighter-db` was created in APAC with id `f651e10a-ad65-4c21-b826-a55baa8887a1`, R2 `ai-street-fighter-sprites` was created with a 1-day `temp/` lifecycle cleanup rule, migrations `0001` → `0014` were applied remotely, and Worker `ai-street-fighter-api` `0.15.0` was deployed at `https://ai-street-fighter-api.shellbot.workers.dev` (version `770313f4-9f1b-491d-bffb-ef3ad1c090af`).
- **External brand is selected but still launch-blocked on clearance**: `AI Street Fighter` remains an internal project name. The selected public platform brand is `Insert Player`, first game `Insert Player: Fight`, short name `P1`, target domain `https://insertplayer.ai`. Static metadata/assets now use Insert Player, React/Worker public share surfaces read the launch brand from env, and `npm run brand:apply` / `npm run brand:rasterize` mechanically update static metadata/SVG/PNG assets. `BRANDING.md` explains the search/legal workflow, `brand-clearance.example.json` is the local evidence template, and `npm run check:launch` rejects missing clearance, internal `Street Fighter` wording, missing static brand application, or dynamic public surfaces that stop reading the public brand config.
- **Cloudflare Pages project is reserved**: `insert-player` will be available at `https://insert-player.pages.dev/` after the first frontend deployment. `.env.production` targets `https://api.insertplayer.ai`; Pages native SPA rendering handles direct routes because the build intentionally has no top-level `404.html` or legacy catch-all `_redirects` rule. The old public Gemini test page has been removed. The frontend should not be deployed for launch until a live Clerk publishable key is set.
- **Pages headers are environment-isolated**: the committed `public/_headers` fallback trusts only self. Every official Pages deploy replaces it with a generated exact allowlist: live trusts only `api.insertplayer.ai` plus `clerk.insertplayer.ai`, sandbox trusts only its Worker plus the exact Clerk Development FAPI decoded from its own key, and prelaunch trusts no external origin. Smoke tests reject cross-environment origins, unsafe script eval/inline execution, and stale app-shell caching. Press Start 2P remains bundled locally.
- **Provider Worker secrets are installed**: Gemini, FAL, Runway, Freepik, and Ludo are present as Worker secrets. Stripe secrets are still missing.
- **Live config helper exists**: `npm run config:live` reads gitignored `.env.production.local`, rejects placeholder/test Clerk or Stripe launch values before mutation, runs `check:production`, patches non-secret Worker vars, uploads Worker secrets without printing values, and redeploys the Worker. `npm run deploy:frontend` requires a cleared-brand `ASF_PAGES_PROJECT_NAME`, then runs `check:production` and `check:frontend-live` so Pages cannot be published without the local hardening gate plus live Clerk/frontend/brand env, then runs `smoke:frontend-live` after upload; that smoke waits briefly for the root Pages shell to become ready before strict route/header checks, so normal Cloudflare propagation does not turn a good deploy red. `npm run deploy:worker` also runs `check:production` before deploying. The standalone live smoke scripts read the same ignored production env files as `check:launch`, so one local env file feeds deploy checks, Pages smoke, and Worker smoke. Use all three once Clerk and Stripe dashboard values exist.
- **Public live Worker smoke passed** against Worker `0.15.0` with `ASF_FRONTEND_ORIGIN=https://insert-player.pages.dev`: production health flags including the configured provider budget, allowed-origin CORS, unconfigured-origin non-reflection, provider-session browser preflight headers, tiers/pricing metadata, public community cache headers with internal owner ids and photo hashes redacted, normalized public owner/leaderboard profile fields, protected signed-out fighter/stats/report/moderation routes, signed-out Rookie policy, the 2-per-IP anonymous generation authorization limit, malformed public route parameters and temp asset paths returning `400`, private-host image/media proxy blocking, provider allowlists/sessions, R2 temp assets, and share-page security headers. The latest rerun against `770313f4-9f1b-491d-bffb-ef3ad1c090af` verified migration `0014`, the deployed provider-spend boundary, the daily AI-arena account bound, and all inherited production bindings. Public share-page metadata smoke runs automatically once the feed has public fighters. Authenticated D1/R2/report/moderation smoke remains blocked until real Clerk users exist.
- **Blockers at that historical checkpoint (superseded by the 2026-08-19 snapshot)**: production Clerk, Stripe profile/purchase validation, live Stripe, the production frontend, authenticated launch smoke, real phones, and a second device were still pending. The brand record, DNS, certificates, sandbox catalog, and real provider generation were completed later.
- **Worker proxy exists in `worker/src/proxy.ts`** for `/proxy/gemini`, `/proxy/fal`, `/proxy/runway`, `/proxy/freepik`, `/proxy/ludo`, `/proxy/image`, `/proxy/media`, and `/proxy/upload-temp`. Temp provider inputs now stay in R2 under `temp/`, preserve supported image MIME types, and are served through `/temp-assets/*` with `nosniff`; image/media result proxies reject local/private hosts, require HTTPS upstream URLs and an active provider session before fetching public upstreams, `/proxy/image` remains image-only with a 24 MB cap, `/proxy/media` accepts generated image/video results with a size cap, and Ludo broad result listing is blocked unless a `request_id` is present. Expensive provider POSTs require an `X-ASF-Provider-Session` minted by billing generation authorization or authenticated feature sessions, so direct allowlisted proxy calls cannot bypass the credit/session layer; sessions are purpose/tier-scoped to the provider families and GA Gemini models they legitimately need, with atomic call and conservative cost ceilings plus a D1-backed global monthly reserve. Generation authorization responses include `providerCallLimit` so authenticated smoke can verify tier budgets directly. Client services use `src/services/ApiClient.ts`, which honors `VITE_API_BASE_URL` and only attaches Clerk bearer tokens/provider-session headers to the configured API origin.
- **Clerk user lifecycle is production-shaped** via `@clerk/react`, JWT verification in `worker/src/auth.ts`, and signed `user.created` / `user.updated` / `user.deleted` handling in `worker/src/clerkWebhooks.ts`. Profile events are idempotent; deletion drains every `users/{owner}/` R2 object in bounded retryable batches, deletes dependent match/account rows in D1, and stores only a hash tombstone so an old still-valid JWT cannot recreate the account. The Worker still validates issuer, optional JWKS override, and `azp`; IndexedDB v5 separately isolates same-browser users. Required live config is `CLERK_ISSUER`, `CLERK_WEBHOOK_SIGNING_SECRET`, and the frontend `VITE_CLERK_PUBLISHABLE_KEY`.
- **Production fighter persistence exists** in new Worker routes under `/api/fighters`: create/list/get/patch/delete, source upload, sprite upload, and upgrade intent. R2 asset reads go through `/assets/*`, validate versioned `users/` keys, allow owners to fetch archived source/sprite versions, return not-found for non-owner private assets, no-store original/raw intermediates, and serve public-facing community assets with immutable caching plus `nosniff`.
- **D1 schema migration path is production-shaped**: migrations `0001` → `0016` cover Clerk storage, immutable asset versions, Stripe credits/reconciliation, legal evidence, moderation, provider sessions, spend reserves, and lookup indexes. `0017_provider_cost_events.sql` adds durable per-call operation/provider/model/outcome accounting. Fresh replay through `0017` is SQLite-validated and both remote databases have applied it.
- **Cloud sync/import exists on the frontend** in `src/services/CloudFighters.ts`. Create flow auto-syncs after generation when signed in; Gallery has a manual Sync Cloud action; Gallery and Roster refresh owned cloud fighters into IndexedDB so another device can become playable after sign-in and later receive remote retries/upgrades for fighters it already imported. Imports are playable-first: owned fighter lists stay light, missing or newer fighters fetch `/api/fighters/:id`, choose the highest available tier per animation, and paint the usable fighter before a bounded background queue fills every lower-tier, historical, and RAW version. The completed remote-version count makes interrupted hydration resumable, archive-only uploads advance `updated_at`, optional assets may retry without blocking playable sprites, and one bad cloud fighter no longer blocks the rest of the roster. Imported fighter metadata uses the Worker/D1 timestamp so refresh decisions do not depend on the browser's local clock. The runtime sprite loader fallback-fills missing animation rows from mapped fallbacks, idle, or the first available animation so partial private cloud imports do not render invisible move states. Gallery rename/delete also patches/deletes the cloud fighter when a synced `cloudFighterId` is present.
- **Local cache is account-scoped and preserves every generated version**: IndexedDB is version 5; all stores use Clerk owner scopes and sprites use `[ownerScope, versionId]` plus scoped hash/animation/tier indexes. Legacy/v4 rows migrate to `local`, the first signed-in account claims that local work, same-browser account switches cannot see each other's rows, and stale operations from a previous account cannot write into the new account. Gameplay/gallery helpers return the latest highest playable tier per animation, while cloud sync uploads all local sprite versions.
- **Tier generation is now wired locally and in cloud metadata**: Create has Rookie/Contender/Champion selection, `CharacterPipeline` forces animation model/pipeline per tier, Gallery shows tier/pricing upgrade buttons, and upgrades regenerate animations then sync the new tier to cloud. Source side/upright/crouch views always use Gemini Pro as canonical seeds and remain separate from animation tier overrides. Mirrored attacks refine four unique keyframes and expand them to seven only after background cleaning.
- **Community sharing and moderation are implemented**: Gallery can Publish/Unpublish cloud fighters and share links through the native mobile share sheet with clipboard fallback; `/api/community` lists public fighters with original uploads, raw intermediates, internal owner ids, and private photo hashes withheld; `/api/community/:id` fetches any public fighter by id for durable deep links with the same public serialization; `/api/community/:id/clone` requires a public fighter with the full launch animation set, copies only public playable R2 assets server-side into the signed-in user's private namespace, and merges missing public sprites into an existing same-photo fighter instead of returning an unplayable shell; `/community?fighter=:id` deep-links a featured fighter so users can invite friends straight to a playable clone. Signed-in players can report public fighters with structured reasons and bounded details; one row per reporter/fighter is reopened and counted instead of duplicated, the route is limited to 10/day, owners are directed to unpublish their own content, and report volume never auto-removes a fighter. Admin-only `/moderation` and `/api/admin/community-reports` support audited review, dismissal, and deliberate unpublish actions. Production share URLs use Worker `/share/:id` pages for fighter-specific Open Graph previews with canonical community links, image alt metadata, and nonce-based Worker security headers, then redirect humans into the Pages community route. Fighter names and public owner profile fields are normalized at the Worker boundary before storage/serialization so public metadata stays bounded. Public community feed/detail/share responses have short shared-cache headers, while missing/unpublished lookups are `no-store`. This is the first viral loop.
- **Launch/share metadata exists**: `index.html`, `public/site.webmanifest`, and `public/assets/asf-*` provide installable app metadata, app icons, and a 1200×630 social card for production/community links. Frontend live smoke verifies the manifest and social card after Pages deploy.
- **Credit authorization + checkout exists**: `/api/billing/generation` requires current generation attestation, verifies owned fighter ids, and prices new generation, upgrades, animation retries, and source retries as explicit operations; `/api/billing/generation/complete` commits or refunds each reservation after success/failure. Anonymous users may attempt one new Rookie per pseudonymized network identity/day after server-verified Turnstile; signed-in accounts receive one free new Rookie, never a free retry. `/api/billing/packs`, `/api/billing/checkout`, and `/api/billing/stripe-webhook` provide automatic-tax Stripe Checkout with one reusable Customer per Clerk user and idempotent crediting. RAW HD rebuilds make no provider or billing request.
- **Match history persistence is wired**: match end in `FightScene` emits `MATCH_COMPLETE_EVENT`; React reports it to `/api/matches`; the Worker stores unranked match rows, updates signed-in win/loss records for launch matches without changing Elo, and uses a synthetic CPU/local opponent user where no real second Clerk user exists. HomePage now shows the signed-in record, recent results, and public fight board. `/api/stats` is signed-in-user scoped, parameterized stats reads are own-user-only, and live smoke covers history and record updates through `/api/stats` once `ASF_CLERK_JWT` is available.
- **Pricing UI exists on HomePage**: credit packs are loaded from the Worker, the user's current credit balance is shown when signed in, and buying a pack redirects to Stripe Checkout. Stripe success/cancel redirects return to the menu wallet, scrub query params, preserve the pending pack locally, and briefly refresh the billing profile so webhook-delayed credit grants show up without a manual reload. Tier selection/upgrades still show credit costs in Create/Gallery.
- **Phaser is code-split behind `/fight`**: the initial menu bundle is ~430 kB minified, while the Phaser/createGame chunk loads only when the match runtime mounts.
- **Production check scripts exist**: `npm run check:production` runs frontend guard, structural tier parity, typecheck, Worker typecheck, D1 migration replay, legacy route scanning, billing redirect-origin checks, Turnstile wiring/tests, provider model/spend controls, fee-aware profitability checks, durable cost-event guards, and proxy/client hardening checks. `npm run check:tiers` verifies operation-specific credit costs, measured provider costs, VAT/Stripe-aware coverage floors, pipeline/model/background-removal settings, animation-model tier control, and Pro source-view env docs stay in sync. `npm run check:live-readiness` is the deploy gate for real `wrangler.toml` ids, frontend live env, deployed frontend app-shell routes, current Wrangler auth, Worker secrets including Turnstile, remote D1/R2 readiness through migration `0017`, and mandatory Worker `/health` verification including `providerBudget=configured`, resolved from `ASF_WORKER_HEALTH_URL`, `ASF_WORKER_URL`, or `VITE_API_BASE_URL`; live curl/Wrangler/fetch checks have bounded timeouts and logs stay in ignored `.wrangler-logs/`. `npm run smoke:live` exercises the deployed public Worker API and verifies that anonymous Rookie cannot mint a provider session without Turnstile, while `npm run smoke:live:launch` additionally requires Clerk/live Stripe and two distinct Clerk JWTs. `npm run check:launch` is the one-command final launch gate and also requires recorded evidence that one real Turnstile token succeeds and replaying it fails.
- **Config examples exist**: `.env.example` for frontend vars and `worker/.dev.vars.example` for local Worker secrets.
- **Production runbook exists** in `PRODUCTION_READINESS.md` with Cloudflare, Clerk, Stripe, migration, and cross-device smoke-test steps.
- Verified: `npm run build`, `npm run check:production`, `cd worker && npx tsc --noEmit`, remote D1 migration `0014` in production and sandbox, active Cloudflare Cron Trigger, local Vite legal/generation/checkout/report/moderation flows, live refund/dispute/moderation/provider-budget Worker code, public Worker and sandbox smoke, and fresh SQLite replay of D1 migrations `0001` → `0014`. Bundle-size warning remains for the lazy fight chunk, not the initial route.

### What works end-to-end

- **React shell owns all non-match UI** (`/menu`, `/gallery`, `/fighters/new`, `/roster/*`). Phaser is reduced to `[BootScene, FightScene]`. Don't reintroduce Phaser scenes for UI.
- **Tailwind-only styling**, build-enforced via `npm run check:frontend`. SF2-inspired theme in `src/ui/styles.css`. No inline styles, no raw CSS inside `@layer` blocks.
- **Shared fighter UI primitives** (`src/ui/components/`, `src/ui/shared/`) used by both `CreateFighterPage` and `GalleryPage`. Reuse them for any new fighter-related UI.
- **Sprite pipeline `sheet_refined`** (default for all animations):
  1. `geminiSpriteSheet` → coherent base sheet (1 Gemini call). Establishes pose + style across N frames.
  2. Split into N cells.
  3. Parallel refines (N Gemini calls). Each cell rendered at full Gemini resolution with `IMAGE 1 = side view` (style anchor) + `IMAGE 2 = sheet cell` (pose anchor). Size validation by proportion (not pixels); 2 attempts max with strict prompt on attempt 2.
  4. `cleanCellsWithUnionMasks` per cell: **pre-neutralize green spill on character pixels** (CPU canvas pass, in `SpritePostProcess.neutralizeGreenSpillForSegmentation`) → run BOTH chroma-key flood-fill AND BiRefNet via fal → **union the masks** (max alpha) while rescuing DNN RGB → remove edge-connected green contamination with opaque-interior color reconstruction → add alpha bleed so later scaling cannot reveal hidden green RGB. Genuine green garment regions that continue into opaque interior are preserved. Per-frame parallel.
  5. `composeRefinedFramesToSheet` with transparent padding (cells are already alpha-cleaned).
  6. `cleanSpriteSheet` for locked-scale per-animation normalization.
- **Cache resolution: 768×1024 per cell** (4× original). Game still renders at 192×256 — `AiSpriteLoader` downsamples on load. `SPRITE_PROCESSING_VERSION = 5` rebuilds preserved RAW sheets locally for legacy fighters.
- **Gallery actions**: Save PNG, Save GIF, Save RAW (per anim), Save All (per fighter), Rename, Delete, Rebuild HD (re-normalize from `rawPngBlob`).
- **Retry feedback**: per-target loading state in the preview pane + per-source chip "Regenerating..." label + per-anim tile "generating" badge.

### Validated background removal

- A real authenticated Champion Retry preserved the face and reduced severe green-edge contamination from `43.704%` to `0.276%`; the resulting processing-v5 R2 asset was downloaded by SHA and visually checked on a neutral background.
- All 11 current Champion animations were rebuilt from preserved RAW sheets and completed a fight. Keep `AlphaMask.ts`, `cleanCellsWithUnionMasks`, final-cell decontamination, and `SPRITE_PROCESSING_VERSION` in sync when changing this path.
- The same QA fighter completed Rookie generation, Contender upgrade, Champion upgrade, reservation/commit/refund behavior, all-tier cloud archival, and incremental promotion. Treat the provider/tier matrix, face preservation, and green-fringe removal as resolved unless a new real output regresses.

---

## Phase A — Bg-removal validation [VALIDATED]

Real Champion output has passed face-preservation and edge-fringe validation. Reopen only for a demonstrated regression.

---

## Phase B — Quality tiers

**Fully designed in `QUALITY_TIERS.md`. Don't deviate without rereading it.**

Status: implemented in the current working tree for local generation, cloud metadata, Create tier picker, Gallery tier badge/upgrade buttons, and credit authorization. The remaining production risk is live billing/auth/deployment validation, not tier pipeline design.

Summary of agreed decisions captured in that doc:
- Three tiers: `rookie | contender | champion`.
- Source views (side / upright / crouch) always use Pro regardless of tier.
- Cache preserves every generated sprite version locally (`versionId` key, DB version bump 3 → 4, existing rows migrated into versioned records; DB v5 adds Clerk-owner isolation). Cloud archives every distinct sprite upload in `sprite_versions`, archives source-view uploads in `source_versions`, exposes owned current/history hashes for cross-device import, skips every known source/processed/RAW blob, and promotes an existing archived sprite with a lightweight PATCH when it becomes current.
- Rookie pipeline = `sheet` mode + Flash, no BiRefNet on anims. Measured complete QA cost: $1.43/fighter.
- Contender = `sheet_refined` + Flash + BiRefNet. Measured complete QA cost: $7.88/fighter.
- Champion = `sheet_refined` with a Flash pose scaffold, Pro for every final frame, and BiRefNet. Measured complete QA cost: $12.64/fighter.
- The locked v2 launch packs are €14.99 / €24.99 / €56.99 for 11 / 20 / 47 credits. At the cheapest net credit, clean tier coverage is roughly 1.36× / 1.36× / 1.38× after Spanish VAT, Stripe EEA-card fees, and Stripe Tax; the observed failure-heavy QA sequence remains above 1.10×. Production cost events must drive the next pricing review.
- Upgrade regenerates anims from scratch (decision B in the doc), source views are not regenerated (already Pro).
- Animation model selection is explicit request context from `CharacterPipeline.ts`; no module-level mutable override is used.
- UI: tier chip selector in CreateFighterPage, badge + upgrade buttons in GalleryPage.
- `.env` loses Pro overrides for `_SPRITE / _ANIM_*`; keeps them for `_REPOSE / _UPRIGHT / _CROUCH`.

---

## Phase C — Server-side proxy (Cloudflare Worker)

Move API keys out of the client. Approved by user.

Status: implemented and deployed in `worker/src/proxy.ts`; provider Worker secrets are installed and the public proxy/R2 smoke passes. Real authenticated generation at every tier is still required.

Scope:
- `worker/` has a Cloudflare Workers app with D1 + R2 bindings and Clerk auth.
- Port `apiProxyPlugin` from `vite.config.ts` to a route in `worker/src/index.ts`. Endpoints: `/proxy/gemini`, `/proxy/fal`, `/proxy/runway`, `/proxy/freepik`, `/proxy/ludo`, `/proxy/image`, `/proxy/upload-temp`.
- Keys via `wrangler secret put` (GEMINI_API_KEY, FAL_API_KEY, RUNWAY_API_KEY, FREEPIK_API_KEY, LUDO_API_KEY).
- Update client base URL: `VITE_API_BASE_URL` env, defaults to `/` (Vite proxy in dev) or the production API custom domain `https://api.insertplayer.ai`.
- Keep Vite middleware as dev fallback so local dev doesn't require running the worker.

---

## Phase D — Auth with Clerk

Use Clerk for production identity.

Status: implemented as Clerk JWT verification + Clerk React provider. Still needs live Clerk app config, allowed origins, and production token validation.

Scope:
- Clerk SDK in worker — verifies JWT from `Authorization: Bearer <token>` header.
- Clerk React `<ClerkProvider>` in `src/main.tsx` wrapping `<App>`.
- Sign-in / sign-up UI (Clerk's hosted components).
- Worker resolves `clerk_user_id` (a string like `user_2abc...`) before any rate limit / DB write.
- Anonymous access still allowed for Rookie tier (rate-limit by IP).
- Legacy Google/session client helpers and unused prototype sprite routes have been removed from the working tree.

---

## Phase E — Rate limiting on worker

Approved by user. Rate limit key = `clerk_user_id` when authenticated, IP fallback when anonymous.

Status: implemented with atomic D1 counters keyed by Clerk user id or anonymous IP. Expired counters are pruned opportunistically and blocked responses return the remaining fixed-window duration. Tune route limits after real provider traffic is measured.

Scope:
- D1 fixed-window counters are the launch implementation; writes are atomic at the primary and do not rely on eventually consistent KV.
- Per-route limits — `/proxy/gemini` is the expensive one. Different limits per tier:
  - Anonymous: one Rookie authorization per pseudonymized network identity/day after Turnstile.
  - Free Clerk user: ~5-10 Rookie generations per day.
  - Paid (credits / subscription): higher / unlimited.
- 429 response with `Retry-After` header.

---

## Phase F — Server-side fighter cache (R2 + D1)

Approved by user. Enables cross-device sync + sharing.

Status: implemented as client-orchestrated dual write/import with Worker storage endpoints and deployed against EU D1 `insert-player-db` plus EU R2 `insert-player-assets`. Public storage smoke and authenticated sandbox ownership/version-history/incremental-promotion validation pass; real two-device validation remains.

Scope:
- D1 schema:
  - `fighters(id, owner_user_id, name, photo_hash, quality_tier, public_flag, created_at, updated_at)`
  - `sprites(fighter_id, animation_name, quality_tier, blob_key, raw_blob_key, frame_w, frame_h, frame_count, processing_version, created_at)`
  - `source_versions(fighter_id, kind, blob_key, content_hash, created_at)`
  - `intros(fighter_id, variant_id, blob_key, model, prompt, created_at)`
  - `stages(id, owner_user_id, label, kind, blob_key, created_at)`
- R2 bucket structure: `users/{user_id}/fighters/{fighter_id}/sprites/{anim}_{tier}.png`, similar for `raw` and `intros` and source views.
- Worker endpoints (RESTful):
  - `GET /api/fighters` — list (auth required)
  - `POST /api/fighters` — create
  - `GET /api/fighters/:id` — single (includes presigned R2 URLs for assets)
  - `PATCH /api/fighters/:id` — rename, set public_flag
  - `DELETE /api/fighters/:id` — cascade delete sprites/intros
  - `POST /api/fighters/:id/sources` — write a new source-view upload; duplicate retry uploads reuse the prior archived content hash instead of overwriting R2
  - `POST /api/fighters/:id/sprites` — write a missing processed/RAW animation version; duplicate retry uploads reuse the prior archived content hash instead of creating fake versions
  - `PATCH /api/fighters/:id/sprites` — promote a known archived content hash to the active gameplay pointer without re-uploading bytes
  - `POST /api/fighters/:id/upgrade` — kick off server-orchestrated upgrade (alternative: client orchestrates, worker stores)
- Client: dual-write — IndexedDB stays as fast local cache + offline mode, server is source of truth. Background sync on fighter creation / mutation.
- Migration: "Sync to cloud" button on existing local fighters.

---

## Phase G — Sharing UI

Builds on Phase F.

Status: first viral loop plus launch abuse controls implemented: publish/unpublish, durable share links, public listing, signed-in clone, structured report intake, deduplication, 10/day report limiting, and an admin-only audited review/unpublish queue. Publish/share/clone require the full launch animation set; clone copies only public source assets and same-photo clones merge missing playable sprites. Real Clerk-user and moderator validation remains pending.

- `public_flag` toggle in Gallery hero actions.
- Public fighters discoverable in a new `/community` route (or extension of `/gallery`).
- "Add to my roster" → clones the fighter (new owner, new id, copy R2 blobs).
- Featured fighters; leaderboard/fight-board surface is now wired on HomePage.

---

## Phase H — Video add-on

`IntroVideoService` already exists, supports multiple providers (LTX, Kling, Runway, Veo, Vidu).

For PROD:
- Standalone "Generate Intro Video" button in Gallery (already partially wired in `CachedIntroVariant` schema).
- Tier selector at video time (Quick / Cinema / Premium).
- Route through worker, gate by credits.
- Store in R2 like other assets.

---

## Phase I — Monetization

Status: credit packs and operation-specific billing are implemented. Packs are locked at 11 credits / €14.99, 20 / €24.99, and 47 / €56.99. New generation/upgrades cost 2/11/18; animation retries cost 1/2/4; Pro source retries cost 1; local RAW rebuilds are free. Bootstrap preserves old products/prices as inactive history while reconciling v2. A signed-in sandbox v2 Starter purchase granted 11 credits and left the historical 6-credit Checkout/ledger untouched. Live keys/catalog/webhook and one live purchase remain required. Subscriptions are not required for v1.

---

## Open decisions / questions

1. Free Rookie quota for anonymous users: decided for launch as one authorization per pseudonymized network identity/day, after server-verified single-use Turnstile, plus tier-scoped provider-session budgets.
2. Tier badge style (medal emoji vs text chip vs colored bar): visual decision deferred.
3. Sharing model: public toggle only, or actual social graph (friends/follows)? TBD.
4. Server-orchestrated upgrade vs client-orchestrated: simpler for client now, more reliable from server. TBD.
5. Whether to retire IndexedDB entirely once Phase F lands, or keep it as offline cache permanently. Probably keep.

## Known pre-existing tech debt

- Fight chunk remains ~1.3 MB after splitting. Initial route is much lighter, but the match runtime could still use deeper vendor chunking later.
- Browser console output is gated through `src/services/DebugLog.ts`; production logs stay quiet unless `localStorage.asf:debug` or `window.__ASF_DEBUG_LOGS__` is enabled.
- IndexedDB migrations: v2 added stages, v3 added `qualityTier`, v4 changed sprites to per-generation `versionId` records, and v5 scoped every store by Clerk owner while preserving/claiming legacy local rows.

---

## Reference docs

- `CLAUDE.md` — codebase orientation for agents. Read first.
- `QUALITY_TIERS.md` — full tier design (pipeline + UI + cache).
- `ROADMAP.md` — this file. State snapshot + phase plan.
- `PRODUCTION_READINESS.md` — deployment/configuration/smoke-test checklist.
