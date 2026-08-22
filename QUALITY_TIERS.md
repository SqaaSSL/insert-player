# Quality Tiers — Pricing & Implementation Plan

> **Status:** Implemented for sprite tiers, account-scoped local cache, version-preserving cloud sync, durable backend generation/upgrades/retries, operation-specific credits, UI, and profitability guards. Keep this file as the design contract.
> **Launch evidence:** Real Rookie creation, Contender upgrade, Champion upgrade, authenticated Champion Retry, processing-v5 RAW reconstruction, incremental cloud sync, and playable match entry have passed in isolated QA. A durable Victory Retry and Pro Upright-source Retry also survived navigation/reconnect, committed exactly one credit, and preserved prior versions. Pre-launch failed attempts previously restored reservations; launch policy `2026-08-23.1` supersedes that behavior by committing at the first billable provider attempt and releasing only untouched reservations. Remaining validation is one live Stripe payment/webhook, two production Clerk users for authenticated smoke, real-phone QA, and physical two-device play. Background removal is validated unless a new real output demonstrates a regression.
> **Author:** Discussed 2026-04-24.

---

## 1. Goal

Three sprite-generation quality tiers exposed to the user, designed as a freemium funnel: hook on free → upsell to paid → optional premium. Source views (side / upright / crouch) **always use Gemini Pro** regardless of tier — they are the seed for everything downstream and are showcased to the user as the canonical "this is your fighter" image, so quality there matters most and is non-negotiable. Animations are what differs across tiers.

Fighter creation in any tier is a one-shot purchase. Video intro is a fully separate purchase (not part of any tier — see §8).

---

## 2. Tiers

| Tier | Pipeline | Gemini model (anims) | BiRefNet on anims | Frame detail |
|---|---|---|---|---|---|
| **Rookie** | `sheet` (1 call/anim) | Flash 3.1 | ❌ no | ~256px (single sheet) |
| **Contender** | `sheet_refined` (1 sheet + N refines) | Flash 3.1 | ✅ yes | ~1024px per frame |
| **Champion** | `sheet_refined` (Flash scaffold + N Pro refines) | Flash scaffold + Pro final frames | ✅ yes | ~1024px per frame, premium final render |

Source views always: 1 Gemini Pro call each (side / upright / crouch), plus BiRefNet display cleanup for side and crouch. Fixed nominal cost = **~$0.41** per fighter regardless of tier.

### Why these specific combos
- **Rookie**: matches the pipeline that existed BEFORE the `sheet_refined` work. Cheap, fast, "good enough to play with". Chroma-key only on anims (no per-frame DNN).
- **Contender**: full pipeline + same model that was already producing great quality before we switched to Pro. Best quality/price ratio.
- **Champion**: Flash establishes the strict multi-cell pose sequence, then Pro independently renders every final frame for the bump in fine detail (eye highlights, fabric texture, hair edges). The Flash sheet is only a composition scaffold and is never shipped as the final Champion animation.
- 3-tier with no half-measures: the gap between any two tiers must be visible enough to justify the upsell. Skipping intermediates avoids "is it really worth $X more?" friction.

---

## 3. Per-fighter cost breakdown (our cost, before markup)

Source views (always Pro): **~$0.41** fixed across all tiers.

| Tier | Anim Gemini calls | Anim Gemini cost | BiRefNet anims | **Nominal fighter** | **Measured QA session** |
|---|---|---|---|---|
| Rookie | 11 sheets × Flash @ $0.067 | ~$0.74 | $0 | **~$1.15** | **$1.43** |
| Contender | 87 calls × Flash @ $0.067 | ~$5.88 | 76 × $0.002 = $0.15 | **~$6.44** | **$7.88** |
| Champion | 11 scaffolds × Flash @ $0.067 + 76 final frames × Pro @ $0.134 | ~$10.92 | 76 × $0.002 = $0.15 | **~$11.48** | **$12.64** |

