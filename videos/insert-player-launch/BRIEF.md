---
workflow: product-launch-video
flow: automation
storyboard: no
message: "A real person can become a recognizable, playable arcade fighter"
destination: website-embed
aspect: 1920x1080
language: en
audience: "Nostalgic players, friend groups, creators, and anyone arriving from a shared link"
length: 12s
angle: "Photo to fighter to real gameplay"
narration: "One short arcade-announcer line"
---

## Intent

Launch Insert Player with the shortest possible proof of the product: begin with
a real portrait, transform that same person into a premium arcade fighter, then
cut into a genuine browser match. The piece should feel like a cabinet waking up,
not like an AI avatar advertisement or a software walkthrough.

## Assets

- `../../public/assets/social-card-v7.jpg` - approved transformation concept and visual reference.
- `assets/transformation-visual.png` - frozen, clean photo-to-fighter source visual.
- `assets/generated/player-one-photo-start.png` - deterministic 16:9 start frame built from the exact source portrait.
- `assets/generated/player-one-upright-canonical.png` - exact approved production upright cutout for Player One.
- `assets/generated/player-one-final-frame.png` - deterministic arena composite using that exact cutout.
- `references/neon-arena-creative-fingerprint-v1.json` - private-reference fingerprint derived from the supplied Suno track; the source MP3 is not distributed.
- `assets/generated/launch-mix-original-neon-gameplay-v3.wav` - hybrid mix preserving the approved `Ready... Insert Player` opening and introducing the user-supplied `Neon Arena` recording at the gameplay cut.
- `assets/generated/tts-announcer-v1.wav` - private Gemini TTS announcer line.
- `assets/generated/omni-photo-to-fighter-v2-neon-sync.mp4` - private Omni timing canary, retained for audit but rejected from the final cut because its target was not the immutable global Champion frame.
- `assets/fight-montage-four-stages-hd-lowfix.mp4` - four telemetry-trimmed, one-second production matches captured from the Champion 2x atlas, with the Elon cut recorded after the legacy low-attack presentation fix.

## Customizations

- Borrow the structural idea from Hilo's product promos: real footage, a few crisp branded action beats, and a strong end card.
- Preserve the approved opening mix and Gemini TTS announcer unchanged through `4.65s`. Start the user-supplied `Neon Arena` recording from its beginning exactly when gameplay enters, retaining the cabinet fight SFX above it.
- Keep the private full-length recording outside the repository. Publish only the `7.35s` gameplay excerpt embedded in this approved twelve-second launch cut.
- Keep the transformation literal and readable: `YOUR PHOTO`, the official P1 + `INSERT PLAYER` reveal, then `YOUR FIGHT`.

## Notes

- Use Insert Player branding only: P1, cabinet black, coin red, coin gold, CRT cream, and glass blue.
- Never reproduce Hilo's logo, purple palette, typography, wording, action pills, or other proprietary brand elements.
- Show real gameplay and real generated fighters. Do not fake a fight in motion graphics.
- Keep the production gameplay proof to four one-second cuts and feature the same Player One shown in the transformation across all four signature stages.
- Capture desktop gameplay with an explicit 8 GB capability profile and retain the loader logs proving that Player One used 384x512 atlas cells at density 2x.
- Avoid franchise imitation, cartoon exaggeration, generic AI language, and slow cinematic choreography.
- Generated media is private and single-candidate: no automatic retries, fallbacks, or publishing.
- A generative transition may enter the final cut only when it preserves the exact global Champion. The current Omni v2 canary did not pass that gate, so the deterministic transformation remains authoritative.
- Respect reduced-motion in the website hero even though the rendered promo itself is energetic.
