# GitHub Actions Deployment

GitHub Actions is the only routine production deployment path. Repository-managed
Worker, D1, secret, and Pages mutations are blocked in local checkouts. Every
release must come from a clean checkout of the exact `main` commit authorized
by GitHub Actions, so the checked-in release commands cannot overwrite
Cloudflare with an uncommitted or stale local build. Production credentials must
remain absent from routine local environments so direct vendor CLI calls are not
an alternate deployment path.

Feature branches may be pushed to GitHub for pull requests; they are never
deployment sources. GitHub environment policies enforce `production = main`
and `development = develop`. The checked-in policy test rejects privileged jobs
that are not bound to one of those environments, while the local guards reject
stale, dirty, or wrongly named deployment checkouts.

## Branch Flow

| Source | Target | Result |
|---|---|---|
| `feature/*` or `fix/*` | Pull request to `main` | Required CI and CodeQL; production deploys only after merge |
| Integration branch | Pull request to `develop` | Required CI and CodeQL; no secrets or deployment before merge |
| `develop` | GitHub `development` environment | Automatic isolated sandbox Worker, D1 migrations, Pages, and smoke tests |
| `develop` | Pull request to `main` | Optional sandbox-soaked promotion; CI and CodeQL run again |
| `main` | GitHub `production` environment | After required checks, deploys production Worker, D1, Pages, and live-readiness checks |

Start a branch from the branch it will target. Use `develop` when a change needs
an intentional sandbox soak, and sync current `main` into it before deploying if
the branches have drifted. Never merge a branch based on stale application code
just to publish one feature. `development` may cancel an older in-progress
deployment when a newer commit arrives. `production` never cancels an
in-progress deployment.

## Workflows

- `ci.yml`: required pull-request and branch validation.
- `validate.yml`: reusable production gate, full builds, Worker dry-runs, and a fail-closed check for unresolved high or critical Dependabot alerts.
- `dependency-security.yml`: GitHub Dependency Review blocks pull requests that introduce high or critical vulnerabilities in runtime, development, or unknown scopes.
- `deploy-development.yml`: `develop` to the isolated sandbox.
- `deploy-production.yml`: checked `main` release to `insertplayer.ai`.
- `deploy-frontend-production.yml`: manual Pages-only release of the selected
  `main` commit, with an explicit Worker-drift check.
- `configure-production-smoke-users.yml`: explicit-confirmation deep merge of launch-smoke markers onto two preselected verified OAuth users; the primary must match the separately pinned Arcade admin id, the action restores that private admin marker, and it refuses an admin clone.
- `smoke-development.yml`: manual authenticated sandbox smoke with two disposable Clerk users and full deletion/tombstone validation.
- `smoke-production.yml`: manual authenticated production smoke with two dedicated OAuth QA users and fresh revocable sessions.
- `codeql.yml`: JavaScript/TypeScript code scanning on pull requests, protected branches, and weekly schedule.
- `dependabot.yml`: weekly frontend, Worker, and GitHub Actions updates.

## Canonical Release Invariant

Both production workflows run `scripts/production-deploy-guard.mjs` immediately
after checkout. The guard requires a clean tree, `refs/heads/main`, and
`HEAD == GITHUB_SHA`, then attests that SHA for the remainder of the job. The
only tracked file the workflow may materialize after attestation is
`worker/wrangler.toml`; any source change still blocks every production Wrangler
mutation.

The development workflow likewise runs `scripts/development-deploy-guard.mjs`.
It requires a clean `refs/heads/develop` checkout with `HEAD == GITHUB_SHA`.
Repository-managed sandbox Wrangler, D1, secret, and Pages writes also invoke
that guard locally and require a clean `develop` at the exact remotely verified
`origin/develop` SHA. Dry runs and local-only D1 operations remain available on
feature branches because they cannot publish anything.

Run `npm run check:deployment-policy` after editing a workflow. It verifies the
two canonical push branches and fails if a job can read repository deployment
credentials or invoke a remote deployment without its GitHub environment.

Pages writes `/release.json` into each production build. The propagation and
canonical smokes require its `gitSha` and entry bundle to match the commit being
deployed. This is the authoritative answer to “what code is live”; a successful
upload of some other bundle does not count as a successful release.

## Deployment Credential Policy

Store durable, account-owned credentials only in the matching GitHub
environment. A past successful run is evidence for that commit, not a guarantee
that the two branches, runtimes, migrations, or credentials are still aligned.
Use the current workflow run, Worker `/health`, and frontend `/release.json` when
auditing what is live.

