# Global roster polish audit — 2026-08-28

## Scope

This audit covers the four active production globals and all 44 gameplay animations:

- Donald Trump
- Elon Musk
- Rosalía
- Lamine Yamal

An animation is not approved merely because its PNG and metadata are valid. It must also preserve
identity, read as the requested fighting-game action, keep coherent anatomy and registration, and
work in Gallery plus Arcade at both 1x and 2x density.

Severity in this document:

- **P1** — broken data, wrong action, severe identity/anatomy failure, or visibly broken playback.
- **P2** — playable but materially below the global-roster quality bar.
- **P3** — usable; retain provisionally and polish only after P1/P2 replacements.

## Production-wide findings

- Trump `idle` is the only geometrically invalid HQ asset. The API declares eight `768x1024`
  frames, while the bytes are a `1536x256` opaque green low-resolution sheet. Its runtime is also
  almost static: eight playback frames but only five unique poses.
- The other 43 HQ sheets agree with their declared geometry and use RGBA PNGs.
- Every fighter currently aliases `SIDE` and `UPRIGHT` to byte-identical PNGs. A real upright
  reference would provide a stronger body/identity anchor than reusing the fighting guard.
- All four `low_kick` sequences miss the requested floor-level sweep to some degree; several are
  waist-height front kicks.
- The current technical gates catch geometry, scale, alpha, and gross motion, but do not reliably
  reject the wrong move, an implausible recovery, identity drift, or a physically incoherent KO.
- Official originals remain private by policy. The audit compares against the licensed roster
  references stored privately and the public attribution metadata.
- The original source videos are still available for all 44 actions. Elon, Rosalía, and Lamine
  retain 33/33 SHA-256-verified MP4s in private R2. Trump's 15 unique source/alternate MP4s are now
  copied out of ephemeral `/private/tmp` into the ignored local archive
  `.artifacts/global-source-video-archive-20260828/trump/`; all 15 copies match their source hashes
  and contain 49 frames at 24 fps.
- Frame selection and deterministic recompilation do not call a provider. They can fix a bad cut,
  timing, registration, loop, padding, chroma cleanup, and malformed runtime/HQ output, but cannot
  invent a pose or repair anatomy that never exists in the MP4.

## Donald Trump

| Animation | Severity | Decision | Finding |
|---|---|---|---|
| `idle` | **P1** | Rebuild locally | Nearly frozen; malformed opaque-green HQ with false metadata. Recompile a real HQ sheet and a more visible deterministic breathing loop from the archived raw pose, with no inference. |
| `walk` | P3 | Keep provisionally | Readable combat walk; minor seam/scale polish only. |
| `high_punch` | P3 | Keep | Clear grounded punch. |
| `low_punch` | P3 | Keep | Clear crouched punch. |
| `high_kick` | P2 | Regenerate later | Reads as a front kick, not the specified roundhouse. |
| `low_kick` | P2 | Regenerate | Seated/front kick rather than a floor-level sweep. |
| `jump` | P3 | Keep | Clear anticipation, air, and recovery. |
| `crouch` | P3 | Keep | Usable defensive crouch. |
| `hit` | P3 | Keep | Readable recoil. |
| `ko` | P2 | Regenerate later | Falls forward and ends prone with straight legs instead of backward/compact. |
| `victory` | P3 | Keep | Clear celebration. |

Additional polish: residual scale mismatch against the larger globals and minor green/purple edge
spill after 1x downsampling.

## Elon Musk

| Animation | Severity | Decision | Finding |
|---|---|---|---|
| `idle` | P2 | Regenerate | Motion exists, but hands hang down instead of maintaining a fighting guard. |
| `walk` | P2 | Regenerate or recut | Starts as a civilian walk and turns into a trot; guard is inconsistent. |
| `high_punch` | P3 | Keep provisionally | Short but readable punch with a small step. |
| `low_punch` | P3 | Keep | Readable crouched punch. |
| `high_kick` | **P1** | Recurate now | The MP4 becomes a clear extended front kick from frame 24 onward, but the published selection stops at frame 23. Recut and pad/scale the impact frames locally; this fixes the knee read, although it cannot turn the source into a strict roundhouse. |
| `low_kick` | P2 | Regenerate | Front kick from a crouch, not a floor-level sweep. |
| `jump` | P3 | Keep | Readable jump. |
| `crouch` | P3 | Keep provisionally | Shape is usable; final guard is weak. |
| `hit` | **P1** | Regenerate | Lunges toward the opponent instead of recoiling from impact. |
| `ko` | P2 | Regenerate later | Reads as KO but ends unnaturally flat and drifts in identity. |
| `victory` | P3 | Keep | Clear celebration. |

## Rosalía

Rosalía requires a canonical identity reset before animation replacements. `SIDE`/`UPRIGHT` and
`CROUCH` depict a generic narrower-faced model rather than preserving the licensed reference's
recognisable facial structure. Regenerating isolated actions from those anchors would preserve the
underlying problem.

Required order: new identity-faithful `SIDE` → real `UPRIGHT` → coherent `CROUCH` → regenerate all
11 animations.

