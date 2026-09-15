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

`v23-probes.json` contains actual local FFprobe stream types and durations
for the three archived v23 MP4s, bound to their SHA-256 hashes in the tests.
The v24/v25 lossless WAV tests inspect RIFF PCM directly, following the existing
Neon tests. The voiceover HTTP resumption test stubs only the local duration
probe for its mock WAV. Actual render QA still uses FFmpeg and FFprobe.
