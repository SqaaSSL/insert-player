# XAI video-to-sprite canary

This QA-only experiment compares the existing still-image HIGH_KICK with a
single short image-to-video generation:

```text
approved Trump canonical
  -> pinned Grok Imagine Video 1.5 I2V (2 seconds, 720p)
  -> lossless local frame extraction at 8 fps
  -> F0 normalized only from the canonical + video frames near 33%, 67%, and 92%
  -> playback 0,1,2,3,2,1,0
  -> 768x1024 QA sheet + 192x256 runtime-size review sheet
```

It is intentionally separate from the production generation workflow. It does
not write D1/R2 fighter records, source versions, sprite versions, checkpoints,
or playable pointers, and it never activates a roster.

## Safety contract

- PixCLI model: `grok-imagine-i2v-pinned`
- Provider endpoint: `xai/grok-imagine-video/v1.5/image-to-video`
- Exactly one paid submit
- No provider retry, model fallback, safety sibling, prompt enrichment, or
  automatic resubmission
- A network-ambiguous submit is persisted and cannot be retried automatically
- `completed_with_fallback` and mismatched `provider_runs` are rejected
- Before extraction, the archived request must prove the exact FAL endpoint,
  prompt, canonical URL, duration, resolution, and no-retry/no-fallback policy;
  the archived MP4 must carry the same sole provider `request_id`
- The canonical bytes and prompt/request payload are SHA-256 pinned in state
- The exact canonical input is archived separately; F0 is its chroma-keyed,
  cell-normalized derivative and is never sampled from the video
- Human review remains mandatory; extracted files are QA artifacts only

The I2V endpoint receives one image: the approved canonical. It does **not**
receive the original photograph as an additional identity reference. Do not use
this lane with a poor canonical and then interpret the result as an identity
benchmark.

## Commands

Print the immutable plan. This makes no network request:

```bash
npm run arcade:canary:xai-video
```

Process an already downloaded MP4 locally. `ffmpeg` and `ffprobe` must be on
`PATH`; they are not added to the production container:

```bash
npm run arcade:canary:xai-video -- \
  --extract \
  --canonical=/absolute/path/to/approved-trump-canonical.png \
  --video=/absolute/path/to/grok-output.mp4
```

After reviewing the all-frames contact sheet, the three video frame indexes may
be overridden without another provider call:

```bash
npm run arcade:canary:xai-video -- \
  --extract \
  --canonical=/absolute/path/to/approved-trump-canonical.png \
  --video=/absolute/path/to/grok-output.mp4 \
  --select=4,9,13
```

Paid execution is deliberately awkward and requires both switches:

```bash
PIXCLI_API_KEY='...' npm run arcade:canary:xai-video -- \
  --execute \
  --confirm=ARCADE_HIGH_KICK_XAI_VIDEO_V1 \
  --canonical=/absolute/path/to/approved-trump-canonical.png
```

The state file has an exclusive companion `.lock`; a stale lock is never broken
automatically because doing so could duplicate a paid submit. Reconcile the
owner before removing it manually.

Do not run paid execution until the additive pinned PixCLI model is deployed and
the dedicated MeterKey key permits the exact FAL video endpoint. The expected
provider cost is approximately $0.29 for the 2-second 720p canary. PixCLI
reserves 330,000 microcredits ($0.33) with its current margin; its final
settlement remains authoritative.

Artifacts are written under
`.artifacts/arcade-high-kick-xai-video-canary/arcade-high-kick-xai-video-v1/`
and the resumable ledger is `.arcade-high-kick-xai-video-canary-state.json`.
