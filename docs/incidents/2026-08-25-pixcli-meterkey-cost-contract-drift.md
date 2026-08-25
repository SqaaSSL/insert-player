# Incident review: PixCLI / Meterkey price-contract drift

**Date:** 2026-08-25  
**Status:** Confirmed; paid image canaries remain blocked pending remediation  
**Severity:** SEV-2 for platform cost integrity; low absolute impact, high systemic risk  
**Affected systems:** Insert Player, PixCLI, Meterkey, FAL queue transport  
**Observed model:** `grok-imagine-image-2-edit` -> `xai/grok-imagine-image/v2.0/edit`  
**Observed operation:** one internal Javier Milei `high_punch` frame canary  

## Executive summary

Insert Player obtained explicit approval for a paid canary with a maximum stated cost of **$0.07**. Its preflight then confirmed that PixCLI still advertised `cost_per_image = 70000`, and the runner submitted exactly one image request with no retry or fallback.

Meterkey reserved and recorded **90,000 internal microcredits ($0.09)** for that same request. The approved maximum was therefore exceeded by **20,000 microcredits ($0.02), or 28.57%**.

This was initially described as a markup discrepancy. Production data disproves that diagnosis:

- the dedicated Insert Player Meterkey user has `custom_markup = NULL`;
- the active model-pricing row has `markup = 1`;
- Meterkey's request-aware pricing table maps `quality=medium` plus `resolution=2k` to `90000`;
- PixCLI's model catalog exposes only the scalar `cost_per_image = 70000`.

The root cause is therefore **cross-service price-contract drift**, compounded by a preflight that treated an informational scalar catalog field as a hard maximum. Meterkey priced the payload according to its own active table; PixCLI and Insert Player authorized it according to a different, less expressive contract.

The `$0.09` entry is a wallet debit / conservative settlement in Meterkey. It is **not yet proof of FAL's final wholesale invoice**: `provider_actual_uc` remains `NULL`, the correlated `fal_jobs` row is `UNKNOWN`, and no provider billing event has been attached. Those reconciliation gaps are tracked separately below.

## Impact

### Direct impact

- One internal QA request exceeded its human-approved maximum by `$0.02`.
- No Stripe checkout or real customer payment was attempted.
- No Insert Player user credit was consumed by this admin canary.
- The generated Milei frame remained experimental and was not activated in the playable Arcade roster.
- The output was rejected by human review because Milei was not sufficiently recognizable.
- There was exactly one provider submit, zero automatic retries, zero fallback calls, and zero resubmissions.

### Systemic impact

The absolute delta is small, but the invariant violation is not. If the same mismatch scales to a full fighter, batch, video, or a model with wider price variants, a confirmation such as "maximum `$X`" does not currently cap the amount Meterkey can reserve or settle.

The current contract permits all of the following:

1. UI or CI approval based on stale or incomplete PixCLI catalog data.
2. A transformed request body selecting a more expensive Meterkey pricing variant.
3. Meterkey accepting the request because it has no caller-supplied atomic maximum.
4. The provider request starting before the mismatch is visible to Insert Player.
5. Reconciliation later changing the economic interpretation without a single canonical audit record shared by all three systems.

No further paid canary should rely on `cost_per_image` as a budget ceiling.

## What happened

### Intended contract

The canary manifest and production runner fixed the following policy:

| Field | Intended value |
|---|---:|
| PixCLI model id | `grok-imagine-image-2-edit` |
| Provider endpoint | `xai/grok-imagine-image/v2.0/edit` |
| Outputs | `1` |
| Resolution | `2k` |
| Quality | `medium` |
| Output format | `png` |
| References | `3` |
| Automatic retries | `0` |
| Fallback | `none` |
| Prompt enrichment | `false` |
| Catalog estimate | `70000` / `$0.07` |
| Human-approved maximum | `$0.07` |

The three input references were role-separated and hash-pinned:

| Role | SHA-256 |
|---|---|
| Motion pose and composition master | `0f41337e9c79265c671906f9f5081280a72f9b72c0eacba04e649cf0bcd22d61` |
| Approved Gemini canonical character | `41dcb1e372fdfd36b7f53ba461198fdf26e645b637e3b4417a0833414a702559` |
| Real identity safeguard | `79d329b9bc0668de2d2df78f1ac0b6a3183aa9977e92055c63165046c6009f6c` |

