# Aura Plaza

Created 9 September 2026 with the built-in ImageGen tool for the user's request for a spectacular Aura duel environment, then refined to combine a close circle of children cheering with an interdimensional tournament. This is a new authored game background, also shared by the landing's demo duel. The first distant-festival concept was superseded before release.

- Runtime asset: `public/assets/stages/aura/aura-plaza-v3.webp` (stage `aura-plaza-v3`).
- Dimensions: 1672 × 941 pixels. Original generated PNG retained in the local ImageGen output directory.
- Delivery encoding: WebP quality 88, method 6, metadata removed; 302,372 bytes. No creative pixel editing after ImageGen; only PNG-to-WebP encoding.
- SHA-256: `c51a6b3f13840b4973979cb11d68d9cc0976b075b0e8e44fc939ba44a188139e`.
- Revision 3, created 10 September 2026, redirects the nearby spectators' faces and eyes toward the camera and foreground players. It does not intentionally resize, reposition or enlarge the children. Visual comparison retained the v2 crowd scale, body placement, architecture, lighting, camera and empty floor composition. This is a localized generative edit, not a claim of pixel-identical preservation outside a mask.
- Revision 2 previously scaled the close spectators to roughly half their former size and removed oversized cropped spectators at the edges. Revisions 1 and 2 remain available under their original stage IDs and exact asset digests for existing challenge links, but are hidden from new stage selections. Revision 2's unchanged digest is `365e72a1ea1808a08f06ea5d2de2e2afc8536620356355ee4f2fe08fc98b4fbb`.
- Source floor anchor: 82% of the plate height; the lower 38% is continuous unobstructed dance floor.
- New Aura sessions use Aura Plaza. Explicit stage selections, custom photo stages and existing challenge links retain their own scene. Fight and Rush retain their existing defaults and seeded stage order.
- The public challenge manifest pins this exact delivery asset. A future image revision must receive a new versioned file and matching digest.

## Revision 1 validation

- Full Vitest suite: 242 files passed, 1 skipped; 1,952 tests passed, 6 skipped. The subsequent loading-curtain correction passed all 26 focused GamePage/loading tests and TypeScript.
- Production build passed; existing bundle-size advisory remains.
- Visually checked the live landing widget and actual Aura canvas at the normal 914 × 1,024 browser size and a 390 × 844 mobile viewport. Crowd, floor alignment, turn labels, scores and mobile controls remain readable; viewport override reset afterwards.
- Roster AUTO shows Aura Plaza. Local canvas QA used the existing development-only `auraDemo=1` fixture; the cloud roster was unavailable in this preview environment.
- No deployment or asset-provider calls beyond the two requested ImageGen passes.

## Revision 2 validation

- 168 focused tests and TypeScript passed, covering default selection, the hidden legacy stage, real v1/v2 asset hashes, replay and separate textures for both revisions, persistence and loading.
- Production build passed, with the existing bundle-size advisory.
- Visually checked both the landing widget and the actual Aura canvas at 914 × 1,024: children are smaller than the performers and the arena/floor framing is unchanged. Returned the preview to the landing afterwards.
- One additional built-in ImageGen edit; no deployment.

## Revision 3 validation

- Inspected the original v2 plate, the generated PNG and the delivery WebP. Forward-facing expressions are readable, spectators retain their previous apparent size, and the floor/architecture framing remains aligned.
- Generated output is natively 1672 × 941; no resize or crop was needed. Floor anchor stays at 82%.
- One built-in ImageGen edit, followed only by WebP conversion; no deployment or other image-provider call.
- Stage selection, legacy challenge-media hashes, challenge round-trips, gallery catalog and saved-match tests cover v3 plus both prior versions.
- Full suite: 249 files passed, one skipped; 2,072 tests passed, six skipped. The final HUD layering, portrait crowd placement and camera-label adjustments passed the focused scene, layout, HUD, preview and touch-control suites. Production build passed with the existing bundle-size advisory.
- Live game and landing miniature reviewed in desktop and 390 × 844 portrait viewports, including the official Trump/Lamine roster, stronger duel rail, active actor label, rhythm panel and forward-facing spectators.

## Revision 3 edit prompt

Built-in ImageGen edit of `public/assets/stages/aura/aura-plaza-v2.webp`. Source PNG retained in the local generation archive (not published).

