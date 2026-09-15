# Short Aura v25

2026-09-15. User-requested edit of v24, approved for export and publication.

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
`aura-launch-v25-edit.json`. PR 292 delivers the v25 film directly after the
other-games selector on the game landing and the game list on Play. Playback
is user-initiated, captioned, full-width, native full-screen and preload=none.

## Approved Export

- HyperFrames 0.8.40, delivery quality, 30fps, two workers; 831 frames in 46.6s.
  The summary reports screenshot capture with hardware GPU.
- Master: `renders/insert-player-launch-aura-v25-delivery.mp4`, retained locally.
- Web encode: H.264 CRF 22 slow, 1920x1080, faststart; AAC audio stream-copied
  byte-for-byte from the master. 9,543,434 bytes and exactly 27.7 seconds.
- Web SHA-256: `84e5a2b16ee73a62b810f89cf849cb5989893e4dfd7ff1066592cb46b9cd704c`.
- Versioned public MP4, WebP poster and six-cue English VTT; prior assets remain.
- `aura-launch-v25-qa.json` records actual decoded frames, loudness and file hash.
  All five character regions change throughout the selected clips; sparse-source
  keyframe warnings did not freeze the delivered footage.
- Audio true peak -4.25 dBTP, integrated -19.68 LUFS. The quiet intro handoff is
  preserved; window RMS is checked relative to the approved music source with
  allowance for its existing carve. No audio remaster or narration generation.

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
- Publication regression run: 27 tests across nine files pass, including the
  film component, placement, asset integrity and historical edit checks. The
  video tests use Vitest and checked-in historical snapshots, so shallow CI
  checkouts do not need prior Git objects. No checks are skipped for CI.
- Playwright verified both landing and Play at 1440, 390 and 320 pixels:
  immediate placement after the selector, no initial MP4 request, native playback,
  1080p decoding, six loaded captions and no horizontal overflow. Local full
  suite needs Worker dependencies absent from this media worktree; the complete
  production gate runs on GitHub with all three workspaces installed.