The nominal columns are standard-API estimates dated 2026-08-17. The pricing guard uses the higher measured end-to-end sessions from real sandbox QA, which include actual request shape and pipeline overhead. They do not assume that retries are free. Google released the GA model IDs on 2026-05-28 and shut down the preview IDs on 2026-06-25. Pricing source: [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing); lifecycle source: [Gemini API release notes](https://ai.google.dev/gemini-api/docs/changelog).

---

## 4. Upgrade economics

Upgrades regenerate animations from scratch (decision **B**, MVP simplicity). Source views are NOT regenerated — they are already at Pro, identity is preserved.

| Upgrade path | Our cost |
|---|---|
| Rookie → Contender | Price against the conservative $7.88 measured Contender session |
| Contender → Champion | Price against the conservative $12.64 measured Champion session |
| Rookie → Champion (skip middle) | Same Champion price — straight regeneration |

There is no "discount" for already having a lower-tier blob in cache, because the upgrade regenerates from scratch. The lower-tier blob still sits in cache (see §5).

### Future optimization (not MVP)
For Contender → Champion, the existing Contender base sheet could be reused as the pose anchor and only the refines re-run with Pro. Skipped for MVP because (a) it complicates version provenance and (b) regeneration gives an independent premium result while preserving the Contender version.

---

## 5. Cache must preserve EVERY version

**Hard requirement from user**: never delete a previously generated asset. A user who paid for Rookie and then upgrades to Champion still owns the Rookie blobs and can switch back if they want. Also useful for A/B comparison and for the gallery to show "see how it would look at each quality".

### Schema impact

Original cache key: `[photoHash, animationName]` → unique per anim per fighter.
Implemented cache key: **`[ownerScope, versionId]` per generated sprite record**, with scoped indexes for `[ownerScope, photoHash, animationName]` and `[ownerScope, photoHash, animationName, tier]` lookup.

Each animation can have multiple cached blobs simultaneously, including same-tier retries. Upgrading writes new entries; it doesn't overwrite older generated versions.

### Code-level changes
- `CachedSprite` gets `qualityTier: QualityTier` and optional `versionId` fields.
- IndexedDB key path is `[ownerScope, versionId]` in `SpriteCache.ts` (`DB_VERSION = 5`). Existing v4 rows migrate into versioned `local` records with normalized `qualityTier`; the first Clerk account claims those rows, and later account switches see only their own scope. Same-tier retries and lower-tier assets remain preserved instead of being overwritten.
- New helper `getBestSpriteForAnim(hash, animName, preferredTier?)` returns the highest tier available, optionally capped at `preferredTier`.
- Existing `getAllSpritesForHash(hash)` could return ALL versions; callers that want "best" use the new helper. Or keep `getAllSpritesForHash` as "best per anim" for backwards compat and add `getAllSpriteVersionsForHash` for full listing.
- `setCachedSprite` writes a new `versionId` by default; cloud import may preserve the cloud `sprite_versions.id`.
- `deleteCharacter` already deletes by `photoHash` index → still works (cascades all tiers).
- `CachedMeta.qualityTier` records the *highest* tier the user has ever generated for this fighter. Used for the badge and to decide which upgrade buttons to show.

### Disk impact
3 tiers × ~11 anims × ~1.5 MB per anim sheet (Champion size) ≈ **~50 MB per fighter at full upgrade**, plus any retry versions the user chooses to keep. IndexedDB on modern browsers easily handles GBs. Acceptable.

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
    geminiAnimModelOverride: 'gemini-3.1-flash-image',
    enableDnnBgRemoval: false,
  },
  contender: {
    spriteMode: 'sheet_refined',
    geminiAnimModelOverride: 'gemini-3.1-flash-image',
    enableDnnBgRemoval: true,
  },
  champion: {
    spriteMode: 'sheet_refined',
    geminiAnimModelOverride: 'gemini-3-pro-image',
    enableDnnBgRemoval: true,
  },
};
```

### Per-operation model selection
Animation model selection is explicit request data, not module-level state. `CharacterPipeline.ts` passes the tier model through each sprite call so concurrent generations cannot exchange models or cost profiles:
```ts
generateSpriteWithGemini(
  primaryImage,
  animation,
  secondaryImage,
  undefined,
  normalizationReference,
  tierConfig.spriteMode,
  tierConfig.enableDnnBgRemoval,
  apiContext,
  tierConfig.geminiAnimModelOverride,
);
```

`GeminiApi.ts` accepts that override only for sprite operations. Repose, upright, and crouch source operations fail closed to `gemini-3-pro-image` if an environment override is absent or points at a non-Pro model.

Inside `sheet_refined`, a Pro override means **Flash scaffold + Pro final-frame render**. Flash is used only for the structured pose grid because it follows multi-cell layouts more reliably; each visible Champion frame is regenerated from the canonical character image and its scaffold cell with Pro. Contender remains Flash for both stages.

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
- Marketing line below hero: "Your first fighter is free in Rookie quality. Upgrade anytime to bring out the detail."
- (Future) Credit balance display once monetization wiring is added.

---

## 8. Video — separate concern

Video intro is **not part of any tier**. It's an independent add-on:
- Generated on-demand from Gallery via "Generate Intro Video" button.
- Tier selector at video time: LTX (~$0.20) / Runway (~$0.30) / Kling Pro (~$0.75) / Veo (~$2).
- `CachedIntro` already supports multiple variants → user can purchase multiple video qualities for the same fighter without losing any.

Wire in after sprite tier system is stable.

---

## 9. Marketing / monetization

- Acquisition subsidy is one anonymous Rookie authorization per pseudonymized network identity/day after server-verified single-use Turnstile, plus one signed-in free Rookie per Clerk account. Free quota applies only to a new Rookie fighter, never to a retry or upgrade.
- Full generation/upgrade costs are locked at **2 / 11 / 18 credits** for Rookie / Contender / Champion. Animation retries cost **1 / 2 / 4 credits** by tier, a canonical Pro source-view retry costs **1 credit**, and RAW HD reconstruction is local-only and free. Every prior version remains owned and archived.
- Launch packs are Starter (11 credits, **€14.99**), Versus (20 credits, **€24.99**), and Arcade (47 credits, **€56.99**). Starter buys one Contender; Versus buys one Champion plus one Rookie; Arcade buys two Champions plus one Contender.
- `scripts/check-tier-parity.mjs` keeps frontend, Worker, bootstrap, and pack arithmetic exact. It computes net revenue after 21% VAT, Stripe's 1.5% + €0.25 EEA-card fee, and 0.5% Stripe Tax. At the least valuable pack, each clean tier must cover at least 1.30× the measured provider cost and each retry at least 1.25× its conservative cost. It also replays the actual failure-heavy `$32.64` QA sequence under the old, less favorable assumption that two Champion failures returned their credits, and requires it to remain above 1.10×. Launch behavior retains those credits after provider spend, so this remains a deliberately conservative floor. Provider calls write durable per-operation cost events so these assumptions can be replaced with production cohorts instead of guesswork.
- Provider-cost estimates are internal and are not returned by the public `/api/tiers` response.
- Video remains a separately priced add-on after the sprite launch path is stable.

---

## 10. Launch decisions

1. Tier names are `Rookie / Contender / Champion`.
2. Anonymous launch quota is one Rookie authorization attempt per pseudonymized network identity/day after Turnstile; signed-in users receive one free Rookie through the account quota and generation ledger.
3. Tier badges use the existing product UI treatment; no emoji dependency is required.
4. The per-animation tier preview switcher is post-MVP. Full version history is preserved now so the UI can expose it later without a data migration.
5. Monetization uses one-shot credit packs for v1. Subscriptions are not required for launch.

---

## 11. Sequencing

1. ✅ Bg-removal pre-neutralize + union-mask + connected-edge decontamination path validated on a real Champion Retry: face preserved and severe green-edge rate reduced from `43.704%` to `0.276%`; all current Champion animations rebuilt from preserved RAW sheets at processing v5.
2. ✅ Schema migration: bump `DB_VERSION` to 3, add `qualityTier` to `CachedSprite` + `CachedMeta`, write migration that defaults existing entries to `'champion'`.
3. ✅ Pipeline: add `QualityTier`, `tierToConfig`, pass the animation model explicitly per operation, thread `{ tier }` through `processCharacter` / `retryAnimation`. Add `upgradeFighter`. Source views fail closed to Gemini Pro.
4. ✅ UI: tier selector in CreateFighterPage, tier badge + upgrade buttons in GalleryPage. HomePage pricing/credit panel.
5. ✅ All three real provider paths passed on one preserved fighter: Rookie creation 17 calls / `$1.43`, Contender upgrade 165 / `$7.88`, Champion upgrade 123 / `$12.64`; successful reservations committed, two failed Champion attempts were settled under the superseded pre-launch refund behavior, all 11 animations per tier synced, and every prior version remained archived. Launch code now commits before the first provider attempt. Production payment and two-device evidence remain release checks rather than tier-design work.
6. ⏭ Video integration as separate feature.

---

## 12. Non-goals / things we explicitly DON'T do

- Partial-tier upgrades (e.g., upgrade only the idle to Champion). Confusing, fragments cache, low value. Whole-fighter only.
- Auto-downgrade or cache eviction. Cache grows; user can manually delete fighters.
- Mixed-tier playback in FightScene. The match runtime always loads the highest available tier for each fighter.
- Backwards compat for the `frame_sequence` mode on non-idle anims. Already gracefully falls back to `sheet`. Stays as debug-only.
