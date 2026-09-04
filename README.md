# Insert Player

Insert Player turns a real portrait into a persistent, playable 2.5D fighting-game character. The public product is **Insert Player**; `AI Street Fighter` is a legacy internal project name and must not appear in public product copy.

This repository contains:

- A React/Vite product shell and gallery.
- A Phaser fight runtime loaded only for matches.
- A Cloudflare Worker API and provider proxy.
- Cloudflare Workflows plus an image-processor Container for generation that survives disconnects.
- D1 persistence for users, fighters, billing, sharing, moderation, and cost events.
- R2 storage for source images, generated sprites, and every preserved asset version.
- Clerk authentication and Stripe credit-pack billing.

## Start Here

Read these documents before making architectural or product changes:

1. [`CLAUDE.md`](./CLAUDE.md): architecture, conventions, and hard constraints.
2. [`ROADMAP.md`](./ROADMAP.md): current state, deployed resources, blockers, and next work.
3. [`QUALITY_TIERS.md`](./QUALITY_TIERS.md): tier pipelines, pricing, cache rules, and economics.

Operational and product references:

- [`PRODUCTION_READINESS.md`](./PRODUCTION_READINESS.md): complete Clerk, Stripe, Cloudflare, and launch runbook.
- [`PRODUCTION_AUDIT.md`](./PRODUCTION_AUDIT.md): implemented production controls and remaining evidence.
- [`PRODUCT.md`](./PRODUCT.md): product and growth decisions.
- [`DESIGN.md`](./DESIGN.md): UI and visual-system contract.
- [`BRANDING.md`](./BRANDING.md): public naming and brand-clearance record.

## Environment Matrix

