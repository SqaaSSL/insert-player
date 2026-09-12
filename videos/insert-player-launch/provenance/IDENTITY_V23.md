# Identity And Active Gameplay v23

2026-09-12. Preview only; not exported to the landing or deployed.

## Approved Material Preserved

- Duration: 40.15 seconds, identical to v22.
- Voice, music, audio tags, gain, carve and automation: byte-identical to approved commit `1cc0ba6`.
- Intro transformation and five-second ending: unchanged.
- Aura: still 21.5 seconds, opening and closing the gameplay story. Fight and Rush remain optional extras.
- The approved Casual/Player One loading curtain and one-second exchange are retained. That one-second exchange is legacy footage, not claimed as a new capture.

## New Picture

Gameplay was recorded against `codex/player-identity-hud`, based on main `4116c27`, not the older game build inside this video worktree. The completed HUD implementation is committed as `d187b69`. The companion game change enlarges actual names and uses share-safe head/shoulder portraits in Aura, Fight and Rush. It does not expose original user photos.

The anonymous capture browser only permits remote GET/HEAD/OPTIONS. Its local-only instrumentation exposes the game object and drives Rush's first player using the existing companion CPU. No CPU+CPU mode is shipped, no private browser profile is used, no generation or payment is invoked.

Each recording advances the actual game's RAF/timers by 1/30 second and waits for a complete screenshot. Aura uses the existing silent wall-clock fallback so WebAudio time cannot race the screenshot loop. Its chart, inputs, scoring and movement logic are unchanged. No interpolation or playback acceleration is applied.

Source capture directories, retained locally under `assets/captures/`:

- `aura-active-hud-v23`: 34 seconds, Trump/Rosalia, full per-frame actor state.
- `fight-review-hud-v23`: five seconds, Player One/Trump on Executive Rumble.
- `rush-review-hud-v23`: seven seconds, Player One with Elon as CPU ally.
- Earlier `*-hud-v23` / `*-final-hud-v23` takes remain preserved as review history, not silently overwritten.

The seven opening Aura excerpts and reprise are audited against the active performer's animation and frame index, not background motion. Every excerpt contains at least six distinct poses. The longest retained held pose is under 0.5 seconds; the brief return to rest is under 0.3 seconds. Turn countdowns and multi-second waiting are excluded.

`identity-gameplay-v23-review.json` records cuts, source/output hashes and movement evidence. `build-identity-gameplay-v23.mjs` reconstructs the three picture-only assets from these retained takes. `capture-identity-gameplay.mjs` is the reusable local recording/viewport QA runner; set `CAPTURE_GAME_DIR` and `CAPTURE_URL` to the game checkout and its local server when using another workspace.

## Lamine

An isolated canonical Spain-kit clothing proposal was generated with the built-in image editor in the companion game worktree. It is not a playable or published skin. Lamine is omitted from this preview while that clothing/animation decision awaits visual approval. No existing Lamine assets were deleted or replaced. No Player Zero or Casual Aura pack was generated.

## Verification

- Six video regression tests pass: approved audio/intro integrity, primary-game hierarchy, duration, picture-only media and performer motion.
- HyperFrames 0.8.35 check: zero errors/warnings, all eight contrast checks pass. Two informational entrance findings at 2s belong to the unchanged approved drag/drop intro.
- Intro, both Aura performers, Fight, Rush and ending snapshots inspected.
- Studio on port 3005 inspected in a fresh browser: three v23-review video sources loaded alongside the unchanged v22 voice and original music.
- Game worktree: 2,583 tests pass (six skipped), 19 processor tests pass, build and `check:production` pass. Desktop 1920x1080, mobile 844x390, 390x844 and the rotated Fight shell were inspected.

No production deploy, roster mutation, new animation batch or final MP4 publication has occurred.
