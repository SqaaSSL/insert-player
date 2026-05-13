# Quality Tiers — Pricing & Implementation Plan

> **Status:** Plan only. NOT YET IMPLEMENTED.
> **Blocker:** Validate the DNN background-removal integration (`geminiSheetRefined` → `dnnBgRemoveCells`) is producing clean faces in real fighters before introducing tier-switching complexity on top.
> **Author:** Discussed 2026-04-24.

---

## 1. Goal

Three sprite-generation quality tiers exposed to the user, designed as a freemium funnel: hook on free → upsell to paid → optional premium. Source views (side / upright / crouch) **always use Gemini Pro** regardless of tier — they are the seed for everything downstream and are showcased to the user as the canonical "this is your fighter" image, so quality there matters most and is non-negotiable. Animations are what differs across tiers.

Fighter creation in any tier is a one-shot purchase. Video intro is a fully separate purchase (not part of any tier — see §8).

---

## 2. Tiers

| Tier | Pipeline | Gemini model (anims) | BiRefNet on anims | Frame detail |
|---|---|---|---|---|
| **Rookie** | `sheet` (1 call/anim) | Flash 3.1 | ❌ no | ~256px (single sheet) |
| **Contender** | `sheet_refined` (1 sheet + N refines) | Flash 3.1 | ✅ yes | ~1024px per frame |
| **Champion** | `sheet_refined` (1 sheet + N refines) | Pro | ✅ yes | ~1024px per frame, premium model |

Source views always: 1 Gemini Pro call each (side / upright / crouch) + 1 BiRefNet each. Fixed cost = ~$0.23 per fighter regardless of tier.

### Why these specific combos
- **Rookie**: matches the pipeline that existed BEFORE the `sheet_refined` work. Cheap, fast, "good enough to play with". Chroma-key only on anims (no per-frame DNN).
- **Contender**: full pipeline + same model that was already producing great quality before we switched to Pro. Best quality/price ratio.
- **Champion**: same pipeline as Contender, swap to Pro for the marginal-but-visible bump in fine detail (eye highlights, fabric texture, hair edges).
- 3-tier with no half-measures: the gap between any two tiers must be visible enough to justify the upsell. Skipping intermediates avoids "is it really worth $X more?" friction.

---

## 3. Per-fighter cost breakdown (our cost, before markup)

Source views (always Pro): **$0.23** fixed across all tiers.

| Tier | Anim Gemini calls | Anim Gemini cost | BiRefNet anims | **Total fighter** |
|---|---|---|---|---|
| Rookie | 11 sheets × Flash @ ~$0.03 | $0.33 | $0 | **~$0.56** |
| Contender | 87 calls × Flash @ ~$0.03 | $2.61 | 76 × $0.002 = $0.15 | **~$2.99** |
| Champion | 87 calls × Pro @ ~$0.075 | $6.53 | 76 × $0.002 = $0.15 | **~$6.91** |

Pricing assumptions are estimates; Gemini 3 Pro Image is preview-tier and exact $/image is not yet fully published. Range is ±30%.

---

## 4. Upgrade economics

Upgrades regenerate animations from scratch (decision **B**, MVP simplicity). Source views are NOT regenerated — they are already at Pro, identity is preserved.

| Upgrade path | Our cost |
|---|---|
| Rookie → Contender | ~$2.76 (regenerate 11 anims at Sharp pipeline) |
| Contender → Champion | ~$6.68 (regenerate 11 anims at Ultra pipeline) |
| Rookie → Champion (skip middle) | ~$6.68 (same — straight to Ultra) |

There is no "discount" for already having a lower-tier blob in cache, because the upgrade regenerates from scratch. The lower-tier blob still sits in cache (see §5).

### Future optimization (not MVP)
For Contender → Champion, the base sheet from Contender could be reused as the pose anchor and only the refines re-run with Pro — saves ~$0.73 per upgrade (~10%). Skipped for MVP because (a) it complicates code, (b) full regenerate gives marginally better consistency.

---

## 5. Cache must preserve EVERY version

**Hard requirement from user**: never delete a previously generated asset. A user who paid for Rookie and then upgrades to Champion still owns the Rookie blobs and can switch back if they want. Also useful for A/B comparison and for the gallery to show "see how it would look at each quality".

### Schema impact

Current cache key: `[photoHash, animationName]` → unique per anim per fighter.
New cache key: **`[photoHash, animationName, tier]`** → unique per (anim, tier) per fighter.

Each animation can have up to 3 cached blobs simultaneously (one per tier). Upgrading writes a new entry; doesn't overwrite.

