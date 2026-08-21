# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Node version is pinned in `.nvmrc` (22.23.2); `package.json` requires `>=22.12.0`.

- `npm run dev` — Vite dev server with the API-proxy middleware (see "API proxy" below). Hit `/menu` to get the React shell; `/fight` is where Phaser mounts.
- `npm run build` — runs `check:frontend` → `tsc` (typecheck only; `noEmit` is set) → `vite build`. Any of the three failing fails the build.
- `npm run check:frontend` — `scripts/check-no-inline-styles.mjs`. Scans `index.html`, `src/main.tsx`, and React/DOM surfaces under `src/ui` and `src/game`; it fails on inline `<style>`/`style="…"` HTML or `style={{…}}` JSX props. React and match-overlay UI must be styled through `src/ui/styles.css` / Tailwind classes only; Phaser canvas drawing configuration is unaffected.
- `npm test` — Vitest unit tests. The first focused suite covers virtual/touch input state, one-shot attack pulses, simultaneous controls, player isolation, and reset behavior.
- `npm run check:production` — frontend style/type checks, Vitest, Worker typecheck, SQLite replay of D1 migrations `0001`→`0017`, source/sprite upload idempotency checks, provider model/spend/cost-event guards, fee-aware pricing guards, legal-consent/privacy checks, Stripe refund/dispute reconciliation, community-moderation safety, data-retention safety checks, and stale legacy API route scans.
- `npm run check:frontend-live` — Pages deploy preflight for production frontend env (`VITE_API_BASE_URL`, live Clerk publishable key, Pro source-view model vars, no client-exposed secrets).
- `npm run check:live-readiness` — live deploy gate: production-shaped `wrangler.toml`, frontend live env, Wrangler auth, Worker secrets, R2 temp lifecycle, and optional `ASF_WORKER_HEALTH_URL`.
- `npm run check:launch` — final launch gate. Requires HTTPS Worker/Pages URLs, two fresh Clerk JWTs from different users, and a recent ignored `.launch-validation.json` copied from `launch-validation.example.json` with browser/provider/two-device evidence before running production checks, live readiness, Pages smoke, and authenticated Worker smoke.
- `npm run brand:apply -- --name "Cleared Brand" --short "CB" --origin "https://your-domain.example"` — applies the chosen public brand to static launch metadata/manifest/SVG source assets. Regenerate PNG assets from final art afterward.
- `npm run stripe:bootstrap -- --create-webhook` — idempotently create/reconcile the dedicated Stripe catalog and webhook from ignored env values. Add `--allow-live` only for the isolated live Insert Player account.
- `npm run config:live` — after `.env.production.local` has live Clerk/Stripe values, patch Worker vars, upload Worker secrets, and redeploy the Worker without printing secret values.
- `npm run deploy:frontend` — require cleared-brand `ASF_PAGES_PROJECT_NAME`, production-check, frontend-live-check, build, deploy `dist/` to Cloudflare Pages, then run Pages smoke.
- `npm run smoke:frontend-live` — after Pages deploy, verify direct SPA routes, live Worker/Clerk bundle config, and absence of old public test pages. Reads `.env.production.local`, `.env.production`, `.env.local`, `.env`, and process env like the launch gate; defaults to the reserved Pages URL when no frontend URL override is set; waits briefly for the root Pages shell before strict route/header checks.
- `npm run preview` — serve the built `dist/`.

### Cloudflare Worker backend (`worker/`)
Separate package. Runs only when using the Worker API (auth, leaderboard, persistent character/sprite storage in R2 + D1). The in-browser game works standalone without it.

- `cd worker && npm run dev` — `wrangler dev` on port 8787.
- `cd worker && npm run deploy` — `wrangler deploy`.
- `cd worker && npm run db:migrate` — apply pending D1 migrations to the EU `insert-player-db` database.

## Architecture

Two-layer frontend: **React shell** owns navigation, menus, roster, and gallery; **Phaser 3** owns only the in-match runtime. They are wired together through a hand-rolled launch-target handoff, not a shared store.

