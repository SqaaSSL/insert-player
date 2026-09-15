# Aura Farming Film v21

2026-09-12. Local review; not deployed. The user requested a fluid replacement
for the jump/red-impact Fight excerpt, more Aura screen time, and respectful
copy explicitly about farming Aura.

## Picture

- The old Trump capture was encoded at 30 fps but its selected source interval
  had only 25 screencast captures in 2.6 seconds (9.6 distinct captures/second).
  This was capture loss, not a lack of paid high-resolution fighter assets.
- Re-recorded Player One versus Trump on Executive Rumble from this worktree's
  real browser game. Playwright advances the simulation by one 30 Hz frame and
  waits for each PNG to finish before advancing again. No interpolation, game
  code changes, paid generation or production mutations.
- New master: 240 PNGs / 8 seconds, 1920x1080; selected 2.4-4.5 seconds includes
  the jump, landing and close exchange, excluding the old red counter scene.
- Both Trump excerpts now use the fresh capture. The approved Casual versus
  Player One loader and one-second exchange remain, preserving intro continuity.
- Aura's main block grows from 13 to 18.5 seconds. With its 1.4-second teaser,
  Aura occupies 19.9 seconds of the 40.15-second composition (+5.5 seconds).
  Trump, Rosalia and Lamine get distinct longer passages showing flow and score.
- The existing Aura/Rush masters are 1024x576 canvas captures, upscaled for
  the 1080p composition, not newly recorded native-1080p gameplay.
- Approved intro and five-second closing card remain intact. Every old asset
  remains available. Source hashes and ranges: `aura-launch-v21-cuts.json`.

## Voice And Music

- One new Orus take, Gemini TTS via PixCLI/Meterkey; no retries or fallback.
  Job: `232562298667e1487b69dcd31b3bb246`. Raw, matched audio, transcript,
  prompt hash and durable submission journal are retained.
- Copy: "This is Aura farming. Hit the beat. Build your flow. Stack up Aura.
  Challenge your friends. Take the lead. Own the spotlight. Give the group chat
  something to talk about." No mocking descriptions of the moves or players.
- Actual approved intro, Fight/Rush narration and closing are reused at original
  speed, with the new take matched to their measured loudness. Timings and
  captions are in `aura-launch-v21-cues.json`.
- Neon Arena uses 35.5 consecutive seconds of the original private MP3 after
  the approved intro, without looping. The private source is not committed.
- Recomputed HyperFrames voice carve, explicitly preserving strength 0.25.
  The current helper defaults to 0.8, so the build must not rely on its default.

## Verification

- HyperFrames upgraded from 0.8.34 to 0.8.35; check passes: zero errors,
  warnings or layout issues, 8/8 contrast checks. Five snapshots inspected.
- Animation-map diagnostics were inspected: repeated child timeline entries
  and authored intro/closing reveal overlaps; gameplay-only spans naturally
  contain no GSAP motion. Do not treat those spans as frozen video.
- Final H.264/AAC: 1920x1080, 30 fps, 40.17 seconds, 9,980,852 bytes.
  The chosen delivered Fight segment contains 63 distinct decoded frames.
- Final mix: -18.98 LUFS, -4.24 dB true peak. Eleven one-second windows across
  narration, gameplay and closing pass dropout/clipping checks. Local transcript
  confirms farming/friend competition and no mocking language. ASR slightly
  mishears "in Fight" and "Own the spotlight"; authored captions use the copy.
- Six component/asset regression tests, two mock-only submission recovery tests,
  build and frontend-style checks pass. Existing bundle/import warnings remain.
- Browser QA at widths 1440, 390 and 320: correct 40.17-second video, nonblank
  decoded picture, captions, no overflow, no download before opt-in playback.
- `scripts/verify-aura-launch-v21.mjs` regenerates final hash/audio/cadence QA.
  It trims by frame index to avoid fractional-seek frame-count ambiguity.

## Recovery And Preview

Capture master/metadata, final render and web video are also preserved outside
the worktree in `.media-archive/insert-player-launch/aura-v21/` under the main
checkout. Original PNGs remain in this worktree's ignored capture directory.

Studio: port 3005, project `insert-player-launch`, revision `aura-farming-v21`.
Landing local preview: port 5189. No production deployment or payment testing.
