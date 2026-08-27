# Video roster generation

Video-to-sprite generation is additive. The established image-sheet renderer remains the default and is identified as `original`; the new path is identified as `video`.

The choice is immutable for one paid generation. It is copied into the charge, provider session, durable job, artifact run, and signed generation token. A continuation must present the same value. Missing values from older clients and rows resolve to `original`; unknown values are rejected.

The rollout is intentionally fail-closed:

1. The flow-contract release adds persistence but accepts only `original` work.
2. The PixCLI transport release adds a server-only, allowlisted transport. It is unreachable from original-flow tokens.
3. The compiler/Workflow release enables `video`, archives the MP4, and produces reviewable candidates.
4. The UI release exposes an explicit choice and requires the authorization response to echo the selected flow before a job can start.

At no point may a request for `video` silently execute the original renderer, or vice versa.

Each paid PixCLI submit has one semantic identity:
`run:<artifactRunId>:sprite:<action>`. The Worker stores one cache row for that
identity and derives the upstream idempotency key from the immutable row id,
not from request bytes or a local ownership attempt. A recreated upload,
changed multipart boundary, changed PixCLI asset hash, received HTTP response,
or unknown dispatch outcome can therefore never trigger an automatic second
advanced-video POST.

Video retrieval is also closed over exact PixCLI paths. The processor may read
`/api/v1/jobs/<32-hex>/canva`, validate the single expected video asset, and
download only `/api/v1/assets/<32-hex>` through the authenticated Worker proxy.
The asset proxy accepts only bounded `video/mp4` and `application/json`
responses for the generated video and its sealed request/response audit. It
rejects queries, redirects, every other MIME type, and oversized streams;
metadata URLs and direct FAL URLs are never followed.
