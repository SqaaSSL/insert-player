# Gameplay previews

The entry screens show the mechanics and HUD of each game, including in compact Play cards.

## Aura

`auraPreviewDuel.ts` selects short phrases from the real `AuraChart`, feeds deterministic input offsets through `AuraBattle`, and exposes notes, receptors, grades, combo and scores. Both performers receive the same phrase. The demo is an abbreviated autoplay duel, not a recording of an entire match.

`auraPreviewCanvas.ts` renders the real note projection and cabinet theme using the same `AuraLayout`, `AuraHud` and `AuraCamera` as the game. Both views put the active performer on the left and the four rhythm lanes on the right. A 720 ms pan between two stage marks briefly shows both performers; the rhythm instrument remains fixed. The existing calibrated sprites and Aura Plaza v3 background are reused.

The shared HUD groups named totals, explicit lead in points, a 24px duel rail and larger crown. One status line gives round, active seat and remaining turn seconds. The instrument groups FLOW, keys and crowd response; the performer has one name and its move bubble. The same hierarchy remains visible in compact previews.

The final camera move gathers both performers in the center over 800 ms. A performer with an Aura pack celebrates with the one-leg dance (or another available routine); the loser plays the shrug once and holds its ending. Fighters without Aura assets retain their own combat victory/defeat animations. The live game shows this tableau for three seconds before results, and the recording includes it. Reduced motion skips camera travel while retaining both characters and readable results.

The latest real score delta appears as one small signed number below the active HUD score, without repeating “AURA”. A new hit replaces the previous cue. Precision feedback stays above the notes, while the original comic move icons keep the stage clear. Delayed rival judgements still update scores without replacing the active feedback.

Move bubbles have seven short synthesized sound signatures, shared with the game. The preview starts silent and offers a Sound toggle; enabling sound, resuming or scrolling back never replays an old bubble. Audio stops when paused, offscreen or unmounted. The live game includes these effects in its existing recording mix.

The normal official Trump selection now supplements missing Aura moves from his seven bundled, hash-verified atlases in either slot. Current cached Aura assets take priority. This supplement requires the canonical Arcade identity and matching public cache metadata; it never substitutes Trump for another character. Other official fighters continue to use their own available assets until they have a dedicated Aura pack.

The preview pauses offscreen, on a hidden tab, or when the user pauses it. Reduced motion shows an informative frame with an actual hit and approaching notes. Score changes are not announced on every animation frame.

## Fight and Rush

`CombatEntryPreview` plays silent, looping gameplay video with the entire frame contained in the card. It loads on first visibility, pauses when offscreen or hidden, preserves manual pause, and offers explicit playback when autoplay is blocked. Reduced motion seeks a representative action frame.

| Game | Source | Poster |
| --- | --- | --- |
| Fight | Existing real gameplay asset `public/assets/insert-player-gameplay-5a19b606.mp4` (8 seconds, 960×540) | `public/assets/play-mode-fight-gameplay-poster-v1.webp`, extracted at 2 seconds |
| Rush | `public/assets/play-mode-rush-loop-v1.mp4` (9.96 seconds, 960×540, H.264, 24 fps, 961,994 bytes) | `public/assets/play-mode-rush-gameplay-poster-v1.webp`, extracted at 8.7 seconds |

Rush was captured locally from the real Rush scene with Donald Trump, Lamine Yamal as CPU ally, Rookie difficulty, and Side Street. The recording includes movement, enemy encounters, attacks, damage, stage progression, and the canvas HUD. It contains no microphone or audio track. Automatic preview inputs use the existing virtual controls; the game still decides collisions, hits and outcomes.

To refresh Rush footage in development, select the real roster and start a Rush match, then visit `/rush?gameplayCapture=1`. The opt-in panel records ten seconds of the canvas and can save the result to `.local/captures/`. Its fixed-purpose Vite endpoint accepts only same-origin loopback MP4/WebM requests, checks the container, caps uploads at 32 MB, and generates the filename. Neither the capture component nor this endpoint is included in production.

The shipped clip is transcoded to H.264/yuv420p with fast-start metadata; its poster is extracted from that same clip. No generated illustration or recreated HUD is used for either combat preview.
