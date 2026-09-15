# Generation pipeline transition

Owner decision: 2026-09-15. Keep every prior renderer and its evidence, mark
them deprecated for future development, and keep their technical controls out
of public creation. No assets, old jobs or implementations are deleted.

## Product direction

| Public quality | Selected next renderer | State |
| --- | --- | --- |
| Rookie | Two white-background 4096×4096 Template Zero atlases for the character | Local playable experiment, not connected to the web generator |
| Champion | One white-background 4K Template Zero sheet per animation (formerly the “Rookie 4K” experiment) | Local experiment, not connected to the web generator |

Both use 4K images; the difference is how much image area each frame gets.
This replaces the planned need for individual inference on every Champion
frame, not the requirement to validate output quality. Template Zero is an
internal pose/registration asset, never a publicly selectable fighter.

The two-atlas test covers 20 animations (13 Fight and 7 Aura). This is not a
claim that current purchasable packs, Aura's supported gesture set, fatalities
or other add-ons are identical to that test. Map product packs explicitly at
integration, rather than silently adding, dropping or charging for actions.

## Deprecated does not mean deleted or already replaced

Preserve the original `sheet`, `sheet_refined`, `frame_sequence` and reviewed
`video` code paths, tests, prompts, RAWs and version history. Original frame
generation and later per-frame Template Zero experiments are separate
provenance, even if both were informally called Champion.

The currently running original renderer stays in service until the successor
is integrated and verified. Hiding its technical selector must not silently
switch a paid job, disable all creation, or present its output as the new atlas
result. This change does not activate the new generator, change provider
routing, run paid inference, alter credit prices or publish local characters.

The frontend presents quality, not a choice of Original, Video, model or
sheet/refinement algorithm. The archived `CreationFlowPicker` remains available
only by explicit internal-review opt-in. Public routes must not mount it.
Review/resume controls for already-paid legacy video jobs remain accessible;
these are asset recovery, not new pipeline offers.

Never rewrite the persisted `rookie`, `contender`, `champion`, `original` or
`video` identifiers. In the current release, visible Champion has offer ID
`contender`. A future atlas implementation needs explicit persisted pipeline
and template versions on jobs and artifacts, separate from the display label
and billing offer. Unknown or mismatched pipeline versions must not fall back
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

Postprocessing has no formal end-to-end timer. Local file timestamps suggest
roughly 30 additional seconds for cleaning/export, including preview outputs.
Therefore **1–2 minutes from prepared references** is only an engineering
projection. A brand-new photo-to-playable run has not been measured: this test
reused Fran's prepared white upright and prebuilt Template Zero atlases.
Do not put a guaranteed “ready in 45 seconds” claim or countdown in the UI.

Meterkey recorded USD 0.10 per sheet, USD 0.20 total; the prior estimate was
USD 0.32. Final settlement/provider invoice was not confirmed. This excludes
identity preparation, retries, storage/processing and retail margin. It is
not the full cost or selling price of creating a new character from a photo.

## Integration and generation experience still to implement

- Persist a versioned renderer/template manifest through authorization, durable
  jobs, provider idempotency, artifacts, recovery and per-asset retries. Keep
  existing session, spending and refund boundaries intact.
- Port atlas packing, white-background removal, frame maps, holds and fixed
  registration into the Insert Player processor. No manual Codex steps or
  personal credentials may be required for a user's creation.
- Prepare the user's identity through the application, reuse the prepared
  upright, and submit the two Rookie sheets in parallel. Keep source photos
  private and do not send them again for every animation/frame.
- Validate both outputs, preserve RAWs, persist playable assets and load the
  actual Fight/Aura renderers. Do not substitute another character or resize
  each pose to hide a failed grid or registration mismatch.
- Show real stages: preparing your character, creating moves, finishing the
  cutouts, saving, ready to play. Reveal the owned prepared portrait and then
  validated animations as they become available. Do not fake progress or
  show a partial character as complete. Recovery must survive navigation.
- Measure upload-to-ready time with a new identity, both quality levels and
  failure/retry recovery in the existing review environment before cutover.
  Retire the old comparison assets from merchandising only when an honest
  new Rookie/Champion same-character comparison is available.

Only after that validation should default new purchases switch to the new
renderers. This policy PR deliberately does not perform that cutover.
