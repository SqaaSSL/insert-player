# Asynchronous Aura challenges

A result can share a playable `/challenge?challenge=…` link alongside the existing
actual match-video export. The recipient can start with the generic Nova demo,
or choose an available performer from their own scoped local library. Creating a
character can return to the same challenge; its private identity stays local.

The URL contains a bounded base64url JSON object (maximum 2,048 characters): the
sender's explicitly chosen display name, claimed score, original player side,
positive uint32 seed, difficulty, and supported song/stage/chart/rules versions.
Unknown fields and malformed or impossible scores are rejected. It never
contains photo hashes, cloud fighter IDs, login tokens, media, or custom stages.
The player side matters: P2 performs later in the same song. Incoming challenges
retain that side, its exact note times and the human's controls. Retry keeps the
routine and target. Remix leaves the challenge and moves a P2 recipient's chosen
identity into the normal P1 human position.

Versioning is intentionally conservative. A checksum of the scoring, chart,
configuration, RNG, music clock and performance source plus the generated full
chart must match this build. Public music and stage SHA-256 values must also
match the installed manifest; runtime verifies actual media bytes and plays the
verified music blob. A changed or unsupported version fails clearly instead of
substituting a routine. Compatible historical engines are not bundled: future
rules updates can expire old links, and the sender must create a new challenge.
The checksum is a compatibility marker, not a security signature.

Scores are unverified social claims. They never become ranked proof or authorize
account mutations. Device history stores up to twenty compatible public links
with local best scores; it is not synchronized and does not identify unique
players. Device-only ProductEvents record open/start/complete/create and actual
video handoffs without names, IDs or link tokens.

Generic bundled demo art is covered by the isolated exception in
`aura-animation-packs-v1.md`. It is not a public roster identity or a paid-quality
sample. Owned packs and live online matches never receive the demo override.

Validation covers both player sides from result to URL to identical chart and
response, invalid/version/private payloads, installed media hashes and bounded
downloads, scoped player selection, scene keyboard ownership and Remix identity,
React touch ownership through lifecycle restarts, history bounds, and unchanged
video/action-recording contracts. Real browser timing, media capture, native
sharing and visual quality still need browser validation on supported devices.
