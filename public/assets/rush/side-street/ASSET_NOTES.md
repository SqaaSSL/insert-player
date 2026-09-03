# Side Street Rush asset kit

Generated for the Phaser `1024 × 576` canvas and a `3840 × 576` Rush world. The playable walk band is normalized to `y = 342..516` in every route panel. All sprite files use a bottom-center anchor and genuine PNG alpha.

## Final files

| File | Dimensions | Notes |
| --- | ---: | --- |
| `side-street-route-v1.webp` | 3840 × 576 | Four-panel Rush route, WebP quality 88 |
| `side-street-fight-v1.webp` | 1024 × 576 | Clean first-screen hybrid Fight plate, WebP quality 88 |
| `barricade-intact.png` | 180 × 150 | Transparent, bottom-center |
| `barricade-damaged.png` | 180 × 150 | Transparent, bottom-center |
| `barricade-broken.png` | 180 × 150 | Transparent, bottom-center |
| `fuel-cell-intact.png` | 120 × 170 | Transparent, bottom-center |
| `fuel-cell-damaged.png` | 120 × 170 | Transparent, bottom-center |
| `fuel-cell-broken.png` | 120 × 170 | Transparent, bottom-center |
| `steam-vent-idle.png` | 160 × 120 | Transparent, bottom-center |
| `steam-vent-active.png` | 160 × 120 | Transparent, bottom-center; static steam frame |
| `entry-door.png` | 180 × 260 | Transparent facade socket |
| `entry-manhole.png` | 160 × 100 | Transparent ground socket |
| `entry-drop-rig.png` | 220 × 260 | Transparent overhead socket |
| `side-street-assets-contact-sheet.jpg` | 1600 × 900 | QA overview on `#111827` |

## Reference inputs

- Approved north-star mock: `/var/folders/m6/ypmj4kmn7vdc8ptw_yjz8f2c0000gn/T/codex-clipboard-c8f4b940-a1cf-4307-bd11-0ddb58bd8847.png`
- Stable north-star copy: `/Users/francisconovellafletcher/.codex/generated_images/01a05966-0b18-7b01-854e-52241337c323/exec-30cdb6b7-4bf3-4da7-bccd-0ffc42f237f5.png`
- Approved palette: `/Users/francisconovellafletcher/.codex/generated_images/01a05966-0b18-7b01-854e-52241337c323/exec-c18573f7-52d8-4103-9732-6243b85d0412.png`

## Built-in ImageGen sources and exact prompts

All image-native content was made with built-in ImageGen. Paths below are untouched generated masters.

### Route panel 1

Source: `/Users/francisconovellafletcher/.codex/generated_images/01a0665c-15c1-75c1-8a6a-9730355388a9/exec-00dd517e-e6c9-4db2-8fb8-2b08691bce42.png`

```text
Use case: precise-object-edit
Asset type: first 1024x576 screen panel of a Phaser 2.5D side-scrolling beat-em-up stage background
Primary request: Preserve the approved workshop-at-sunset environment and art direction from Image 1, but convert it into a clean, prop-free gameplay background. Remove the concrete barricade, wheeled dumpster, steam vent, loose foreground obstacles, all logos/emblems/text/arrows/watermarks. Keep the workshop facade, blue service door, shutter, fence, sunset, rooftop machinery, utility poles, and the right-side raised ramp only as a clearly separated BACKGROUND enemy entrance.
Style/medium: original high-resolution 2D cel-shaded arcade illustration; crisp silhouettes; restrained hand-painted texture; not photorealistic; not pixel art; no copyrighted or franchise imagery.
Composition/framing: exact 16:9 side-on gameplay plate. Camera roll 0 degrees, camera yaw 0: front facade parallel to the picture plane, verticals perfectly vertical, all major ground borders perfectly horizontal. The back edge of the playable asphalt must be a straight horizontal seam at 59.4% image height. The front edge must be a straight horizontal curb at 89.6% image height. These two lines define a broad empty rectangular walk band. X movement parallel to top edge; depth is screen-Y perpendicular to top edge. No playable stairs, ramps, diagonal lane, tilted ground, or 3/4 route. Reserve the middle asphalt entirely for characters and dynamic props.
Lighting/mood: golden sunset on far left grading into ink navy, warm practical lamps, restrained cyan accents.
Color palette: #080A12 #111827 #334155 #687386 #FFCF33 #42D9F5 with rare #F04E3E.
Constraints: scenery only; absolutely no fighters, people, enemies, HUD, props, labels, signs, logos or text. Keep the ground readable and uncluttered. Output one seamless full-bleed environment panel.
```

