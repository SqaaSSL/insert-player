# Aura-Led Launch Film, v19

## Capture

Worktree base: `f559090`. No production mutations or paid inference. All sessions
used anonymous, temporary Chromium profiles against the local Vite build with
public roster downloads. Remote non-read requests were denied.

Selected masters are preserved in the ignored `assets/captures/` directory:

| Capture | Native pixels | Selected content |
| --- | --- | --- |
| `aura-trump-lamine-v1/master.webm` | 1024 x 576 | Trump and Lamine rhythm performances |
| `aura-rosalia-trump-v1/master.webm` | 1024 x 576 | Rosalia performance |
| `rush-player-one-elon-v5/master.webm` | 1024 x 576 | Player One and Elon clear Side Street |
| `fight-player-one-trump-v2/screen.mp4` | 1920 x 1080 | Player One versus Trump, including DOM HUD |

Rush v3 was stationary and v4 was interrupted by a Vite reload. Neither enters
the cut. Fight v1 omitted the DOM HUD and is also excluded. Successful masters
were visually checked using sampled contact sheets before selection.

Fight and Rush loader logs confirm 384 x 512 atlas cells at density 2x. Aura and
Rush native-canvas captures are scaled to 1080p with Lanczos, not regenerated or
misrepresented as native 1080p. Fight's browser capture includes its actual HUD.

The approved Casual/Player One loader and one exchange from v15 are retained:
Casual was not available in the anonymous public roster during this recording.
All other excerpts are new. Exact ranges/hashes are in the adjacent cuts JSON.

## Local CPU Instrumentation

During the successful Rush capture, a temporary DEV-only input switch selected
the existing companion AI for P1, and public asset downloading kept HD sources.
Those changes were restored immediately after recording; both product files
have zero diff. There is no new CPU-vs-CPU option in the shipped game.

For future recordings, `scripts/capture-three-games.mjs` applies these two hooks
only to local module responses in its isolated browser. Source code and other
browsers remain unchanged. The hook fails if its exact source anchor changes.
Use a localhost Vite build and explicit names in CAPTURE_P1/CAPTURE_P2. New
CAPTURE_ID values preserve earlier recordings. Do not edit the app during capture.

## Rebuild

1. Run the capture script with CAPTURE_MODE aura/fight/rush and a new CAPTURE_ID.
2. Select real active gameplay visually, preserving private full masters.
3. Update the version and edit decisions in `build-three-games-montage.mjs`.
4. Run `build-aura-launch-audio.mjs` with the private original Neon Arena path.
5. Run the HyperFrames audio carve, `npm run check`, then render a new version.
6. Encode the web asset with H.264/AAC and faststart. Verify the picture, sound,
   duration, HTTP range playback, mobile layout and no unsolicited video download.

Intro and closing sub-compositions are unchanged. The old published MP4s,
original montage and historical audio remain in place. No asset is deleted.

## Verification

- HyperFrames 0.8.34: full check passes with zero errors and zero warnings.
  Two informational overflow notices belong to the unchanged animated intro.
- Render: 1085 frames, 1920 x 1080, 30 fps, 36.166667 seconds, H.264/AAC.
- Web asset: 9,431,265 bytes, faststart, CRF 25, 2-second keyframe interval.
  SHA-256: `4c4cdfc303480829acabd37df87d2af8446e25472179b29db0631624d1405009`.
- Build and frontend style guard pass. All 372 UI tests plus the versioned
  asset test pass. Existing bundle-size warnings remain unchanged in scope.
- Playwright at 1440, 390 and 320 pixels: no horizontal overflow, zero film
  requests before play, successful decoding/seeking, captions and native controls.
- Final encoded Fight/Rush/Aura each have 10 distinct sampled frames out of 10;
  no frozen section. The closing audio remains audible through the reading hold.
- The standalone browser-only Rush capture hook was rechecked after restoring
  all product-code instrumentation, including clearing the opening obstacle.

The current change is prepared locally for review, not deployed to production.
