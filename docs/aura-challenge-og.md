# Aura challenge social image

`aura-versus-v2` uses the same red/blue cabinet composition as the Fight invitation: a character on the left, the Insert Player / VS lockup in the centre, and the recipient's P2 challenge on the right. The shared styles live in `worker/src/arcadeChallengeOgStyles.mjs`; Fight's rendered PNG is byte-identical after extracting those styles.

The chosen public name and score are rendered for each challenge. Long names wrap to two lines and large scores scale down. The right side says `YOUR TURN`, `BEAT MY AURA`, and `SAME SONG · SAME MOVES · PLAY FREE`. This is an asynchronous friendly score challenge, not a live room or a verified leaderboard result.

## Artwork provenance

- Bundled file: `worker/src/assets/aura-six-seven-og-v2.png`.
- Exact source: `artifacts/aura-animation-canary/donald-trump/aura_six_seven/champion/processed/authored-2x/rightHandHigh.png`.
- SHA-256 for both files: `407257c2c8e4cc3653e0da07c2f5a2168db4cdbb279f304c3e4fd79954fc382f`.
- Dimensions: 768×1024, original alpha preserved, no pixel edits or new generation.
- This is a high-resolution source frame of the game's existing 6–7 choreography. It is representative Aura artwork. The token does not include the sender's fighter identity, and the card does not claim this is their private fighter.

The Hilo plugin was inspected during exploration. The selected direction directly reuses Fight's existing composition and reviewed game artwork; no Hilo generation, upload, remix, or associated cost was incurred.

## Delivery and validation

The existing `/challenges/aura/<token>/og.png` endpoint renders a 1200×630 PNG. The cache and metadata image version are `aura-versus-v2`. The PNG is bundled with the Worker and supplied through a fixed `asset://` image source, so cold requests do not require frontend assets, external image calls or access to player media. The public transport and playable challenge are unchanged.

Only bundled fonts are used. Names remain literal text; emoji may show a missing glyph with the existing Latin fonts, while the exact chosen name remains in the share-page metadata.

Run `node --experimental-strip-types scripts/render-aura-challenge-og-preview.mjs /tmp/aura-og.png Alex 12500` for the same render used in production. The integration suite renders ordinary, long, hostile-looking and emoji names with real image/font bytes and asserts that no network fetch occurs. Visual review also covers zero and maximum-safe-integer scores.
