# Design

## Product Context

Insert Player is a browser game and creation tool. The visual system should feel like a premium, modern arcade cabinet: tactile, dark, high-contrast, fast to scan, and centered on playable fighters.

The product is not a museum-piece retro clone. The arcade layer should make actions feel fun while the account, billing, cloud, and quality-tier surfaces stay clear and trustworthy.

## Brand Architecture

- Platform: Insert Player
- First game: Insert Player: Fight
- Short mark: P1
- Internal project name: AI Street Fighter, never public
- Primary tagline: Insert yourself into the game.
- Core user promise: turn a photo into a playable fighter that can sync, upgrade, share, and clone.

## Color

The existing palette is valid and should be treated as the first Insert Player palette, even where token names still use the internal `asf` prefix.

| Role | Token / Value | Use |
| --- | --- | --- |
| Cabinet black | `#050507`, `#04040d` | Body background, game shell, high-contrast panels |
| Screen indigo | `#0a0a20`, `#13102d` | Secondary surfaces, depth, inactive cabinet areas |
| Coin red | `#d22727`, `#ff2a2a` | Primary actions, selected tier, urgent state, P1 brand heat |
| Coin gold | `#ffce3a`, `#fff080` | Brand highlights, headings, borders, credit/coin metaphors |
| CRT cream | `#fff4d6`, `#f4f0dd` | Primary text, logo strokes, social assets |
| Cabinet violet | `#7b3dff` | Secondary mode accent, not dominant |
| Glass blue | `#4fb3ff` | Debug/status information, links when needed |
| Player green | `#30e07a` | Success and ready states |

Guidance:

- Keep dark cabinet surfaces dominant.
- Use red for action and active decisions, not broad decoration.
- Use gold as the coin/credit/highlight language.
- Avoid one-hue dominance. Red, gold, black, cream, and one cool accent should all be visible in key product surfaces.
- Do not introduce beige, brown, generic neon purple gradients, or cute candy colors.

## Typography

Current shipped face: `Press Start 2P`.

This works for the arcade identity but must be used carefully:

- Strong for hero labels, buttons, chips, roster labels, and short arcade UI.
- Weak for long explanatory text, checkout copy, and dense account/billing states.
- If adding a second typeface, use a readable UI sans for body text and keep `Press Start 2P` as display/label. Do not add more than one companion family.
- Avoid all-caps paragraphs. Arcade labels can be uppercase; explanations should be mixed case when readability matters.

## Logo & Mark

The core mark is `P1`, not a fighter silhouette.

Preferred interpretations:

- P1 inside a cabinet-screen frame.
- P1 near a coin slot or insert slot.
- P1 as the app icon and compact social avatar.

Avoid:

- Fireballs, dragons, skulls, ninjas, military sprites, plumbers, or other genre-specific symbols.
- Literal fighting-game franchise motifs.
- Overly cute pixel mascots.

## Imagery

Product imagery should show the actual transformation:

1. source photo or source view,
2. generated sprite,
3. in-game fight or roster context.

Do not use atmospheric arcade photos as the main value proof. The magic is "this person became playable."

For generated visual assets:

- favor 2.5D arcade sprite energy over flat cartoon;
- keep faces recognizable;
- preserve human individuality, clothing, hair, and posture;
- avoid exaggerated chibi, toy-like, or anime-only results unless a user explicitly asks for that style later.

## UI Components

Buttons:

- Use short action verbs: Create fighter, Sync cloud, Upgrade to Champion, Clone fighter.
- Primary action: coin red background, gold/cream text, strong focus state.
- Secondary action: dark surface with gold border.
- Disabled state: visibly unavailable without hiding the label.

Panels:

- Panels may feel like cabinet glass or control surfaces, but should not become nested cards.
- Keep radii small, currently 4-6px.
- Border and shadow treatments should communicate machine hardware, not soft SaaS cards.

Tier UI:

- Rookie: fast, free/low-cost, playable.
- Contender: default recommendation, best value.
- Champion: highest fidelity, premium.
- Tiers should communicate visible output quality, not just cost.

Community UI:

- Public fighters should feel like challengers on a cabinet, not social profiles.
- Share and clone actions should be visually close to the fighter preview.

## Motion & Sound Direction

Motion should feel responsive and arcade-like: fast state changes, small hover lifts, crisp loading feedback, and no slow page choreography.

Potential sound vocabulary, if audio branding is added:

- coin insert,
- cabinet hum,
- menu cursor tick,
- roster select confirm,
- "Ready" and "Fight" style announcer cues written and recorded as original lines,
- victory/continue stings.

Never sample or imitate recognizable franchise announcers, music, effects, or move calls.

## Copy

Best verbs:

- Insert
- Create
- Build
- Fight
- Clone
- Upgrade
- Sync
- Share

Avoid:

- unleash,
- supercharge,
- next-gen,
- AI-powered as the headline hook,
- 2D yourself,
- avatar generator,
- metaverse,
- "like Street Fighter".

Preferred CTAs:

- Create fighter
- Insert player
- Fight CPU
- Clone fighter
- Upgrade to Contender
- Upgrade to Champion
- Sync cloud

## Implementation Notes

- Existing `asf` token/class prefixes are internal implementation names. Do not show `ASF` publicly.
- React owns all non-match UI; Phaser owns only the match runtime.
- Follow Tailwind through `src/ui/styles.css`. Do not add inline styles or raw CSS inside Tailwind layers.
- Static public brand lives in `index.html`, `public/site.webmanifest`, `public/assets/*`, and launch env.
- Dynamic public brand surfaces must read configured brand env and keep launch gates intact.
