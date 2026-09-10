# Aura animation packs v1

Status: runtime and capability contract implemented. Official Trump, Rosalía and Lamine presentation bundles provide complete dedicated Aura performances; the generic Nova/Byte trial stays available without an account. Template Zero is a reviewed choreography scaffold, never a real character or a Champion render master. New character packs still require individual identity-preserving renders and visual/runtime review.

## Product contract

A fighter is one identity with independent capability packs. Packs are additive: buying Aura does not silently charge for Fight, and buying Fight later reuses the same source identity rather than regenerating it.

- `fight-v1`: the existing eleven combat animations. Required by Fight and, for now, Rush.
- `aura-v1-2026`: six performance animations for Aura Battle.
- A complete `fight-v1` fighter needs the six dedicated Aura performances before it can be selected in Aura. Combat moves do not satisfy Aura eligibility. The optional shrug is never required.
- An Aura-only fighter is playable in Aura but not in Fight or Rush until `fight-v1` exists.
- Quality belongs to each pack. A fighter may be Aura Champion and Fight Rookie.
- Template Zero is generation infrastructure and must never enter a selectable roster.

### Isolated free demo exception

The offline Aura trial and challenge entry may use the reviewed Template Zero
runtime sheets as clearly generic bundled demo performers, Nova and Byte (a blue
presentation tint of the same neutral pack). This works in production without a
development query. It only applies to those explicit names with no photo hash or
cloud fighter ID, and never applies to live online matches. An owned pack is never
filled or replaced with demo art. These performers do not become roster entries,
public fighters, or evidence of paid Champion quality; all generation, identity,
review and publication gates above remain in place.

### Reviewed official presentation bundles

The official Arcade identities `donald-trump`, `rosalia-v2` and `lamine-yamal`
load their own reviewed runtime atlases under `public/assets/aura/<slug>/` in
either player seat. Trump includes the optional shrug; Rosalía and Lamine each
contain all six core performances. No reaction is mandatory.

Selection requires the canonical `arcade:<slug>:<fighter-id>` cache key and
matching public cached metadata. Display names, private copies and the legacy
`rosalia` slug never select these assets. Current cached Aura animations take
precedence, and every bundled file must match its reviewed SHA-256 before it
enters the renderer. These supplements do not modify cloud manifests, cache
pointers, pack ownership or paid entitlements. Other characters require their
own complete dedicated Aura assets; they never inherit another identity or
Template Zero art. The opt-in development canaries remain available for QA.

Rosalía and Lamine were generated as 46 distinct full-resolution poses each,
with the approved six-seven repeats expanded into eight-frame sheets. Each
render combines the official public canonical reference with a normalized pose
anchor through the existing Insert Player → Meterkey → FAL transport using
`bytedance/seedream/v5/pro/edit`. Four pose canaries passed before the remaining
88 were submitted with concurrency four. The conservative reserved cost for
92 calls is $13.248; no paid repairs or blind retries were used.

Exact hashes, request IDs, source/pose hashes, registration measurements and
compact visual contact sheets are retained under
`artifacts/aura-animation-canary/official-roster-v1/`. Original 1536×2048 PNGs
and the authored 4× atlases remain in the task's ignored local archive. They
are not shipped to players. Runtime cells match the established upright
192×256, one-leg 256×256 and floor-worm 384×256 geometry.

`AuraBuiltinAssets.ts` records standing body/root references measured from the
new exact bytes at alpha 32. It preserves authored motion using one fixed scale
per action and never borrows Trump's frame remaps or pose-correction curves.
A documented 2% uniform raster reduction of Lamine's entire mog-check action
keeps its deliberate large-face peak clear of the top edge; the standing
reference restores its body size in the renderer without per-frame shrinking.

Aura landing and Play provide a separate **Choose a character** action opening
`/roster/aura`; one-tap free Nova/Byte quickplay remains the primary action.

Selection filters apply to both seats, local and online play, gallery capability
labels and recipient-owned challenge choices. Cached readiness is checked again
before launch. The scene requires all six animations to load and calibrate before
starting the clock or recording; missing or invalid assets produce a recoverable
loading error instead of silently switching to combat choreography.

The Aura pack is versioned and seasonal because meme language ages much faster than the fighting contract. A later pack must coexist with `aura-v1-2026`; it must not invalidate assets players already own.

## Aura v1 performances

| Asset name | Performance direction | Runtime role |
| --- | --- | --- |
| `aura_unbothered` | Calm, upright, deliberately effortless. No fighting guard. | Default loop and breathing room between phrases. |
| `aura_six_seven` | Recognisable 6-7 palm seesaw with readable shoulders and hands. | Short meme accent; do not overuse. |
| `aura_mog_check` | Looksmaxxing/mewing beat: jaw, cheeks, lips and a confident head turn. | Camera can punch in and exaggerate the head at runtime; anatomy stays reusable. |
| `aura_glide` | Original calm glide inspired by aura-farming processions, without copying a named choreography. | Travelling phrase with low apparent effort. |
| `aura_floor_worm` | Breakdance-style descent, floor worm and clean recovery. | High-energy phrase; requires the largest safe canvas. |
| `aura_one_leg` | Original one-leg hop with the free ankle held behind the body. | Comedic climax phrase. Exact third-party emotes are not copied. |