### Route panel 2

Source: `/Users/francisconovellafletcher/.codex/generated_images/01a0665c-15c1-75c1-8a6a-9730355388a9/exec-43f46cd6-08ff-4036-b895-a4bcec013df5.png`

```text
Use case: stylized-concept
Asset type: second 1024x576 adjacent screen panel of a Phaser 2.5D side-scrolling beat-em-up stage background
Primary request: Create the immediate rightward continuation of the approved Mediterranean industrial workshop street in Image 1. Evolve naturally from the workshop into a narrow service district at late sunset/early blue hour: longer cracked stucco facade, shuttered loading bays, wall pipes, mesh service gate and a recessed doorway that can visually justify enemy entry. Do not duplicate the exact first facade.
Style/medium: match Image 1 exactly as an original high-resolution 2D cel-shaded arcade illustration, crisp silhouettes, restrained hand-painted texture, not photorealistic, not pixel art, no copyrighted/franchise imagery.
Composition/framing: exact 16:9 side-on orthographic beat-em-up gameplay plate. Camera roll 0, yaw 0, facade parallel to image plane, verticals vertical. Back floor seam is one perfectly straight horizontal line at 59.4% image height and must visually continue across both left and right edges. Front boundary is one perfectly straight horizontal curb at 89.6% image height. Empty rectangular walk band between them; X scroll parallel to top; screen-Y depth perpendicular. No diagonal road, tilted plane, converging route, playable ramp or stairs.
Lighting/mood: early blue hour, residual warm sunset from the left, amber practical lamps, restrained cyan utility light.
Color palette: #080A12 #111827 #334155 #687386 #FFCF33 #42D9F5 with rare #F04E3E.
Constraints: prop-free scenery only; no fighters, people, enemies, HUD, crates, barrels, barricades, dumpsters, vents, text, labels, arrows, logos, emblems or watermarks. Keep middle asphalt empty and readable. Left and right edges must be generic wall/asphalt continuations suitable for horizontal stitching.
```

### Route panel 3

Source: `/Users/francisconovellafletcher/.codex/generated_images/01a0665c-15c1-75c1-8a6a-9730355388a9/exec-5f084e1e-e989-486f-9897-4cf1599b498d.png`

```text
Use case: stylized-concept
Asset type: third 1024x576 adjacent screen panel of a Phaser 2.5D side-scrolling beat-em-up stage background
Primary request: Continue directly rightward from Image 2's service district into a horizontal industrial underpass and sheltered loading yard at blue hour. Show concrete bridge structure overhead, flat front-facing loading walls, drainage channels, pipes, caged service openings and recessed bays that can later receive separate enemy-entry overlays. It must feel like the same route and same night progression, not a new location.
Style/medium: match the reference as original high-resolution 2D cel-shaded arcade illustration, crisp silhouette, restrained hand-painted texture, not photorealistic, not pixel art.
Composition/framing: exact 16:9 side-on orthographic beat-em-up gameplay plate. Camera roll zero and yaw zero. All structural floor seams and curbs perfectly horizontal; verticals perfectly vertical. Back floor seam is a straight horizontal line at 59.4% image height; front boundary a straight horizontal curb at 89.6%. Broad empty rectangular asphalt walk band. X scroll parallel to screen top, screen-Y depth perpendicular. No diagonal or receding playable route, no stairs, no playable ramp, no 3/4 view. Generic continuous surfaces at left and right edges for stitching.
Lighting/mood: deep blue hour under warm sodium fixtures, a few restrained cyan service lamps, readable silhouettes and ground.
Color palette: #080A12 #111827 #334155 #687386 #FFCF33 #42D9F5 rare #F04E3E.
Constraints: prop-free scenery only. No people, fighters, enemies, vehicles, HUD, crates, barrels, barricades, containers, vents, loose objects, text, arrows, labels, logos, emblems or watermarks. Keep the walk band empty.
```

