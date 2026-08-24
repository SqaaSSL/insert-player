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
- `configure-production-smoke-users.yml`: explicit-confirmation deep merge of launch-smoke markers onto two preselected verified OAuth users; the primary must match the separately pinned Arcade admin id, the action restores that private admin marker, and it refuses an admin clone.
- `smoke-development.yml`: manual authenticated sandbox smoke with two disposable Clerk users and full deletion/tombstone validation.
- `smoke-production.yml`: manual authenticated production smoke with two dedicated OAuth QA users and fresh revocable sessions.
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
| `ASF_CLOUDFLARE_ZONE_ID` | Not used | `insertplayer.ai` zone id |
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
| `ASF_LAUNCH_SMOKE_CLERK_KEY` | Clerk Backend API key for the matching environment; used only by authenticated launch smoke |
| `CLERK_BACKEND_AUTH_BRIDGE_SECRET` | Distinct random secret shared only by the matching Worker and authenticated smoke workflow; at least 32 characters |
| `ASF_LAUNCH_SMOKE_PRIMARY_USER_ID` | Production only; Clerk user id for the dedicated primary OAuth QA account |
| `ASF_LAUNCH_SMOKE_CLONE_USER_ID` | Production only; Clerk user id for the dedicated clone OAuth QA account |
| `TURNSTILE_SECRET_KEY` | Matching environment widget |
| `ANONYMIZATION_SECRET` | Stable random HMAC secret, at least 32 characters |
| `GENERATION_JOB_SIGNING_SECRET` | Stable random HMAC secret for scoped processor job tokens, at least 32 characters |
| `BRAND_CLEARANCE_JSON` | Production only; exact JSON from the local cleared brand record |

The Cloudflare token needs account-scoped Worker Scripts edit, D1 edit, R2 edit, Pages edit, Containers write, zone Cache Purge, and the route/resource permissions required by the checked-in Worker/Workflow bindings. Scope it to Cloudflare account `61fc998aa16c1c11a949d982e7a65dcb` and zone `insertplayer.ai`; do not use a Global API Key. A `7403` response from the first D1 migration means the token is for the wrong account or cannot access D1, even if its permission names otherwise look correct. Production Pages deploys probe a fresh immutable asset under an isolated cache key, purge the exact apex and `www` asset URLs after propagation, then run a second smoke against the canonical URL so an SPA fallback can never remain cached as JavaScript.

Never use one GitHub environment as a fallback for another. A missing value must fail the deployment rather than silently reuse a test or live credential.

Neither authenticated smoke consumes AI inference or charges Stripe. The development workflow creates two identified `+clerk_test` users, establishes browser sessions through Clerk Agent Tasks, runs the complete authenticated D1/R2/billing-reservation/match/community-clone/privacy smoke, deletes both users, and verifies that the deletion webhook tombstones their still-valid tokens. Clerk Agent Task tokens omit the browser `azp` claim, so these two workflows send a private backend bridge header. The Worker accepts a missing `azp` only when that header matches `CLERK_BACKEND_AUTH_BRIDGE_SECRET`; an incorrect `azp` is still rejected, and the header is deliberately absent from CORS.

Production is intentionally different because its Clerk instance accepts only social sign-in: a Backend API user without a real OAuth identification cannot receive a production session. Create two dedicated Google or Apple QA accounts by signing into `insertplayer.ai` once with each account, then store their Clerk user ids in the two production secrets above and pin the operator separately as `ASF_ARCADE_ADMIN_CLERK_USER_ID`. Run `Configure production launch-smoke users` with the exact confirmation `CONFIGURE_PRODUCTION_LAUNCH_SMOKE_USERS`; it requires the primary to match that independent admin id, rejects an admin clone, verifies Google/Apple, and deep-merges the admin/QA markers without replacing other private metadata. The smoke workflow re-verifies those markers and OAuth accounts before it creates fresh Agent Task sessions. It exercises auth, D1, R2, publishing, sharing, cloning, and cross-account privacy, cleans up its fighters, and revokes both sessions. It deliberately leaves credit reservations and match history untouched on persistent QA accounts; the disposable development run covers those mutations and account deletion. Browser diagnostics are retained for seven days only when a run fails.

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
