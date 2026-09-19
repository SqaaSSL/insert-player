# Restored Photo OG

Visually approved for publication by the owner on 2026-09-19. Repeated full-card
AI edits had changed the left photographic face in v11. This version restores
the earlier matching-jacket photograph without generating another image. The
two game poses, lettering, stage and divider retain the approved v11 design.

- Input: `scripts/assets/social-card-photo-aura-fight-v12.jpg`.
- Public JPEG: `/assets/social-card-v12.jpg`, 1200x630, 158691 bytes.
- JPEG SHA-256: `ea23c4320d2fc8dccc9e7f974a5d23af8e9c9672de880062f46a478d5ffe80ba`.
- Optional WebP: `/assets/social-card-v12.webp`, derived from the reviewed JPEG.
- Portrait: `videos/insert-player-launch/assets/generated/player-one-photo-matched-v1.png`.
- Portrait SHA-256: `2fc3c2d7cdb7b013c12564da947d0d1a35d8e9f67d48efe6ff445c9d8abe5605`.

The restoration used a native Canvas composition, not another image-model pass.
The preserved 1672x941 photo was scaled uniformly by 630/941 and translated by
-182 source pixels horizontally. It replaced x=0..372; x=373..387 blended only
the wall beside the divider. The lossless master was checked pixel-by-pixel:
the opaque portrait matches its resized source and x>=388 matches the decoded
v11 card exactly. Those exact pixel comparisons precede lossy JPEG/WebP encoding.
The old black-T-shirt original and every previous card remain preserved.

`npm run brand:rasterize -- --social-only` ships the reviewed JPEG byte-for-byte
after checking its hash. It encodes only the optional WebP. Tests pin this JPEG,
the portrait source and the previous v11 JPEG, along with dimensions, byte budget
and consistent metadata/deployment defaults. Gameplay changes must not redraw
this artwork. Future creative edits require a new reviewed, versioned asset;
keep the photographic portrait as a separate protected layer.