### Route panel 4

Source: `/Users/francisconovellafletcher/.codex/generated_images/01a0665c-15c1-75c1-8a6a-9730355388a9/exec-d9c6f68b-14c5-4966-bbf5-4a22000ec094.png`

```text
Use case: stylized-concept
Asset type: fourth and final 1024x576 screen panel of a Phaser 2.5D side-scrolling beat-em-up stage background
Primary request: Continue the same industrial Mediterranean route into its final gate yard at full blue hour. A broad front-facing steel security gate and concrete checkpoint facade form a strong finale, with rooftop tanks, distant neighborhood silhouettes and a glimpse of night sky. Include plausible recessed wall sockets for later enemy entrances but leave the playable ground completely empty. The far right edge visually closes the route with architecture, not a diagonal road.
Style/medium: match the references exactly as original high-resolution 2D cel-shaded arcade illustration, crisp silhouettes, restrained hand-painted texture, not photorealistic, not pixel art, no franchise imagery.
Composition/framing: exact 16:9 side-on orthographic beat-em-up gameplay plate, camera roll zero, yaw zero. Facade parallel to image plane, verticals vertical. Back floor seam is a perfectly straight horizontal line at 59.4% image height; front boundary is a perfectly straight horizontal curb at 89.6%. Empty rectangular asphalt walk band between. X scroll parallel to top, screen-Y depth perpendicular. No diagonal road, tilted ground, 3/4 route, playable ramp or stairs.
Lighting/mood: rich ink navy night, warm gate lamps, restrained cyan electrical accents, faint residual warmth only at the far-left edge.
Color palette: #080A12 #111827 #334155 #687386 #FFCF33 #42D9F5 rare #F04E3E.
Constraints: prop-free scenery only; no people, fighters, enemies, HUD, crates, barrels, barricades, dumpsters, vents, text, signs, arrows, logos, emblems or watermarks. Keep ground empty and readable.
```

### Barricade state atlas

Source: `/Users/francisconovellafletcher/.codex/generated_images/01a0665c-15c1-75c1-8a6a-9730355388a9/exec-a2f96724-a788-4e6c-9fc0-7b2dc8619f34.png`

```text
Use case: stylized-concept
Asset type: transparent Phaser game sprite atlas for one destructible obstacle family
Primary request: Create exactly three matching front-side-view concrete road barricade sprites in a single horizontal row: LEFT intact, CENTER visibly damaged, RIGHT broken/destroyed. Same object identity and proportions across states. Intact: compact weathered concrete jersey barrier with integrated black-and-coin-gold hazard bands. Damaged: deep cracks, chipped corner, bent inset reinforcement. Broken: collapsed central section and a few large readable fragments, still recognizable and contained within its cell.
Style/medium: original high-resolution 2D cel-shaded arcade game illustration matching the approved industrial Mediterranean street; crisp dark outline/silhouette, restrained texture, not photorealistic, not pixel art.
Composition/framing: each full object isolated, evenly spaced in three equal columns, identical bottom baseline and camera angle, bottom-center anchor, generous transparent padding, nothing cropped, no overlap between columns. Orthographic side/front 2.5D game sprite, not dramatic perspective.
Color palette: #080A12 #111827 #334155 #687386 #FFCF33 #42D9F5, rare #F04E3E only for damage.
Background: genuinely transparent alpha, no colored field, no checkerboard.
Constraints: no cast shadow beyond a tiny contact shadow, no text, arrows, labels, logos, icons, characters, debris crossing cells or watermark. Only the three barricade states.
```

