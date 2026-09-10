# Aura tracks: prompt → song → game track

Aura charts are procedural. They are generated at match time on the song's
beat grid (BPM + first-beat offset), so a new song never needs a hand-made
chart. The only per-song work is measuring the grid and confirming it by ear.

## Pipeline

1. **Prompt** one of the recipes below in Suno, *Advanced* tab, on a paid plan
   (Pro/Premier: the free plan has no commercial rights). Put the recipe's
   *Style* text in the Styles box, keep *Instrumental* on, leave Lyrics empty.
   The title is an internal label only; skip it if the UI has no field.
2. **Pick the take** whose kick is the most regular. Skip takes with a long
   ambient intro, a tempo change, a half-time drop that lasts more than 8 bars,
   or a fade-in.
3. **Download the MP3** into `audio-src/aura-inbox/` (git-ignored) named after
   the recipe's file id, e.g. `side-street-152.mp3`.
4. Run `npm run aura:tracks`. It encodes every inbox file into a game cut
   (`public/assets/audio/aura/<id>.mp3`: loudness-normalised to -16 LUFS,
   trimmed to 120 s with a fade, 160 kbps, about 2.4 MB), measures BPM and
   first-beat offset for every new or changed cut, tags the stage from the id
   prefix, and regenerates the catalogue.
5. **Confirm the offset by ear**: play one Aura match on that track and watch
   the early/late meter under each call-out. A consistent "LATE 60MS" means the
   first beat is 60 ms earlier than measured: subtract it and pin the value in
   `AURA_TRACK_OVERRIDES` (`src/game/aura/AuraTracks.ts`). Run the match again
   until the meter centres.
6. Commit the MP3, `aura-tracks.json`, `aura-tracks.generated.ts`, and the
   override.

## What every song must satisfy

- Fixed tempo, straight 4/4, no rubato, no tempo changes, no shuffle/swing base.
- Kick on all four beats for most of the track; the analyser locks onto the kick.
- Beat enters within the first two bars. No long pad intro, no fade-in.
- At least 90 s long. The chart is 132 beats: 51 s at 154 BPM, 66 s at 120, 47 s at 170.
- Energy lift around 35–45 s after the first beat (that is where the final round lands).
- Tempo between 120 and 175 BPM.
- Instrumental, or vocals without recognisable lyrics. Never name an artist,
  song, game, or franchise in the prompt; the game's copy stays original.

## Prompt template

```
Style: <genre>, <BPM> BPM, steady 4/4, strong kick on every beat, tight snare on 2 and 4,
no tempo changes, no swing, beat starts immediately, no fade-in, no long intro,
energy builds after 30 seconds and peaks at 45 seconds, arcade fighting-game energy,
clean mix, punchy low end, <colour words for the stage>.
Instrumental: on
Title: <title>
```

Exclude styles (if the UI offers it): `ballad, ambient, rubato, half-time, waltz, 3/4, acoustic`.

## Recipes by stage

Each stage gets three tracks (fast, mid, slow) plus two wildcards for photo
stages, twenty in all. The file id is the name to save the MP3 under; its
prefix pairs the track with the stage automatically.

### Insert Player Arena (neon cabinet)
- `neon-arena-155` · title **Cabinet Heat** · 155 BPM
  Style: synthwave arcade, 155 BPM, steady 4/4, driving kick on every beat, gated snare on 2 and 4, arpeggiated bass, bright supersaw lead, no tempo changes, beat starts immediately, no fade-in, energy builds after 30 seconds and peaks at 45 seconds, clean punchy mix, neon, chrome, coin-op.
- `neon-arena-128` · title **Insert Coin** · 128 BPM
  Style: electro house arcade, 128 BPM, steady 4/4, four-on-the-floor kick, clap on 2 and 4, sidechained bass, retro chiptune stabs, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, punchy low end, neon glass, midnight.
- `insert-player-arena-170` · title **Overdrive** · 170 BPM
  Style: hardstyle-adjacent electro with a full kick on every beat, 170 BPM, steady 4/4, snare on 2 and 4, rave stabs, distorted lead, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, strobe, cabinet glass, adrenaline.

### Executive Rumble (glass tower, boardroom)
- `executive-rumble-150` · title **Hostile Takeover** · 150 BPM
  Style: orchestral trap, 150 BPM, steady 4/4, 808 kick on every beat, crisp snare on 2 and 4, staccato strings, brass hits, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, cinematic, marble and glass, power.
- `executive-rumble-124` · title **Quarterly Results** · 124 BPM
  Style: dark techno with orchestral strings, 124 BPM, steady 4/4, four-on-the-floor kick, rimshot on 2 and 4, rolling bassline, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, sleek, corporate, cold steel.
