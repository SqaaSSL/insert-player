# Signature stage assets

These four static backgrounds were generated with OpenAI ImageGen for the official Arcade roster. The checked-in files are immutable, versioned 1024 x 576 PNG derivatives sized to the game's logical viewport.

| Arcade fighter | Stage | Public asset |
| --- | --- | --- |
| `donald-trump` | Executive Rumble | `/assets/stages/signature/executive-rumble-v2.png` |
| `elon-musk` | Mars Incorporated | `/assets/stages/signature/mars-incorporated-v1.png` |
| `rosalia` | Tablao 3000 | `/assets/stages/signature/tablao-3000-v1.png` |
| `lamine-yamal` | La Jaula 304 | `/assets/stages/signature/la-jaula-304-v1.png` |

## Generation contract

Shared direction for every prompt:

> Use case: stylized concept. Asset type: final 2D fighting-game stage background PNG. Premium hand-painted 2.5D arcade environment art. Exact wide 16:9, side-on fighting-stage composition. Keep the lower 30% as a readable fighting floor, the ground/contact line around 83% of the frame, a clear center lane for two fighters, and the top 18% quiet enough for the HUD. No people, readable text, logos, UI, borders, signatures, or watermarks.

Stage-specific direction:

- **Executive Rumble:** The White House South Lawn at night under a bright moon; an official helicopter parked at frame left, press bleachers and floodlights at frame right, loose papers in the air, an elegant but faintly chaotic political-showdown mood, and a broad stone-and-grass fighting plane.
- **Mars Incorporated:** A spectacular first permanent Mars colony at sunset; tall launch vehicle at frame left, futuristic habitat and communications complex in the middle distance, exploration rover at frame right, a ringed planet in the sky, red mountains, and a wide metallic landing pad as the fighting plane.
- **Tablao 3000:** A theatrical flamenco tablao fused with a custom motorcycle workshop; deep red velvet curtains, timber and brick, warm spotlights, roses, tools and wheels on the side walls, motorcycles parked only at the far edges, and an empty polished wooden dance floor.
- **La Jaula 304:** A fenced Mediterranean neighbourhood football court at golden hour; dense apartment terraces and laundry behind it, blank dark scoreboard over a small goal, faded geometric murals and bunting, and a wide empty concrete court with strong perspective and no players.

The Executive Rumble source received one ImageGen cleanup pass to remove a spurious corner signature. Its delivery derivative was then cropped slightly at the bottom and sides. All four sources were center-cropped where necessary, resized to 1024 x 576, stripped of metadata, and losslessly encoded as PNG. Original ImageGen outputs remain outside the repository in the local generated-image store.

`executive-rumble-v2.png` rotates only the immutable public cache key after a pre-publication fallback response was cached at the original URL; its reviewed image bytes are unchanged.
