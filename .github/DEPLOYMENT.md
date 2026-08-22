# GitHub Actions Deployment

GitHub Actions is the canonical team deployment path. Local deployment commands remain available for diagnostics, but routine releases should come from protected branches so every deployment is traceable to a reviewed commit.

## Branch Flow

| Source | Target | Result |
|---|---|---|
| `feature/*` or `fix/*` | Pull request to `develop` | CI and CodeQL; no secrets or deployment |
| `develop` | GitHub `development` environment | Automatic isolated sandbox Worker, D1 migrations, Pages, and smoke tests |
| `develop` | Pull request to `main` | CI and CodeQL again |
| `main` | GitHub `production` environment | After required checks, deploys production Worker, D1, Pages, and live-readiness checks |

`development` may cancel an older in-progress deployment when a newer commit arrives. `production` never cancels an in-progress deployment.

## Workflows

- `ci.yml`: required pull-request and branch validation.
- `validate.yml`: reusable production gate, full builds, Worker dry-runs, and dependency audits.
- `deploy-development.yml`: `develop` to the isolated sandbox.
- `deploy-production.yml`: checked `main` release to `insertplayer.ai`.
- `codeql.yml`: JavaScript/TypeScript code scanning on pull requests, protected branches, and weekly schedule.
- `dependabot.yml`: weekly frontend, Worker, and GitHub Actions updates.

## GitHub Environments

The repository uses environments named exactly `development` and `production`.

`production` is restricted with:

- Deployment branch: `main` only.
- No manual environment reviewer. Required CI and CodeQL checks remain the release gate for this owner-operated project.

`development` is restricted to `develop` and does not need a manual reviewer.

Use the same variable and secret names in both environments. Values must remain environment-specific.

### Variables

| Variable | Development | Production |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Insert Player Cloudflare account | Same account |
| `VITE_API_BASE_URL` | Sandbox Worker URL | `https://api.insertplayer.ai` |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk Development key | Clerk Production key |
| `VITE_TURNSTILE_SITE_KEY` | Sandbox/test widget | Production widget |
| `VITE_GEMINI_IMAGE_MODEL_REPOSE` | `gemini-3-pro-image` | `gemini-3-pro-image` |
| `VITE_GEMINI_IMAGE_MODEL_UPRIGHT` | `gemini-3-pro-image` | `gemini-3-pro-image` |
| `VITE_GEMINI_IMAGE_MODEL_CROUCH` | `gemini-3-pro-image` | `gemini-3-pro-image` |
| `VITE_BG_REMOVAL_PROVIDER` | `fal` | `fal` |
| `VITE_INTRO_VIDEO_PROVIDER` | `fal-ltx-v2-3-fast` | `fal-ltx-v2-3-fast` |
| `CLERK_ISSUER` | Development issuer | `https://clerk.insertplayer.ai` |
| `CLERK_AUTHORIZED_PARTIES` | Sandbox and approved local origins | Apex and `www` production origins |
| `CORS_ORIGIN` | Not used by sandbox workflow | Apex and `www` production origins |
| `STRIPE_ACCOUNT_ID` | Dedicated account id | Dedicated account id |
| `STRIPE_PRICE_STARTER` | Sandbox Starter price | Live Starter price |
| `STRIPE_PRICE_VERSUS` | Sandbox Versus price | Live Versus price |
| `STRIPE_PRICE_ARCADE` | Sandbox Arcade price | Live Arcade price |
| `TURNSTILE_HOSTNAMES` | Not used by sandbox workflow | `insertplayer.ai,www.insertplayer.ai` |
| `ASF_FORBIDDEN_STRIPE_ACCOUNT_IDS` | Shared accounts that must be rejected | Same denylist |
| `ASF_STRIPE_WEBHOOK_URL` | Sandbox billing webhook | Not used by production workflow |
| `ASF_SANDBOX_WORKER_URL` | Sandbox Worker URL | Not used |
| `ASF_SANDBOX_FRONTEND_URL` | Sandbox Pages URL | Not used |
| `ASF_SANDBOX_PAGES_PROJECT_NAME` | `insert-player-sandbox` | Not used |
| `ASF_WORKER_URL` | Not used | `https://api.insertplayer.ai` |
| `ASF_WORKER_HEALTH_URL` | Not used | `https://api.insertplayer.ai/health` |
| `ASF_FRONTEND_URL` | Not used | `https://insertplayer.ai` |
| `ASF_FRONTEND_ORIGIN` | Not used | `https://insertplayer.ai` |
| `ASF_PAGES_PROJECT_NAME` | Not used | `insert-player` |

### Secrets

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Least-privilege Wrangler token scoped to the Insert Player account and zone |
| `GEMINI_API_KEY` | Server-side image generation |
| `FAL_API_KEY` | Background removal and video generation |
| `RUNWAY_API_KEY` | Configured provider fallback |
| `FREEPIK_API_KEY` | Configured provider fallback |
| `LUDO_API_KEY` | Configured provider fallback |
| `STRIPE_SECRET_KEY` | Test in development, live in production |
| `STRIPE_WEBHOOK_SECRET` | Matching environment billing endpoint |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Matching environment user-lifecycle endpoint |
| `TURNSTILE_SECRET_KEY` | Matching environment widget |
| `ANONYMIZATION_SECRET` | Stable random HMAC secret, at least 32 characters |
| `BRAND_CLEARANCE_JSON` | Production only; exact JSON from the local cleared brand record |

The Cloudflare token needs Worker Scripts edit, D1 edit, Pages edit, and the route/resource permissions required by the checked-in Worker bindings. Scope it to the single SqaaS Cloudflare account and `insertplayer.ai`; do not use a Global API Key.

Never use one GitHub environment as a fallback for another. A missing value must fail the deployment rather than silently reuse a test or live credential.

## Required Branch Rules

For both `develop` and `main`:

- Require a pull request.
- Require the `CI / Production gate` status check.
- Require the branch to be current before merge.
- Dismiss stale approvals when new commits arrive.

For `main`, also require CodeQL. Restrict direct pushes and force pushes; a separate human approval is optional rather than a release dependency.

`CODEOWNERS` assigns the SqaaSSL team to every path so reviewers are discoverable, while the project owner may merge a production promotion after the required automated checks pass.

## Recovery

If Worker deployment fails after a migration, fix forward; D1 migrations are transactional and recorded. If a newly deployed Worker is unhealthy, use Wrangler deployment history to roll back the Worker version, then investigate without deleting D1 or R2 data. Pages retains prior deployments that can be promoted from Cloudflare.

Never delete fighter assets or historical versions as part of rollback or cleanup.
