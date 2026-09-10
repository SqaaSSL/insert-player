# Aura-first product experience

Approved scope (9 September 2026): give Aura its own entry, keep one Insert Player identity and library, retain direct Fight access, put Rush third, preserve intent through creation and checkout, explain capability packages and their actual cost, and turn results into playable asynchronous challenges. Existing game mechanics remain intact while an independent design review considers a more body-focused challenge.

## Integration baseline

Created `codex/aura-product-experience` from fetched `origin/develop` (`ca6a4c7`) and merged the existing clean `codex/aura-crowd-dynamics` (`4960452`). This retains the already-authored Aura performance packs, calibrated presentation, audio, and match-video export. No other working tree is modified. Releases must use protected branches and the existing CI gates.

## Acceptance criteria

- New visitors see Aura first; game-specific entries show the selected experience and a playable trial. Returning players can continue their most recent game.
- Aura selection requires all six dedicated performance animations for both seats. Shrug is optional. Fight-only characters remain available in Fight/Rush, and the official Trump plus generic trial performers keep their existing dedicated bundles.
- Main navigation is Play, My characters, Challenges; credits/account and community remain reachable without competing with first play.
- Aura, Fight, and Rush communicate performance, rivalry, and adventure respectively. Rush accurately describes its CPU companion.
- Creation preserves game, challenge, package, and quality context through login, checkout, recovery, and completion. Original/Video remains available as an advanced choice.
- Aura-only and complete offers are server-bound generation capabilities with tested cost assumptions. Existing assets remain usable, preserved, and private. Expanding a character does not charge or regenerate previously supplied work unnecessarily.
- Checkout states today's payment, credits received, generation cost, and remaining balance. A failed or cancelled checkout cannot imply success.
- An Aura result can share its existing actual video and a specific, bounded, versioned challenge that another person can play without account creation. Invalid or incompatible challenges fail clearly. Social scores are not ranked proof.
- Instrument activation, completion, creation, challenge sharing/opening, and return visits without names, photos, tokens, or private asset identifiers. Keep initial measurement local and inspectable unless an existing consented analytics destination is configured.
- Validate meaningful unit/integration contracts, production checks, builds, and desktop/mobile browser flows. No paid inference or financial transaction is needed for these checks.

## Ownership during implementation

- Root: app routing, creation and checkout UI, roster simplification, integration and browser validation.
- Generation agent: package contract, pricing, billing binding, durable jobs, processor and expansion tests.
- Challenge agent: bounded asynchronous challenge format, results/share UX, challenge screens, game input integration.
- Design agent: nonblocking minigame comparison, then landing/play surfaces.

## Validation log

- Full `npm run check:production` passed, including 1,919 unit/integration tests (6 skipped), Worker binding/type checks, processor/video/benchmark tests, source/privacy/deployment guards, D1 schema checks and isolated prelaunch build.
- Normal frontend production build passed. It retains the existing large Phaser bundle warning.
- Desktop and 390px mobile review covered Play, Aura/Fight landings, Rush settings and the package form. The local preview has no live Clerk/roster/Stripe configuration; authenticated payment and paid image generation were not exercised.
- Focused regressions cover immutable generation plans, ownership, repeated/concurrent expansion reservations, partial-work resumption, challenge tampering, media bytes, P2 timing/controls, character preservation on Remix, creation context and account-scoped draft restoration.
- A full browser Aura match completed with all seven bundled generic performance/reaction sheets, results and its actual match-video export. The generated challenge link opened the matching recipient screen, retained its token and package through creation and Back, and started the recipient challenge without an account. No link or video was sent to another person.

## Aura challenge design assessment

The current look has a credible connection to real-world aura battles: six-seven, one-leg and floor-worm are authored, recognizable performances. The four lanes currently compete with the performance for attention, and the performance selection and sprite-loop phase are independent from the note accents. That is the main design risk, not an absence of a challenge.

Retain the current rhythm game while validating one alternative phrase: watch a short gesture, answer its accents, hold a pose and release on the finish. Put the cues beside the body; synchronize animation anticipation and its key pose with the scoring targets. Start with two touch controls and explain misses as early/late or release timing. Score measurable timing; the crowd reacts to that score rather than judging an unspecified charisma value.

A prototype candidate uses three eight-beat phrases, around 22–25 seconds including both turns and result. The candidate accuracy windows (80ms excellent / 160ms hit) are hypotheses for testing, not tuned release constants. Test whether people look at the body, can name the gesture, understand lost points, and want to reply to a friend.

Sources reviewed: AP, 2 September 2026, [real aura competitions](https://www.wral.com/news/ap/5b829-aura-farming-the-video-game-inspired-youth-trend-sweeping-latin-america/); [Red Bull Dance Your Style format](https://www.redbull.com/my-en/red-bull-dance-your-style-introduction). These support the performance/crowd analogy; they do not establish demand or retention for this product.

## Measurement limits

ProductEvents records bounded device-only diagnostics, exportable under Credits. No analytics transmission or identity tracking was added. It is ready for a supervised playtest, but cannot establish acquisition conversion, unique-user return or viral coefficient across devices. Share actions distinguish link creation and completed video handoff; opening a share sheet alone is not evidence a friend received it.

## Rollout boundary

This work is implemented in a separate local branch based on fetched develop, incorporating the user's latest Aura crowd/animation branches first. The original dirty checkout was preserved. Production has not been changed. Release requires migration 0037, a successful canonical CI run, and a controlled paid Aura generation canary before broadly offering the new package. Local/mock tests prove contracts and pricing rules; they cannot prove a provider will return six visually convincing movements at the projected cost.

The repository is public. No new private source image, credential or playtest export belongs in a publication. Existing local historical artwork in the merged Aura branches should be reviewed before pushing their full history.
