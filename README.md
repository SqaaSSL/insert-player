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

Production serves the full app with Clerk Production and dedicated live Stripe configuration. QA remains the environment for paid-provider generation and test Checkout; promotion to production is automated from `main` only after migrations, checks, and smoke pass.

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

## Required Checks

Run the full gate before requesting review or deploying:

```bash
npm run check:production
```

This includes frontend style guards, TypeScript, 196 tests across 40 files, Worker typechecking, a clean replay of D1 migrations through `0019`, the provider benchmark, a credential-free prelaunch scan, durable-job race/recovery checks, billing reconciliation, provider-session controls, bounded streaming provider caches, durable cost accounting, privacy checks, and tier profitability.

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

Production configuration belongs in ignored `.env.production.local`. The authoritative sequence and manual evidence requirements live in [`PRODUCTION_READINESS.md`](./PRODUCTION_READINESS.md).

Merges to `main` trigger the branch-restricted `production` GitHub environment after required CI and CodeQL checks pass. Production secrets remain environment-scoped, but this owner-operated project does not require a separate manual deployment approval. See [`.github/DEPLOYMENT.md`](./.github/DEPLOYMENT.md) for branch rules, environment variables, secrets, and recovery.

High-level release order:

1. Configure the Insert Player Clerk Production instance and lifecycle webhook.
2. Bootstrap the dedicated live Stripe catalog and webhook.
3. Apply live Worker configuration and deploy the Worker.
4. Deploy the full Pages application to `insertplayer.ai`.
5. Run the authenticated launch gate with two Clerk users and completed manual evidence.

Commands with remote production side effects:

```bash
npm run stripe:bootstrap -- --allow-live --create-webhook
npm run config:live
npm run deploy:frontend
npm run check:launch
```

Do not run these as routine development commands. `config:live` and `deploy:frontend` fail closed when live Clerk, Stripe, brand, origin, or security configuration is incomplete.

Read-only production diagnostics:

```bash
npm run check:live-readiness
npm run smoke:live
```

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
  provider-session and spend enforcement
  fighter/community/moderation APIs
       |
       +--> Workflow + Container: durable generation, upgrades, and retries
       +--> D1: users, fighters, versions, billing, reports, cost events
       +--> R2: private source, sprite, RAW, intro, and stage assets
       +--> Gemini / fal / Runway / Freepik / Ludo via server-side secrets
```

The browser never receives provider or Stripe secret keys. Provider calls require short-lived, purpose-scoped Worker sessions so direct proxy calls cannot bypass billing or spend controls.

## Non-Negotiable Rules

- Canonical side, upright, and crouch source views always use Gemini Pro, regardless of fighter tier.
- Preserve every generated version locally and in cloud storage. Upgrades and retries never delete paid assets.
- Authenticated generation, upgrades, and retries must remain backend-owned durable jobs; a tab or network loss cannot cancel paid work.
- The original photo and private fighter stay account-private. Publish requires a separate confirmation and exposes only the chosen fighter's clean generated source views/playable assets under the neutral author label `Player`; account names, emails, Clerk profile photos, Clerk/internal account ids, original uploads, RAW intermediates, private hashes, and archived history remain private. Public media uses revocable opaque URLs that never expose the owner-scoped R2 key. A future public handle requires separate opt-in.
- Upgrades regenerate animations from scratch while retaining prior tiers.
- React owns product UI. Do not create Phaser scenes for menus, gallery, auth, pricing, or account UI.
- Use the existing Tailwind/component CSS system. No inline styles and no raw declarations inside `@layer`.
- Keep provider and Stripe secrets server-side in Cloudflare Worker secrets.
- Keep local, QA, and production identity, billing, storage, CSP, and environment files isolated.
- Do not expose internal provider cost estimates through public APIs.
- Do not weaken legal consent, rate limits, Turnstile, ownership checks, or cost-event retention to simplify a feature.

## Git Workflow

The canonical repository is [SqaaSSL/insert-player](https://github.com/SqaaSSL/insert-player).

- Branch from `develop`; use focused `feature/*` or `fix/*` branches and pull requests.
- Merge reviewed work into `develop` for automatic sandbox deployment.
- Promote `develop` to `main` through a pull request; production deploys automatically after the required checks pass.
- Do not commit `.env*`, `.dev.vars`, Wrangler state/logs, launch evidence containing identities, or downloaded/generated user assets.
- Keep unrelated local changes intact when working in a dirty tree.
- Run `npm run check:production` before review.
- Never bypass the protected production environment with a local deploy during routine releases.

## Getting Help

For implementation context, start with `CLAUDE.md` and `ROADMAP.md`. For environment access or secrets, contact the Insert Player project owner through the team's secure credential channel. Never request secrets in a GitHub issue or pull request.