### React shell (`src/ui/`)
- Entry is `src/main.tsx` → `App.tsx`. Routing is a hand-rolled hash/path router (`useHashRoute`) with routes `/menu`, `/gallery`, `/community`, `/moderation`, `/fighters/new`, `/roster/{watch,cpu,vs}`, `/legal`, `/privacy`, `/terms`, `/refunds`, and `/fight`. There is no React Router.
- Routes under `src/ui/routes/`: `HomePage`, `GalleryPage` (characters + stages, with retries), `CreateFighterPage` (photo → pipeline → gallery), `RosterPage` (match builder). Only `/fight` mounts Phaser — via `GamePage`, which instantiates `createGame('game-container', launchTarget)` and destroys it on unmount.
- Shared fighter-UI primitives live in `src/ui/components/` (`AnimationGrid`, `SourceViewsPanel`, `SpritePreviewSurface`, `SpritePreviewCanvas`, `DebugFeed`, `PipelineProgress`) and `src/ui/shared/` (`fighterPreview.ts` = labels/types/helpers, `useObjectUrl.ts`, `downloadBlob.ts`). `GalleryPage` (edit) and `CreateFighterPage` (create) consume the same primitives — do not re-implement animation grids, source view chips, or sprite preview rendering in new screens.
- `App` persists the selected `MatchSceneData` to `sessionStorage` under key `ai-street-fighter:last-match` so a hard reload at `/fight` can still start the match.
- Phaser↔React bridge: `GamePage` installs `window.__ASF_EXIT_TO_MENU__` which `FightScene` (and `BootScene` fallback) call to pop back to the React `/menu` instead of trying to start a Phaser menu scene.