One rhythm note does **not** trigger one full animation. Each turn deterministically selects two or three performance phrases. Accurate notes sustain or intensify the current phrase; a miss interrupts it with the existing hit/stumble fallback. The same phrase schedule is derived from match seed, round and slot, so online presentation stays reproducible without touching the scoring simulation.

### Optional reactions

`aura_shrug` is a reusable reaction, not a seventh paid performance. After two consecutive misses or mash inputs, the inactive opponent may shrug for 1.05 seconds. A 2.2-second cooldown keeps the joke readable without turning it into a repeated trigger. Fighters without the reaction remain fully valid `aura-v1-2026` fighters, and the reaction can never be selected as a scored routine phrase.

## Sprite contract

- Transparent PNG sheet with bottom-centred root and stable scale across frames.
- `frameWidth`, `frameHeight` and `frameCount` are explicit metadata; the loader must not guess them from a filename.
- The clean runtime asset and optional high-resolution source follow the existing sprite-version storage model.
- Full-body frames must preserve hands, feet and floor contact. `aura_floor_worm` must fit without shrinking every upright performance.
- The runtime may add camera punch-ins, aura trails, head emphasis and crowd lighting. Those effects are not baked into every fighter sprite.

### Champion production path

Template Zero is a pose and timing atlas. Its 384×512 storyboard cells are deliberately sufficient to communicate silhouette, hand ownership and body mechanics; enlarging those pixels would not create Champion detail. A paid character pack follows the existing `sheet_refined` quality model instead:

1. Extract and review each Template Zero cell as a pose anchor.
2. Combine that pose anchor with the target fighter's canonical identity and outfit references.
3. Refine or regenerate every unique target-character frame independently at archival resolution.
4. Remove the background, register the root and preserve the HQ frame as immutable source evidence.
5. Derive the lightweight Phaser sheet from those exact approved HQ frames.

The minimum archival target is four times the runtime dimensions on each axis: 768×1024 for upright 192×256 cells, 1024×1024 for `aura_one_leg`, and 1536×1024 for the wide `aura_floor_worm`. A conventional pixel upscale of a storyboard or runtime frame cannot satisfy the Champion gate. The six core performances contain at most 46 unique render poses after explicit repeats are deduplicated; the optional shrug raises that upper bound to 49.

## Template Zero development batch

`aura_six_seven` was generated first as the eight-frame canary and passed these gates before the remaining five were authorized:

1. Identity, clothing and body proportions stay stable across all frames.
2. Both hands read clearly at gameplay scale, each anatomical hand visibly trades the upper position, and the gesture is recognisable without UI copy.
3. Feet remain planted on one root line; no lateral drift or accidental camera movement.
4. No cropped fingers, duplicated limbs, fighting guard, text, glow or background survives cleanup.
5. The processed sheet loads through the real Aura loader and can be interrupted cleanly on a miss.
6. Actual provider cost, frame-repair rate and manual-review time are recorded before pack pricing is set.

The authorized development batch now includes `aura_unbothered`, `aura_mog_check`, `aura_glide`, `aura_one_leg` and `aura_floor_worm`. Every asset has its raw choreography storyboard, processed development-runtime sheet, non-accumulating GIF preview, gameplay capture, QA measurements and provenance manifest under `artifacts/aura-animation-canary/template-zero/`. None of those gray Template Zero sheets is a selectable fighter or a Champion publication asset.

Frame metadata is deliberately per animation. Upright performances use 192×256 cells, `aura_one_leg` uses 256×256 for the balancing arm and held ankle, and `aura_floor_worm` uses 384×256 so horizontal anatomy is neither cropped nor globally shrunk. Phaser consumes that explicit metadata; it never guesses the grid from the filename.

The development canary is intentionally opt-in and can never enter a roster. Run Aura with `?auraCanary=template-zero` to load all six processed performances and `aura_shrug` through the real runtime. Add `&auraAutoplay=1` to watch CPU versus CPU, or `&auraCanaryMove=aura_mog_check` (using any routine animation name) to pin one performance for review. Both helpers are removed from production builds. The reproducible processor command is `npm --prefix processor run aura:canary:process -- --input <raw.png> --output <runtime.png> --qa-output <qa.json> [--frame-width 256]`.

## Commercial rollout

Do not derive Aura price by multiplying six by the existing eleven-animation Fight price. Motion complexity and frame repair differ materially. Price only after the canary and one high-motion animation have measured costs.

The creation UI should eventually offer:

- Aura only
- Fight + Rush only
- Complete player (Aura + Fight + Rush), with delta pricing that reuses already-generated identity/source views

Publishing and online rooms must declare their game mode and validate the corresponding pack. General community visibility must never imply Fight compatibility when a fighter is Aura-only.
