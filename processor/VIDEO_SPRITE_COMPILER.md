# Deterministic video → sprite compiler

The Processor owns the local, non-generative half of the video roster path. FAL
or another provider may create an MP4 upstream; this compiler never calls a
model, retries a provider, or chooses a fallback.

## API

`POST /v1/compile-video-sprite`

The internal request contract is exported from
`src/services/VideoSpriteCompileContract.ts`:

```json
{
  "schemaVersion": 1,
  "action": "high_kick",
  "expectedFacing": "right",
  "videoBase64": "...",
  "canonicalFrameBase64": "...",
  "lineage": {
    "jobId": "...",
    "providerRequestId": "...",
    "modelId": "...",
    "promptSha256": "...",
    "videoSha256": "...",
    "canonicalSha256": "..."
  }
}
```

The response contains the `video-dense-v1` runtime sheet, an all-decoded-frame
contact sheet, a unique-frame sheet, and a hash-bound
`video-sprite-compile-report.v1`. The report deliberately contains no wall-clock
timestamp or temporary path, so identical inputs under the same media toolchain
and policy produce the same report hash.

Media/transport failures use ordinary HTTP errors. A successfully decoded
candidate always returns HTTP 200 and one deterministic technical outcome:

- `technical_pass`: every objective hard and review threshold passed.
- `needs_review`: the sheet is mechanically usable, but one or more soft
  thresholds need a person to inspect the cited frames.
- `reject`: at least one objective hard gate failed.

`technical_pass` is not a publication decision. The
report always sets `semanticPromotionApproved: false`.

## Deterministic work

The container runs software FFmpeg/ffprobe with bounded input, duration, decoded
frame count, command output, and execution time. The compiler then:

1. samples at 24 fps, preserves selected unique archival frames at 768×1024,
   and derives the 192×256 runtime frames from those exact HQ selections;
2. zeroes hidden RGB and decontaminates translucent green edges;
3. measures alpha bounds, connected components, margins, root, sharpness, spill,
   and pairwise pixel/silhouette motion;
4. selects poses at quantiles of cumulative motion distance (not wall-clock
   spacing and not an LLM);
5. integer-registers the subject root according to the action profile;
6. expands loop, forward ping-pong, or timeline playback only in the physical
   runtime sheet (the HQ raw sheet never duplicates ping-pong endpoints); and
7. emits per-frame evidence, hashes, gates, and a policy hash.

Static `idle` is explicitly allowed. `ko` deliberately disables root
registration because rotating a standing body into a grounded pose changes the
meaning of the root and otherwise crops valid frames.

## What this version does not automate

The report lists these limitations explicitly: identity equivalence, anatomy or
extra limbs, semantic correctness of the move, facing direction, and legal or
likeness clearance. No silhouette threshold can honestly prove those properties.
A future local pose estimator belongs in this Processor container with pinned
weights and CPU execution; until it is calibrated against committed fixtures,
its confidence may only downgrade to `needs_review`, never auto-approve.

The Worker/UI integration keeps automatic evaluation separate from human
promotion. Every candidate waits for review, bound to `reportSha256`. An
operator may replace only the strictly increasing decoded-frame indices; that
recompile uses the same private MP4 and canonical, makes no provider call, and
creates a new immutable revision/report rather than mutating the old one.

Production pins Debian FFmpeg/ffprobe `5.1.9-0+deb12u1` and verifies the version
at runtime. Changing that toolchain requires a deliberate processing-version
bump and regenerated deterministic fixtures; a package repository update must
fail the image build rather than silently alter extraction bytes.
