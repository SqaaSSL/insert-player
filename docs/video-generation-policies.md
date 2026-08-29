# Video generation policies

`creationFlow` remains a public product choice with only two values: `original` and
`video`. Video behavior is selected by a separate immutable run policy; it is not a
third creation flow and must never be added to the UI picker.

| Policy | Entry point | Prompt | Automatic frame selection | Review |
| --- | --- | --- | --- | --- |
| `self_service_v1` | Normal signed-in Champion Video generation | `self-service-video-prompt.v2`, with a timed action contract and explicit identity/anatomy locks | `action-profile-temporal-anchors-v1` | Existing human review gate remains required |
| `studio_curated_v1` | Admin Arcade generation API only | Frozen `studio-video-prompt.v1` | Frozen `cumulative-motion-quantiles-v2`, plus existing operator re-curation | Existing human/Codex cherry-picking workflow |

## Studio Curated API boundary

An authenticated admin starts the private policy through the existing endpoint:

```http
POST /api/admin/arcade/:fighterId/generate
Content-Type: application/json

{
  "creationFlow": "video",
  "legal": { "...": "current legal attestation" }
}
```

The route already requires a user whose `plan_tier` is `admin`. It always seals a
Video run as `studio_curated_v1`; callers cannot select that policy through the
normal generation-job request body. No frontend component calls this route.

The admin-only `/api/admin/arcade/generation-contract` response advertises the
policy and the compiler selection capabilities expected by the deployed Worker.

## Self-service timing contract

The two-second prompts assign explicit phases to all eleven actions. Loops include
the beginning and omit the duplicated terminal pose. Non-loop actions use the
approved canonical image as frame zero, sample fixed interior anchors, and include
the final video frame. For a 49-frame clip, examples are:

- `idle`: `0, 6, 12, 18, 24, 31, 37, 43`
- `high_punch`: canonical frame zero, then `10, 19, 29, 38, 48`

Selection therefore does not drift toward whichever frames happen to contain the
most motion. The full MP4, all-frame contact sheet, selected-frame sheet, compiler
report, and manual adjustment route are retained.

## Compatibility and rollout

Migration `0035_video_generation_policies.sql` marks every existing Video run as
`studio_curated_v1`. This preserves in-progress and historical behavior. New
normal Video roots are `self_service_v1`; continuations inherit the stored policy
and reject an attempted policy change.

Roll out in this order: apply the D1 migration, deploy the Processor, then deploy
the Worker. The Processor health response lists both supported automatic selectors,
and the admin preflight fails closed if the deployed compiler does not advertise
them.

Prompting and deterministic sampling reduce variance; they do not prove anatomy or
action semantics. A generated MP4 still has to be acceptable, and the existing
review gate remains the safety boundary until a separate validator is introduced.
