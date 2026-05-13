# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Node version is pinned in `.nvmrc` (20.19.0); `package.json` requires `>=20.19.0`.

- `npm run dev` — Vite dev server with the API-proxy middleware (see "API proxy" below). Hit `/menu` to get the React shell; `/fight` is where Phaser mounts.
- `npm run build` — runs `check:frontend` → `tsc` (typecheck only; `noEmit` is set) → `vite build`. Any of the three failing fails the build.
- `npm run check:frontend` — `scripts/check-no-inline-styles.mjs`. Scans `index.html`, `src/main.tsx`, and everything under `src/ui/**/*.{tsx,jsx}` and fails on inline `<style>`/`style="…"` in HTML or `style={{…}}` JSX props. React UI must be styled through `src/ui/styles.css` / Tailwind classes only — Phaser code is unaffected.
- `npm run preview` — serve the built `dist/`.

No test runner is configured.

### Cloudflare Worker backend (`worker/`)
Separate package. Runs only when using the Worker API (auth, leaderboard, persistent character/sprite storage in R2 + D1). The in-browser game works standalone without it.

- `cd worker && npm run dev` — `wrangler dev` on port 8787.
- `cd worker && npm run deploy` — `wrangler deploy`.
- `cd worker && npm run db:migrate` — apply `migrations/0001_init.sql` to the D1 database `ai-street-fighter-db`.

## Architecture

Two-layer frontend: **React shell** owns navigation, menus, roster, and gallery; **Phaser 3** owns only the in-match runtime. They are wired together through a hand-rolled launch-target handoff, not a shared store.

### React shell (`src/ui/`)
- Entry is `src/main.tsx` → `App.tsx`. Routing is a hand-rolled hash/path router (`useHashRoute`) with routes `/menu`, `/gallery`, `/fighters/new`, `/roster/{watch,cpu,vs}`, `/fight`. There is no React Router.
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
- Systems under `src/game/systems/`: `CombatSystem` (hit detection/resolution), `AIController` (personality-driven opponent), `InputManager` + `MotionInputs` (directional-input buffer for specials), `SoundManager`. HUD lives in `src/game/ui/HUD.ts`.

### Character / sprite pipeline (`src/services/`)
This is the most complex area. Characters are built from a user photo by chaining several generative-AI services; results are cached in IndexedDB so regenerations are incremental.

- `CharacterPipeline.ts` orchestrates generation. The canonical animation set is the `ANIMATIONS` array at the top of the file (`idle`, `walk`, `high_punch`, `high_kick`, `low_punch`, `low_kick`, `jump`, `crouch`, `hit`, `ko`, `victory`, plus mirrored variants). Adding or renaming an animation must be kept in sync with `AnimationProfiles.ts`, `AiSpriteLoader.ts`, and `constants.ts`'s `FighterState` enum, or the cache misses and the fighter loads with missing states.
- Two providers (`PipelineProvider = 'gemini' | 'ludo'`) switchable via `setProvider()`. Gemini is the default and generates side/upright/crouch reference poses plus per-animation sprite sheets via `GeminiApi.ts`. Ludo (`LudoApi.ts`) and Freepik (`FreepikApi.ts`) are fallback paths.
- `SpriteCache.ts` wraps IndexedDB (`DB_NAME='ai-street-fighter'`, version 2, object stores `sprites`, `intros`, `meta`, `stages`). Cache key is a SHA of the source photo (`hashPhoto`). Processing version (`SPRITE_PROCESSING_VERSION` in `CharacterPipeline.ts`, also stored per-sprite) is bumped whenever sprite post-processing changes — stale cache entries are re-processed on load. Bump it if you change `SpritePostProcess.ts`.
- `SpritePostProcess.ts` cleans the raw AI output: alpha thresholding, per-frame grid slicing (`CELL_W`/`CELL_H`), bounds measurement, background-removal plumbing, and horizontal mirroring for `MIRRORED_ANIMATION_NAMES`.
- `BackgroundRemovalService.ts` picks a provider via `VITE_BG_REMOVAL_PROVIDER` (`rembg` in-browser via `@bunnio/rembg-web`, or `fal`).
- `IntroVideoService.ts` generates per-character cinematic intros via Runway, FAL, Kling, or Veo (provider chosen by `VITE_INTRO_VIDEO_PROVIDER`). Videos are cached per photo hash as `CachedIntroVariant`s and played by `FightScene` at round start.
- `StageBackgroundService.ts` generates or reuses stage backgrounds (also cached by hash in IndexedDB).
- `GifExportService.ts` composites cached sprite sheets into animated GIFs (`gifenc`) for sharing from the Gallery.
- `DebugLog.ts` is a session-scoped ring buffer — UI (and `GalleryScene`) subscribes via the `DEBUG_EVENT_NAME` DOM event to surface pipeline status.

