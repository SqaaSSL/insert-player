# Shared Fight / Aura body calibration

## Contract

An atlas cell is storage geometry, not character height. Aura now takes the
visible idle body height and physical bottom from `FighterView`, including the
same idle presentation profile, stage scale, root offset and texture density
used by Fight. The reference never depends on the currently playing action.

For a reviewed pose, `expectedHeight = displayedIdleHeight * poseHeight /
templateStandingHeight`. Each source frame can receive a different isotropic
correction to cancel input zoom. This does not force a crouch, a prone body or
an extended limb to have standing height.

`PoseFrameCalibration` provides the pure registration/audit contract. Source
alpha bounds are measured at threshold 32. Offsets retain the authored target
motion relative to its standing root. Horizontal normalization is an explicit
choice, never an automatic width-fit that shrinks a fighter to fit its cell.
Clipped/invalid inputs are rejected; secondary shape deviations remain warnings
even when the fitted height is exact. Temporal audits compare residuals against
each intended pose, including the loop closure, rather than raw height changes.

## Current integration and preservation

- Calibration is calculated once when loading the Aura pack, before playback.
  Playback applies the resulting transform; no per-tick pixel scan is added.
- The 7 Template Zero and 7 Trump atlases have exact byte-hash-bound references
  in `AuraPoseTemplates.ts`, including documented standing reference frames.
  Every action normalizes to the same displayed idle body height.
- Unknown/newly generated packs receive only a shared idle baseline. They never
  inherit a known character's pose curve merely because the animation name or
  frame count matches. Their own reviewed pose contract must be added before
  enabling pose-specific corrections.
- Original PNGs, generation inputs, stored atlases, database records, providers,
  combat simulation, timing and hitboxes are unchanged. These corrections are
  not baked into downloaded PNGs or gallery previews in this change.
- Trump `aura_one_leg` previously began in the ankle-grip pose while its target
  began neutral. Its existing neutral recovery frame 8 is reused at entry, with
  the same target and scale at both ends. There are still eight timing slots.

The pure registration functions can be used by offline compilers before
packing too. That is not yet wired into all generation/export pipelines; do not
claim all future generations or downloaded assets have been recalibrated.

## Verification

Run `node --experimental-strip-types scripts/audit-aura-pose-templates.mjs` after
installing the processor dependencies. The read-only audit verifies the actual
14 PNG hashes, 56 template bounds, neutral references and 112 projected frames
(Template Zero plus Trump), using an independent desired height of 200 pixels.
It checks height, silhouette center, vertical bottom and temporal closure. A
silhouette-center match does not prove a weighted horizontal foot-root match.

Unit tests cover per-frame zoom, a 95% pose ratio, crouches, jumps, wide/prone
poses, mirroring, 1x/4x density, unknown hashes, corrupt geometry, source-frame
reuse and the stable Fight idle reference. A passing size audit is not an
anatomy/identity/semantic quality approval.

## Remaining visual review

Trump floor-worm frames 2 and 7 retain independent width/shape warnings. Height
registration cannot repair generated anatomy. The deliberately exaggerated
mog-check lean/face remains authored motion. The one-leg source was already
ground-registered, so this patch does not invent an airborne trajectory.

The local Francisco preview still has 13 combat animations and uses the combat
fallback in Aura; it does not yet have a generated Aura pack. Trump has its 7
Aura performances. No deployment or paid inference is part of this fix.