### Phaser runtime (`src/game/`)
- `createGame.ts` builds the `Phaser.Game` (1024×576, arcade physics, FIT scaling). Before instantiating, it calls `setPendingLaunchTarget(...)` in `launchState.ts` (module-level singleton, the bridge between React and Phaser).
- Scene registry: `[BootScene, FightScene]`. That is the entire in-browser Phaser surface. Everything else (title, menu, roster, gallery, character creation) is owned by React. If you find yourself wanting to add a new Phaser scene for a UI flow, build it in React instead.
- `BootScene` reads `getPendingLaunchTarget()` and immediately `scene.start(sceneKey, data)` into the real target scene. If nothing is pending (shouldn't happen in the React shell flow), it calls `window.__ASF_EXIT_TO_MENU__` to bounce back to `/menu`.
- `FightScene` runs on a fixed `FIXED_TIMESTEP` (60 Hz) accumulator with a `SeededRng` for deterministic replays. Match parameters come in as `MatchSceneData` from `src/game/match/MatchConfig.ts`; stage theme from `StageConfig.ts`. On ESC after match-over it calls `__ASF_EXIT_TO_MENU__` (no Phaser title scene exists to return to).
- Core combat constants (health, round time, attack frame data, hitboxes) live in `src/game/constants.ts`. `ATTACKS` is the canonical table — damage/startup/active/recovery/hitbox per move.
- Systems under `src/game/systems/`: `CombatSystem` (hit detection/resolution), `AIController` (personality-driven opponent), `InputManager` + `MotionInputs` (directional-input buffer for specials), `VirtualInput` (React touch bridge), `SoundManager`. `InputManager` merges keyboard, browser gamepad, and virtual controls. HUD lives in `src/game/ui/HUD.ts`; React renders coarse-pointer controls through `src/ui/components/MobileFightControls.tsx`.

### Character / sprite pipeline (`src/services/`)
This is the most complex area. Characters are built from a user photo by chaining several generative-AI services; results are cached in IndexedDB so regenerations are incremental.

- `CharacterPipeline.ts` orchestrates generation. The canonical animation set is the `ANIMATIONS` array at the top of the file (`idle`, `walk`, `high_punch`, `high_kick`, `low_punch`, `low_kick`, `jump`, `crouch`, `hit`, `ko`, `victory`, plus mirrored variants). Adding or renaming an animation must be kept in sync with `AnimationProfiles.ts`, `AiSpriteLoader.ts`, and `constants.ts`'s `FighterState` enum, or the cache misses and the fighter loads with missing states.
- Two providers (`PipelineProvider = 'gemini' | 'ludo'`) switchable via `setProvider()`. Gemini is the default and generates side/upright/crouch reference poses plus per-animation sprite sheets via `GeminiApi.ts`. Ludo (`LudoApi.ts`) and Freepik (`FreepikApi.ts`) are fallback paths.
- `SpriteCache.ts` wraps IndexedDB (`DB_NAME='ai-street-fighter'`, version 5, object stores `sprites`, `intros`, `meta`, `stages`). Every store is scoped by Clerk user id; legacy/v4 records migrate to a `local` scope that the first signed-in account claims without deleting existing account data. Sprite records use the composite `[ownerScope, versionId]` key with scoped hash/animation/tier indexes, so retries and upgrades preserve every generated version while shared-browser account switches remain isolated. Stale operations from a previous account are rejected before writing. `getAllSpritesForHash` returns the latest best playable tier per animation, while `getAllSpriteVersionsForHash` returns every locally cached generation for the active owner. Processing version (`SPRITE_PROCESSING_VERSION` in `CharacterPipeline.ts`, also stored per-sprite) is bumped whenever sprite post-processing changes — stale cache entries are re-processed on load. Bump it if you change `SpritePostProcess.ts`.
- `SpritePostProcess.ts` cleans the raw AI output: alpha thresholding, per-frame grid slicing (`CELL_W`/`CELL_H`), bounds measurement, background-removal plumbing, edge decontamination, and horizontal mirroring for `MIRRORED_ANIMATION_NAMES`.
- `BackgroundRemovalService.ts` picks a primary provider via `VITE_BG_REMOVAL_PROVIDER` (`rembg` in-browser via `@bunnio/rembg-web`, or `fal`). Refined animation cleanup pre-neutralizes green spill, unions chroma and DNN masks, then runs connected-component-aware green-edge decontamination and alpha bleed so scaling cannot reveal hidden green RGB. Genuine green clothing is preserved when it continues into the opaque interior. The DNN path falls back from fal/BiRefNet to Freepik before accepting chroma-only output, and DNN work is processed in bounded batches of three.
- `IntroVideoService.ts` generates per-character cinematic intros via Runway, FAL, Kling, or Veo (provider chosen by `VITE_INTRO_VIDEO_PROVIDER`). Videos are cached per photo hash as `CachedIntroVariant`s and played by `FightScene` at round start.
- `StageBackgroundService.ts` generates or reuses stage backgrounds (also cached by hash in IndexedDB).
- `GifExportService.ts` composites cached sprite sheets into animated GIFs (`gifenc`) for sharing from the Gallery.
- `DebugLog.ts` is a session-scoped ring buffer — UI (and `GalleryScene`) subscribes via the `DEBUG_EVENT_NAME` DOM event to surface pipeline status.

### API proxy (`vite.config.ts` dev, Worker prod)
The Vite dev server registers `apiProxyPlugin()` middleware that injects API keys for local iteration. Production uses the Cloudflare Worker proxy in `worker/src/proxy.ts`; services call through `src/services/ApiClient.ts`, which honors `VITE_API_BASE_URL` and attaches Clerk bearer tokens when available. Service URLs remain:

- `/proxy/gemini/...` → `generativelanguage.googleapis.com` (`GEMINI_API_KEY`)
- `/proxy/ludo/...` → `api.ludo.ai` (`LUDO_API_KEY`)
- `/proxy/freepik/...` → `api.freepik.com` (`FREEPIK_API_KEY`)
- `/proxy/runway/...` → `api.dev.runwayml.com` (`RUNWAY_API_KEY`, adds `X-Runway-Version`)
- `/proxy/fal/...` → `queue.fal.run` (`FAL_API_KEY`)
- `/proxy/upload-temp` → requires an active provider session before reading the body, enforces multipart limits while streaming before parsing, stores bounded base64 PNG/JPEG/WebP/GIF input in R2 under `temp/`, and returns an unguessable `/temp-assets/*` URL for third-party APIs that require a reachable URL
- `/proxy/image?url=…` → CORS-safe passthrough fetcher for public HTTPS image URLs; each redirect is handled manually and revalidated, private/special IPv4 and all IPv6 literals are blocked, supported image MIME is required, and the response body is capped while streaming
- `/proxy/media?url=…` → CORS-safe passthrough fetcher for generated HTTPS image/video result URLs with the same redirect/host/streaming protections and required supported media MIME in production

Local API keys and model overrides live in `.env` (gitignored). Local API keys use non-`VITE_` names only (`GEMINI_API_KEY`, `FAL_API_KEY`, etc.) so provider secrets are never browser-exposed. Production API keys are Worker secrets. `VITE_GEMINI_IMAGE_MODEL*` envs choose Gemini model variants per pipeline stage; source-view model overrides stay Pro-oriented, while tiered animation model overrides are scoped in `CharacterPipeline.ts`.
The Vite middleware is a local-only convenience fallback; production temp uploads must stay on the Worker/R2 path above.

### Worker backend (`worker/`)
Cloudflare Workers app (`wrangler.toml`) backing production auth, proxying, persistence, and stats:
- D1 binding `DB` (`insert-player-db`, EU jurisdiction, migrations in `worker/migrations/`)
- R2 binding `SPRITES` (`insert-player-assets`, EU jurisdiction) for storing generated sprite/source/stage assets
- D1-backed `rate_limits` counters use one atomic UPSERT per request, keyed by Clerk user id or an HMAC-pseudonymized anonymous network identifier. Raw IP addresses must never be persisted. Do not switch this security boundary to eventually consistent KV.
- Provider temp inputs are served by the same Worker from the R2 `temp/` prefix at `/temp-assets/*`. Keep the Worker 24h expiry check and configure a matching R2 lifecycle delete rule for `temp/*`.
- `CORS_ORIGIN` accepts a comma-separated allowlist. The Worker reflects the matching request origin and only enables credentialed CORS for concrete configured origins; without `CORS_ORIGIN`, cross-origin credentialed calls intentionally fail.
- Clerk JWT auth is in `worker/src/auth.ts` (`CLERK_ISSUER`; optional `CLERK_JWKS_URL` override). `worker/src/clerkWebhooks.ts` verifies `/api/clerk/webhook` with `CLERK_WEBHOOK_SIGNING_SECRET`, syncs profile changes, and purges R2/D1 on `user.deleted`; hashed tombstones prevent still-valid old JWTs from recreating deleted users. Frontend Clerk publishable key is `VITE_CLERK_PUBLISHABLE_KEY`.
- Server-side proxy routes in `worker/src/proxy.ts`: `/proxy/gemini`, `/proxy/fal`, `/proxy/runway`, `/proxy/freepik`, `/proxy/ludo`, `/proxy/image`, `/proxy/media`, `/proxy/upload-temp`. API keys are Worker secrets, not Vite-exposed env vars.
- Fighter/community routes in `worker/src/fighters.ts`: `/api/fighters`, `/api/fighters/:id`, `/api/fighters/:id/sources`, `/api/fighters/:id/sprites`, `/api/fighters/:id/upgrade`, `/api/community`, `/api/community/:id/clone`, `/api/community/:id/report`, `/assets/:key`, `/api/tiers`. Admin-only moderation queue/actions live in `worker/src/moderation.ts` under `/api/admin/community-reports`.
- Cloud sprite uploads write unique R2 keys and archive every generated version in `sprite_versions`; `sprites` remains the active gameplay pointer. Private fighter manifests expose current and archived content hashes so `CloudFighters.ts` uploads only missing blobs and uses lightweight `PATCH /api/fighters/:id/sprites` promotion when existing content becomes current. Never switch back to overwriting same-tier R2 keys or re-uploading known bytes.
- Scheduled maintenance in `worker/src/maintenance.ts` deletes only expired operational rows (rate limits, provider sessions, minimized webhook markers, abandoned checkouts), closed moderation reports after one year, and pseudonymized legal-acceptance evidence after its six-year retention period. It must never delete fighters, sprite/source versions, credit history, users, tombstones, or R2 assets.
- Billing routes in `worker/src/billing.ts`: `/api/billing/generation` verifies current legal attestation and owned fighter ids before reserving operation-specific credits for generation, upgrades, animation retries, or Pro source retries. Only a new Rookie can use anonymous/account free quota; RAW HD rebuilds stay local and free. `/api/billing/generation/complete` commits or refunds the reservation; `/api/billing/packs` exposes the fixed catalog; `/api/billing/checkout` creates automatic-tax Stripe Checkout against account-pinned Price IDs. Each Clerk user has one reusable Stripe Customer. Webhooks verify signatures and account/customer/legal metadata, then credit packs idempotently.
- Leaderboard/stat routes remain in `worker/src/leaderboard.ts`.

## Conventions

- TypeScript is strict; `allowImportingTsExtensions` + `verbatimModuleSyntax` are on, so relative imports include the `.ts`/`.tsx` extension and type-only imports must use `import type`.
- React frontend: Tailwind v4 + `src/ui/styles.css`. **No inline styles** in React — `check:frontend` enforces this and runs in `build`.
- Styling convention: Tailwind is applied **from component CSS** in `src/ui/styles.css` (Tailwind-powered classes), not by sprinkling long utility strings across JSX `className`s. Prefer extending `styles.css` over moving utilities inline into `.tsx`.
- Phaser scenes do use inline style-like configuration (Phaser text objects, graphics calls) — the inline-style check does not apply to `src/game/`.
- When changing any sprite post-processing or animation definitions, bump `SPRITE_PROCESSING_VERSION` in `CharacterPipeline.ts` so users' cached characters are regenerated on next load rather than displaying with stale post-processing.

## Active refactor

The non-match → React migration is complete: all title, roster, gallery, character-creation, and photo-upload Phaser scenes have been deleted, and the React shell owns every UI flow except the in-match runtime. Fighter creation (`/fighters/new`) and fighter editing (inside `/gallery`) now share the primitives listed in "React shell" above instead of each reimplementing grids/previews. **Do not add new Phaser scenes for UI flows.** The Phaser runtime is dynamically imported only when entering `/fight`, so the first menu load no longer ships the fight engine.

## Roadmap and pending work

For "what's next?" questions, read these in order:
- **`ROADMAP.md`** — state snapshot + phased plan (Phase A validation → B tiers → C-G PROD migration → H video → I monetization).
- **`QUALITY_TIERS.md`** — full design of the pricing tier system (Phase B; implemented locally and wired to cloud metadata, still needs live auth/billing/provider validation).
- **`PRODUCTION_READINESS.md`** — live deployment/configuration/smoke-test checklist for Cloudflare, Clerk, Stripe, and cross-device validation.
- **`BRANDING.md`** — external naming/trademark clearance workflow. `AI Street Fighter` is internal-only; selected public brand is `Insert Player` (`P1`), first game `Insert Player: Fight`; public launch is blocked until `.brand-clearance.json` records concrete clearance/domain evidence.
- **`PRODUCT.md`** and **`DESIGN.md`** — Insert Player product/brand strategy and visual-system contract. Use these before changing public UI, copy, social assets, auth/checkout surfaces, or launch metadata.

Current state in the working tree: the sprite pipeline default is `sheet_refined` with HD cache (768×1024 per cell). Background removal uses a pre-neutralize CPU pass, a union of chroma-key flood-fill and BiRefNet (fal), connected-component-aware edge decontamination, and alpha bleed. `SPRITE_PROCESSING_VERSION = 5`; preserved RAW sheets are rebuilt locally when older processed versions load. Gemini image generation uses the GA `gemini-3.1-flash-image` and `gemini-3-pro-image` models; source side/upright/crouch views always use Pro. Mirrored 7-frame attacks refine only their four unique base keyframes, clean those frames, then expand them to the intended 4→7 playback sequence.

Tier generation, Clerk auth scaffolding, Worker proxying, version-preserving R2/D1 fighter sync, community clone/report/moderation flows, Stripe credit purchase plumbing, touch controls, browser gamepad input, and server-verified Turnstile for anonymous Rookie are implemented. Cloud sync is content-hash incremental: it skips every known source/processed/RAW blob, uploads only missing history, and promotes existing versions without sending bytes. Browser API calls use immutable account/provider-session request contexts. Provider sessions enforce purpose/tier route allowlists, Gemini model allowlists, atomic call limits, conservative per-session cost ceilings, a global monthly D1-backed provider budget, and a rolling ten-minute spend window; concurrent generations cannot exchange users, sessions, or model tiers.

Direct uploads and community clones commit current/version D1 rows transactionally, preserve every committed copy, and remove only unreferenced staged R2 objects after a losing concurrent write. Multipart uploads and provider POST bodies are byte-capped while streaming; public result downloads manually revalidate every redirect, block private/special literal hosts, require supported MIME, cap response streams, and use bounded upstream timeouts. Generation and checkout require versioned legal attestation; anonymous network identifiers are HMAC-pseudonymized before D1; Stripe Checkout uses automatic tax, inclusive tax-aware catalog validation, one reusable Customer per Clerk user, and account/customer/legal binding in webhooks. Refunds and disputes reconcile credits idempotently, tolerate out-of-order Stripe events, and can leave a negative wallet when already-spent credits are reversed. Community reports are authenticated, bounded, rate-limited, deduplicated in D1, and reviewed through an admin-only queue; report volume never auto-removes content.

Worker `0.16.0` (version `98270002-24fc-427d-8467-67b6374a4d3d`) is deployed at the production API and backed by clean EU D1 `insert-player-db` plus R2 `insert-player-assets`; Pages project `insert-player` still serves the credential-free legal prelaunch. A physically separate QA stack is also deployed: Worker `insert-player-api-sandbox` `0.16.0` (version `ec74e04b-50e5-4c6b-83c4-ae6ecb7fb7a6`), D1 `insert-player-sandbox-db`, R2 `insert-player-sandbox-assets`, and Pages deployment `13a05984` at `https://insert-player-sandbox.pages.dev`; both D1 databases have migrations through `0017`. Clerk Development auth/webhooks, all three real tier pipelines, version-preserving cloud sync, and playable match entry are validated. Measured complete-pipeline usage was Rookie 17 calls / `$1.43`, Contender 165 / `$7.88`, and Champion 123 / `$12.64`; the real Champion Retry used 33 calls / `$2.64`, preserved the face, and reduced severe green edge contamination from `43.704%` to `0.276%`. Billing is operation-specific: generation/upgrades cost 2/11/18 credits, animation retries 1/2/4, Pro source retries 1, and local RAW rebuilds zero. The sandbox v2 catalog is 11 credits / €14.99, 20 / €24.99, and 47 / €56.99; an authenticated Starter purchase moved the wallet from 6 to 17 while retaining the historical 6-credit purchase. Durable `provider_cost_events` record attempted provider calls by operation/model/outcome without being pruned by maintenance. Provider, Turnstile, and anonymization Worker secrets are installed in production, the `0 4 * * *` maintenance schedule is active, public live and isolated sandbox smoke pass, dependency audits are clean, and the 145-test / 29-file local production gate passes.

Pages custom domains `insertplayer.ai` / `www.insertplayer.ai`, Worker custom domain `api.insertplayer.ai`, and their proxied DNS records are active under the delegated Cloudflare zone. HTTPS-only delivery, strict origin TLS, TLS 1.2 minimum, HTTP/3, Brotli, and Browser Integrity Check are configured. Launch remains blocked on Clerk Production, live Insert Player Stripe configuration and purchase smoke, production frontend deployment, a real Turnstile token/replay check, authenticated two-user smoke, real-phone input QA, and two-device validation.