| Animation | Severity | Decision | Finding |
|---|---|---|---|
| `idle` | P2 | Regenerate after sources | Vertical drift and a loop pop rather than convincing breathing. |
| `walk` | P2 | Regenerate after sources | Torso/face rotate toward camera and the seam is visible. |
| `high_punch` | P2 | Regenerate after sources | Punch reads, but face/profile changes through the move. |
| `low_punch` | **P1** | Regenerate | Impact hand/forearm deform and turn yellow-green. |
| `high_kick` | P2 | Regenerate after sources | Action reads, but wind-up is long and boots show magenta/green spill. |
| `low_kick` | **P1** | Regenerate | Elevated front kick instead of a low sweep; fluorescent boot/fist. |
| `jump` | P2 | Regenerate after sources | Apex reads as levitation/dance rather than a guarded jump. |
| `crouch` | **P1** | Regenerate | Ends in a kneeling lunge rather than the defensive source crouch. |
| `hit` | P2 | Regenerate after sources | Excessive rotation and strong face/hair drift. |
| `ko` | **P1** | Regenerate | Physically incoherent orientation changes plus severe hair/hand spill. |
| `victory` | P2 | Regenerate after sources | Good intent, but hands/sleeve flicker green and the raised fist touches the top edge. |

## Lamine Yamal

| Animation | Severity | Decision | Finding |
|---|---|---|---|
| `idle` | P2 | Rebuild locally | Almost frozen, with a small visible loop pop. Use deterministic breathing from the HQ pose; selecting different source frames alone is insufficient. |
| `walk` | **P1** | Recurate now | The MP4 contains a usable walk cycle, but the current cut includes the gesture around frames 18–24 and closes badly. Select one clean step window and rebuild the loop locally. |
| `high_punch` | P3 | Keep | Clear action and closed ping-pong; small hand/face drift. |
| `low_punch` | P3 | Keep | Clear crouched punch; small mutations only. |
| `high_kick` | P2 | Regenerate later | Front/axe kick rather than roundhouse, with excessive knee chamber. |
| `low_kick` | **P1** | Regenerate | Waist-height front kick instead of a low sweep; identity changes at impact. |
| `jump` | P3 | Keep | Coherent jump; minor face/hair drift. |
| `crouch` | P3 | Keep | Stable and coherent; light green hand halo. |
| `hit` | P3 | Keep | Clear recoil; minor drift. |
| `ko` | **P1** | Regenerate | Broken hands/eyes, abrupt orientation change, identity loss, and floating final body. |
| `victory` | P3 | Keep provisionally | Clear celebration; only 2 px of runtime headroom at the peak. |

Additional source issues: the base likeness is recognisable mainly through hair/build rather than
facial structure, and the shoes retain a visible Nike Swoosh despite the no-logo generation
contract.

## Zero-inference recuration boundary

| Fighter / animation | Local-only outcome | Source limitation |
|---|---|---|
| Trump `idle` | Rebuild correct runtime/HQ geometry and deterministic breathing. | All three MP4 attempts are either static, root-drifting, or contain a punch; frame selection alone will not produce a strong natural idle. |
| Elon `high_kick` | Recut through the extension beginning around source frame 24 and reframe the impact. | The result is a high front kick, not the requested roundhouse; late toes are cropped by the source frame. |
| Lamine `walk` | Select a clean one-step window and close its loop. | Some face/hand jitter remains in the source. |
| Lamine `idle` | Build deterministic breathing from the stable HQ pose. | The MP4 itself is effectively static. |
| Rosalía `low_punch` | Omit the worst contaminated hand frames and apply local despill as a temporary patch. | Does not repair the incorrect base likeness. |
| Rosalía `crouch` | Use the defensive descent around frames 8–23 and close it as ping-pong. | Does not repair the incorrect base likeness. |

Elon `hit`, Lamine `low_kick`/`ko`, and Rosalía `low_kick`/`ko` require new source motion to
meet the action contract: their complete MP4s contain the wrong movement or an unavoidable broken
transition. Rosalía's likeness also requires a new canonical source before a final animation pass.

## Delivery order

### Wave 0 — guardrails without paid generation

1. Keep jobs that own archived video-review candidates out of the seven-day operational purge;
   otherwise D1 cascades away the revisions and R2 keys needed for zero-inference recuration.
2. Seal a durable key/hash manifest for the 33 modern private R2 MP4s and keep the verified Trump
   archive outside ephemeral storage.
3. Reject uploaded/public HQ assets whose real PNG geometry cannot contain the declared frames.
4. Fall back to the valid 1x asset when a downloaded HQ fails that same check.
5. Add review evidence for action semantics, identity, loop seam, frame uniqueness, alpha edge
   contact, and runtime/HQ agreement.
6. Keep every candidate non-current until human review; preserve all active and historical assets.

### Wave 1 — visible blockers

1. Trump: locally rebuild `idle` runtime/HQ.
2. Elon: locally recurate `high_kick`; generate a new source only for `hit`, then `idle`.
3. Lamine: locally recurate `walk` and rebuild `idle`; generate new sources for `ko` and
   `low_kick`.
4. Rosalía: rebuild canonical identity sources and all 11 animations as one reviewed set.

### Wave 2 — semantic and presentation polish

1. Replace the remaining incorrect low sweeps and non-roundhouse high kicks.
2. Improve weak walk guards and KO recoveries/end poses.
3. Normalize residual presentation scale and clean remaining chroma halos.
4. Re-review all 44 animations together in Gallery and real Arcade matches at 1x and 2x.

Use the review-gated video-dense workflow or a sealed reviewed import. Do not use the ordinary
single-animation image-sheet retry for these active globals: it defaults to the legacy animation
format and would silently replace a video-dense asset with a different delivery contract.

## Parked product work

The non-roster backlog remains recorded in `ROADMAP.md`: animated stage layers, public reference
photo UX, official stages in Gallery, live roster counts/default mirror-match prevention, and the
low-risk offline cache dedupe edge. These items stay visible but do not displace the roster waves.
