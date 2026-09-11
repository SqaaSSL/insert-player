# Saved battles and optional finishers

Aura, Fight and Rush capture the rendered final scene after the result settles. Aura portrait stills omit the retired input area. The capture belongs to one scene lifecycle; rematches cannot reuse an earlier result. Capturing a frame is local and free.

The result offers an optional, collapsed **Make a finisher · 1 credit** action. Signing in, opening an offer, restoring a draft, saving a battle or polling a job never purchases a finisher. The user confirms the current generation terms and explicitly presses Generate. Local drafts bridge sign-in and credit checkout; they are temporary recovery data, not permanent battle storage.

## Persistence and sharing

- `battle_media` records a private, owned battle summary and immutable source JPEG. An available Aura match recording is copied to this battle's own R2 prefix.
- `battle_finisher_jobs` records a durable Cloudflare Workflow, source audit, provider request, credit reservation/refund and stored output. Neither generated video nor the associated original recording depends on fal's CDN retention or the older expiring Aura clip links.
- `/battles` lists saved battles. `/battles/:id` plays the original recording, when available, followed by the finisher. `/battles/:id/finisher` opens just the finisher.
- Sharing explicitly publishes the battle and its associated media. Both links are Insert Player pages with branded social previews; downloading the video is a secondary action. Private media is authenticated, including video playback.
- Deletion revokes access immediately. Tombstones guard against late generation/upload completions and maintenance removes the stored objects. Account deletion follows the same revocation path.

## Provider and billing contract

The server alone calls `minimax/h3-max-turbo/image-to-video`, using the existing `FAL_API_KEY`. The request is pinned to a five-second, 768P video with `prompt_expansion_mode: fast`, native audio and provider safety checks. The supplied frame determines aspect ratio. Fixed prompts preserve the actual winner and use a playful non-graphic arcade finish appropriate to each game; client prompts or arbitrary source URLs are not accepted.

fal advertises roughly three-second turnaround for this model, but queueing, transfer and storage add time. The interface reports progress rather than promising a deadline. The fixed accounting estimate is **$0.20 per request**, the price after the temporary September 2026 promotion, not the promotional price.

One immutable provider-attempt claim bounds a job to one paid submission. A lost submission response never triggers an automatic second provider POST. The user's reservation is returned once if a durable playable result cannot be delivered; provider spend is recorded independently. Concurrent clicks, reloads and two tabs recover the existing active job. A failed finisher can be retried only through another deliberate purchase action.

Workflow dispatch can be recovered by maintenance using the same job ID. Production binds `BATTLE_FINISHER` to `insert-player-battle-finisher`; sandbox uses its own workflow. Migration 0039 creates the battle and job tables. Deploy through the existing protected-main production workflow; no manual production schema or provider mutations are required.

## Validation

Tests cover real D1/R2 semantics for credit concurrency/refunds, publication and ownership, streaming bounded storage, provider submission uncertainty, workflow recovery and deletion races. Browser QA exercises color/touch controls, turn handoffs, audio lifecycle, final frame capture and the generation/share UI with mocked provider responses. A mocked provider check does not establish the quality or latency of a real paid output.
