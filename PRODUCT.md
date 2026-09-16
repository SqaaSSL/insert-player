# Product

## Register

product

## Users

Insert Player is for people who instantly understand the thrill of seeing themselves inside an arcade game: nostalgic players, friend groups, streamers, meme-makers, founders, teams, and casual users who want a shareable "wait, that is me" moment without learning a creation tool.

They usually arrive from a social link or a friend challenge, often on mobile, and want proof fast: play a short Aura challenge with a ready character, recognize the gestures, share a score, and then create their own character. Fight and Rush remain direct entry points for people who want combat or an adventure.

## Product Purpose

Insert Player turns a real person into a playable retro arcade character. Aura is the first social entry point: a rhythm battle with recognizable performances and reproducible challenges. Fight delivers rivalry and an arcade ladder. Rush is an action adventure with a CPU ally. All three share one account and character library, while each has a focused landing page.

Success means the user recognizes the person, trusts the generated assets enough to play, understands which games and moves a creation purchase includes, and has a natural reason to send the fighter to someone else.

## Brand Personality

Arcade-native, player-first, competitive.

The voice should feel like a modern cabinet waking up: direct, energetic, lightly cocky, and built around verbs. It should avoid corporate AI language. The product is not "a model pipeline"; it is a playable machine that inserts the user into a game.

Primary line: "Insert yourself into the game."

Useful supporting lines:

- "Make yourself playable."
- "Upload a photo. Build your fighter. Play anywhere."
- "Create fighters, upgrade quality, clone challengers."
- "Your roster follows you."

## Anti-references

- Do not present the product as AI Street Fighter, Street Fighter-adjacent, Mortal Kombat-adjacent, Metal Slug-adjacent, Mario-adjacent, or a clone of any legacy game franchise.
- Do not use "2D yourself" or other technical phrasing as the public hook.
- Do not look like an AI avatar/profile-picture generator, a cartoon filter app, a crypto game, a SaaS dashboard, or a generic pixel-art template.
- Do not rely on direct franchise homage: no copied character-select layouts, announcer samples, health-bar styling, fonts, logos, move names, or recognizable poses from protected games.
- Do not hide the product behind marketing. The first screen should feel playable, not like a landing page waiting to explain itself.

## Design Principles

1. Person first, game second.
   The brand earns attention when a real person becomes playable. UI, copy, sharing, and pricing should point back to that transformation.

2. Arcade memory without legal cosplay.
   Use the emotional grammar of coin slots, P1/P2, cabinets, rosters, rounds, and attract mode, but never the literal look or sounds of protected franchises.

3. Playable before explanatory.
   Let a new player try a ready character before asking for a photo, an account or payment. Explanations should appear only where they unblock a decision.

4. Quality must be visible.
   Rookie and Champion are two visible qualities. Show the difference using real versions of the same character, while preserving every generated version. Champion replaces the former Contender offer; provider brands are implementation details, not customer plans.

5. Virality is a product loop, not a banner.
   Community fighters, share cards, clone links, and records should create the "you have to try this" moment without feeling spammy.

6. Trust under the arcade skin.
   Auth, checkout, cloud sync, and storage must feel dependable. The visual language can be arcade, but account and payment flows need clarity and restraint.

## Accessibility & Inclusion

Target WCAG 2.2 AA for shipped product surfaces. Preserve keyboard access for core flows, visible focus states, sufficient contrast, and status text that does not depend on color alone. Motion should respect `prefers-reduced-motion`; arcade feedback can remain energetic, but it must not block comprehension or play.

## Product entry and purchases

- The first solo Aura battle starts with four optional, unscored practice notes on the real lanes; the music, score and recording start with the actual duel. Contextual tips explain real points and alternating turns, and completion or dismissal is remembered on the device.
- New public creation starts with sign-in, one photo and a name, then Rookie or Champion quality. Both create the complete 20-animation character: 13 Fight + Rush moves and seven Aura moves. Any first-Rookie entitlement and subsequent credit price come from the server; authorization rejects a changed quote.
- `/` and `/games/aura` introduce Aura. `/games/fight` and `/games/rush` give direct entry without requiring users to discover the games in order.
- `/menu` is Play, followed by My characters and Challenges in navigation; credits are a separate destination. Returning players can resume their last game.
- A creation keeps the selected game and challenge through credits and returns with the new character selected. Quality is the public choice; Original/Video and other technical renderer selectors are hidden. Deprecated pipelines remain available internally for existing jobs, versions and recovery.
- Rookie uses two white 4K Template Zero atlases for the complete character. Champion uses one white 4K Template Zero sheet per animation. Template Zero is an internal pose template, never a public roster character. The application prepares side/upright references and performs generation, cutout, assembly and cloud storage without a manual operator step.
- Aura requires its six dedicated performance loops; the shrug reaction remains optional for playback. Existing legacy Fight-only and Aura-only packs are preserved and may still need their missing-pack expansion. New complete creations include both. The official Trump presentation uses its reviewed bundled Aura performances; generic Nova/Byte retain their isolated free trial packs.
- Prices come from GenerationPackages and the server, not marketing constants. Any missing-pack expansion is quoted against the owner's cloud assets before authorization. It is not advertised as a price-difference upgrade.
- Challenge links carry a chosen display name, a social score and a compatible routine. They do not carry a private portrait or character identifier, and they are not verified ranked scores.
- Generation progress reflects persisted server checkpoints, not an elapsed-time percentage. Do not promise a total creation time until photo-to-playable latency is measured. The experimental Rookie atlas requests took approximately 45 seconds in parallel, excluding source preparation and assembly; this is not an end-to-end SLA or a complete-character cost measurement.
- The four-lane Aura game remains the released mechanic in this branch. A phrase-and-pose variant requires a separate playable validation, described in the product implementation document.

## Measurement

Device-only playtest events record game starts/completions, creation starts/completions with elapsed time, challenge creation/open/start/completion and video-share actions. Credits includes an export. No external analytics or visitor identifiers are introduced. This supports supervised playtests, not population-level conversion or retention claims; aggregate collection and a research sample are still required before selecting a winner on evidence.
