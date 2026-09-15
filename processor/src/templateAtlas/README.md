# Frozen Template Zero atlas compiler

This is an inference-free processor module. Generic pose assets are private server
inputs, copied to `dist/templateAtlas-assets` by `processor/build.mjs`; they are not
web-public assets. No source photograph, prepared identity, generated Fran/Trump,
credential, provider receipt or absolute workstation path is included.

## Preserved source contract

- Template Zero V3 manifest: `36614af09625e1b0f3911e1e4fce73eedf8d8109b0db9abd7fd1d218b04528a4`.
- Frozen atlas experiment input manifest: `25ca63a37e9af0dc09bd9ad097a42369894ebf3eb29be26aabd526eaebdf838d`.
- Private asset manifest: `d352bb3fd4151673a4739ebf6e4cad2211bce6ae1f5b06ddbdccd7bb46ef8de8`.
- 131 byte-identical generic RGBA masters, 20 actions, 184 playback positions.
- Rookie: original two 4096-square 10×7 atlases, 66/65 occupied cells.
- Champion: one 4096-square atlas per selected action, exact unique source poses.
- Canonical full canvas 1536×2048; shared root `(768, 1884)`. No body bounding-box
  fitting, per-action scale adjustment, frame trimming or inferred pose repair.
- Holds are expanded from exactly the same raster bytes. Frame count is the
  expanded playback count, not the number of distinct poses. Runtime 384×512,
  clean HQ and uncleaned per-animation HQ 768×1024. Original provider RAW atlas
  remains a separate job checkpoint; it must not masquerade as animation RAW.

`whiteKey.ts` ports the frozen exterior white-key and closed-hole classifier:
minimum channel225, chroma≤18, fully transparent245; enclosed components require
area≥0.01%, ≥90% strong white, ≥80% template background and closed-hole agreement,
and silhouette IoU≥0.70. The native-cell operation changes only alpha. Ambiguous
interior whites stay in place. Runtime/HQ uniform resampling is a separate,
explicit step, not an RGB-preservation claim for resized pixels.

## Automatic acceptance is geometric, not semantic

The compiler rejects malformed sizes, empty required subjects, silhouette
mismatch, fragmented foreground, required-cell border contact and foreground in
known packing margins. It does not prove identity, anatomy, expression or motion
quality. In particular, white clothing, fine halos and ambiguous enclosed white
patches remain limits of this deterministic method. Existing source review
statuses remain in the manifest rather than being rewritten as semantic approval.

Trailing blank cells are outside the frame contract. Unexpected artwork wholly
inside those slots is ignored by declared index and reported as a warning, never
counted as an extra frame. Crossing into a required cell remains a hard failure.
This is a general layout rule, not a character-specific exception.

`getTemplateAtlasPlans` resolves trusted local inputs. Client-supplied geometry or
template URLs are not accepted. `compileTemplateAtlas` validates a RAW and caches
its native mattes as lossless PNGs for five minutes under a 256MiB byte cap, not
duplicate decoded RGBA. Cache identity includes
the exact RAW and template geometry hashes; animation subset retries reuse the
same mattes. `assembleTemplateAtlasHqAnimation` is the RPC path: one HQ clean sheet,
then one HQ RAW sheet, without allocating an unused runtime sheet or retaining
all per-pose rasters. `assembleTemplateAtlasAnimation` additionally returns a
runtime sheet for offline clients. Responses are limited to24MiB JSON; larger
results fail explicitly with preserved native RAWs, never reduced image quality.
Do not send all20 clean+RAW HQ sheets in one JSON response. Champion submit/collect
resolves only its requested template image, retaining the full authorized
selection and identical plan fingerprint.

## Offline checks

```sh
node --import ./processor/node_modules/tsx/dist/loader.mjs --test processor/src/templateAtlas/*.test.ts
npm run --prefix processor check
npm run --prefix processor build
```

`import-template-assets.mjs` is a one-time hash-gated vendoring tool, not a runtime
dependency on the experimental directory. It copies only the generic master and
Rookie template PNG bytes from that frozen source manifest.
