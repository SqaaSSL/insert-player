---
format: 1920x1080
duration: 36.15s
message: "Become the character. Three games. Aura takes the spotlight."
arc: Photo transformation -> three-game teaser -> Fight -> Rush -> Aura -> five-second CTA
audience: "Friend groups, creators, nostalgic players and visitors from shared clips"
mode: autonomous
music: "Original Neon Arena, continuous after the approved intro, no loop"
---

## Video Direction

Preserve the approved transformation and end-card design. Record actual current
gameplay from the local build: public characters, no provider calls. Use a short
mixed teaser, then separate blocks so viewers can distinguish the games. Aura
gets thirteen uninterrupted seconds and three recognizable performers. Retain
the approved narration, placing its combat sentence over Fight. Rush is one
player with a CPU ally; do not describe it as online co-op.

## Frame 1 - Your Photo. Your Fighter.

- start: 0s
- duration: 4.95s
- src: compositions/frames/01-transform.html
- status: animated
- scene: The exact approved drag-and-drop transformation of Player One and Casual.
- voiceover: "Upload a photo. Insert Player turns you and your friends into arcade fighters."
- transition_out: Existing 0.30s zoom-through starting at 4.65s.

No new face, clothing, cursor, scan or layout changes. Existing source assets and
GSAP choreography remain byte-identical to the approved composition.

## Frame 2 - Three Games

- start: 4.65s
- duration: 26.75s
- src: compositions/frames/02-games.html
- footage: assets/three-games-aura-v19.mp4
- status: animated
- scene: Real browser matches, full frame. Brief branded labels, no device frame.
- voiceover: "Create your own fighters, then challenge each other in the arena."
- transition_in: Cut beneath the approved intro exit.

| Absolute Time | Content |
| --- | --- |
| 4.65-7.65 | Aura, Rush and Fight teaser |
| 7.65-10.05 | Approved Casual versus Player One loading curtain |
| 10.05-11.05 | Their approved one-second exchange on Executive Rumble |
| 11.05-13.65 | Newly recorded Player One versus Trump, actual HUD retained |
| 13.65-18.15 | Newly recorded Player One and Elon clear Side Street in Rush |
| 18.15-22.65 | Trump performs in Aura |
| 22.65-27.15 | Rosalia performs in Aura |
| 27.15-31.15 | Lamine performs in Aura |
| 31.15-31.40 | Last-frame hold under the closing transition |

Fight label: "Challenge a friend." Rush label: "You + your CPU ally."
Aura label: "Hit the beat. Win the crowd." Labels only persist for 1.8s; the
remaining footage is unobstructed. The caption track is optional in the player.
Edit ranges, source hashes and provenance are in `provenance/aura-launch-v19-cuts.json`.

## Frame 3 - Insert Player

- start: 31.15s
- duration: 5s
- src: compositions/frames/03-insert-player.html
- status: animated
- scene: Unchanged P1 logo, typewriter wordmark, free-fighter CTA and URL.
- voiceover: "Ready? Insert Player."
- transition_in: Existing 0.25s horizontal reveal.

Keep the five-second reading hold. Music continues from the original source;
only the final 0.30s has a terminal fade. No echoed tail or repeated music.