Use case: precise-object-edit. EDIT TARGET: the supplied Aura Plaza videogame background. Make a surgical, minimal change ONLY to the eyes, faces, head direction and facial expressions of the existing close semicircle of children/teen spectators. They should all be looking straight forward TOWARD THE CAMERA/viewer and the game performers who will stand on the empty foreground floor, with attentive, happy, cheering expressions. Their eyes should visibly focus out of the image toward us rather than sideways at each other or arbitrary places. Rotate heads only as much as needed for this frontal gaze. Keep each child's existing identity, hairstyle and head size; preserve natural anatomy and the original illustrated detail. Some can smile or look delighted, but all should have clear forward eye contact.

ABSOLUTE PRESERVATION: keep the same exact image size/aspect, camera angle, framing, perspective, every child's body size and screen position, count and spacing, crouching or seated pose, arms, hands, clothes, shoes, raised gestures, shrubs and flowers, background tiny crowds, golden architectural rings, portals, floating structures, planets, star sky, lighting, colors, reflections, floor textures and the entire empty foreground dance floor. Do not repaint or redesign the setting. Do NOT make the children larger, closer, taller or more prominent. Do not shift their bodies or silhouettes. The task is only the direction of the spectator faces/eyes; everything outside those small face/head regions should be unchanged. Keep the current premium 2.5D illustrated game rendering. No added players, objects, text, logo or UI. Preserve the wide 1672x941 composition and original floor anchor. Output the full image.

## Initial generation prompt

Use case: stylized-concept. Asset type: production background plate for a 2.5D side-view rhythm-duel video game named Aura, also used in a website's live game preview. Create one spectacular, beautifully art-directed wide 16:9 environment, 2048x1152 if possible, FULL BLEED with no border and no UI.

Scene: AURA PLAZA, an open-air urban dance-battle amphitheatre high above a luminous night-time megacity. This is a huge social performance event, stylish and electric. A packed crescent of excited small spectators behind the performance floor, silhouettes raising phones and cheering, warm phone lights like stars. Architectural terraces, immense sculptural gold rings suspended above the rear DJ platform like a radiant halo/crown, subtle audio-wave LED installations and tall speaker towers at the outer edges. The city and tiered crowd create astonishing depth and scale. The performance area feels inviting, competitive and meme-worthy, with a tangible music-video energy.

Composition for gameplay: locked front-on camera at the performers' eye level, almost orthographic like a premium 2.5D videogame backdrop, no Dutch angle or fisheye. Very wide, level, continuous empty dark-polished performance floor fills the lower 38% of the image. Two generous unobstructed standing zones are around x=22% and x=78%, both on exactly the same flat floor baseline y=82%. Their whole-body silhouettes will occupy y=35% to82%, so keep those zones lower-contrast with no foreground people, rails, props or bright spots behind faces. Crowd must stay BEHIND the stage plane, around y=42-60%, smaller than the future performers. Leave the bottom 15% as uninterrupted dance floor continuing to the camera. Keep the central floor empty too: the game's rhythm lanes will be drawn over it. Preserve interesting scenery at both edges even under a central UI overlay, and make the central 60% read well in a square crop.

Art: rich, crisp, high-end 2.5D game environment illustration with physically grounded materials, detailed painterly PBR finish, architectural depth, atmospheric perspective, readable large silhouettes. NOT a photograph, not low-poly, not pixel art, not a blurry abstract gradient. Palette and lighting: deep ink/navy night, restrained warm coral/amber energy on the left, electric cyan/ice-blue on the right, a commanding luminous gold halo and searchlight beams above, muted reflections on charcoal floor. Spectacular light choreography but protect the dark foreground for character contrast. Tasteful haze, confetti glints ONLY high in the background, not across character bodies.

No main characters or dancers on the empty floor. No boxing or wrestling ring, ropes, cages, fighting props, weapons, martial-arts motifs, healthbars, scores, arrows, HUD, screenshot framing, watermarks, written words, logos or readable text. The composition must look like the actual playable location for a crowd-judged aura/dance duel, not a conventional combat arena.

## Revision 1 edit prompt

Edit the supplied game background into a more intimate, playful AURA DUEL gathering inside an awe-inspiring interdimensional tournament. The user likes the existing grandeur but wants recognizable CHILDREN AND TEENAGERS close around the performers in a circle, like a real-life friendly aura challenge, with cosmic tournament scale behind them. Blend those two concepts.