### Actual Meterkey contract

The active production pricing row was:

```json
{
  "id": "price_fal_grok_imagine_image_2_edit_20260825",
  "provider": "fal",
  "model": "xai/grok-imagine-image/v2.0/edit",
  "per_request_uc": 90000,
  "markup": 1,
  "pricing": {
    "basis": "variant_image_table",
    "variant_fields": ["quality", "resolution"],
    "variant_defaults": {
      "quality": "medium",
      "resolution": "2k"
    },
    "multiplier_fields": ["num_images", "num_outputs", "n"],
    "default_quantity": 1,
    "table_uc": {
      "low": { "1k": 50000, "2k": 70000 },
      "medium": { "1k": 70000, "2k": 90000 }
    }
  }
}
```

For the submitted `medium + 2k` body, this table deterministically selects `90000`. The scalar `70000` published by PixCLI is ambiguous: it could represent `low + 2k`, `medium + 1k`, a legacy default, or another catalog convention. It cannot describe all variants.

## Timeline

All timestamps below are UTC.

| Time | Event |
|---|---|
| Before submit | Insert Player verified the PixCLI catalog entry and required exact `cost_per_image = 70000`. |
| Before submit | Human confirmation authorized one paid output with a displayed maximum of `$0.07`. |
| Before submit | Pose, canonical, and identity inputs were hash-verified; no playable pointer was changed. |
| `2026-08-25T22:23:33.644Z` | Meterkey created request `mk_req_MX9nOvyYQARIxa5zGDD4` and estimated `90000`. |
| `2026-08-25T22:23:34.112Z` | Meterkey recorded successful HTTP `200`, `actual_uc = 90000`, duration `468 ms`. |
| `2026-08-25T22:23:55.534Z` | Correlated FAL queue job was marked terminal locally with HTTP `200`; status normalized to `UNKNOWN`. |
| After completion | The GitHub Action completed successfully and archived the one generated output. |
| Human review | The output was rejected for insufficient facial likeness; it remained inactive. |
| Audit | Wallet/model rows showed `$0.09`; investigation disproved the initial markup hypothesis. |

## Audit identifiers

These identifiers are intentionally retained for cross-service tracing. No API secret is included.

