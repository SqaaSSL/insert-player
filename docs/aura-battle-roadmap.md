# Aura Battle: match shape and special meter

Status: three-round match shape and continuous crowd mix shipped. MAIN CHARACTER is the next gameplay pass.

## Product promise

Aura is a performance battle, not a reskinned fight. The camera presents one character at a time, the four-key highway occupies the opposite side, and the crowd turns accuracy into spectacle. Fight, Rush, and Aura share fighters and stages, but each owns its route and game rules.

The shipped beta remains playable without extra generation: every complete Fight fighter falls back to its current animations. The optional [`aura-v1-2026`](./aura-animation-packs-v1.md) pack adds purpose-built meme performances without changing scoring, rollback, or Fight/Rush compatibility.

## Standard match: three rounds

- Three call-and-response rounds, six turns total.
- Each player receives the same generated phrase in a round.
- Density escalates each round while lane speed, timing windows, and key positions remain constant.
- At the current 154.27 BPM, this takes about 52 seconds instead of the current 36 seconds.
- The third round is the visual climax: hotter lighting, louder crowd, more stage pulses, and denser patterns. It does not secretly change input physics.
- Results appear immediately after the last four-beat finish. Rematch keeps the song and changes the routine seed; Remix changes both the routine and presentation accents.

This is long enough to create a comeback story without turning a shareable web match into a full song commitment. Longer competitive formats should be best-of-three matches, not one endless chart.

## Crowd meter

The visible eight-segment CROWD meter becomes the special-energy system.

### Earning it

- PERFECT raises it most, GREAT raises it slightly, and GOOD maintains momentum.
- Completing a phrase without a miss grants a clear bonus segment.
- MISS and mash remove energy immediately.
- The meter persists between that player's turns, so the first two rounds create a decision for the finale.

### Spending it: MAIN CHARACTER

- Available from six of eight segments.
- Press Space during your own turn to activate it for eight beats.
- Base score is doubled while active; judgement windows and note speed do not change.
- The stage gives the player a full spotlight takeover, the highway frame lights up, the crowd peaks, and the multiplier is unmistakable.
- It is a strategic score window, not an accessibility advantage or an automatic comeback mechanic.

## Rival interaction: separate CHAOS ruleset

Default and ranked Aura should remain a readable skill contest. Never scramble keys, bend scroll speed, cover receptors, or change timing windows as an attack.

For casual battles, a full meter can instead be spent during the rival's count-in on CALL OUT:

- Four clearly telegraphed bonus notes are appended to the rival's phrase.
- If the rival clears them, they steal the attacker's multiplier and the crowd turns on the attacker.
- If the rival drops them, the attacker wins a crowd-and-score bonus.
- The base phrase stays untouched, so a player always understands what happened and why.

CALL OUT makes disruption funny, reversible, and skill-based. It can lengthen an individual match by a few seconds without compromising the deterministic chart or requiring new character animations. It should ship after MAIN CHARACTER and online synchronization are proven.

## Delivery order

1. Continue polishing the stage/highway/camera presentation and responsive layouts.
2. ✅ Expand the chart from two to three rounds and tune the third-round density.
3. Turn CROWD into the persistent meter and ship MAIN CHARACTER in CPU/local modes.
4. Synchronize meter activation online and add replay/share data.
5. Prototype CALL OUT behind a CHAOS toggle; keep it out of default matchmaking until playtests prove it is fun.
