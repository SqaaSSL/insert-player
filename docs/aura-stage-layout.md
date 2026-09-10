# Aura stage presentation

Aura has its own composition, independent of Fight's two-fighter camera.

## Layout contract

- Desktop: 1024 × 576 logical canvas; the active performer owns the left stage and the four rhythm lanes stay on the right. A 720ms camera pan shows both bodies during the handoff, then settles on the next performer. The finale gathers both in the center for celebration and defeat.
- Narrow portrait viewports: 576 × 1024 logical canvas; the active performer is above the highway and the waiting performer is hidden. Touch targets align with the four lane centers and remain at least 44 CSS pixels tall.
- The viewport resizes the existing game. It must not restart the chart, clock, recording, or network session. Paused notes are reprojected using the frozen music time.
- Performer framing scales the calibrated rig from its idle reference once per layout (or portrait role). It never normalizes each animation frame's visible height. Aura suppresses combat simulation root travel, while preserving authored pose offsets.
- The active floor ring is ordered before both performer containers. Sprite tint/flash effects remain disabled; feedback uses separate floating comic elements.

## Visual hierarchy

1. Duel: the upper 128px (160px portrait) holds both named scores, a 24px balance rail, a fixed tie marker and a 28×32 gold crown. The actual lead is written in points; the rail is not presented as a percentage. `AuraHud` supplies the same data, geometry and drawing to the live game and miniature.
2. Performance: one name above the active body, with the move bubble beside it. The name waits for the camera handoff to settle so it never labels the outgoing actor. The score's latest small delta remains under the HUD total, outside the stage.
3. Rhythm: one instrument contains lane heading, FLOW combo, receptors, keys, control hint and crowd response. The continuous hit line and stronger panel distinguish this interactive area from the scenery. Portrait moves the compact crowd meter into the header, between the lane heading and FLOW, clear of the touch buttons in the footer.
4. Turn: one status line gives round, active seat and seconds remaining. Precision feedback stays directly above the notes. Camera movement never moves the instrument.

Aura Plaza v3 keeps the approved crowd scale and floor, with the nearby spectators looking toward the camera. Previous stage versions remain available to pinned challenges.

## Loading contract

Aura requests processed `uprightViewBlob` portraits only. A missing upright portrait falls back to initials, never an original reference photo or side-view asset. Existing Fight/Rush portrait preferences are unchanged.

Each scene initialization creates a presentation token. The React curtain handles loading, ready, and error states for that token. The match clock and recording start only after the ready curtain has left the DOM. Rematches repeat this handshake, and online readiness cannot bypass it.

## Validation and scope

Covered by scene lifecycle/layout tests, portrait and loading tests, responsive canvas tests, and touch geometry/input tests. Browser checks include desktop and portrait loading, active/inactive framing, floor layering, pause and orientation changes, and a completed match with a playable MP4 after rotation.

This change does not regenerate sprites, alter source PNGs/calibration, or change the site's fonts. It preserves the existing local match-video sharing workflow. Aura requires complete dedicated performance packs at selection and loading; presentation improvements do not supply missing animation assets.