### Fuel-cell atlas and extractions

Visual atlas source: `/Users/francisconovellafletcher/.codex/generated_images/01a0665c-15c1-75c1-8a6a-9730355388a9/exec-37c1a34b-ffbc-4181-8465-5416ec429299.png`

```text
Use case: stylized-concept
Asset type: transparent Phaser game sprite atlas for one destructible obstacle family
Primary request: Create exactly three matching vertical industrial energy-cell obstacle sprites in a single horizontal row: LEFT intact, CENTER visibly damaged, RIGHT broken/destroyed. Design an original compact waist-high fuel/power cell, not a barrel: blue-gray armored cylinder-in-frame with coin-gold structural braces and a restrained cyan glowing core. Damaged state has dented frame, cracked core housing, cyan leakage and a tiny rare vermilion warning spark. Broken state is a collapsed split casing with extinguished fractured core and a few contained parts. Same identity and proportions across states.
Style/medium: original high-resolution 2D cel-shaded arcade game illustration matching the approved industrial Mediterranean street; crisp dark silhouette, restrained hand-painted texture, not photorealistic, not pixel art, no franchise cues.
Composition/framing: each full object isolated, evenly spaced in three equal columns, same bottom baseline and camera angle, bottom-center anchor, generous transparent padding, nothing cropped, no overlap. Orthographic side/front 2.5D game sprite.
Color palette: #080A12 #111827 #334155 #687386 #FFCF33 #42D9F5, rare #F04E3E for damage only.
Background: genuine transparent alpha, no colored field, no checkerboard.
Constraints: no barrel, crate, canister label, cast shadow beyond tiny contact shadow, text, arrows, logo, character, watermark, or debris crossing cells. Exactly three states.
```

The atlas returned a baked checkerboard. This first extraction attempt also retained it and was discarded: `/Users/francisconovellafletcher/.codex/generated_images/01a0665c-15c1-75c1-8a6a-9730355388a9/exec-c2d26c03-badb-4418-b53a-1e5cb3f18dfc.png`.

```text
Use case: background-extraction
Asset type: transparent Phaser sprite atlas
Primary request: Remove the white-and-light-gray checkerboard background from Image 1 and replace it with genuine transparent alpha.
Constraints: Preserve the three energy-cell sprites exactly: same design, damage states, positions, scale, colors, outlines, lighting, details and spacing. Do not redraw, restyle, add, remove, crop, merge or move any object. Preserve tiny contact marks belonging to each object but remove all background pixels and all fake checkerboard squares. Output PNG with actual transparency; no matte, no glow field, no checkerboard, no shadow extending away from the objects.
```

Selected intact source: `/Users/francisconovellafletcher/.codex/generated_images/01a0665c-15c1-75c1-8a6a-9730355388a9/exec-fc5eccca-872b-4e2d-81f7-5c70dd7dc559.png`

```text
Use case: background-extraction
Asset type: single transparent Phaser obstacle sprite
Primary request: Isolate ONLY the LEFT intact energy-cell object from Image 1 as one standalone sprite. Remove the other two objects and every background/checkerboard pixel. Preserve the intact object's exact design, proportions, colors, outline, details and front-side 2.5D view.
Composition: full object centered, bottom-center anchor, generous transparent padding, no crop.
Background: genuine transparent alpha.
Constraints: do not redesign or add anything; no floor, checkerboard, matte, text, shadow field or watermark.
```

Selected damaged source: `/Users/francisconovellafletcher/.codex/generated_images/01a0665c-15c1-75c1-8a6a-9730355388a9/exec-53a37842-61bd-428a-8bda-2c22bd283dcb.png`