### API proxy (`vite.config.ts`)
The Vite dev server registers `apiProxyPlugin()` middleware that injects API keys (never expose them to the browser). Services in `src/services/` call relative URLs of the form:

- `/proxy/gemini/...` → `generativelanguage.googleapis.com` (`GEMINI_API_KEY`)
- `/proxy/ludo/...` → `api.ludo.ai` (`LUDO_API_KEY`)
- `/proxy/freepik/...` → `api.freepik.com` (`FREEPIK_API_KEY`)
- `/proxy/runway/...` → `api.dev.runwayml.com` (`RUNWAY_API_KEY`, adds `X-Runway-Version`)
- `/proxy/fal/...` → `queue.fal.run` (`FAL_API_KEY`)
- `/proxy/upload-temp` → POSTs base64 image to `litterbox.catbox.moe` and returns a public URL (used when a third-party API needs a reachable URL, not a data blob)
- `/proxy/image?url=…` → CORS-safe passthrough fetcher for remote images

All five API keys and model overrides live in `.env` (gitignored). `VITE_GEMINI_IMAGE_MODEL*` envs choose Gemini model variants per pipeline stage (repose, upright, crouch, sprite, anim_idle); these are read on the client. Production deployments do **not** run this proxy — calls would need to be routed through the Worker or a separate edge proxy.

### Worker backend (`worker/`)
Cloudflare Workers app (`wrangler.toml`) backing optional multiplayer/persistence features:
- D1 binding `DB` (`ai-street-fighter-db`, migrations in `worker/migrations/`)
- R2 binding `SPRITES` for storing generated sprite assets
- Routes: `/auth/google*` (Google OAuth → session cookie), `/api/characters`, `/sprites/:key`, `/api/leaderboard`, `/api/stats`, `/api/matches`, `/health`
- Session auth via HTTP-only cookie; `requireAuth` guards protected routes. `CORS_ORIGIN` var drives CORS/redirect target.

## Conventions

- TypeScript is strict; `allowImportingTsExtensions` + `verbatimModuleSyntax` are on, so relative imports include the `.ts`/`.tsx` extension and type-only imports must use `import type`.
- React frontend: Tailwind v4 + `src/ui/styles.css`. **No inline styles** in React — `check:frontend` enforces this and runs in `build`.
- Styling convention: Tailwind is applied **from component CSS** in `src/ui/styles.css` (Tailwind-powered classes), not by sprinkling long utility strings across JSX `className`s. Prefer extending `styles.css` over moving utilities inline into `.tsx`.
- Phaser scenes do use inline style-like configuration (Phaser text objects, graphics calls) — the inline-style check does not apply to `src/game/`.
- When changing any sprite post-processing or animation definitions, bump `SPRITE_PROCESSING_VERSION` in `CharacterPipeline.ts` so users' cached characters are regenerated on next load rather than displaying with stale post-processing.

## Active refactor

The non-match → React migration is complete: all title, roster, gallery, character-creation, and photo-upload Phaser scenes have been deleted, and the React shell owns every UI flow except the in-match runtime. Fighter creation (`/fighters/new`) and fighter editing (inside `/gallery`) now share the primitives listed in "React shell" above instead of each reimplementing grids/previews. **Do not add new Phaser scenes for UI flows.** Current open item is the large JS bundle (~1.6 MB) — a candidate for code-splitting the Phaser runtime behind a dynamic import when entering `/fight`.

## Roadmap and pending work

For "what's next?" questions, read these in order:
- **`ROADMAP.md`** — state snapshot + phased plan (Phase A validation → B tiers → C-G PROD migration → H video → I monetization).
- **`QUALITY_TIERS.md`** — full design of the pricing tier system (Phase B, not yet implemented).

Current state at the head of `main`: the sprite pipeline default is `sheet_refined` with HD cache (768×1024 per cell). Background removal uses a pre-neutralize CPU pass + a union of chroma-key flood-fill + BiRefNet (fal). Tier system designed but not yet implemented. Worker / Clerk / server-side cache approved as next PROD phases.
