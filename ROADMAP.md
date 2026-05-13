# Roadmap & handoff

> Living document of where the project is and what's next.
> Read `CLAUDE.md` first for codebase orientation, then `QUALITY_TIERS.md` for the pricing tier plan, then this file.

---

## Snapshot — end of session 2026-05-13

### What works end-to-end

- **React shell owns all non-match UI** (`/menu`, `/gallery`, `/fighters/new`, `/roster/*`). Phaser is reduced to `[BootScene, FightScene]`. Don't reintroduce Phaser scenes for UI.
- **Tailwind-only styling**, build-enforced via `npm run check:frontend`. SF2-inspired theme in `src/ui/styles.css`. No inline styles, no raw CSS inside `@layer` blocks.
- **Shared fighter UI primitives** (`src/ui/components/`, `src/ui/shared/`) used by both `CreateFighterPage` and `GalleryPage`. Reuse them for any new fighter-related UI.
- **Sprite pipeline `sheet_refined`** (default for all animations):
  1. `geminiSpriteSheet` → coherent base sheet (1 Gemini call). Establishes pose + style across N frames.
  2. Split into N cells.
  3. Parallel refines (N Gemini calls). Each cell rendered at full Gemini resolution with `IMAGE 1 = side view` (style anchor) + `IMAGE 2 = sheet cell` (pose anchor). Size validation by proportion (not pixels); 2 attempts max with strict prompt on attempt 2.
  4. `cleanCellsWithUnionMasks` per cell: **pre-neutralize green spill on character pixels** (CPU canvas pass, in `SpritePostProcess.neutralizeGreenSpillForSegmentation`) → run BOTH chroma-key flood-fill AND BiRefNet via fal → **union the masks** (max alpha) keeping chroma RGB. Per-frame parallel.
  5. `composeRefinedFramesToSheet` with transparent padding (cells are already alpha-cleaned).
  6. `cleanSpriteSheet` for locked-scale per-animation normalization.
- **Cache resolution: 768×1024 per cell** (4× original). Game still renders at 192×256 — `AiSpriteLoader` downsamples on load. `SPRITE_PROCESSING_VERSION = 3` triggers `Rebuild HD` for legacy fighters.
- **Gallery actions**: Save PNG, Save GIF, Save RAW (per anim), Save All (per fighter), Rename, Delete, Rebuild HD (re-normalize from `rawPngBlob`).
- **Retry feedback**: per-target loading state in the preview pane + per-source chip "Regenerating..." label + per-anim tile "generating" badge.

### Pending validation (BLOCKER before Phase B)

- **Confirm the bg-removal pipeline (pre-neutralize + union mask) actually preserves faces** on the user's photoreal fighters. The user has seen multiple iterations; the last one shipped pre-neutralize as a CPU step before segmentation. If face holes persist, debug from:
  - `cleanCellsWithUnionMasks` in `src/services/GeminiApi.ts`
  - `neutralizeGreenSpillForSegmentation` and `chromaKeyRemove` in `src/services/SpritePostProcess.ts`
  - `unionMasksKeepRGB` (max-alpha merge)
- If a fundamental fix is needed beyond the current approach, candidates the user has already considered: dual-bg ensemble (re-render same frame on two different bgs, intersect masks), GPT Image 1 ($0.23/img, too expensive for tiers), Recraft V3 with native alpha (worth investigating), video matting / RVM (single call for the whole sheet, temporal consistency).

---

## Phase A — Bg-removal validation [BLOCKER]

User to test. If broken, debug as above. If working, move to Phase B.

---

## Phase B — Quality tiers

**Fully designed in `QUALITY_TIERS.md`. Don't deviate without rereading it.**

Summary of agreed decisions captured in that doc:
- Three tiers: `rookie | contender | champion`.
- Source views (side / upright / crouch) always use Pro regardless of tier.
- Cache preserves every tier blob ever generated (`[photoHash, animationName, qualityTier]` key, DB version bump 2 → 3, backfill existing entries as `'champion'`).
- Rookie pipeline = `sheet` mode + Flash, no BiRefNet on anims. ~$0.56/fighter.
- Contender = `sheet_refined` + Flash + BiRefNet. ~$2.99/fighter.
- Champion = `sheet_refined` + Pro + BiRefNet. ~$6.91/fighter.
- Upgrade regenerates anims from scratch (decision B in the doc), source views are not regenerated (already Pro).
- Module-level runtime model override in `GeminiApi.ts` (try/finally scoped in `CharacterPipeline.ts`).
- UI: tier chip selector in CreateFighterPage, badge + upgrade buttons in GalleryPage.
- `.env` loses Pro overrides for `_SPRITE / _ANIM_*`; keeps them for `_REPOSE / _UPRIGHT / _CROUCH`.

---

## Phase C — Server-side proxy (Cloudflare Worker)

Move API keys out of the client. Approved by user.

