---
workflow: product-launch-video
flow: automation
storyboard: no
message: "A real person can become a recognizable, playable arcade fighter"
destination: website-embed
aspect: 1920x1080
language: en
audience: "Nostalgic players, friend groups, creators, and anyone arriving from a shared link"
length: 36.15s
angle: "Keep the approved photo transformation, then prove three real games with Aura as the main attraction"
narration: "A concise product explanation ending with the arcade-announcer lockup"
---

## Current Revision: Aura Audio v20 (2026-09-11)

The user requested narration matching the new length and three-game story.
All v19 picture edits, intro, end card and original Neon Arena music remain
unchanged. Preserve the actual approved intro and closing Orus recordings.
One new Gemini TTS / Orus take explains Fight, CPU-ally Rush and Aura's rhythm,
playful moves and rivalry with friends. Split it at natural sentence boundaries
to match the game blocks, with no speed changes. Aura carries the longest read.

- 36.15-second mix; nine speech cues in `provenance/aura-launch-v20-cues.json`.
- Raw take, submission journal, hashes, local transcript and loudness measurements
  are retained. One paid TTS request, no retries or fallback; no image/video calls.
- `launch-voice-aura-v20.wav` replaces only the voice. Recompute the music carve.
- New versioned MP4 and captions; keep v19 and every source asset intact.
- Preview only until the user approves publication.

## Previous Revision: Aura v19 (2026-09-11)

The user asked to restore the film to the current landing and record new Aura,
Rush and Fight gameplay, with substantially more attention on Aura. This section
supersedes the earlier v15 edit notes retained below for provenance.

- Keep `01-transform.html` and `03-insert-player.html` unchanged.
- Three-second teaser, a six-second Fight block, 4.5 seconds of Rush, then a
  thirteen-second Aura block with Trump, Rosalia and Lamine.
- Retain the approved 2.4-second Casual/Player One loading curtain and their
  one-second exchange. The remaining gameplay is recorded from `f559090`.
- Keep the original approved speech. Move its Fight sentence to the Fight block
  and its closing line to the five-second end card. No speech generation.
- Play original Neon Arena continuously after the intro, no loops. The new bed
  and retimed voice are `launch-bed-aura-v19.wav` and `launch-voice-aura-v19.wav`.
- Label the game blocks honestly. Rush has a CPU ally, not online co-op.
- Restore the film below the current `GameLandingPage` hero, user-initiated,
  with captions, native full-screen controls and `preload="none"`.
- No provider calls, auth operations, production writes or fighter regeneration.
- Exact edit decisions and source SHA-256 hashes live in
  `provenance/aura-launch-v19-cuts.json`; full capture masters stay private.

## Previous Approved Cut (v15)

### Intent

Launch Insert Player with the shortest possible proof of the product: begin with
a real portrait, transform that same person into a premium arcade fighter, then
cut into a genuine browser match. The piece should feel like a cabinet waking up,
not like an AI avatar advertisement or a software walkthrough.

## Assets

- `../../public/assets/social-card-v7.jpg` - approved transformation concept and visual reference.
- `assets/transformation-visual.png` - frozen, clean photo-to-fighter source visual.
- `assets/generated/player-one-photo-matched-v1.png` - wardrobe-matched photoreal portrait that preserves Player One's identity, pose, and studio framing while aligning the real clothing with the approved fighter.
- `assets/generated/player-one-upright-canonical.png` - exact approved production upright cutout for Player One.
- `assets/generated/player-one-final-frame.png` - deterministic arena composite using that exact cutout.
- `assets/generated/casual-photo-card-v1.webp` - exact second-person portrait already used on the production landing page.
- `assets/generated/casual-fighter-card-v1.webp` - exact matching Casual fighter already used on the production landing page.
- `references/neon-arena-creative-fingerprint-v1.json` - private-reference fingerprint derived from the supplied Suno track; the source MP3 is not distributed.
- `assets/generated/launch-bed-original-neon-v11.wav` - a direct 20.05-second mix: the approved announcer intro followed by the first 15.40 consecutive seconds of the original private `Neon Arena.mp3`; no repeated tail, echo loop, or regenerated music.
- `assets/generated/tts-launch-friends-v5-retimed.wav` - the approved Gemini TTS explanation with only its final `Ready? Insert Player.` phrase delayed to the closing lockup; no speech was regenerated.
- `assets/generated/omni-photo-to-fighter-v2-neon-sync.mp4` - private Omni timing canary, retained for audit but rejected from the final cut because its target was not the immutable global Champion frame.
- `assets/fight-montage-player-one-vs-casual-v15.mp4` - one 2.40-second production loading curtain for Casual versus Player One, followed by their clean one-second bout on `EXECUTIVE RUMBLE` and seven one-second global-roster exchanges featuring Trump, Rosalía, Elon Musk, and Lamine Yamal. The opening composite excludes the captured placeholder floor rule and old renderer shadows, preserves bright HUD and hit effects, and uses lossless 4:4:4 intermediates.

## Customizations

- Borrow the structural idea from Hilo's product promos: real footage, a few crisp branded action beats, and a strong end card.
- Preserve the approved explanatory voiceover, delaying only its final `Ready? Insert Player.` lockup so it lands with the closing title. Duck the user-supplied `Neon Arena` bed beneath speech while retaining the cabinet fight SFX; continue the original track linearly beneath the final reading hold and use only a short terminal fade.
- Reject the mix if any measured late-gameplay or closing-fade window falls below `-50 dBFS`; `loudnorm` may change its internal sample rate, so post-normalization trims must be time-based.
- Keep the private full-length recordings outside the repository. Publish only the selected proof excerpts embedded in this `20.05s` launch cut.
- Keep the transformation literal and readable: physically drag Player One's photo into the P1 slot, transform it into the approved fighter, confirm the same operation with Casual, then enter `YOUR FIGHT`.

## Notes

- Use Insert Player branding only: P1, cabinet black, coin red, coin gold, CRT cream, and glass blue.
- Never reproduce Hilo's logo, purple palette, typography, wording, action pills, or other proprietary brand elements.
- Show real gameplay and real generated fighters. Do not fake a fight in motion graphics.
- The wardrobe-matched Player One portrait may change clothing only. Identity, face, hair, body proportions, pose, studio lighting, and framing remain the same.
- The closing card lasts exactly five seconds. Type `INSERT PLAYER` first, then `CREATE YOUR FIGHTER FOR FREE`, reveal `INSERTPLAYER.AI`, and hold the completed card long enough to read.
- Open the proof block with one `2.40s` production `CASUAL VS PLAYER ONE` loading curtain labeled `EXECUTIVE RUMBLE`, pay it off with their real `1s` bout composited over that exact published stage, then continue through seven `1s` global-roster recordings. The placeholder floor rule must not survive the composite. Do not repeat the loader for the other rivals.
- Capture desktop gameplay with an explicit 8 GB capability profile and retain the loader logs proving that Player One used 384x512 atlas cells at density 2x.
- Avoid franchise imitation, cartoon exaggeration, generic AI language, and slow cinematic choreography.
- Generated media is private and single-candidate: no automatic retries, fallbacks, or publishing.
- A generative transition may enter the final cut only when it preserves the exact global Champion. The current Omni v2 canary did not pass that gate, so the deterministic transformation remains authoritative.
- Respect reduced-motion in the website hero even though the rendered promo itself is energetic.
