# Generation pipeline transition

Owner decision: 2026-09-15. Keep every prior renderer and its evidence, mark
them deprecated for future development, and keep their technical controls out
of public creation. No assets, old jobs or implementations are deleted.

## Product direction

| Public quality | Selected next renderer | State |
| --- | --- | --- |
| Rookie | Two white-background 4096×4096 Template Zero atlases for the character | `rookie-two-atlas-v1`, durable web pipeline |
| Champion | One white-background 4K Template Zero sheet per animation (formerly the “Rookie 4K” experiment) | `champion-animation-sheet-v1`, durable web pipeline |

Both use 4K images; the difference is how much image area each frame gets.
This replaces the planned need for individual inference on every Champion
frame, not the requirement to validate output quality. Template Zero is an
internal pose/registration asset, never a publicly selectable fighter.

New creation includes the same 20 animations in both qualities (13 Fight and
7 Aura). The intended next game remains selected, but new creation uses the
complete package. Existing completed characters, paid jobs and expansions
retain their previous package contract. Finishers and other add-ons are not
silently included. Existing complete-package retail quotes remain Rookie 2
credits / Champion 11 credits; this change does not equate provider cost with
the selling price. First-Rookie eligibility remains account-checked.

## Deprecated does not mean deleted or already replaced

Preserve the original `sheet`, `sheet_refined`, `frame_sequence` and reviewed
`video` code paths, tests, prompts, RAWs and version history. Original frame
generation and later per-frame Template Zero experiments are separate
provenance, even if both were informally called Champion.

The original implementations stay available for legacy recovery and asset
maintenance. New creation explicitly requests its versioned renderer; a
missing or different acknowledgement fails closed before uploading/starting
another job. A new frontend cannot silently run against an old backend. The
release preflight requires both renderer contracts in the deployed processor
before publishing the new frontend. Repository code is not proof of a live
release: verify the deployed revision and perform a real new-photo canary.

The frontend presents quality, not a choice of Original, Video, model or
sheet/refinement algorithm. The archived `CreationFlowPicker` remains available
only by explicit internal-review opt-in. Public routes must not mount it.
Review/resume controls for already-paid legacy video jobs remain accessible;
these are asset recovery, not new pipeline offers.

Never rewrite the persisted `rookie`, `contender`, `champion`, `original` or
`video` identifiers. In the current release, visible Champion has offer ID
`contender`. Atlas jobs persist explicit renderer/template versions in the
versioned animation-plan envelope on charges, jobs and artifact runs. Sprites
use `animation_format=template-atlas-v1`, processing version 6; private compile
metadata and RAW checkpoints preserve provenance. Unknown versions must not fall back
silently to an old renderer. Legacy jobs resume their original renderer and
quote; historical assets keep their actual provenance.

## Timing and cost evidence

Local experiment `rookie-atlas-white-v1`, 2026-09-15, Nano Banana 2 edit through
Meterkey → FAL, two successful requests, one attempt each:

| Sheet | Submitted UTC | RAW downloaded and verified UTC | Wall time |
| --- | --- | --- | --- |
| two-01 | 16:37:08.702 | 16:37:53.365 | 44.663 s |
| two-02 | 16:37:08.731 | 16:37:50.133 | 41.402 s |

Requests started 29 ms apart. Both RAWs were ready in **44.663 seconds**, not
the sum of their durations. These measurements include submission, queue,
polling, download and hash verification. They are one observed run, not a
latency percentile or SLA. The preserved local `ledger.json` and `transport.mjs`
define the timing boundaries; provider-reported inference alone was about
33.1 and 31.0 seconds.

The production compiler replay of the preserved two RAWs took 31.5 seconds
locally for all 20 outputs and checks; no provider inference was repeated.
This is not the deployed Container's latency. Therefore **1–2 minutes from prepared references** is only an engineering
projection. A brand-new photo-to-playable run has not been measured: this test
reused Fran's prepared white upright and prebuilt Template Zero atlases.
Do not put a guaranteed “ready in 45 seconds” claim or countdown in the UI.

Meterkey recorded USD 0.10 per sheet, USD 0.20 total; the prior estimate was
USD 0.32. Final settlement/provider invoice was not confirmed. This excludes
identity preparation, retries, storage/processing and retail margin. It is
not the full cost or selling price of creating a new character from a photo.

## Implemented application contract

- A versioned renderer/template manifest passes through authorization, durable
  jobs, provider idempotency, artifacts, recovery and per-asset retries. Keep
  existing session, spending and refund boundaries intact.
- Atlas packing, white-background removal, frame maps, holds and fixed
  registration live in the Insert Player processor. No manual Codex steps or
  personal credentials may be required for a user's creation.
- The application prepares side and upright views, reuses the cleaned upright,
  and submits the two Rookie sheets in parallel. Source photos remain
  private and are not sent again for every animation/frame. The transport is
  Worker → dedicated Insert Player Meterkey → FAL (Nano Banana 2 edit), with
  prepared-source Gemini requests through Meterkey too. No personal/direct
  FAL or PixCLI fallback participates in the new renderer.
- Both outputs are validated, RAWs retained, playable assets persisted for the
  actual Fight/Aura renderers. Do not substitute another character or resize
  each pose to hide a failed grid or registration mismatch.
- The UI shows real stages: preparing your character, creating moves, finishing the
  cutouts, saving, ready to play. Reveal the owned prepared portrait and then
  validated animations as they become available. Do not fake progress or
  show a partial character as complete. Recovery must survive navigation.

## Release validation still required

- Measure upload-to-ready time with a new identity, both quality levels and
  failure/retry recovery in the existing review environment before cutover.
  Retire the old comparison assets from merchandising only when an honest
  new Rookie/Champion same-character comparison is available.

The two-sheet experiment and offline compiler replay establish neither
photo-to-playable latency nor live-provider availability. Record those
separately from unit/integration/preview evidence and deployed revision.

## Recovery, geometry and storage

- Submit is run-and-plan scoped. Its request-body hash and durable receipt are
  checked before accepting provider provenance. Collection is GET-only; a
  transport-ambiguous submit stops automatic retries rather than buying again.
- Verified provider RAWs are immutable, private R2 objects. A compiler failure
  resumes from them. Missing/corrupt previously saved evidence fails closed.
  Incorrect-size RAWs are retained for diagnosis, never promoted to playable.
- Compile each animation separately to bound response size. The Worker pins
  manifest SHA, authored sequence/holds, source RAW hashes, dimensions, origin,
  timing and QA contract before persistence. A semantic quality claim is not
  inferred solely from a geometry pass.
- 131 unique masters become 184 playback frames. Full-canvas registration is
  1536×2048 with ground Y=1884; HQ cells are 768×1024. No independent per-frame
  fit or automatic ping-pong may alter the template's scale or timing. The
  existing device-dependent GPU texture limits remain in place.
- Migration 0041 extends format checks and checkpoint stage capacity without
  deleting character history. It preserves IDs, content hashes, foreign keys,
  indexes and recuration triggers. Apply through the existing idle-generation
  migration/deployment gate, never by a local production mutation.
- The private generic template bundle contains no human identity references
  and is shipped with the processor, not the public frontend/static roster.