Rotate `CLOUDFLARE_API_TOKEN` deliberately through both environments when they
share the same account-owned credential; never replace it with a Global API Key
or a temporary Wrangler OAuth session. Maps requires two separate restricted
credentials per environment: the public browser key in the environment variable
and the server-only Street View Static key in the environment secret.

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
| `VITE_GOOGLE_MAPS_BROWSER_KEY` | Sandbox browser key restricted to its referrers | Production browser key restricted to apex + `www` |
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
| `ASF_METERKEY_EXPECTED_KEY_ID` | Not used | Dedicated production Meterkey key id |
| `ASF_METERKEY_EXPECTED_KEY_FINGERPRINT` | Not used | scrypt fingerprint of the dedicated production Meterkey key |
| `ASF_METERKEY_EXPECTED_USER_ID` | Not used | Dedicated production Meterkey user id |
| `ASF_METERKEY_EXPECTED_WALLET_ID` | Not used | Dedicated production Meterkey wallet id |
| `ASF_METERKEY_MIN_AVAILABLE_UC` | Not used | Minimum approved production balance |
| `ASF_METERKEY_EXPECTED_PER_REQUEST_CAP_UC` | Not used | Approved per-request production cap |

### Secrets

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Least-privilege Wrangler token scoped to the Insert Player account and zone |
| `METERKEY_API_KEY` | Production Gemini transport through the dedicated Insert Player Meterkey wallet and Google BYOK |
| `GEMINI_API_KEY` | Direct Google rollback credential; production does not read it while `GEMINI_TRANSPORT=meterkey` |
| `GOOGLE_MAPS_SERVER_KEY` | Worker-only key restricted to Street View Static API; never expose it as a `VITE_` variable |
| `FAL_API_KEY` | Background removal and video generation |
| `RUNWAY_API_KEY` | Configured provider fallback |
| `FREEPIK_API_KEY` | Configured provider fallback |
| `LUDO_API_KEY` | Configured provider fallback |
| `PIXCLI_API_KEY` | Server-only PixCLI transport for the opt-in video creation flow |
| `STRIPE_SECRET_KEY` | Test in development, live in production |
| `STRIPE_WEBHOOK_SECRET` | Matching environment billing endpoint |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Matching environment user-lifecycle endpoint |
| `ASF_LAUNCH_SMOKE_CLERK_KEY` | Clerk Backend API key for the matching environment; used only by authenticated launch smoke |
| `CLERK_BACKEND_AUTH_BRIDGE_SECRET` | Distinct random secret shared only by the matching Worker and backend workflows; authenticates Agent Task tokens and the read-only deploy processor probe; at least 32 characters |
| `ASF_LAUNCH_SMOKE_PRIMARY_USER_ID` | Production only; Clerk user id for the dedicated primary OAuth QA account |
| `ASF_LAUNCH_SMOKE_CLONE_USER_ID` | Production only; Clerk user id for the dedicated clone OAuth QA account |
| `TURNSTILE_SECRET_KEY` | Matching environment widget |
| `ANONYMIZATION_SECRET` | Stable random HMAC secret, at least 32 characters |
| `GENERATION_JOB_SIGNING_SECRET` | Stable random HMAC secret for scoped processor job tokens, at least 32 characters |
| `BRAND_CLEARANCE_JSON` | Production only; exact JSON from the local cleared brand record |

The Cloudflare token needs account-scoped Worker Scripts edit, D1 edit, R2 edit, Pages edit, Containers write, Workflows edit, zone Cache Purge, and the route/resource permissions required by the checked-in Worker/Workflow bindings. Scope it to Cloudflare account `61fc998aa16c1c11a949d982e7a65dcb` and zone `insertplayer.ai`; do not use a Global API Key or a temporary Wrangler OAuth access token. A `7403` response from the first D1 migration means the token is for the wrong account or cannot access D1, even if its permission names otherwise look correct. A `9109` response means the stored token is expired or invalid. Production Pages deploys probe a fresh immutable asset under an isolated cache key, purge the exact apex and `www` asset URLs after propagation, then run a second smoke against the canonical URL so an SPA fallback can never remain cached as JavaScript.

Never use one GitHub environment as a fallback for another. A missing value must fail the deployment rather than silently reuse a test or live credential.

Production secrets are supplied to `wrangler deploy --secrets-file` together with
the Worker version. Do not replace this with a loop of `wrangler secret put`:
each individual put creates a deployment and can expose a half-configured
transport between secret updates.

