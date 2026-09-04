# Aura animation packs v1

Status: runtime and capability contract implemented. The complete seven-asset Template Zero development set (six core performances plus optional shrug) passes mechanical and in-game agent review. Owner semantic review and measured production-provider cost remain the gates before generating real roster packs.

## Product contract

A fighter is one identity with independent capability packs. Packs are additive: buying Aura does not silently charge for Fight, and buying Fight later reuses the same source identity rather than regenerating it.

- `fight-v1`: the existing eleven combat animations. Required by Fight and, for now, Rush.
- `aura-v1-2026`: six performance animations for Aura Battle.
- A complete `fight-v1` fighter remains playable in Aura with the existing combat-animation fallback.
- An Aura-only fighter is playable in Aura but not in Fight or Rush until `fight-v1` exists.
- Quality belongs to each pack. A fighter may be Aura Champion and Fight Rookie.
- Template Zero is generation infrastructure and must never enter a selectable roster.

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

## Template Zero development batch

`aura_six_seven` was generated first as the eight-frame canary and passed these gates before the remaining five were authorized:

1. Identity, clothing and body proportions stay stable across all frames.
2. Both hands read clearly at gameplay scale, each anatomical hand visibly trades the upper position, and the gesture is recognisable without UI copy.
3. Feet remain planted on one root line; no lateral drift or accidental camera movement.
4. No cropped fingers, duplicated limbs, fighting guard, text, glow or background survives cleanup.
5. The processed sheet loads through the real Aura loader and can be interrupted cleanly on a miss.
6. Actual provider cost, frame-repair rate and manual-review time are recorded before pack pricing is set.

The authorized development batch now includes `aura_unbothered`, `aura_mog_check`, `aura_glide`, `aura_one_leg` and `aura_floor_worm`. Every asset has its raw storyboard, processed runtime sheet, non-accumulating GIF preview, gameplay capture, QA measurements and provenance manifest under `artifacts/aura-animation-canary/template-zero/`.

Frame metadata is deliberately per animation. Upright performances use 192×256 cells, `aura_one_leg` uses 256×256 for the balancing arm and held ankle, and `aura_floor_worm` uses 384×256 so horizontal anatomy is neither cropped nor globally shrunk. Phaser consumes that explicit metadata; it never guesses the grid from the filename.

The development canary is intentionally opt-in and can never enter a roster. Run Aura with `?auraCanary=template-zero` to load all six processed performances and `aura_shrug` through the real runtime. Add `&auraAutoplay=1` to watch CPU versus CPU, or `&auraCanaryMove=aura_mog_check` (using any routine animation name) to pin one performance for review. Both helpers are removed from production builds. The reproducible processor command is `npm --prefix processor run aura:canary:process -- --input <raw.png> --output <runtime.png> --qa-output <qa.json> [--frame-width 256]`.

## Commercial rollout

Do not derive Aura price by multiplying six by the existing eleven-animation Fight price. Motion complexity and frame repair differ materially. Price only after the canary and one high-motion animation have measured costs.

The creation UI should eventually offer:

- Aura only
- Fight + Rush only
- Complete player (Aura + Fight + Rush), with delta pricing that reuses already-generated identity/source views

Publishing and online rooms must declare their game mode and validate the corresponding pack. General community visibility must never imply Fight compatibility when a fighter is Aura-only.
