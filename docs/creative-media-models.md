# Google Creative Media Models

This guide records the approved creative-media path for Insert Player launch
assets. It is deliberately separate from the fighter-generation runtime.
Nothing in this document changes the production Gemini-only fighter pipeline.

Last verified: 2026-08-29.

## Decision table

| Need | Model | Access path | Insert Player use |
| --- | --- | --- | --- |
| Short generative video bridge | `gemini-omni-1.1-flash` | Gemini Interactions API | Animate a bounded photo-to-fighter transition. Never replace real gameplay footage. |
| Short spoken line | `gemini-3.1-flash-tts-preview` | PixCLI `gemini-tts` through Meterkey | Arcade announcer line or a very short product statement. |
| Instrumental music bed | `lyria-3-pro-preview` upstream, exposed as PixCLI `lyria-3-pro` | PixCLI through Meterkey | Generate one instrumental candidate, then trim and mix locally. |

The model names above are real and current. Do not substitute a similarly named
preview alias without checking the official model page and the live model catalog.

## 1. Gemini Omni 1.1 Flash

Official documentation:

- [Generate and edit videos with Gemini Omni Flash](https://ai.google.dev/gemini-api/docs/omni)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)

Current model ID: `gemini-omni-1.1-flash`.

Relevant capabilities:

- Text-to-video, image-to-video, subject references, and first/last-frame interpolation.
- `16:9` and `9:16`; 720p is the native default and higher resolutions are upscaled.
- Native audio is generated with the video, but the launch edit may mute it and use the controlled Lyria/TTS mix.
- SynthID is embedded in generated video.
- The current Interactions API accepts text, image, and video inputs for this model, but not an uploaded audio reference. Translate a music reference into a written beat and timecode plan before calling Omni.

Pricing is token-based. At 720p, the documented effective output price is about
`$0.10/second`. A four-second candidate is therefore roughly `$0.40`, excluding
small input cost. The API does not expose a hard duration control, so timing in
the prompt is guidance rather than a billing limit.

### Insert Player prompt rules

- Use one continuous shot and explicitly say `No scene cuts`.
- Pin the first and last reference frames.
- Preserve face, age, hair, body proportions, and clothing continuity.
- State `no extra limbs`, `no duplicate body`, `no text`, and `no logos`.
- Keep motion restrained. The product claim is transformation, not spectacle.
- Use `store: false`, `background: false`, and `stream: false` for this one-shot asset.
- Request inline video bytes. URI delivery currently requires `store: true`, which is unnecessary for this private build artifact.
- One request only. A rejected or poor candidate falls back to the deterministic HyperFrames transition; it is not retried automatically.
- A visually plausible candidate still fails if its final fighter is not the exact production fighter. Preserve the candidate and metadata, but do not integrate it.

The project runner is:

```bash
set -a
source .env
set +a
node videos/insert-player-launch/scripts/generate-omni-transition.mjs
```

It reads `GEMINI_API_KEY` from the environment and never writes it to disk or metadata.

## 2. Gemini 3.1 Flash TTS Preview

Official documentation:

- [Gemini 3.1 Flash TTS model](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-tts-preview)
- [Text-to-speech generation guide](https://ai.google.dev/gemini-api/docs/speech-generation)

Current model ID: `gemini-3.1-flash-tts-preview`.

The project uses PixCLI/Meterkey rather than placing the upstream key in a
command line. PixCLI exposes the model as `gemini-tts`:

```bash
METERKEY_API_KEY="$(security find-generic-password \
  -s hilo-meterkey -a insert-player-platform -w)" \
node /path/to/pixcli/cli/dist/index.js voice \
  "In a firm arcade-announcer voice: Insert Player." \
  --engine gemini --voice Orus --language en \
  --output videos/insert-player-launch/assets/generated/announcer.wav --json
```

Rules:

- Keep speech under one short sentence for a sub-20-second launch video.
- Treat delivery instructions as part of the prompt (`Say firmly`, pace, energy).
- Use a named Gemini voice. `Orus` is the default candidate for a firm announcer.
- Preserve the raw output and record the PixCLI job ID and cost in provenance.
- Do not synthesize celebrity voices or imply a real person endorsed the product.

## 3. Lyria 3 Pro

Official documentation:

- [Lyria 3 model card](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/lyria/lyria-3)
- [Generate music with Lyria](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/music/generate-music)
- [Google generative media pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)

The upstream Vertex model ID is `lyria-3-pro-preview`. PixCLI exposes Google
Lyria 3 Pro through FAL as `lyria-3-pro`; this is the approved path for the
launch asset because it is already metered and scoped by the dedicated Insert
Player wallet.

Google documents a flat `$0.08` upstream price per Pro composition. PixCLI's
current metered price includes its margin and should be treated as the source of
truth at request time.

```bash
METERKEY_API_KEY="$(security find-generic-password \
  -s hilo-meterkey -a insert-player-platform -w)" \
node /path/to/pixcli/cli/dist/index.js music \
  "Instrumental launch bed ..." \
  --duration 24 \
  --output videos/insert-player-launch/assets/generated/lyria-launch-bed.mp3 \
  --json
```

Rules:

- Always request `instrumental`, `no vocals`, and `no lyrics`.
- Name tempo, instrumentation, arc, and prohibited genre cliches.
- Generate one source composition, then trim/fade/duck locally.
- Music never replaces gameplay impact sounds around hits and K.O.

## 4. Private audio references

A user-supplied track may be analyzed privately as a creative reference when its
distribution rights are unclear. It is not copied into the repository, passed
to Lyria, uploaded to Omni, or included in a rendered asset.

The allowed handoff is a compact written fingerprint:

- Approximate tempo, meter, energy curve, instrumentation families, mix density, and section boundaries.
- New, independently composed musical instructions that fit the Insert Player timeline.
- Explicit prohibitions against copying melody, chord progression, lyrics, motifs, artist identity, or exact sound effects.

For the launch v2 build, `Neon Arena.mp3` was analyzed privately with
`gemini-3.5-flash` and local signal tools. Only
`videos/insert-player-launch/references/neon-arena-creative-fingerprint-v1.json`
is retained. Lyria received the derived text brief, while Omni received only a
textual 145 BPM timecode plan. The raw MP3 is neither committed nor published.

For launch v6, the user explicitly selected the original recording for the
gameplay section while preserving the approved Lyria-and-announcer opening. The
private full-length MP3 remains outside the repository; only its first `7.35s`
are present from the `4.65s` gameplay cut onward, under the existing fight
effects. The build script verifies the private source SHA-256 before producing
the derived mix.

For the game runtime, the user subsequently selected the complete original
`Neon Arena` recording as low-level battle music. The shipped runtime copy is
`public/assets/audio/neon-arena-battle-v1.mp3`: embedded artwork and metadata
are removed, while the original MP3 audio stream is preserved. This explicit
runtime selection is separate from the Lyria-derived launch candidates above.

The reproducible local arrangement is built with:

```bash
node videos/insert-player-launch/scripts/build-launch-mix.mjs
```

It uses the opening as transformation tension, cuts to the first sustained
Lyria groove at `4.65s`, preserves the local gameplay impacts, ducks beneath the
announcer, and normalizes the final 12 seconds to `-16 LUFS` with a `-1.5 dBFS`
true-peak ceiling.

## Provenance and acceptance

Every generated media candidate must retain:

- Model ID and access path.
- Prompt file SHA-256.
- Provider job or interaction ID.
- HTTP outcome and metered cost when available.
- Source asset hashes.
- Local output SHA-256 and duration.
- Human acceptance state: `candidate`, `approved`, or `rejected`.

Generated assets remain candidates until reviewed in HyperFrames Studio. The
high-quality render is still a human gate.
