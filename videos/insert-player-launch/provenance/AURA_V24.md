# Alternating Aura v24

2026-09-14. User-requested edit of the approved v23 preview. Not a production export.

- Aura opens with ten 1.6-2s shots, strictly alternating Trump and Rosalia.
- Both perform five distinct moves. Every selected frame is active; none is
  a countdown/rest pose or a repeat of another selected source frame.
- Native HyperFrames source trims use the retained, byte-identical v23 capture,
  now tracked as `assets/aura-active-hud-v23-source.mp4`. No re-encoding of picture.
- Fight/Rush montage, intro and end-card design remain unchanged.
- No Aura reprise after Rush. The closing reveal begins at 31.9s, overlapping
  the final 0.25s of Rush, and the five-second closing ends at 36.9s.
- The v22 voice is edited at silence: keep [0,31.9), then [35.15,40.15).
  This removes only the return-to-Aura sentence and advances the brand close.
  The PCM regression proves all retained speech samples are identical.
- Voice is frozen as a derived WAV before running the standard carve script:
  its current decoder ignores `data-media-start` and `data-duration` on split
  audio tags. Feeding the exact audible PCM avoids analysing deleted speech.
- The same original Neon Arena stem runs from zero without a splice or loop.
  Preserve voice gain 0.82, music gain 1 and carve strength 0.25. Only the last
  0.3s has a terminal volume fade; no long closing fade or extra music tail.

`build-aura-launch-v24.mjs` writes immutable audio, frame-movement provenance and
captions. Rebuilding refuses to overwrite existing outputs. The original capture
metadata stays retained under `assets/captures/aura-active-hud-v23/`.

No inference, new gameplay recording, roster mutation or production deployment.
After preview approval: export the final film, update the landing's media
references, finish the delivery PR and verify the deployed release.

## Verification

- Ten v22/v23/v24 regression tests pass, including exact retained speech PCM,
  disjoint source ranges, strict performer alternation and continuous music.
- HyperFrames 0.8.40: zero errors/warnings across 16 sample times; 9/9 contrast
  checks pass. Three informational entrance findings belong to the unchanged
  intro/end-card choreography.
- Nine snapshots inspected: both Aura identities/moves, Fight, Rush and the
  five-second ending. No black media, missing portraits or text collisions.