```text
Use case: background-extraction
Asset type: single transparent Phaser obstacle sprite
Primary request: Isolate ONLY the CENTER damaged energy-cell object from Image 1 as one standalone sprite. Remove the other two objects and every background/checkerboard pixel. Preserve the damaged object's exact design, proportions, cyan crack/leak, tiny vermilion spark, outline, details and front-side 2.5D view.
Composition: full object centered, bottom-center anchor, generous transparent padding, no crop.
Background: genuine transparent alpha.
Constraints: do not repair, redesign or add anything; no floor, checkerboard, matte, text, shadow field or watermark.
```

Selected broken source: `/Users/francisconovellafletcher/.codex/generated_images/01a0665c-15c1-75c1-8a6a-9730355388a9/exec-ec70d36c-1dc4-4e9a-ae1e-321a5ab97d48.png`

```text
Use case: background-extraction
Asset type: single transparent Phaser obstacle sprite
Primary request: Isolate ONLY the RIGHT broken energy-cell object from Image 1 as one standalone sprite. Remove the other two objects and every background/checkerboard pixel. Preserve the broken object's exact split casing, collapsed dark core, contained pieces, colors, outline, details and front-side 2.5D view.
Composition: full broken object centered, bottom-center anchor, generous transparent padding, no crop.
Background: genuine transparent alpha.
Constraints: do not repair, redesign or add anything; no floor, checkerboard, matte, text, shadow field or watermark.
```

### Steam-vent atlas

Source: `/Users/francisconovellafletcher/.codex/generated_images/01a0665c-15c1-75c1-8a6a-9730355388a9/exec-97c1f96b-3b86-4903-b1c4-de906e3d5138.png`

```text
Use case: stylized-concept
Asset type: transparent Phaser game sprite atlas for one environmental hazard family
Primary request: Create exactly two matching low circular street steam-vent sprites in a single horizontal row: LEFT idle, RIGHT active. Same original heavy cast-metal flush pavement vent with concentric blue-gray rings, small coin-gold fasteners and a restrained cyan service light. Idle has closed dark grille and only a faint cool glow. Active has opened glowing grille with a compact plume of translucent white-blue steam rising upward, visually obvious but contained.
Style/medium: original high-resolution 2D cel-shaded arcade game illustration matching the approved industrial Mediterranean street; crisp silhouette, restrained texture, not photorealistic, not pixel art.
Composition/framing: two isolated full sprites, equal columns and identical ground-plane angle, same bottom baseline, bottom-center anchor, generous transparent padding, nothing cropped or overlapping. The object is viewed from the same shallow 2.5D game angle as the stage floor, while remaining horizontally aligned.
Color palette: #080A12 #111827 #334155 #687386 #FFCF33 #42D9F5.
Background: genuine transparent alpha, no colored field, no checkerboard.
Constraints: no manhole logo, text, arrows, labels, characters, excessive cast shadow, giant steam cloud or watermark. Exactly two states.
```

### Entry-socket atlas

Initial visual source, discarded because it baked the checkerboard: `/Users/francisconovellafletcher/.codex/generated_images/01a0665c-15c1-75c1-8a6a-9730355388a9/exec-77e43528-aa62-4fb9-adf5-f2355822fde4.png`

