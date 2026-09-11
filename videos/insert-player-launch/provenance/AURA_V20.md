# Aura Launch Film: Audio v20

2026-09-11. Local review, not deployed. The user requested speech matching the
new 36-second, three-game film, especially Aura.

## Edit

- Preserve the actual approved Orus intro and `Ready? Insert Player.` closing.
- One new Orus / Gemini TTS take through PixCLI and Meterkey; no retries,
  fallback, image or video generation. Job `9c26920424af877b162dc021d5893f3d`.
- New middle copy covers friend rivalry in Fight, the CPU ally in Rush, then
  Aura's rhythm, playful moves, scores and group-chat appeal.
- Fit at natural sentence breaks, original playback speed. The middle take's
  measured loudness is matched to the approved voice using two-pass loudnorm.
- Keep Neon Arena v19 unchanged, no loop. Recompute HyperFrames' dynamic music
  carve against the new speech; preview and render use the same audio graph.
- Keep every picture edit. Remux v19's exact H.264 stream with v20 render audio
  to avoid another generation of video compression.

## Output

- `public/assets/insert-player-launch-aura-v20.mp4`: 36.166667 s,
  1920x1080, 30 fps, H.264/AAC, 9,428,775 bytes.
- Matching `insert-player-launch-aura-v20-en.vtt`; poster remains v19 because
  the picture is unchanged. Native opt-in playback, captions and full-screen.
- `provenance/aura-launch-v20-cues.json`: nine timed speech edits.
- `provenance/aura-launch-v20-audio.json`: source hashes and loudness settings.
- `provenance/aura-launch-v20-qa.json`: final hash, loudness, dropout checks.
- Raw take, submission journal, local transcript and matched take are retained.
  The generator resumes an existing job instead of issuing another paid POST.

## Verification

- HyperFrames check: zero errors/warnings; two existing intro layout infos.
- Five component/asset tests; two submission-journal tests with mock HTTP only.
- Browser playback at widths 1440, 390, 320: correct 36-second source, decoded
  picture, captions, no horizontal overflow, no video request before playback.
- Final mix locally transcribed: the complete intro, three modes and closing
  are present. New speech ends before the final lockup; no time-stretch.
- Exact video-packet SHA-256 matches v19. Ten one-second audio windows across
  narration, gameplay and the closing hold pass the dropout/clipping checks.
- Build and frontend styling checks pass; existing chunk-size/import warnings.

No production mutation, deployment, provider change or payment testing.