Scope:
- `worker/` already has a Cloudflare Workers skeleton with D1 + R2 bindings (currently uses Google OAuth — to be replaced in Phase D).
- Port `apiProxyPlugin` from `vite.config.ts` to a route in `worker/src/index.ts`. Endpoints: `/proxy/gemini`, `/proxy/fal`, `/proxy/runway`, `/proxy/freepik`, `/proxy/ludo`, `/proxy/image`, `/proxy/upload-temp`.
- Keys via `wrangler secret put` (GEMINI_API_KEY, FAL_API_KEY, RUNWAY_API_KEY, FREEPIK_API_KEY, LUDO_API_KEY).
- Update client base URL: `VITE_API_BASE_URL` env, defaults to `/` (Vite proxy in dev) or production worker URL (e.g., `https://api.ai-street-fighter.workers.dev`).
- Keep Vite middleware as dev fallback so local dev doesn't require running the worker.

---

## Phase D — Auth with Clerk

Replace the Google OAuth scaffold with Clerk.

Scope:
- Clerk SDK in worker — verifies JWT from `Authorization: Bearer <token>` header.
- Clerk React `<ClerkProvider>` in `src/main.tsx` wrapping `<App>`.
- Sign-in / sign-up UI (Clerk's hosted components).
- Worker resolves `clerk_user_id` (a string like `user_2abc...`) before any rate limit / DB write.
- Anonymous access still allowed for Rookie tier (rate-limit by IP).
- Remove `worker/src/auth.ts` Google flow once Clerk is wired.

---

## Phase E — Rate limiting on worker

Approved by user. Rate limit key = `clerk_user_id` when authenticated, IP fallback when anonymous.

Scope:
- Cloudflare KV (cheap) or Durable Objects (more accurate counters) for sliding-window rate counters.
- Per-route limits — `/proxy/gemini` is the expensive one. Different limits per tier:
  - Anon: 1-2 Rookie generations per day (marketing freebie).
  - Free Clerk user: ~5-10 Rookie generations per day.
  - Paid (credits / subscription): higher / unlimited.
- 429 response with `Retry-After` header.

---

## Phase F — Server-side fighter cache (R2 + D1)

Approved by user. Enables cross-device sync + sharing.

Scope:
- D1 schema:
  - `fighters(id, owner_user_id, name, photo_hash, quality_tier, public_flag, created_at, updated_at)`
  - `sprites(fighter_id, animation_name, quality_tier, blob_key, raw_blob_key, frame_w, frame_h, frame_count, processing_version, created_at)`
  - `intros(fighter_id, variant_id, blob_key, model, prompt, created_at)`
  - `stages(id, owner_user_id, label, kind, blob_key, created_at)`
- R2 bucket structure: `users/{user_id}/fighters/{fighter_id}/sprites/{anim}_{tier}.png`, similar for `raw` and `intros` and source views.
- Worker endpoints (RESTful):
  - `GET /api/fighters` — list (auth required)
  - `POST /api/fighters` — create
  - `GET /api/fighters/:id` — single (includes presigned R2 URLs for assets)
  - `PATCH /api/fighters/:id` — rename, set public_flag
  - `DELETE /api/fighters/:id` — cascade delete sprites/intros
  - `POST /api/fighters/:id/sprites` — write a new tier of an animation
  - `POST /api/fighters/:id/upgrade` — kick off server-orchestrated upgrade (alternative: client orchestrates, worker stores)
- Client: dual-write — IndexedDB stays as fast local cache + offline mode, server is source of truth. Background sync on fighter creation / mutation.
- Migration: "Sync to cloud" button on existing local fighters.

---

## Phase G — Sharing UI

Builds on Phase F.

- `public_flag` toggle in Gallery hero actions.
- Public fighters discoverable in a new `/community` route (or extension of `/gallery`).
- "Add to my roster" → clones the fighter (new owner, new id, copy R2 blobs).
- Featured fighters / leaderboard (worker already has `leaderboard.ts` scaffold).

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

Out of agent scope until product decisions are made:
- Credit system or subscription.
- Stripe integration.
- Free quota per anon / per free Clerk user.
- Pricing UI in HomePage.

---

## Open decisions / questions

1. Free Rookie quota for anonymous users: 1 per session? 1 per IP per day? TBD.
2. Tier badge style (medal emoji vs text chip vs colored bar): visual decision deferred.
3. Sharing model: public toggle only, or actual social graph (friends/follows)? TBD.
4. Server-orchestrated upgrade vs client-orchestrated: simpler for client now, more reliable from server. TBD.
5. Whether to retire IndexedDB entirely once Phase F lands, or keep it as offline cache permanently. Probably keep.

## Known pre-existing tech debt

- JS bundle ~1.6 MB. Code-split Phaser behind dynamic import gated on `/fight` — easy win.
- Some `console.info` / `console.warn` in production code. Gate behind a debug flag.
- IndexedDB migrations: v2 added stages store, v3 will add `qualityTier` per sprite (Phase B).

---

## Reference docs

- `CLAUDE.md` — codebase orientation for agents. Read first.
- `QUALITY_TIERS.md` — full tier design (pipeline + UI + cache).
- `ROADMAP.md` — this file. State snapshot + phase plan.
