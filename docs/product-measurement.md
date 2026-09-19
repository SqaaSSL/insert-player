# Launch measurement

ProductEvents keeps the last 200 detailed, sanitized events on the device, and delivers best-effort anonymous events to Insert Player's own Worker. There is no third-party SDK, persistent visitor or session identifier, account token, cookie, referrer, raw URL, free-text campaign, contact detail, photo or fighter identifier in the delivery. Browsers expressing Do Not Track or Global Privacy Control do not send these events. There is no queue and no retry; measurement cannot hold up gameplay or purchases.

The Worker immediately increments daily aggregates in `product_event_daily`; it does not keep individual event rows or timestamps. The date is assigned by the server, in UTC. Only event name, source, game, tier, channel, event count, duration sample count and summed duration are stored. The shared contract accepts a finite vocabulary and bounds numeric values. The endpoint accepts at most 2 KiB from configured frontend origins, with at most 120 requests per hour per existing pseudonymized security rate-limit key. That security key is never written into the aggregate table. The browser also caps delivery at 100 events per page load. Scheduled cleanup removes aggregates older than the 90-day window.

## Read the report

`GET /api/admin/product-events?days=7` requires a current Clerk bearer token for an Insert Player `admin` account. It accepts 1–90 days (default 30), is rate limited, and sends `Cache-Control: private, no-store`. The response contains `events`, `daily`, `channels`, `sources`, `games` and `tiers`, each with event counts, duration samples and averages. The optional query is a count of UTC calendar days including today, not a rolling interval. No operational IDs or personal records are returned.

For a readable production report, supply the short-lived token through the secure environment variable `INSERT_PLAYER_ADMIN_TOKEN`, then run `node scripts/report-product-funnel.mjs --days=7`. Add `--json` for the complete aggregate response. The script makes one read-only request to the fixed production API, rejects redirects, and never prints or accepts authentication data as an argument. Do not paste tokens into a committed file or diagnostic report.

Example acquisition links:

- `https://insertplayer.ai/games/aura?utm_source=instagram`
- `https://insertplayer.ai/games/aura?utm_source=tiktok`
- `https://insertplayer.ai/games/aura?utm_source=whatsapp`

Only `utm_source` is read. The fixed channels are direct, Instagram, TikTok, WhatsApp, YouTube, Facebook, X, Reddit and other. `ig`, `wa`, `yt`, `fb` and `twitter` are normalized. The channel stays in memory for that open page; reloads or authentication redirects without the parameter lose it. Unknown text becomes `other`; `utm_campaign`, `utm_content`, referrer and full URLs are never delivered. `source` describes the product entry (`trial`, `landing`, `referral`, etc.), not an arbitrary campaign.

## Interpret it honestly

The client sequence is `platform_visited` → trial `game_completed` → `account_ready` → `creation_completed` → `crew_created` → `invite_created` → `invite_accepted` → `stage_completed`. Existing Aura tutorial and sharing events remain available. An event is an observed action, **not a unique person**. Reopening a page can count again; blockers, privacy signals, rate limits, navigation or network failure can reduce counts. Client events can also be forged. Ratios between adjacent counts are directional signals and may exceed 100%; they are not a cohort conversion rate. An account-ready event includes returning accounts and is not a signup.

`operational` is reported separately from existing service records: created accounts, Rookie fighters with committed charges, distinct completed Rookie fighters and creators, created invitations, confirmed accepted invitations and distinct joiners, ready Crew stages, and Stripe credit grants and distinct buyers. A committed charge can mean provider processing started, including work that later fails; `rookieFightersReady` instead requires a completed durable artifact run. Its server-measured average creation time includes any pauses and retries from that run's creation to completion. This does not cover historical creations outside durable runs or independently audit sprite quality. A pending or failed invite does not count as an accepted member. A reserved stage does not count as ready. Client calls cannot fabricate a credit purchase. Purchase counts use the original Stripe credit ledger grant date; later refunds do not erase the original purchase, so this is not net revenue. These are period activity counts, not people attributed to an acquisition channel. They include admin/test activity and exclude deleted records.

Duration averages apply to the individual events that carry `durationMs`, such as character generation. They do not measure elapsed time between anonymous funnel steps. `onboarding_started/completed/skipped` refer to the Aura tutorial, not the entire Crew journey. Link creation or opening WhatsApp never proves the recipient received it.

For the first cohort, compare counts and generation durations with existing client-error and provider-cost reports and direct feedback. True cross-device conversion or retention would require an additional, explicitly reviewed measurement design; do not infer it from these anonymous totals.

The privacy notice describes this operational aggregation. This implementation does not broaden image-generation consent, add advertising attribution or link the anonymous stream to existing accounts. Any expansion to personal identifiers, cross-site measurement or third-party analytics requires a fresh privacy and consent review.