### Code-level changes
- `CachedSprite` gets a `qualityTier: QualityTier` field.
- IndexedDB key path bumps from `[photoHash, animationName]` to `[photoHash, animationName, qualityTier]`. This requires a DB version bump in `SpriteCache.ts` (today `DB_VERSION = 2`, would go to 3) with an `onupgradeneeded` migration that backfills existing entries with `qualityTier = 'champion'` (everything pre-tier was generated at the highest pipeline → safest default).
- New helper `getBestSpriteForAnim(hash, animName, preferredTier?)` returns the highest tier available, optionally capped at `preferredTier`.
- Existing `getAllSpritesForHash(hash)` could return ALL versions; callers that want "best" use the new helper. Or keep `getAllSpritesForHash` as "best per anim" for backwards compat and add `getAllSpriteVersionsForHash` for full listing.
- `setCachedSprite` writes with the new 3-key path.
- `deleteCharacter` already deletes by `photoHash` index → still works (cascades all tiers).
- `CachedMeta.qualityTier` records the *highest* tier the user has ever generated for this fighter. Used for the badge and to decide which upgrade buttons to show.

### Disk impact
3 tiers × ~11 anims × ~1.5 MB per anim sheet (Champion size) ≈ **~50 MB per fighter at full upgrade**. IndexedDB on modern browsers easily handles GBs. Acceptable.

---

## 6. Pipeline changes (do not break current flow)

### New module-level type
```ts
// CharacterPipeline.ts
export type QualityTier = 'rookie' | 'contender' | 'champion';

interface TierConfig {
  spriteMode: SpriteGenerationMode;     // 'sheet' | 'sheet_refined'
  geminiAnimModelOverride: string | null; // null → use env defaults; string → force model
  enableDnnBgRemoval: boolean;          // whether the refine path runs BiRefNet per frame
}

const TIER_CONFIGS: Record<QualityTier, TierConfig> = {
  rookie: {
    spriteMode: 'sheet',
    geminiAnimModelOverride: 'gemini-3.1-flash-image-preview',
    enableDnnBgRemoval: false,
  },
  contender: {
    spriteMode: 'sheet_refined',
    geminiAnimModelOverride: 'gemini-3.1-flash-image-preview',
    enableDnnBgRemoval: true,
  },
  champion: {
    spriteMode: 'sheet_refined',
    geminiAnimModelOverride: 'gemini-3-pro-image-preview',
    enableDnnBgRemoval: true,
  },
};
```

### Runtime override mechanism
Module-level state in `GeminiApi.ts` with try/finally scoping in `CharacterPipeline.ts`:
```ts
// GeminiApi.ts
let runtimeAnimModelOverride: string | null = null;
export function setGeminiAnimModelOverride(model: string | null): void {
  runtimeAnimModelOverride = model;
}

function resolveGeminiImageModel(options) {
  // For sprite/animation operations, runtime override takes precedence.
  if (runtimeAnimModelOverride && (options?.operation === 'sprite' || options?.animationName)) {
    return runtimeAnimModelOverride;
  }
  // For repose/upright/crouch, env defaults stand → always Pro per user's setup.
  // ... existing env resolution
}
```

For BiRefNet enable/disable in `geminiSheetRefined`, add a parameter `{ enableBgRemoval: boolean }` that gates the call to `dnnBgRemoveCells`.

### Public API changes
```ts
processCharacter(file, onStatus, name, options?: { tier?: QualityTier })
retryAnimation(hash, animName, onStatus, options?: { tier?: QualityTier; spriteMode? })
upgradeFighter(hash, toTier, onStatus): Promise<void>  // NEW
```

`processCharacter` reads `options.tier` (default `contender`), looks up config, sets module-level overrides only for the animation phase, runs the pipeline, clears overrides in `finally`.

`upgradeFighter` reads existing meta, iterates animations, calls `retryAnimation(..., { tier: toTier })` for each. Each `retryAnimation` creates a NEW cache entry tagged with `toTier` — does not overwrite the lower-tier entry. Updates `CachedMeta.qualityTier` to `toTier` if it's higher than the current value.

