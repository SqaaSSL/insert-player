# Deterministic video-sprite goldens

`gold-cases.json` describes synthetic RGBA sequences instead of generated likenesses.
The test renderer is deterministic and covers static idle, non-uniform motion-arc
selection, and an objective hard rejection. These fixtures are safe to run in CI.

The full-resolution Trump and Elon videos used to calibrate the canary remain
private, local regression inputs. They are intentionally not copied into Git:

- Trump action videos and curated reports:
  `.artifacts/arcade-trump-xai-video-roster-canary/` in the isolated Trump canary worktree.
- Elon dense high-kick video and frames:
  `.artifacts/arcade-high-kick-xai-video-elon-canary/` in the isolated Elon canary worktree.

Promotion must never depend on those paths. CI expectations are pinned only to
the synthetic fixture and to report/artifact hashes generated from it.
