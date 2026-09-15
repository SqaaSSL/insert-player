# Aura First v22

2026-09-12. Preview revision, not rendered or published.

The user's correction is product hierarchy: Aura farming is the core game;
Fight/Rush are optional activities after Aura has won the viewer's interest.
More seconds at the end of an equal-games trailer did not satisfy that intent.

## Edit

- New voice hook: "Your photo. Your character. Start farming Aura."
- No mixed teaser and no "One character. Three games." narration.
- 4.65-23.15: Aura first, 18.5 uninterrupted seconds of Trump, Rosalia and
  Lamine building flow and competing on score.
- 23.15-32.15: "Want a change?" introduces the approved Fight loader and bouts,
  then Rush. Labels say "ALSO" and use smaller type than Aura's headline.
- 32.15-35.15: return to farming Aura before the closing brand lockup.
- Same five-second end card with "START FARMING AURA FOR FREE" as its CTA.
- Total remains 40.15 seconds. Aura occupies 21.5 seconds, 76.5% of the
  gameplay excluding the loading curtain.

## Sources And Audio

The same v21 source is split into three native HyperFrames video clips using
`data-media-start`, `data-start`, and `data-duration`. No recording, generation,
resampling or intermediate compression. The smooth Fight footage is retained.
All source ranges/hashes are in `aura-launch-v22-cuts.json`.

One new Orus/Gemini TTS request through PixCLI/Meterkey:
`223c75c1ac4604ed84acb676d5c910f7`, raw duration 34.32 seconds. No retry/fallback.
Natural paragraph pauses are trimmed at measured silence boundaries. Speech is
never time-stretched; the original approved "Ready? Insert Player." is reused.
The original Neon Arena bed is byte-identical to v21; its voice carve is
recomputed at the approved 0.25 strength for the new speech.

Prompt, raw take, matched take, journal, local transcript, cues and captions are
retained. The raw ASR word timings extend across long pauses; they are not used
as cut boundaries. The assembled voice was locally transcribed again to confirm
the Aura-first copy without equal-games or mocking wording.

## Validation

- HyperFrames 0.8.35 (current at the version probe): check passes with zero
  errors/warnings, zero layout issues and 8/8 contrast checks.
- Nine snapshots covering Aura, the optional loader/bouts and closing inspected.
- Animation map reviewed; inherited duplicated sub-timeline diagnostics and
  video-only spans do not indicate missing footage. Native media snapshots pass.
- Three regression tests enforce primary-game order, narration hierarchy,
  continuous native clip timing and unchanged source footage/music/intro.
- Studio port 3005 verified with three native clips and the v22 voice source.
- No frontend source, public MP4, production state or provider configuration
  changes. The landing continues referencing the exported v21 until the user
  approves rendering/publishing this new direction.