### Backward compat
- Existing fighters in IndexedDB lack `qualityTier`. Migration backfills as `'champion'`.
- Default tier for new fighters when no option passed: `'contender'` (matches current default behavior — `sheet_refined` + Flash via env, except env currently has Pro overrides that we'd remove).
- The `.env` Pro overrides for `_SPRITE / _ANIM_*` should be REMOVED so the defaults are Flash; the tier system explicitly overrides to Pro for Champion. Source view env vars (`_REPOSE / _UPRIGHT / _CROUCH`) STAY as Pro.

---

## 7. UI changes

### CreateFighterPage
- Tier selector chip group above the file input: `Rookie / Contender / Champion`.
- Each chip shows: name + 1-line pitch + estimated time + estimated credit cost.
- Default selected: `Contender` (best ratio).
- Pass `tier` to `processCharacter`.
- Visible "what you get" line below selector: source views always premium, animations vary by tier.

### GalleryPage
- **Tier badge** on each fighter card in the sidebar list (small chip: 🥉 / 🥈 / 🥇 or text).
- **Upgrade buttons** in the fighter hero actions row, conditional on current tier:
  - Rookie fighter: shows "Upgrade to Contender" + "Upgrade to Champion".
  - Contender fighter: shows "Upgrade to Champion".
  - Champion fighter: no upgrade button.
- Upgrade buttons trigger a confirmation modal: "Regenerate all 11 animations at [TIER]. This costs N credits and takes ~M minutes. Existing animations are kept in cache and remain accessible.".
- **Tier preview switcher** in the Animations panel (future enhancement — not MVP): per-anim dropdown that lets you preview the same animation at different cached tiers. Useful for showing the user "this is what upgrading would unlock".

### HomePage
- Marketing line below hero: "Your first 1-2 fighters are free in Rookie quality. Upgrade anytime to bring out the detail."
- (Future) Credit balance display once monetization wiring is added.

---

## 8. Video — separate concern

Video intro is **not part of any tier**. It's an independent add-on:
- Generated on-demand from Gallery via "Generate Intro Video" button.
- Tier selector at video time: LTX (~$0.20) / Runway (~$0.30) / Kling Pro (~$0.75) / Veo (~$2).
- `CachedIntro` already supports multiple variants → user can purchase multiple video qualities for the same fighter without losing any.

Wire in after sprite tier system is stable.

---

## 9. Marketing / monetization (out of code scope but worth recording)

- Cost per acquired user: 1-2 free Rookies = ~$0.56 to $1.12. Cheaper than a Meta ad click.
- Suggested credit pack: 10 credits for $5. Conversion: 1 credit = Rookie (or free), 6 credits = Contender, 15 credits = Champion. Upgrade Rookie→Contender = 6 credits. Upgrade Rookie→Champion = 15 credits.
- Margin at 3x markup: Rookie freebie costs us $0.56, Contender $9 sale ⇒ ~$6 margin, Champion $20 sale ⇒ ~$13 margin. Healthy.
- Video as add-on: 1-5 credits depending on provider.

---

## 10. Open decisions before building

1. **Confirm tier names**: `Rookie / Contender / Champion`. Or alternatives.
2. **Free fighter quota**: hard-code 1, 2, or N free Rookies per browser/account? Out of code scope but affects HomePage copy.
3. **Tier badge style**: text chip, medal emoji, or a tiny colored bar? UI polish detail.
4. **Tier preview switcher in Gallery**: MVP or post-MVP?
5. **Monetization wiring**: stub now (just costs/labels) or skip entirely until later?

---

## 11. Sequencing

1. ✅ Validate DNN bg-removal works in current `Champion`-equivalent path. **[BLOCKER, in progress]**
2. ⏭ Schema migration: bump `DB_VERSION` to 3, add `qualityTier` to `CachedSprite` + `CachedMeta`, write migration that defaults existing entries to `'champion'`.
3. ⏭ Pipeline: add `QualityTier`, `tierToConfig`, runtime override setters, thread `{ tier }` through `processCharacter` / `retryAnimation`. Add `upgradeFighter`. Remove env overrides for animations (keep for source views).
4. ⏭ UI: tier selector in CreateFighterPage, tier badge + upgrade buttons in GalleryPage. HomePage marketing copy.
5. ⏭ Verify all three tiers end-to-end with a real fighter, including upgrades and cache preservation.
6. ⏭ Video integration as separate feature.

---

## 12. Non-goals / things we explicitly DON'T do

- Partial-tier upgrades (e.g., upgrade only the idle to Champion). Confusing, fragments cache, low value. Whole-fighter only.
- Auto-downgrade or cache eviction. Cache grows; user can manually delete fighters.
- Mixed-tier playback in FightScene. The match runtime always loads the highest available tier for each fighter.
- Backwards compat for the `frame_sequence` mode on non-idle anims. Already gracefully falls back to `sheet`. Stays as debug-only.
