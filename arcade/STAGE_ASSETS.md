# Signature stage assets

The original OpenAI ImageGen backgrounds are immutable visual seeds for the official Arcade roster. Each active background was created by feeding its seed through Insert Player's own photo-stage pipeline, then normalized to the game's 1024 x 576 logical viewport. Seeds and active outputs remain checked in side by side; upgrades never overwrite an earlier version.

| Arcade fighter | Stage | Immutable seed | Active pipeline output |
| --- | --- | --- | --- |
| global | Insert Player Arena | `/assets/stages/signature/insert-player-arena-seed-v1.png` | `/assets/stages/signature/insert-player-arena-pipeline-v1.png` |
| `donald-trump` | Executive Rumble | `/assets/stages/signature/executive-rumble-v2.png` | `/assets/stages/signature/executive-rumble-pipeline-v1.png` |
| `elon-musk` | Mars Incorporated | `/assets/stages/signature/mars-incorporated-v1.png` | `/assets/stages/signature/mars-incorporated-pipeline-v1.png` |
| `rosalia-v2` | Tablao 3000 | `/assets/stages/signature/tablao-3000-v1.png` | `/assets/stages/signature/tablao-3000-pipeline-v1.png` |
| `lamine-yamal` | La Jaula 304 | `/assets/stages/signature/la-jaula-304-v1.png` | `/assets/stages/signature/la-jaula-304-pipeline-v1.png` |

## Seed contract

Shared direction for every prompt:

> Use case: stylized concept. Asset type: final 2D fighting-game stage background PNG. Premium hand-painted 2.5D arcade environment art. Exact wide 16:9, side-on fighting-stage composition. Keep the lower 30% as a readable fighting floor, the ground/contact line around 83% of the frame, a clear center lane for two fighters, and the top 18% quiet enough for the HUD. No people, readable text, logos, UI, borders, signatures, or watermarks.

Stage-specific direction:

- **Insert Player Arena:** The launch film's red-corner/blue-corner truss arena, with main-event lights, distant spectators, an empty center lane, and a rain-slick tournament floor. The generated output's two invented pseudo-text signs were converted deterministically into blank LED panels after review; raw, pre-clean, and final versions remain archived.
- **Executive Rumble:** The White House South Lawn at night under a bright moon; an official helicopter parked at frame left, press bleachers and floodlights at frame right, loose papers in the air, an elegant but faintly chaotic political-showdown mood, and a broad stone-and-grass fighting plane.
- **Mars Incorporated:** A spectacular first permanent Mars colony at sunset; tall launch vehicle at frame left, futuristic habitat and communications complex in the middle distance, exploration rover at frame right, a ringed planet in the sky, red mountains, and a wide metallic landing pad as the fighting plane.
- **Tablao 3000:** A theatrical flamenco tablao fused with a custom motorcycle workshop; deep red velvet curtains, timber and brick, warm spotlights, roses, tools and wheels on the side walls, motorcycles parked only at the far edges, and an empty polished wooden dance floor.
- **La Jaula 304:** A fenced Mediterranean neighbourhood football court at golden hour; dense apartment terraces and laundry behind it, blank dark scoreboard over a small goal, faded geometric murals and bunting, and a wide empty concrete court with strong perspective and no players.

The Executive Rumble source received one ImageGen cleanup pass to remove a spurious corner signature. Its delivery derivative was then cropped slightly at the bottom and sides. All four sources were center-cropped where necessary, resized to 1024 x 576, stripped of metadata, and losslessly encoded as PNG. Original ImageGen outputs remain outside the repository in the local generated-image store.

`executive-rumble-v2.png` rotates only the immutable public cache key after a pre-publication fallback response was cached at the original URL; its reviewed image bytes are unchanged.

## Insert Player pipeline pass

The active `pipeline-v1` files were produced on 2026-08-28 and 2026-08-29 by the same product path used for an uploaded photo stage:

- operation `stage_background` with `gemini-3.1-flash-image`;
- `geminiStageBackground` with `sourceMode: 'transform-scene'`;
- the stage's production label and blurb from `StageConfig.ts`;
- product normalization with `bottomShadeAlpha: 0.04` and `verticalBias: 0.92`;
- lossless removal of the fully opaque alpha channel after generation.

The transform preserves the seed's location and composition while reinterpreting it as stylized 2D fighting-game art with a readable side-on floor. The exact seed and output hashes are pinned in `arcade/signature-stage-pipeline-2026.json` and verified by CI.

Insert Player Arena additionally carries a reviewed `interpolate-empty-panels-v1` cleanup in its sealed request. It samples the clean top and bottom rows of each generated sign panel and interpolates only the two bounded interiors. This removes provider-invented glyphs without another inference or any change to the arena floor, lighting, crowd, or truss geometry. Its provider raw, rejected pre-clean normalization, final output, workflow ids, and estimated cost events are pinned in `arcade/generated/stages/insert-player-arena-pipeline-v1.provenance.json`.

## Publishing another official stage

Unpublished seeds live under `arcade/stage-publication-seeds/`, outside the public asset tree. A sealed request in `arcade/stage-publication-requests/` pins its label, blurb, source hash, approved model, output dimensions, and normalization contract.

Run **Generate production signature stage** with the exact `GENERATE_ONE_STAGE_PRODUCTION` confirmation. The production-environment job:

- verifies the live Worker is healthy and reports `geminiTransport=meterkey`;
- exercises Chromium decoding, the exact Canvas normalization, and `ffmpeg` PNG encoding before creating a provider session;
- mints a short-lived Clerk token from environment secrets;
- obtains a `stage_background` provider session capped at one call and 10 estimated cents;
- sends the shared product prompt to `gemini-3.1-flash-image` exactly once, with no retry, fallback, resubmit, or alternate model;
- uploads any available provider or normalized output even when a later review gate fails;
- preserves both the provider output and the normalized 1024 x 576 PNG in an immutable review artifact, alongside hashes and provenance.

Generation does not publish. After visual review, commit the seed and active derivative together, append both hashes to `arcade/signature-stage-pipeline-2026.json`, and add the versioned active path to `StageConfig.ts`. Existing versions remain immutable.
