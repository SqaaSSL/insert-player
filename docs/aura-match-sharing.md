# Aura match sharing — local video first

## Available

Every new Aura round records the Phaser canvas at its existing 1024×576
resolution, targeting 30 fps and 5 Mbps. This is the actual rendered match,
including choreography, comic feedback, score and winner reveal; not a score
card or a regenerated approximation. Recording pauses with the offline match.

SoundManager supplies a game-only mix of music, crowd and synthesized SFX.
The recorder clones that track and never stops the original. It does not
request screen, microphone or camera permissions and performs no uploads.

At the result screen players can preview the video, use native file sharing
where the browser supports it, or download the file and attach it themselves.
MP4 is preferred when supported; WebM is the fallback. Extensions match the
real container. Missing audio is labelled. Cancellation is not reported as
success. Encoder failure, unsupported browsers, 120 MiB and five-minute limits
are explicit failures, never successful partial matches.

The video is held in memory for this result screen. Download it before a
rematch, navigation or reload. Matches played before this feature cannot be
recovered retroactively. No automatic video cloud storage exists.

## Action history foundation

`AuraRecorder` stores versioned chart/config snapshots, ordered local
presentation-clock judgements (including mash and wrong-turn inputs), and the
final result. It preserves the exact timestamp used to judge input/CPU/misses.
Pre-clock, paused and completed-match input is ignored by gameplay and is not
part of the journal. Online remote events are received judgements, not every
raw keypress on the other computer.

The last five completed journals are retained in a separate local IndexedDB
database, `insert-player-aura-recordings`. `listAuraRecordings()` reads them.
Quota/private-mode failures do not interrupt gameplay or prevent video sharing.
Incomplete or invalid journals are never saved as complete. Source photos,
photo hashes, original asset URLs and online room credentials are excluded.

This is not yet a public interactive replay: there is no share URL, public
replay route, hosted clip or downloadable asset bundle. Local fighter IDs alone
cannot make sprites accessible to a recipient. The journal is a foundation, not
a promise of pixel-identical future replay across engine or asset versions.

## Next delivery: public replay links

Keep separate from the shipped local export:

- An explicit publish/share action and revocable public ID; no automatic photo
  or private fighter publication.
- Hosted match video, or a versioned replay manifest and a renderer pinned to
  compatible presentation rules and approved playable assets.
- Recipient page with play, matchup/result metadata, social preview and a
  clear invitation to play their own match. No login just to watch a shared clip.
- Retention, size/rate limits, abuse reporting and deletion; rights policy for
  custom music and private stages/fighters before hosted publication.

## Validation

Unit coverage: encoder lifecycle and MIME, owned-track cleanup, native file
sharing capability and aborts, mixed audio routing, bounded durable history,
exact input/CPU/miss timestamps, inactive-performer regressions and rematch
epoch guards. Build and frontend styling checks must pass.

Manual smoke: complete a new Aura round; pause/resume; inspect full duration,
seek/play preview; download/share by file; run a rematch and ensure no previous
video appears; leave while recording and verify cleanup. Preview testing on
the local 4175 app produced a playable 52.414-second, 1024×576 MP4 (~29.9 MiB)
for a 51.5-second match plus winner tail, despite an offline pause.

This branch changes no deployment configuration or production data.
