# Repository operating contract

## Establish the source of truth first

Before claiming that a feature is missing, merged, or deployed:

1. Run `git fetch --prune origin`.
2. Inspect `origin/main` or `origin/develop`, not a same-named local branch.
3. Compare the checked-out `HEAD`, its upstream, and `git status --short --branch`.
4. For production, verify `https://insertplayer.ai/release.json` and the Worker `/health` response.

A worktree is an isolated checkout, but its branch and files may be stale. Never infer repository or production state from the current directory alone. Do not reset, clean, stash, switch, or update a dirty worktree that you did not create for the current task.

## Branch and deployment boundaries

- Feature branches may be pushed only to open or update pull requests. A pushed feature branch is not a deployment source.
- Only `develop` may deploy the `development` GitHub environment.
- Only `main` may deploy the `production` GitHub environment.
- Begin changes in a new clean worktree based on the current remote target branch.
- Merge through protected pull requests; never push directly to `main` or `develop`.
- Never run routine production mutations locally. Sandbox mutations require a clean local `develop` whose `HEAD` exactly matches `origin/develop`.
- Run `npm run check:deployment-policy` and the relevant tests before changing deployment workflows or wrappers.

The detailed release and recovery contract is in `.github/DEPLOYMENT.md`.
