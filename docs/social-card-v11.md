# Photo-to-Character OG

Approved by the owner on 2026-09-19: a photo becomes the same character in two
poses, six-seven and a high kick. This restores the transformation concept while
retaining Aura Plaza, without lanes, scores or a gameplay HUD.

- Source: `scripts/assets/social-card-photo-aura-fight-v11.jpg`.
- Published JPEG: `/assets/social-card-v11.jpg`, 1200x630, 280083 bytes.
- JPEG SHA-256: `f27111d43d5448e8627cd3435ae1ccd07704db45ac3697ef1b227bcc9bc144c6`.
- Optional WebP: `/assets/social-card-v11.webp`, 1200x630, 101008 bytes.

The artwork was edited with built-in image generation using the existing
synthetic Player One photograph, matching canonical character and Aura Plaza.
The final pose correction used the second top-row frame of the game's
Rosalia six-seven sheet as a pose-only reference, followed by restoring Player
One's full-length jacket and gloves. This is marketing artwork, not a literal
runtime screenshot or a new playable character asset.

`npm run brand:rasterize -- --social-only` checks the approved source hash and
copies the reviewed JPEG byte-for-byte. Only the optional WebP is encoded.
Gameplay/HUD changes must not regenerate or replace this approved composition.
Old raster cards and the previous gameplay template remain preserved.

For a future design, obtain visual approval and use a new versioned filename;
do not overwrite an immutable published URL. Update OG/Twitter metadata, alt
copy, production workflow defaults, fallback previews and the regression tests
together. The embedded bitmap lettering requires artwork review if the brand
ever changes; editing the historical HTML template does not rebrand this image.