| System | Identifier |
|---|---|
| GitHub Actions run | [`32905501274`](https://github.com/SqaaSSL/insert-player/actions/runs/32905501274) |
| Insert Player candidate | `arcade-qa-milei-high-punch-f4-xai-v1` |
| PixCLI job | `cda68846870746da1c87b4e0f9d1210d` |
| Meterkey request | `mk_req_MX9nOvyYQARIxa5zGDD4` |
| Meterkey hold | `mk_hold_0BZ1u57PUFtOyrwuh5WW` |
| Meterkey user | `mk_usr_P47kwJ4xFO6ahsEkHmT8` |
| Meterkey key id | `mk_key_5fHQP8UDzxXdNFbXKdsH` |
| Meterkey wallet | `mk_wal_P47kwJ4xFO6ahsEkHmT8` |
| FAL queue request | `01a03b05-8ab6-7800-b57b-e54f28738f5d` |
| Fighter draft | `f0915dca6c2cec6f509ee330e4f17b15` |
| Pricing row | `price_fal_grok_imagine_image_2_edit_20260825` |

## Evidence

### PixCLI / Insert Player side

The production manifest pins:

```json
{
  "modelId": "grok-imagine-image-2-edit",
  "endpoint": "xai/grok-imagine-image/v2.0/edit",
  "provider": "xai",
  "backend": "fal",
  "catalogCostPerImage": 70000,
  "estimatedCostUsd": 0.07,
  "numImages": 1
}
```

The runner refuses to submit unless the live PixCLI catalog still reports that exact scalar price. This protected against silent catalog drift inside PixCLI, but it did not compare the normalized request against Meterkey's authoritative variant table.

### Meterkey request log

```text
provider       fal
model          xai/grok-imagine-image/v2.0/edit
status_code    200
success        1
estimated_uc   90000
actual_uc      90000
duration_ms    468
error_code     NULL
```

### Markup checks

```text
users.custom_markup       NULL
model_pricing.markup      1
```

There is no evidence that a user-specific, model-specific, or default markup converted `$0.07` to `$0.09`. The entire observed difference is explained by the active variant table.

### FAL reconciliation row

At the time of this review:

```text
status                    UNKNOWN
billed_uc                 90000
refund_uc                 0
provider_actual_uc        NULL
settlement_adjustment_uc  0
reconciliation_eligible   1
final_http_status         200
billing_event_json        {}
```

This means:

- Meterkey has accounted for `$0.09` in its wallet/request ledger.
- We have not yet attached FAL's final provider billing event.
- We must not describe `$0.09` as FAL's invoice or proven wholesale cost.
- The row is eligible for reconciliation, but its `UNKNOWN` terminal state needs investigation.

## Root cause

### Primary cause: two incompatible sources of price truth

PixCLI and Insert Player used a scalar catalog price. Meterkey used request-aware variant pricing. Both contracts were internally consistent, but they did not describe the same request price.

The true request price depends at least on:

- model endpoint;
- quality tier;
- output resolution;
- output count;
- possibly the number and size of input images;
- the effective pricing version at submit time;
- any applicable account/model markup.

A scalar `cost_per_image` cannot safely authorize a payload whose price is selected from a multidimensional table.

### Enforcement gap: approval was advisory, not atomic

Insert Player stored and checked `$0.07`, but did not transmit an enforceable `max_charge_uc = 70000` to the component that created the wallet hold. Meterkey therefore had no instruction to reject its own `$0.09` quote before contacting FAL.

The approval and the wallet hold were two separate facts rather than one atomic economic contract.

### Observability gap: overloaded cost fields

The systems currently use names such as `cost_per_image`, `estimatedCostUsd`, `pixcliCostEstimate`, `estimated_uc`, and `actual_uc` without a shared definition of whether each value means:

- catalog hint;
- normalized request quote;
- approved maximum;
- wallet reservation;
- wallet settlement;
- provider-estimated wholesale;
- provider-final wholesale;
- marked-up retail cost.

This makes a technically correct ledger entry easy to report incorrectly.

## Contributing factors

1. PixCLI's catalog flattened variant pricing into one number.
2. Insert Player duplicated `70000` in the manifest, runner guard, workflow copy, and tests.
3. The preflight queried PixCLI only; it did not ask Meterkey to price the exact normalized request.
4. There was no server-enforced approved maximum in the Meterkey reservation call.
5. PixCLI did not return a price version or quote digest that could be bound to the job.
6. The output count was fixed, but quality and resolution still selected a different table cell.
7. Three input images were supplied while the pricing note says "output tier plus one input image"; the effect of additional inputs is not represented in the observed pricing JSON.
8. The successful FAL result and `UNKNOWN` queue status obscure whether reconciliation consumed the response action, a status action, or both.

## What worked

Several controls materially limited the incident:

- Exact provider/model pinning prevented substitution.
- The request had one output only.
- Automatic retry and resubmit were disabled.
- Fallback was disabled.
- Prompt enrichment was disabled.
- Input assets and request policy were hash-pinned.
- The output remained draft/experimental and never changed a playable pointer.
- Human review rejected poor identity preservation.
- Request, hold, wallet, PixCLI job, and FAL queue identifiers were retained.
- The mismatch was visible after a single request rather than after a roster batch.

## Separate issues that must not be conflated

### Earlier FAL queue-control `403` / PixCLI `502`

The earlier polling failure was caused by FAL canonicalizing a versioned model URL and Meterkey deriving the wrong allowlist model from the canonical status path. That transport/correlation defect is documented in [PixCLI issue #16](https://github.com/SqaaSSL/pixcli/issues/16).

It is not the cause of this `$0.07 -> $0.09` discrepancy.

### Output quality

The generated frame failed the user's likeness criterion. That is a model/prompt/evaluation result, not a billing root cause. The same immutable inputs may be used for a future provider comparison only after the economic contract is repaired.

### Provider invoice

Meterkey's `$0.09` wallet amount is not yet FAL's final wholesale billing event. Reconciliation must not be used to retroactively excuse an approval-cap violation: even if FAL later reports `$0.07`, Meterkey still reserved and exposed `$0.09` after a `$0.07` approval.

## Immediate containment

Effective immediately:

1. Do not run another paid image or video canary whose approval is based only on PixCLI `cost_per_image`.
2. Do not retry the Milei output automatically.
3. Do not start the Trump video canary in PR [#97](https://github.com/SqaaSSL/insert-player/pull/97) until the same gate supports its exact payload.
4. Keep existing canary outputs and ledgers immutable for audit.
5. Keep provider/model pinning, `fallback:none`, and zero retries.
6. Do not bypass Meterkey or use a different project/key to avoid this gate.

## Required target contract

Meterkey should be the authority for **wallet charge quoting**. The provider billing event should be the authority for **final wholesale cost**. PixCLI's model catalog may remain informational, but it must not authorize spend.

### Quote before submit

PixCLI should normalize the final provider request first, then request an authoritative quote from Meterkey before any provider call. A possible contract:

```http
POST /v1/quotes
Idempotency-Key: <stable operation id>
Content-Type: application/json
```

```json
{
  "provider": "fal",
  "model": "xai/grok-imagine-image/v2.0/edit",
  "operation": "image.edit",
  "normalized_input": {
    "quality": "medium",
    "resolution": "2k",
    "num_images": 1,
    "input_image_count": 3
  },
  "payload_sha256": "<hash of the normalized billable request>",
  "requested_max_charge_uc": 70000
}
```

An accepted response should contain at least:

```json
{
  "quote_id": "mk_quote_...",
  "pricing_version": "price_fal_grok_imagine_image_2_edit_20260825",
  "payload_sha256": "...",
  "currency": "USD",
  "wallet_charge_uc": 90000,
  "provider_estimate_uc": null,
  "markup_multiplier": 1,
  "expires_at": "...",
  "approved": false,
  "rejection": {
    "code": "quote_exceeds_requested_max",
    "requested_max_charge_uc": 70000,
    "quoted_charge_uc": 90000
  }
}
```

### Atomic maximum at reservation

The provider submit must reference the quote and repeat the cap:

```json
{
  "quote_id": "mk_quote_...",
  "payload_sha256": "...",
  "max_wallet_charge_uc": 70000
}
```

Meterkey must reject before creating a hold or contacting the provider when any of these changes:

- pricing version;
- normalized payload hash;
- model or provider;
- quote expiry;
- calculated wallet charge;
- caller-approved maximum.

This check must be atomic with hold creation. A check performed only in Insert Player or PixCLI is insufficient.

### Required cost vocabulary

Every system should use explicit fields with the same units:

```text
catalog_hint_uc
billing_quote_uc
approved_max_uc
wallet_reserved_uc
wallet_settled_uc
provider_estimated_uc
provider_actual_uc
markup_multiplier
pricing_version
quote_id
payload_sha256
reconciliation_status
```

`actual_uc` without a qualifier should be deprecated because it is unclear whether it means wallet or provider actual.

## Remediation by service

### Meterkey

- Add a request-aware quote/dry-run endpoint that uses the same pricing code as hold creation.
- Accept and atomically enforce `max_wallet_charge_uc`.
- Return `quote_id`, `pricing_version`, normalized billable dimensions, and payload digest.
- Ensure submit cannot mutate priced dimensions after quote validation.
- Expose wallet reserve, wallet settlement, provider actual, markup, and reconciliation status separately.
- Investigate why a successful result remains `fal_jobs.status = UNKNOWN`.
- Confirm how additional input images are billed for this endpoint.
- Reconcile the observed FAL request and retain the billing event evidence.

### PixCLI

- Stop representing variant-priced models with an authoritative scalar `cost_per_image`.
- Either expose the full pricing schema as informational data or omit the scalar for variable-price models.
- Normalize the final provider payload before requesting a Meterkey quote.
- Pass the caller's maximum through unchanged and fail closed on quote rejection.
- Store and return the quote, pricing version, wallet charge fields, and reconciliation state with each job.
- Keep explicit-model requests pinned with no equivalent-model fallback.

### Insert Player

- Bind human approval to exact model, normalized payload hash, quote id, pricing version, output count, and maximum wallet charge.
- Display the authoritative Meterkey wallet quote, not the PixCLI catalog hint.
- Fail closed if a quote changes between approval and submit.
- Archive the quote beside provider request ids and immutable input hashes.
- Distinguish wallet spend from provider wholesale in D1 and operator output.
- Remove hard-coded `70000` assumptions after the authoritative quote path exists.
- Keep all paid QA calls at one output, zero retry, and no fallback until the contract is proven.

## Acceptance criteria

The incident can be closed only when all of the following pass:

1. A `medium + 2k` xAI edit request receives one canonical quote at every layer.
2. A caller-approved maximum of `70000` is rejected before provider contact when the quote is `90000`.
3. Repeating the same quote/job idempotency key does not create a second hold or provider request.
4. Changing quality, resolution, output count, model, or payload hash invalidates the quote.
5. PixCLI no longer presents `70000` as the maximum for the observed `medium + 2k` body.
6. Insert Player's confirmation copy is generated from an unexpired authoritative quote.
7. Audit records preserve catalog hint, quote, approval cap, reservation, settlement, provider actual, markup, and reconciliation as separate values.
8. Tests cover three input references and verify whether additional inputs affect price.
9. FAL queue status/result polling reaches an unambiguous terminal state.
10. No real payment, batch, retry, or fallback is needed to prove the guard; mocked contract tests must fail before one tightly bounded live canary is approved.

## Regression test matrix

| Case | Expected result |
|---|---|
| `low + 1k`, one output | Quote exact table cell; submit only at or below cap. |
| `low + 2k`, one output | Quote `70000` under current table. |
| `medium + 1k`, one output | Quote `70000` under current table. |
| `medium + 2k`, one output | Quote `90000` under current table. |
| Two outputs | Quantity multiplier reflected before approval. |
| Three reference images | Input-image billing explicitly represented and tested. |
| Catalog hint differs from quote | Catalog cannot authorize; quote wins. |
| Price changes after quote | Submit rejected; new human approval required. |
| Payload changes after quote | Submit rejected before hold/provider call. |
| Duplicate idempotency key | Same quote/job returned; no duplicate charge or inference. |
| Provider HTTP failure | Wallet/provider outcomes recorded separately. |
| Missing billing event | Reconciliation stays pending; never reported as invoice. |

## Open questions

1. What does PixCLI's `70000` scalar intend to represent: a default, minimum, low/2k, medium/1k, or stale price?
2. Does FAL charge for all three input images on `xai/grok-imagine-image/v2.0/edit`? Meterkey's note currently mentions one input image.
3. Why did Meterkey record a terminal HTTP `200` while leaving the FAL job status `UNKNOWN`?
4. Which queue action supplied the terminal payload: status, response, webhook, or reconciliation cron?
5. When will `provider_actual_uc` and `billing_event_json` be populated for this request?
6. Should wallet settlement wait for provider actual when the provider supports reliable billing events, or remain conservative and reconcile later?
7. How should quote expiry and provider price changes be surfaced to a human-approved GitHub Action?

## Recommended ownership and order

| Priority | Owner | Deliverable |
|---|---|---|
| P0 | Meterkey | Exact quote plus atomic maximum enforcement using production pricing code. |
| P0 | PixCLI | Quote integration after payload normalization; no scalar authorization. |
| P0 | Insert Player | Approval bound to quote id, payload digest, and maximum charge. |
| P1 | Meterkey | FAL terminal-state and billing-event reconciliation fix. |
| P1 | All | Shared cost vocabulary and trace fields. |
| P1 | All | Cross-repository contract/regression suite. |
| P2 | PixCLI | Rich model pricing schema for display and planning. |

Recommended implementation order:

1. Implement and test Meterkey quote/max-cap primitives.
2. Integrate them into PixCLI after final request normalization.
3. Replace Insert Player's scalar catalog gate with quote-bound approval.
4. Run mocked end-to-end contract tests.
5. Perform one read-only production preflight.
6. Ask for explicit approval of one newly quoted paid canary.
7. Submit once, stop, and reconcile before any second provider/model comparison.

## Closure evidence checklist

- [ ] Meterkey PR and deployment id recorded.
- [ ] PixCLI PR and deployment id recorded.
- [ ] Insert Player PR and deployment id recorded.
- [ ] Unit and integration tests linked.
- [ ] Production quote for the exact three-reference request archived.
- [ ] Rejection proof for `approved_max_uc < billing_quote_uc` archived.
- [ ] Proof that rejection made zero provider requests archived.
- [ ] FAL billing event or explicit reconciliation terminal state attached.
- [ ] One newly approved live canary reconciled from quote through provider actual.
- [ ] Paid image/video canary block deliberately removed.

## Data handling note

This document includes non-secret audit identifiers and content hashes needed for incident correlation. It intentionally excludes API key material, Clerk tokens, signed asset URLs, source photographs, generated images, and raw provider payloads containing media URLs.