Neither authenticated smoke consumes AI inference or charges Stripe. The development workflow creates two identified `+clerk_test` users, establishes browser sessions through Clerk Agent Tasks, runs the complete authenticated D1/R2/billing-reservation/match/community-clone/privacy smoke, deletes both users, and verifies that the deletion webhook tombstones their still-valid tokens. Clerk Agent Task tokens omit the browser `azp` claim, so these two workflows send a private backend bridge header. The Worker accepts a missing `azp` only when that header matches `CLERK_BACKEND_AUTH_BRIDGE_SECRET`; an incorrect `azp` is still rejected, and the header is deliberately absent from CORS. Production delivery also uses that secret on one machine-only, GET-only processor-contract endpoint before Pages is released. That probe cannot mutate user or application state and does not depend on an operator retaining an active Clerk browser session.

Production is intentionally different because its Clerk instance accepts only social sign-in: a Backend API user without a real OAuth identification cannot receive a production session. Create two dedicated Google or Apple QA accounts by signing into `insertplayer.ai` once with each account, then store their Clerk user ids in the two production secrets above and pin the operator separately as `ASF_ARCADE_ADMIN_CLERK_USER_ID`. Run `Configure production launch-smoke users` with the exact confirmation `CONFIGURE_PRODUCTION_LAUNCH_SMOKE_USERS`; it requires the primary to match that independent admin id, rejects an admin clone, verifies Google/Apple, and deep-merges the admin/QA markers without replacing other private metadata. The smoke workflow re-verifies those markers and OAuth accounts before it creates fresh Agent Task sessions. It exercises auth, D1, R2, publishing, sharing, cloning, and cross-account privacy, cleans up its fighters, and revokes both sessions. It deliberately leaves credit reservations and match history untouched on persistent QA accounts; the disposable development run covers those mutations and account deletion. Browser diagnostics are retained for seven days only when a run fails.

## Required Branch Rules

For both `develop` and `main`:

- Require a pull request.
- Require `validate / Production gate`, `JavaScript and TypeScript`, and `CodeQL`.
- Require the branch to be current before merge.
- Dismiss stale approvals when new commits arrive.
- Apply the rules to administrators, resolve review conversations, and prohibit
  force pushes and branch deletion.

A separate human approval is optional rather than a release dependency for this
owner-operated project; the pull request and automated gates are not optional.

`CODEOWNERS` assigns the SqaaSSL team to every path so reviewers are discoverable, while the project owner may merge a production promotion after the required automated checks pass.

## Recovery

If Worker deployment fails after a migration, fix forward; D1 migrations are transactional and recorded. If a newly deployed Worker is unhealthy, use Wrangler deployment history to roll back the Worker version, then investigate without deleting D1 or R2 data. Pages retains prior deployments that can be promoted from Cloudflare.

Prefer rerunning the production workflow for the desired `main` commit. If
GitHub Actions itself is unavailable and production must be restored, the local
break-glass path requires all of the following at once:

```bash
export ASF_PRODUCTION_BREAK_GLASS=1
export ASF_EXPECTED_PRODUCTION_SHA="$(git rev-parse HEAD)"
export ASF_PRODUCTION_BREAK_GLASS_REASON="Restore production during confirmed GitHub Actions outage"
```

The checkout must be clean, `HEAD` must exactly equal the remotely verified
`origin/main`, and the reason must be explicit. Use a temporary least-privilege
Cloudflare token, record the incident and SHA, then revoke the token. Never keep
production Cloudflare credentials in routine local development environments.

Never delete fighter assets or historical versions as part of rollback or cleanup.

## Worktree hygiene

Worktrees isolate files; they do not overwrite one another. They do share Git
refs and can therefore create a dangerous illusion when a stale local `main` is
mistaken for `origin/main`. Before repository or release diagnosis, fetch and
inspect the remote ref explicitly. Do not repair a dirty checkout in place:
create a clean worktree from the current remote target, preserve the dirty one,
and reconcile its changes through a focused pull request. `git worktree prune`
may remove registrations whose administrative directory no longer exists, but
must never be used as a substitute for reviewing valid dirty worktrees.

## Durable Object lifecycle changes

`deploy-production` refuses a push that adds, renames, or deletes a Durable Object
class (`[[migrations]]` in `worker/wrangler.toml`): Cloudflare cannot roll a Worker
back across a DO migration, so the automatic rollback path would be gone. To ship
one deliberately, run the workflow by hand with **Actions → Deploy production →
Run workflow → `allow_durable_object_lifecycle` = true**. That single rollout is
one-way; every later push is rollback-safe again because the stable base moves
past the migration. Deploy the same change to the sandbox (`develop`) first.
