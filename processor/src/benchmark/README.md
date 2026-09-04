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

## Klein 4B/9B sequence gate

This provider-only follow-up reuses each model's Phase 0 impact frame, generates the other three unique HIGH_KICK poses for both Klein 4B and Klein 9B, and applies eight exact production-payload BiRefNet cleanups. It allows exactly 14 paid submissions, takes an exclusive execution lock, disables retries and fallback, and reconciles final cost against per-request billing events. The guarded budget is USD 0.197 under the approved USD 0.20 ceiling; expected cost from prior billing events is roughly USD 0.127–0.129.

```bash
npm run benchmark:klein-sequence:test
npm run benchmark:klein-sequence:plan
npm run benchmark:klein-sequence:pricing
npm run benchmark:klein-sequence:repair-cleanup
npm run benchmark:klein-sequence:execute -- --execute --confirm-paid-benchmark=phase2-klein-high-kick-20260823-v1 --max-cost-usd=0.20
```

`repair-cleanup` is local-only. It rebuilds a separate diagnostic from the frozen raw outputs and existing BiRefNet masks, makes zero provider calls, and never overwrites the original cleanup artifacts.

## Trump production-style HIGH_KICK benchmark

This isolated run uses the licensed roster portrait and reproduces the production HIGH_KICK dependency chain independently for all six Plan B renderers: canonical source, character-specific 2x2 scaffold, four unique refines, production-equivalent cleanup, and local mirror. The original portrait is supplied at source and again to every refine; no generic actor anchor is used. Runtime routing remains Gemini-only.

The frozen plan allows at most 60 submissions with zero automatic retries or provider fallbacks and a USD 2.05 hard cap. The completed run used 46 submissions. Do not execute it again without a new explicit spending approval.

```bash
npm run benchmark:trump-prod-flow:test
npm run benchmark:trump-prod-flow:plan
```

Artifacts and the independent visual assessment are under `.qa/provider-benchmark/trump-prod-flow-all-renderers-20260823-v1/`. Both commands above are local-only and make zero paid inference calls.

## Provider × temporal-strategy matrix

This harness separates the renderer from the temporal flow. It freezes one canonical frame and one common HIGH_KICK pose scaffold, then compiles six strategies for all seven renderer adapters and all eleven animation-specific topologies. The licensed portrait is retained only as canonical lineage and is never sent to a temporal renderer.

Strategies are `direct-sheet`, `sheet-independent`, `canonical-independent`, `previous-delta`, `canonical-previous`, and `previous-pose`. Production remains Gemini-only; this entire harness lives below `processor/src/benchmark/providerMatrix/`.

The current `v2` planner gives the three chained strategies the complete animation trajectory: all unique phases, playback order, exact `Fn of N` position, previous input phase, current target, and next phase as context-only. It explicitly preserves appearance but not the previous pose and rejects an unchanged prior frame. Independent strategies keep their original prompts so the strategy comparison remains isolated. The closed paid `v1` artifacts and ledger are preserved unchanged as historical evidence.

Planning and prompt inspection are local-only:

```bash
npm run benchmark:provider-matrix:test
npm run benchmark:provider-matrix:plan
npm run benchmark:provider-matrix:plan -- --renderer=klein-9b --strategy=previous-delta --animation=high_kick
```

Paid execution requires an active code-level entry in `PROVIDER_MATRIX_PAID_APPROVALS`, the exact generated confirmation token, the exact approved staged guard, and an explicit `--through-frame`. A later approval may raise the same ledger cap monotonically, but can never lower it or reset attempts. The harness uses one global paid-benchmark lock, a durable one-attempt ledger, zero generation retries, no fallback, disabled fal IO storage, and one-hour output expiry. The ledger cap is an operational submission guard, not a provider-enforced billing ceiling; variable BiRefNet compute time is reported explicitly.

The complete HIGH_KICK cartesian matrix would reserve USD 6.748 across 217 submissions, so it is deliberately forbidden as a batch. Paid execution is currently locked to HIGH_KICK; the remaining animation topologies are planning contracts until their own standing/crouched bases and pose scaffolds are frozen.

The first approved gate was exactly three Klein 9B one-reference generations plus three BiRefNet cleanups, reusing the frozen F0. It stopped at F2 after four submissions and USD 0.043282812 recorded spend because F2 failed temporal progression. The approval is now closed and F3 cannot be submitted by this CLI.

Historical command (documented for audit; it is no longer authorized by the approval registry):

```bash
npm run benchmark:provider-matrix:execute -- \
  --renderer=klein-9b \
  --strategy=previous-delta \
  --animation=high_kick \
  --through-frame=1 \
  --confirm=trump-provider-strategy-matrix-20260824-v1:klein-9b:previous-delta:high_kick \
  --max-cost=0.069
```

The next strategy/model gate must first be added as a new explicit approval with its own reviewed cap. Omitting `--through-frame` never executes an entire sequential plan.
