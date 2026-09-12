# Gameplay previews

The entry screens show the mechanics and HUD of each game, including in compact Play cards.

## Aura

The landing, `/games/aura` and Play use real Aura gameplay recordings. The previous Canvas demo had drifted from the shipped game: it forced a desktop layout on phones, used Nova instead of Lamine and selected moves independently of the match routine.

`GameplayEntryPreview` now uses the same media playback controller as Fight and Rush. `gameplayPreviewMedia` selects exactly one capture with `getAuraCanvasSize`, the same portrait rule as the game. Portrait footage includes the real HTML touch controls, their disabled rival state, the game HUD and the move rail. Landscape footage includes the actual DFJK instrument. The captures show Trump and Lamine taking turns with the current animations, camera, note judgement and scores. Automated inputs go through the normal controls; no synthetic scores, notes, sprites or feedback are added to the footage.

| Shape | Video | Poster | Format |
| --- | --- | --- | --- |
| Portrait | `public/assets/play-mode-aura-portrait-v1.mp4` | `public/assets/play-mode-aura-portrait-poster-v1.webp` | 432×768, 23.03s, 1,164,557 bytes |
| Landscape | `public/assets/play-mode-aura-landscape-v1.mp4` | `public/assets/play-mode-aura-landscape-poster-v1.webp` | 1024×576, 23.13s, 1,870,996 bytes |

Both were captured from gameplay source `d2c56b25c7ceff3c1ed989b5cdcd115629956662`, encoded as H.264/yuv420p at 30fps with fast-start metadata. Their posters are frames at 1s from their respective clips.

The whole frame remains visible. On a phone, the portrait frame is capped at 56% of the viewport height so the Play action follows directly below it. Both clips are silent; the menu keeps ownership of menu music. There is one preview playback control.

Only the selected visible media loads. Playback pauses offscreen and on hidden tabs. A deliberate pause survives rotation/source changes; reduced motion seeks an actual gameplay frame, with explicit playback still available. The poster comes from that same capture. The controller invalidates old play promises when changing media.

To refresh the clips after gameplay changes, commit the game source and start Vite, then run:

```bash
AURA_PREVIEW_BASE=http://127.0.0.1:5173 CAPTURE_VARIANT=portrait node scripts/capture-aura-gameplay-preview.mjs
AURA_PREVIEW_BASE=http://127.0.0.1:5173 CAPTURE_VARIANT=landscape node scripts/capture-aura-gameplay-preview.mjs
```

The harness requires Playwright Chromium, FFmpeg/ffprobe and cwebp. It captures only local free quickplay, blocks remote mutations/provider requests, validates real score progression and both turns, and writes provenance plus encoding metadata under `.artifacts/aura-gameplay-*`. Review both clips before committing them. `--encode-only` reuses validated raw frames when changing compression.

The legacy `auraPreviewCanvas` and its chart/presentation helpers remain inputs to the static social-card renderer only. They no longer render any landing or Play preview.

## Fight and Rush

`CombatEntryPreview` plays silent, looping gameplay video with the entire frame contained in the card. It loads on first visibility, pauses when offscreen or hidden, preserves manual pause, and offers explicit playback when autoplay is blocked. Reduced motion seeks a representative action frame.

| Game | Source | Poster |
| --- | --- | --- |
| Fight | Existing real gameplay asset `public/assets/insert-player-gameplay-5a19b606.mp4` (8 seconds, 960×540) | `public/assets/play-mode-fight-gameplay-poster-v1.webp`, extracted at 2 seconds |
| Rush | `public/assets/play-mode-rush-loop-v1.mp4` (9.96 seconds, 960×540, H.264, 24 fps, 961,994 bytes) | `public/assets/play-mode-rush-gameplay-poster-v1.webp`, extracted at 8.7 seconds |

Rush was captured locally from the real Rush scene with Donald Trump, Lamine Yamal as CPU ally, Rookie difficulty, and Side Street. The recording includes movement, enemy encounters, attacks, damage, stage progression, and the canvas HUD. It contains no microphone or audio track. Automatic preview inputs use the existing virtual controls; the game still decides collisions, hits and outcomes.

To refresh Rush footage in development, select the real roster and start a Rush match, then visit `/rush?gameplayCapture=1`. The opt-in panel records ten seconds of the canvas and can save the result to `.local/captures/`. Its fixed-purpose Vite endpoint accepts only same-origin loopback MP4/WebM requests, checks the container, caps uploads at 32 MB, and generates the filename. Neither the capture component nor this endpoint is included in production.

The shipped clip is transcoded to H.264/yuv420p with fast-start metadata; its poster is extracted from that same clip. No generated illustration or recreated HUD is used for either combat preview.
