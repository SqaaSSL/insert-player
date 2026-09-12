# Character quality

## Current product contract — 2026-09-12

There are two purchase choices: **Rookie** and **Champion**. Champion is the
former Contender offer. The former third premium offer is retired for new
purchases. This is a quality simplification, not a credit-pack repricing.

| Visible quality | Persisted offer ID | Animation process | What the customer sees |
| --- | --- | --- | --- |
| Rookie | `rookie` | Generate a sheet and normalize its cells | Basic definition; a quick playable character |
| Champion | `contender` | Generate a sheet, refine frames individually, clean backgrounds | More facial, hair and clothing detail and cleaner edges |

Quality describes the delivered result and processing effort, not a provider
brand. Do not market the choices as “Flash versus Pro.” The current standard
processor still uses the existing Gemini sheet/refinement implementation; local
multi-provider experiments are separate from the public creation pipeline.
No new model has been activated by the naming change.

Stored cell size is not native image detail. Both qualities may be normalized
onto the same canvas; enlarging a Rookie cell does not create the missing
facial detail. Avoid resolution multipliers or a guarantee that every refined
frame is better: the renderer has validation/fallback behavior and results vary.

## Compatibility and billing

- Keep all historical `rookie`, `contender`, and `champion` IDs, asset ranks,
  versions, model selection and original job quotes. Never rewrite or delete
  purchased assets to rename an offer.
- Public `QUALITY_TIERS` / `OFFERED_TIER_ORDER` expose only `rookie` and
  `contender`. Both refined historical IDs display as Champion. Neither offers
  another paid quality upgrade.
- Unsent drafts, URLs and purchase intents normalize the retired choice to
  `contender` and display its current quote before starting. Saved jobs resume
  from their original records.
- A fresh full generation/upgrade purchase of retired `champion` returns
  `409 generation_tier_retired` before billing. Exact paid resumptions and
  per-asset maintenance retain their historical contracts.
- Add-on packs select an offered tier and reuse higher-quality owned assets.
  Each animation retry must retain the selected animation's actual quality.
- The historical reviewed Video flow remains available to existing paid jobs.
  It is not offered as a new purchase under the two standard qualities.
- Existing packs, balances and per-offer prices remain unchanged. Aura uses
  the former Rookie/Contender quotes; Fight + Rush likewise. Pricing is a
  separate product decision. The proposed entry bundle means one **Rookie
  Aura plus two Fatalities**; that bundle has not been added to checkout here.

## Real comparison in Create

The quality picker includes a same-character comparison with full-character
and face-detail views. It displays preserved Rookie and former Contender idle
frames for Nova, an original synthetic adult demo identity, generated on
2026-08-18. It is a Fight example, not a fabricated Aura recording.

`public/assets/quality/provenance.json` records identity, original archive
records, dimensions and SHA256s. The PNGs are exact archived copies. The
Rookie raw sheet was 1456×720 and its archived processed sheet is 3072×2048;
the latter is normalization, not native Rookie detail. The archive does not
contain per-request model receipts, so the comparison makes no model claim.

## Fran's local character

The inspected local combat character lives outside this release checkout at
`ai-street-fighter/.local/template-zero-provider-sweep/francisco-full-template-v1/compiled-local-francisco-v2-curated/fighter.json`.
Its sibling `provider-outputs-francisco-v1/provenance-manifest.json` records
67 selected Kling O3 masters (`fal-ai/kling-image/o3/image-to-image`) and
23 Seedream 5 Pro masters (`bytedance/seedream/v5/pro/edit`). The compiled
pack contains 13 combat animations, with 192×256 runtime cells and 768×1024
HQ cells. These two sizes are versions of that refined output, not evidence
of a Rookie/Champion comparison. Its historical `champion` metadata does not
mean it was made by the old public Gemini Pro route.

The later `.local/francisco-aura-v1/provider-round-normalized-v2/RESULTS.md`
records multi-provider Aura trials, not a complete installed Aura pack.
No private Fran assets or paid generations are included in this change.

## Historical evidence

The superseded three-level design and its measured QA sessions remain in
[`docs/history/quality-tiers-three-levels.md`](docs/history/quality-tiers-three-levels.md).
Historical cost evidence and legacy maintenance rates remain useful; its
three-choice merchandising and blanket Pro-render claims are not the current
product contract.
