# La Jaula 304 hybrid stage

Built for the shared Fight/Rush stage catalog. The Fight plate is the first
screen of the same world used by the four-screen Rush route, so the two modes
feel connected without pretending the old tilted court was traversable.

## Final files

| File | Dimensions | Use |
| --- | ---: | --- |
| `la-jaula-304-fight-v2.webp` | 1024 × 576 | Flat side-on Fight plate |
| `la-jaula-304-route-v1.webp` | 3840 × 576 | Four-sector Rush route |

The playable band is normalized to `y = 342..516` in every panel. Facades,
fences, curbs, and the player route are parallel to the top of the screen;
there is no playable diagonal, camera roll, yaw, ramp, or receding court.

## Built-in ImageGen masters

- Panel 1: `/Users/francisconovellafletcher/.codex/generated_images/01a05966-0b18-7b01-854e-52241337c323/exec-42c82b22-5c00-486e-b6cc-52c0d7b15af5.png`
- Panel 2: `/Users/francisconovellafletcher/.codex/generated_images/01a05966-0b18-7b01-854e-52241337c323/exec-0fe71eec-6f30-4be7-961b-e8495cef27f0.png`
- Panel 3: `/Users/francisconovellafletcher/.codex/generated_images/01a05966-0b18-7b01-854e-52241337c323/exec-8332ff31-99f4-43aa-b4a3-c50272214296.png`
- Panel 4: `/Users/francisconovellafletcher/.codex/generated_images/01a05966-0b18-7b01-854e-52241337c323/exec-c0e6117a-48b3-4152-abe5-2648e04d6db9.png`

## Prompt set

All four prompts requested an original high-resolution 2D cel-shaded arcade
environment, using the original La Jaula image only as a world, palette, and
sunset reference. Each prompt fixed camera roll and yaw to zero, required a
straight back-floor seam at 59.4% height and front curb at 89.6%, and banned
tilted courts, diagonal or converging routes, characters, loose gameplay props,
UI, text, logos, and franchise imagery.

The four authored beats were:

1. Mediterranean street outside the sports cage at golden hour.
2. Long cage touchline with a recessed back-wall entrance.
3. Floodlit maintenance end at blue hour.
4. Night lockdown gate and horizontal architectural exit.

## Post-processing

Each `1672 × 941` master was normalized with three vertical bands:

- source `0..632` → `342 px`
- source `632..830` → `174 px`
- source `830..941` → `60 px`

The resulting `1024 × 576` panels use 85, 85, and 86 pixel linear alpha
crossfades to produce the exact `3840 × 576` route. WebP quality is 88.
