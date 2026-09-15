# Short Aura v25

2026-09-15. User-requested edit of v24, pending final export review.

- Aura: 18.5s -> 9.3s. Total film: 36.9s -> 27.7s.
- Five unique actions with no repeated source ranges or resting frames.
  Rosalia opens with Six Seven and closes with floor worm. Trump appears in
  two short shots; Rosalia also performs mog check. No complete-turn blocks.
- All gameplay uses native HyperFrames trims of the exact existing v23 master.
  No new capture, provider calls, image edits or lossy intermediate files.
- Intro, nine-second Fight/Rush block, closing design and five-second hold
  remain intact. Rush leads directly to the closing with a 0.25s overlap.
- Voice preserves the actual approved samples at natural speed. Keep photo,
  character, farming Aura, friends challenge, Fight, CPU-ally Rush and the
  announcer close. Remove the beat/flow/stack and group-chat sentences.
- Four retained voice ranges are cut in source silence. A 3.55s speech pause
  leaves room for the music and action before the optional-game explanation.
- Freeze audible voice PCM for the carve decoder, as in v24. Recalculate the
  approved 0.25-strength carve; keep voice 0.82 and music 1. Original Neon Arena
  stays continuous, without a loop, with only a 27.4-27.7s terminal fade.
- `build-aura-launch-v25.mjs` refuses to overwrite the voice, manifest or VTT.
  v24 remains preserved in Git, its assets and historical regression tests.

The exact timings, hashes, movement counts and captions are recorded in
`aura-launch-v25-edit.json`. The landing still references the older exported
film until this preview is approved, rendered and integrated through PR 292.

## Verification

- Fourteen v22-v25 regression tests pass, including exact retained voice PCM,
  silent edit boundaries, five different moves and continuous music.
- HyperFrames 0.8.40 check: zero errors/warnings across sixteen sample times,
  9/9 contrast checks pass. Two informational findings are on the existing intro.
- Eleven snapshots inspected, including Six Seven, floor worm, Fight, Rush and
  the finished closing card. No blank footage or missing identity HUDs.
- Animation map confirms 27.7s total and the closing reveal at 22.7-22.95s.
  Its offscreen flag is the intentional horizontal reveal; its static spans
  describe GSAP only, while the underlying gameplay remains moving video.