| Environment | Frontend | API | Identity and billing | Storage |
|---|---|---|---|---|
| Local | `http://127.0.0.1:5173` | `http://127.0.0.1:8787` | Clerk Development, Stripe test | Local Wrangler D1/R2 |
| QA | [insert-player-sandbox.pages.dev](https://insert-player-sandbox.pages.dev) | `https://insert-player-api-sandbox.shellbot.workers.dev` | Clerk Development, dedicated Stripe sandbox | Isolated sandbox D1/R2 |
| Production | [insertplayer.ai](https://insertplayer.ai) | [api.insertplayer.ai](https://api.insertplayer.ai) | Clerk Production, dedicated Stripe live | Isolated production D1/R2 |

Production serves the full app with Clerk Production, dedicated live Stripe configuration, and Cloudflare Workflow/Container generation. QA remains the environment for paid-provider generation and test Checkout. The protected `main` and `develop` branches are byte-for-byte aligned; both databases are migrated through `0024` and both Workers report healthy `0.18.0` runtimes. Production Actions `32767504225` / `32769749516` and development Actions `32767773857` / `32770040565` passed their complete checks, migrations, Worker/Container/Workflow deploys, API smokes, Pages deploys, and readiness checks with the durable account-owned Cloudflare token. Authenticated sandbox Action `32768251105` also passed two-user Clerk, D1/R2, billing-reservation, privacy, clone, match, cleanup, webhook, and tombstone validation without inference or Stripe charges. Promotion from protected branches is the canonical team release path; Markdown-only changes are CI-validated without redeploying unchanged infrastructure.

Never point a local or QA build at production storage, Clerk, Stripe, or Worker secrets. Never install test Stripe credentials on the production Worker.

## Prerequisites

- Node.js `22.23.2` recommended (`>=22.12.0` required).
- npm.
- A Clerk Development publishable key and issuer.
- Provider keys supplied through the team's secure secret channel when generation work is required.
- Wrangler authentication only for remote Cloudflare operations.

Install both workspaces:

```bash
npm ci
npm --prefix worker ci
```

## Local Development

Create ignored local configuration files:

```bash
cp .env.example .env.local
cp worker/.dev.vars.example worker/.dev.vars
```

Fill them with **development/test values only**. Do not commit either file and do not paste secrets into issues, pull requests, chat, logs, or screenshots.

Initialize the local D1 database:

```bash
npm --prefix worker run db:migrate:local
```

Run the Worker and frontend in separate terminals:

```bash
npm --prefix worker run dev
```

```bash
npm run dev
```

Open `http://127.0.0.1:5173`. The frontend calls the local Worker at `http://127.0.0.1:8787`.

The Vite development proxy remains available for focused frontend work, but production-shaped auth, billing, provider sessions, D1, and R2 behavior should be tested through the Worker.

### Recover a legacy browser cache

Older paid generations can be inventoried and exported from the exact local origin that created them without mutating IndexedDB:

```bash
npm run cache:audit -- --port=5173
```

Open both `http://localhost:5173` and `http://127.0.0.1:5173`, because browser storage is isolated by hostname. Each export is a lossless TAR containing the fighter metadata, source views, every preserved sprite version, and intro media. Archives are written with unique timestamped names to ignored `.local/legacy-cache-rescue/`; verify and move them into account-owned cloud storage before clearing browser data. Use another `--port` for a cache created by a different Vite origin.

## Required Checks

Run the full gate before requesting review or deploying:

```bash
npm run check:production
```

This includes frontend style guards, TypeScript, 328 tests across 63 files, Worker typechecking, a clean replay of D1 migrations through `0024`, the provider benchmark, a credential-free prelaunch scan, per-artifact checkpoint/resume and crash-recovery checks, billing reconciliation, provider-session controls, bounded streaming provider caches, durable cost accounting, privacy checks, and tier profitability.

Useful focused commands:

```bash
npm test
npm run build
npm run check:frontend
npm run check:tiers
```

## QA Deployment

QA uses ignored `.env.sandbox.local` configuration and physically separate Cloudflare, Clerk, Stripe, D1, and R2 resources.

The team path is a pull request into `develop`: after CI passes, GitHub Actions deploys the isolated sandbox automatically. The commands below are the local operator equivalent.

```bash
npm run db:migrate:sandbox
npm run config:sandbox
npm run deploy:frontend:sandbox
npm run smoke:sandbox
npm run smoke:frontend-sandbox
```

`config:sandbox` validates the sandbox account boundaries, uploads Worker secrets without printing them, and deploys the sandbox Worker. Do not use QA commands with live credentials.

## Production Deployment

Production configuration and Cloudflare credentials belong in the GitHub
`production` environment. An ignored `.env.production.local` may be used for
read-only readiness checks, but it is not a routine deployment source. The
authoritative sequence and manual evidence requirements live in
[`PRODUCTION_READINESS.md`](./PRODUCTION_READINESS.md).

Merges to `main` trigger the branch-restricted `production` GitHub environment after required CI and CodeQL checks pass. Production secrets remain environment-scoped, but this owner-operated project does not require a separate manual deployment approval. See [`.github/DEPLOYMENT.md`](./.github/DEPLOYMENT.md) for branch rules, environment variables, secrets, and recovery.

High-level release order:

1. Configure the Insert Player Clerk Production instance and lifecycle webhook.
2. Bootstrap the dedicated live Stripe catalog and webhook.
3. Apply live Worker configuration and deploy the Worker.
4. Deploy the full Pages application to `insertplayer.ai`.
5. Run the authenticated launch gate with two Clerk users and completed manual evidence.

The routine release interface is GitHub Actions:

- Merge a reviewed, current pull request to `main` for the full Worker, D1, and
  Pages pipeline.
- Run **Deploy frontend only** against `main` only when its Worker-drift gate is
  satisfied.
- Verify `https://insertplayer.ai/release.json` reports the expected commit and
  entry bundle; the deployment smoke enforces both automatically.

`config:live`, production D1 commands, Worker deploys, Pages deploys, and Worker
rollout mutations fail locally before contacting Cloudflare. The exceptional
break-glass procedure is documented in [`.github/DEPLOYMENT.md`](./.github/DEPLOYMENT.md)
and requires a clean checkout of the exact remote `main` SHA plus an explicit
incident reason.

Read-only production diagnostics:

```bash
npm run check:live-readiness
npm run smoke:live
```

Official Arcade roster generation is operator-only through the `Seed Arcade roster (production)` GitHub workflow. It accepts an authenticated, non-billable `preflight` that verifies the deployed Container without restoring or mutating fighter data; generation operations restore the manifest-pinned source from private R2 and verify its exact SHA-256 hash. The Action accepts only explicit `preflight`, `dry-run`, `seed`, `resume`, `restart-draft`, `register-draft`, `prepare-canary`, or `canary-side` operations and never activates a fighter automatically. `register-draft` creates a new private fighter only when its licensed-photo identity does not resolve to any existing Arcade fighter; `prepare-canary` repairs and freezes an existing draft's source/prompt state without inference; `canary-side` starts one fresh side-only run capped at two Pro calls / `$0.30`. Billable runs require the exact `GEMINI_ONLY_PRODUCTION` confirmation and fail closed unless the approved-provider guard can prove the production processor is Gemini-only before the first call. Normal application and infrastructure deployments never seed, regenerate, or activate Arcade fighters. No paid roster inference may run without a separate explicit owner approval.

## Architecture

```text
Browser
  React product UI
  IndexedDB account-scoped cache
  Phaser match runtime (lazy loaded)
       |
       v
Cloudflare Worker
  Clerk JWT verification
  credit reservations and Stripe webhooks
  provider-session enforcement and durable cost accounting
  immutable artifact checkpoints and resumable generation runs
  fighter/community/moderation APIs
       |
       +--> Workflow + Container: durable generation, upgrades, and retries
       +--> D1: users, fighters, versions, billing, reports, cost events
       +--> R2: private source, sprite, RAW, intro, and stage assets
       +--> Gemini / fal / Runway / Freepik / Ludo via server-side secrets
```

The browser never receives provider or Stripe secret keys. Provider calls require short-lived, purpose-scoped Worker sessions so direct proxy calls cannot bypass billing, route, call-count, or per-session cost controls. D1 keeps atomic monthly aggregates and permanent per-call cost events for profitability and operations, but aggregate spend is observability rather than a global kill switch.

## Non-Negotiable Rules

- Canonical side, upright, and crouch source views always use Gemini Pro, regardless of fighter tier.
- Official Arcade roster seeding, regeneration, retries, and fallbacks are Gemini-only. Experimental image providers must never enter that runtime path; fail closed before the first provider call if isolation cannot be proved.
- Preserve every generated version locally and in cloud storage. Upgrades and retries never delete paid assets.
- Authenticated generation, upgrades, and retries must remain backend-owned durable jobs; a tab or network loss cannot cancel paid work.
- Release a generation reservation only before the first external AI request. Commit the charge atomically with that first billable attempt; provider failure, timeout, or a result needing repair must never restore credits automatically.
- The original photo and private fighter stay account-private. Publish requires a separate confirmation and exposes only the chosen fighter's clean generated source views/playable assets under the neutral author label `Player`; account names, emails, Clerk profile photos, Clerk/internal account ids, original uploads, RAW intermediates, private hashes, and archived history remain private. Public media uses revocable opaque URLs that never expose the owner-scoped R2 key. A future public handle requires separate opt-in.
- Upgrades regenerate animations from scratch while retaining prior tiers.
- React owns product UI. Do not create Phaser scenes for menus, gallery, auth, pricing, or account UI.
- Use the existing Tailwind/component CSS system. No inline styles and no raw declarations inside `@layer`.
- Keep provider and Stripe secrets server-side in Cloudflare Worker secrets.
- Keep Stripe refund/dispute reconciliation because it removes credits only after Stripe or a bank has already reversed money. Do not add an API path that voluntarily initiates generation refunds.
- Keep local, QA, and production identity, billing, storage, CSP, and environment files isolated.
- Do not expose internal provider cost estimates through public APIs.
- Do not reintroduce a global monthly or rolling provider-spend cap. Scale is controlled by paid credits, per-session route/call/cost bounds, user/IP rate limits, Turnstile, and the provider's real quotas while durable accounting remains mandatory.
- Do not weaken legal consent, rate limits, Turnstile, ownership checks, or cost-event retention to simplify a feature.

## Git Workflow

The canonical repository is [SqaaSSL/insert-player](https://github.com/SqaaSSL/insert-player).

- Branch from the current target branch and use a focused `feature/*` or `fix/*` pull request; a routine production change targets `main`.
- Use `develop` only when an intentional isolated sandbox deployment is needed, and sync current `main` into it before the test deployment if it has drifted.
- Promote sandbox-soaked `develop` work or merge a current feature branch to `main` through a protected pull request; production deploys automatically only after the required checks pass.
- Do not commit `.env*`, `.dev.vars`, Wrangler state/logs, launch evidence containing identities, or downloaded/generated user assets.
- Keep unrelated local changes intact when working in a dirty tree.
- Run `npm run check:production` before review.
- Never bypass the protected production environment with a local deploy during routine releases.

## Getting Help

For implementation context, start with `CLAUDE.md` and `ROADMAP.md`. For environment access or secrets, contact the Insert Player project owner through the team's secure credential channel. Never request secrets in a GitHub issue or pull request.
