---
workflow: product-launch-video
flow: automation
storyboard: no
message: "Farm Aura as yourself, build flow and challenge friends; Fight and Rush are optional extras"
destination: website-embed
aspect: 1920x1080
language: en
audience: "Nostalgic players, friend groups, creators, and anyone arriving from a shared link"
length: 36.9s
angle: "Aura farming is the core product, not one of three equal games"
narration: "A concise product explanation ending with the arcade-announcer lockup"
---

## Current Revision: Alternating Aura v24 (2026-09-14)

The user approved v23 with two changes: alternate Trump and Rosalia more often,
and remove the Aura reprise after Fight/Rush. All other creative choices stay.

- Ten native HyperFrames cuts, 1.6-2 seconds each, strictly alternate performers.
  Five distinct actions each, no reused source frames, waiting or full-turn blocks.
- Keep 18.5 seconds of Aura first. Fight/Rush and their loading stay unchanged.
- Rush leads directly into the existing five-second end card, starting at 31.9s.
  The film now lasts 36.9s, including the original 0.25s closing reveal.
- Remove only "Then get back to farming Aura" and move the approved closing
  voice earlier. No new TTS, changed speaking speed, music loop or inference.
- Original Neon Arena stays continuous. Recalculate the same 0.25-strength
  voice carve against the edited voice; terminal fade only at 36.6-36.9s.
- Preview v24 before final export/publication. Preserve v23 and all older assets.

## Previous Revision: Aura First v22 (2026-09-12)

The user clarified the PRODUCT HIERARCHY, not just screen-time allocation:
Aura farming is the main reason to visit Insert Player. Fight and Rush are
optional side activities for people already interested in farming Aura. Never
sell this film as three equivalent games or lead with a mixed three-game reel.

- Open the voice with "Your photo. Your character. Start farming Aura."
- Preserve the approved visual photo transformation, then cut directly to
  18.5 uninterrupted seconds of Aura. No Fight/Rush teaser before that block.
- Introduce the other activities only at 23.15s with "Want a change?" and
  smaller "ALSO: FIGHT / ALSO: RUSH" labels. Keep the approved loading curtain
  here, with its matching bout and the smooth v21 Trump capture.
- Return to Aura at 32.15s and close on "START FARMING AURA FOR FREE".
- Keep the 40.15-second length and five-second end card. Aura takes 21.5s,
  about three quarters of the gameplay excluding the loading curtain.
- One new Orus/Gemini TTS take, no retry/fallback; reuse the actual approved
  "Ready? Insert Player." ending and the exact v21 Neon Arena music source.
- Reorder through native HyperFrames media-start/start/duration attributes;
  no new gameplay generation, capture, resampling or lossy intermediate.
- Preview v22 first. The landing's exported v21 file remains unchanged until
  approval to render/publish. Every old asset and take is retained.

## Previous Revision: Aura Farming v21 (2026-09-12)

The user flagged stuttering Fight footage and asked for more Aura, explicitly
framed as **Aura farming**. Never mock the moves or call them ridiculous: the
players are building skill, flow and Aura. This is a persistent copy preference.

- The old Trump screen recording supplied only 25 captures over the selected
  2.6 seconds. Replace both excerpts with a fresh, clock-stepped recording of
  the real local game, one full screenshot per 1/30 second, including its HUD.
- Keep the approved Casual/Player One loading and their one-second exchange.
- Reduce the new Trump block by 0.5s and Rush by 1s. Expand continuous Aura from
  13s to 18.5s, plus its 1.4s teaser: 19.9s of the 40.15s film.
- Replace only Aura's narration with one new Orus take about Aura farming,
  rhythm, flow, points and competing with friends. Keep every old take.
- Intro/end card remain unchanged; closing starts at 35.15s and holds for 5s.
- Neon Arena continues from the original MP3 for the longer cut; no loop.
- HyperFrames 0.8.34 -> 0.8.35, verified after the version bump.
- Local preview only. No production changes, image/video inference or payments.

## Previous Revision: Aura Audio v20 (2026-09-11)

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