```text
Use case: stylized-concept
Asset type: transparent Phaser environment-socket sprite atlas
Primary request: Create exactly three separate original enemy-entry facade/ground overlays in one horizontal row: LEFT a narrow weathered blue steel service door with a small cracked concrete frame and warm lamp; CENTER a heavy circular pavement manhole hatch with segmented blue-gray metal and restrained cyan rim detail; RIGHT an overhead industrial drop rig consisting of a wall/ceiling mounting bracket, short rail, cable and compact clamp platform suitable for lowering an enemy, with no enemy present. No labels or symbols.
Style/medium: original high-resolution 2D cel-shaded arcade game illustration matching the approved industrial Mediterranean street; crisp silhouette, restrained hand-painted texture, not photorealistic, not pixel art, no franchise imagery.
Composition/framing: three assets isolated in three equal columns, each fully visible with generous transparent padding and no overlap. Door and drop rig front-facing and perfectly vertical; manhole in shallow stage-floor angle. Each item bottom-center anchored in its cell; door and rig may be tall, manhole low.
Color palette: #080A12 #111827 #334155 #687386 #FFCF33 #42D9F5 rare #F04E3E.
Background: genuine transparent alpha, no colored field, no checkerboard.
Constraints: no wall filling the cell beyond compact mounting/frame fragments; no characters/enemies, text, numbers, arrows, logos, emblems, signs, graffiti, giant shadows or watermark. Exactly three socket assets.
```

Selected alpha source: `/Users/francisconovellafletcher/.codex/generated_images/01a0665c-15c1-75c1-8a6a-9730355388a9/exec-c433617f-9bcb-41ac-a795-7ea32d7e1f2d.png`

```text
Use case: background-extraction
Asset type: transparent Phaser environment-socket atlas
Primary request: Remove the white-and-light-gray checkerboard background from Image 1 and replace it with genuine transparent alpha.
Constraints: Preserve the service door, circular manhole and overhead drop rig exactly: same design, positions, scale, colors, outlines, lighting, details and spacing. Do not redraw, restyle, add, remove, crop, merge or move any asset. Preserve only compact wall/asphalt mounting fragments attached to each asset. Remove all background pixels and fake checkerboard squares. Output PNG with actual transparency; no matte, no checkerboard, no long cast shadows.
```

## Post-processing

- Route masters were normalized with ImageMagick using three vertical bands so the art follows exact gameplay geometry:
  - Panel 1: source `0..500 → 342 px`, `500..835 → 174 px`, `835..941 → 60 px`.
  - Panels 2 and 3: source `0..510 → 342 px`, `510..837 → 174 px`, `837..941 → 60 px`.
  - Panel 4: source `0..552 → 342 px`, `552..837 → 174 px`, `837..941 → 60 px`.
- Each normalized panel is `1024 × 576`. The route uses 85, 85 and 86 px linear alpha crossfades, producing exactly `3840 × 576`. Panel 1 is exported independently for Fight.
- Atlas cells were cropped, low-alpha fringe normalized with alpha `level 1%,100%`, Lanczos-resized and placed on exact transparent canvases with a 4 px bottom margin.
- Barricade crops: `683×500+0+150`, `683×500+683+150`, `682×500+1366+220`; maximum content `170×140`.
- Fuel crops: `960×1450+32+35`; maximum content `110×160`.
- Vent crops: idle `887×437+0+450`, active `887×637+887+250`; maximum content `150×110/112`. The active crop keeps a compact plume for a `160×120` canvas.
- Entry crops: door `565×928+0+0`, manhole `565×400+565+480`, drop rig `515×860+1180+40`; maximum content `170×250`, `150×90`, `210×250`.
- The contact sheet was composed locally from final assets; it adds no generated artwork.

## Validation and limitations

- Route/Fight assets have exact requested dimensions and are RGB WebP.
- Every final sprite is RGBA with real non-opaque pixels and transparent corners.
- The walk band is horizontal at `y = 342..516`; the first-screen ramp remains background-only and must stay outside collision bounds.
- The route is one baked visual composite, not a parallax layer stack. Background doors/bays are decorative unless paired with entry overlays.
- Crossfades hide panel joins at gameplay scale, but independently generated architecture is not a tile-perfect modular set under extreme magnification.
- `steam-vent-active.png` is static; animate alpha/scale or add plume frames later.
- Masters intentionally contain no characters, enemies, HUD or copyrighted/franchise imagery.