Preserve: same 16:9 production game background format, front-on level 2.5D game camera, crisp premium illustrated videogame rendering, large golden halo/crown rig, left warm coral / right ice-cyan light, original polished dark dance floor and a flat standing baseline around y=82%. This remains an EMPTY playable floor where game sprites will be overlaid: do not paint the two competing main characters.

Change the social scale: replace the distant anonymous concert crowd/barrier with a close, friendly semicircle of about 14 to20 fictional kids and young teenagers, roughly ages10to15, in varied casual hoodies, tracksuits, shorts, jackets and sneakers, a varied mix of appearances. They are enthusiastic spectators at a harmless dance/pose challenge: grinning, leaning forward, cheering, copying a gesture, some holding phones to record. Readable faces and individual body language, natural anatomy. They are not fighting, injured, scared, sexualized or holding weapons. Put the main close semicircle behind the gameplay area, their shoes around y=70to74%, heads around y=40to48%. Two slightly closer spectators may frame the extreme left and right margins, but keep x=14to34% and x=66to86% entirely unobstructed in the foreground, since the duel performers stand there. Viewpoint feels like being IN the circle. No railing separating this nearby circle from the empty performance area. Leave clear empty floor across y=76to100%. Preserve the players' future full body readability.

Change the world behind them: a spectacular floating tournament plaza suspended in space between dimensions, gigantic ancient-gold arches and halo rings, fractured floating terraces with little groups of distant spectators, two or three portals showing very different worlds, enormous planets and a luminous cosmic sky. The vibe is a grand interdimensional anime tournament brought down to a funny, human schoolyard aura battle. Original world design; no recognizable franchise characters, logos, costumes or copied set. The cosmic structures must stay further back and feel majestic without dwarfing the emotional importance of the close circle. Reduce the giant concert/DJ/festival staging and remove the large speaker towers, advertising-like city towers and tiny mass audience. Keep strong artistic depth and large memorable silhouettes.

Art direction: playful but premium 2.5D arcade environment, beautiful painted/PBR material detail, expressive believable children, NOT chibi, NOT flat cartoon, NOT photographic. Rich ink navy, cinematic gold, restrained coral and cyan. Faces in the circle receive soft warm/cool light and should read clearly; fewer people with clear personalities is better than hundreds of tiny faces. Overall scene exciting, friendly and slightly surreal. The nearby circle must be unmistakable at thumbnail size.

No main fighters on the empty floor, no combat violence, no boxing ropes or cages, no UI/score/note arrows, no readable writing, no logos, no watermark. Make the visible result feel like a real aura challenge among kids happening at an impossible tournament between worlds.

## Final revision 2 edit prompt

Built-in ImageGen edit of `aura-plaza-v1.webp`. Output PNG retained in the local generation archive (not published).

Use case: precise-object-edit.
Edit target: the supplied Aura Plaza game background. Correct ONLY the oversized spectators. Keep the exact existing cosmic arena, giant gold halo rings, portals, floating terraces, warm/cool lighting, camera, wide 16:9 framing and unobstructed polished foreground floor.

The children currently look like giants compared with the adult game sprites that are added later. Repaint the cheering semicircle with each child's apparent body size roughly 50–55 percent of the original. Put them a few steps farther behind the players, retaining the friendly local circle feeling. The children must be clearly smaller than an adult performer on the foreground plane.

Concrete layout: a loose semicircle of about 18–22 small children/young teens across the rear edge of the empty play floor. All crowd feet stay near y=60–63% of image height, curving slightly at the sides. Crouching/seated spectators occupy approximately 10–14% of image height; standing spectators at most 20–23%. Heads should be small, about 2–3% of image height. Fill the spaces revealed by reducing them with the existing platform and distant architecture naturally. Keep individual cheerful expressions and gestures, varied natural poses, hoodies and sneakers, but make them secondary to future foreground game characters. Remove the two oversized close-up figures at the far left and right: replace them with similarly small, fully visible spectators on the SAME rear plane as the rest. No cropped large heads or foreground spectators at the edges.

Do not change or shrink the arena, zoom the entire picture, shift its horizon, or alter the golden rings and portals. Preserve the entire lower 37% as empty flat floor, the adult performers' future foot line at y=82%, and both empty playing zones around x=24% and x=76%. No main players painted into the image, no interface, scores, words, logos or watermarks. Match the existing premium illustrated 2.5D game rendering exactly.