- `executive-rumble-138` · title **Golden Parachute** · 138 BPM
  Style: big room electro with brass, 138 BPM, steady 4/4, four-on-the-floor kick, snare on 2 and 4, orchestral hits, tense piano ostinato, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, penthouse, night skyline.

### Mars Incorporated (red desert colony)
- `mars-incorporated-160` · title **Red Dust Protocol** · 160 BPM
  Style: industrial drum and bass halfstep with a full kick on every beat, 160 BPM, steady 4/4, snare on 2 and 4, distorted reese bass, metallic percussion, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, rust, dust storm, machines.
- `mars-incorporated-135` · title **Low Gravity** · 135 BPM
  Style: big beat breakbeat, 135 BPM, steady 4/4 with a kick on every beat, heavy snare on 2 and 4, fuzz bass, sci-fi synth stabs, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, red planet, heavy air.
- `mars-incorporated-148` · title **Terraform** · 148 BPM
  Style: cyberpunk midtempo with a kick on every beat, 148 BPM, steady 4/4, heavy snare on 2 and 4, growling bass, arpeggiated synth, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, rover lights, red horizon.

### Tablao 3000 (flamenco club of the future)
- `tablao-3000-140` · title **Compás Eléctrico** · 140 BPM
  Style: flamenco electronic fusion in straight 4/4 (no 12-beat compás), 140 BPM, kick on every beat, palmas handclaps on 2 and 4, nylon guitar rasgueado riffs, cajón, deep sub bass, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, red spotlight, duende.
- `tablao-3000-126` · title **Neon Duende** · 126 BPM
  Style: flamenco house, 126 BPM, steady 4/4, four-on-the-floor kick, palmas on 2 and 4, spanish guitar hook, warm bass, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, midnight tablao, velvet.
- `tablao-3000-158` · title **Zapateado Turbo** · 158 BPM
  Style: flamenco drum and bass hybrid in straight 4/4 with a kick on every beat, 158 BPM, palmas on 2 and 4, fast nylon guitar picado, cajón rolls, sub bass, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, spotlight, sweat, flamenco stage.

### La Jaula 304 (street football cage)
- `la-jaula-304-145` · title **Jaula Cerrada** · 145 BPM
  Style: spanish drill instrumental, 145 BPM, steady 4/4, kick on every beat, sharp snare on 2 and 4, sliding 808, plucked guitar loop, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, concrete, chain-link fence, night game.
- `la-jaula-304-122` · title **Cinco Contra Cinco** · 122 BPM
  Style: hard reggaeton instrumental with a kick on every beat, 122 BPM, steady 4/4, dembow snare pattern kept light, heavy 808, synth brass, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, block party, floodlights.
- `la-jaula-304-134` · title **Golazo** · 134 BPM
  Style: afro house with a kick on every beat, 134 BPM, steady 4/4, snare on 2 and 4, log drums, chant-like synth without words, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, street cage, floodlit night.

### Side Street (sunset block, barricades)
- `side-street-152` · title **Sunset Block** · 152 BPM
  Style: boom bap with a modern punch, 152 BPM, steady 4/4, kick on every beat, cracking snare on 2 and 4, dusty horn sample, upright bass, scratch fills, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, golden hour, brick, asphalt.
- `side-street-130` · title **Roadblock** · 130 BPM
  Style: uk garage two-step with a kick on every beat, 130 BPM, steady 4/4, shuffled hats kept subtle, snare on 2 and 4, warm sub, vocal chops without words, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, side street, sodium lights.
- `side-street-166` · title **Roadwork** · 166 BPM
  Style: breakcore-lite jungle with a full kick on every beat, 166 BPM, steady 4/4, snare on 2 and 4, chopped breaks kept tight, dub bass, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, barricades, sparks, sunset.

### Wildcards (photo stages and any arena)
- `wildcard-140` · title **Main Character** · 140 BPM
  Style: hyperpop trap instrumental, 140 BPM, steady 4/4, kick on every beat, snappy snare on 2 and 4, glossy synth chords, pitched vocal chops without words, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, viral, confetti, phone camera flash.
- `wildcard-120` · title **Aura Check** · 120 BPM
  Style: phonk house with a kick on every beat, 120 BPM, steady 4/4, cowbell pattern, snare on 2 and 4, saturated bass, no tempo changes, beat starts immediately, no fade-in, builds after 30 seconds and peaks at 45 seconds, slow motion walk, sunglasses, night.

## Naming and catalogue

- File ids double as track ids and roster labels; keep them stable once
  committed, since the id is part of the match identity hash.
- Titles are internal labels only; nothing in the game displays them.
- Tracks are never shown or chosen by the player. Each match draws one at
  random (seeded, so netplay peers agree), preferring tracks whose id starts
  with the stage id; photo stages and stages without their own tracks draw
  from the whole catalogue. Wildcards carry no stage prefix on purpose.
