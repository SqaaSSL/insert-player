# Roster provider benchmark

This isolated harness compares two hypotheses without changing the production Roster architecture:

- Plan A: one current-provider Gemini Flash WALK sheet at 4K / 3:4.
- Plan B: one identical two-reference HIGH_KICK impact refine across Gemini Flash, BFL Klein 4B, BFL Klein 9B, BFL FLUX.2 Pro, fal FLUX.2 Flash, and ByteDance Seedream 4. BFL and Seedream are distributed by fal for this run because those are the credentials already present locally.

The frozen inputs are synthetic QA assets. The harness never sends a user's photo.

## Safety contract

- `plan` is local-only and makes no network requests.
- Paid execution requires both `--execute` and the exact run confirmation token.
- The supplied `--max-cost-usd` must cover the guarded estimate and may never exceed USD 0.50.
- Exactly seven provider submissions are possible: one for Plan A and six for Plan B.
- There are zero automatic generation retries. Queue polling and result download may repeat, but a model submission may not.
- fal payload storage is disabled and generated CDN media is set to expire after one hour; completed outputs are downloaded locally immediately.
- A durable local ledger is written before every submit. An interrupted `submitting` entry is never resubmitted automatically.
- Secrets and base64 inputs are never written to the manifest, ledger, or console.

## Commands

```bash
npm run benchmark:providers:test
npm run benchmark:providers:plan
npm run benchmark:providers:execute -- --execute --confirm-paid-benchmark=phase0-20260822-v1 --max-cost-usd=0.50
```

Artifacts are written under `.qa/provider-benchmark/phase0-20260822-v1/`, which is ignored by Git. Re-running `execute` resumes polling or skips completed requests; it does not submit them again.

## Immutable QA pose atlas

The pose atlas selects the strongest preserved Nova QA or Rafa QA sequence per move. It freezes the source export, sprite version, sheet hash, playback order, and the three-reference transfer contract. The builder only reads local lossless exports and writes local review artifacts; it never calls a provider.

```bash
npm --prefix processor run qa:pose-atlas:test
npm run arcade:qa-pose-atlas -- plan
npm run arcade:qa-pose-atlas -- build \
  --source=nova-qa=/absolute/path/to/extracted-nova-export \
  --source=rafa-qa=/absolute/path/to/extracted-rafa-export \
  --archive=nova-qa=/absolute/path/to/localhost--nova-qa--2d8fbd6e1b7feb4b.tar \
  --archive=rafa-qa=/absolute/path/to/127.0.0.1--rafa-qa--9c0c3defc483cfc8.tar \
  --output-dir=/absolute/path/to/new-output-directory
```

Every build refuses to overwrite an existing output directory. Review `qa-pose-atlas-review.png` before using any extracted frame in a paid canary.

## FLUX.2 Flash sequence gate

The follow-up gate reuses the already generated HIGH_KICK impact frame, submits the other three unique keyframes to FLUX.2 Flash, applies four no-fallback BiRefNet cleanups, expands `0,1,2,3` to `0,1,2,3,2,1,0`, and runs the production normalization path. The original preflight guard was USD 0.048; fal's model page revealed a pricing-API mismatch, so the corrected guard is USD 0.057 under the approved USD 0.06 ceiling. The final report reconciles every request against fal's billing-events API rather than inferring cost from model response timings.

```bash
npm run benchmark:flash-sequence:test
npm run benchmark:flash-sequence:plan
npm run benchmark:flash-sequence:pricing
npm run benchmark:flash-sequence:execute -- --execute --confirm-paid-benchmark=phase1-flux2-flash-high-kick-20260822-v1 --max-cost-usd=0.06
```
