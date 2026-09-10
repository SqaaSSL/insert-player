# Audio asset provenance

## Aura crowd reactions

The following files are public-domain audience recordings downloaded from
[MediaCollege's audience sound-effects collection](https://mediacollege.com/downloads/sound-effects/audience/):

- `aura-crowd-applause-v1.wav` from `applause-moderate-01.wav`
- `aura-crowd-cheer-v1.wav` from `cheer-01.wav`
- `aura-crowd-boo-v1.wav` from `boo-crowd-01.wav`

The source page labels each of these recordings `PD` (public domain). Their
content is unchanged; they are decoded to 16-bit PCM WAV so every target
browser gets the same predictable playback format.

Aura plays these files as a continuous four-layer audience bed: two
desynchronised applause layers, one hype layer, and one negative layer. Gameplay
changes their gains smoothly without restarting a clip for each judgement.

## Aura tracks

Aura charts are authored on each track's beat grid, so every track needs a
tempo and a first-beat offset. Drop new tracks (MP3/M4A/OGG/WAV) into
`public/assets/audio/aura/` and run:

    npm run aura:tracks

The script measures each new or changed file with `scripts/measure-aura-track.mjs`
(needs `ffmpeg` on PATH), records the results in `aura/aura-tracks.json`, and
regenerates `src/game/aura/aura-tracks.generated.ts`. BPM is reliable; the
first-beat offset is a starting point, so confirm it by ear with the in-game
early/late meter and pin the final value in `AURA_TRACK_OVERRIDES`
(`src/game/aura/AuraTracks.ts`). Only use tracks whose licence allows
commercial use; generated tracks must not imitate existing artists.
