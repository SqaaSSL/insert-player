# Historical Composition Fixtures

These snapshots preserve approved earlier edits for regression tests without
depending on Git history in a shallow CI checkout. They are not current renders.

| File | Exact source commit | Original path |
| --- | --- | --- |
| v22-index.html | 1cc0ba6 | videos/insert-player-launch/index.html |
| v23-index.html | 718de2c | videos/insert-player-launch/index.html |
| v24-index.html | 02057ffbec9378924ff4999da04480dc43457ca2 | videos/insert-player-launch/index.html |
| v24-games.html | 02057ffbec9378924ff4999da04480dc43457ca2 | videos/insert-player-launch/compositions/frames/02-games.html |

The launch-film tests use the repository's Vitest runner. Run them with
`npx vitest run videos/insert-player-launch/scripts` from the repository root.
