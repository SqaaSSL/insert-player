# Video roster generation

Video-to-sprite generation is additive. The established image-sheet renderer remains the default and is identified as `original`; the new path is identified as `video`.

The choice is immutable for one paid generation. It is copied into the charge, provider session, durable job, artifact run, and signed generation token. A continuation must present the same value. Missing values from older clients and rows resolve to `original`; unknown values are rejected.

The rollout is intentionally fail-closed:

1. The flow-contract release adds persistence but accepts only `original` work.
2. The PixCLI transport release adds a server-only, allowlisted transport. It is unreachable from original-flow tokens.
3. The compiler/Workflow release enables `video`, archives the MP4, and produces reviewable candidates.
4. The UI release exposes an explicit choice and requires the authorization response to echo the selected flow before a job can start.

At no point may a request for `video` silently execute the original renderer, or vice versa.
