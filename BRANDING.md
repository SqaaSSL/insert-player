# Branding & Trademark Clearance

`AI Street Fighter` is an internal project name only. Do not use it as the public launch brand.

`Street Fighter` is a Capcom mark for video games/software and related goods. A public fighting-game product called `AI Street Fighter` is too close for launch-risk tolerance, especially if the game becomes viral.

Selected public brand direction: `Insert Player`.

- Platform brand: `Insert Player`
- First game: `Insert Player: Fight`
- Short app name/icon text: `P1`
- Target domain: `https://insertplayer.ai`
- Core tagline direction: `Insert yourself into the game.`

## Brand System Snapshot

Insert Player is a product brand, not just a game title. It can hold future games beyond fighting while the first shipped experience remains `Insert Player: Fight`.

The sharpest positioning:

> Turn a real person into a playable arcade character.

The emotional territory is arcade insertion: coin slots, P1/P2, rosters, challengers, ready states, cabinet energy, and the moment a user sees themself as a playable character. This should feel nostalgic to people who grew up around arcade and console fighters, without copying any protected franchise.

Preferred language:

- `Insert yourself into the game.`
- `Make yourself playable.`
- `Create fighters, upgrade quality, clone challengers.`
- `Your roster follows you.`

Avoid public language like:

- `AI Street Fighter`
- `2D yourself`
- `avatar generator`
- `like Street Fighter`
- `like Mortal Kombat`
- `AI-powered profile picture`

Brand docs now live in:

- `PRODUCT.md` - strategic product/brand contract.
- `DESIGN.md` - visual system and implementation guidance.

## Name Hierarchy

- Company/operator: can be ShellBot in legal/footer contexts.
- Public product/platform: `Insert Player`.
- First game: `Insert Player: Fight`.
- Compact mark/app icon: `P1`.
- Internal repo/project: `AI Street Fighter`.

For launch, auth, checkout, emails, social cards, and app metadata should feel product-branded as Insert Player. ShellBot can appear as the operator, but should not be the first thing a new user sees when signing up for Insert Player.

## Visual Direction

The public mark should emphasize `P1` and insertion, not a fighter silhouette. Use cabinet frames, coin slots, roster screens, source-photo-to-sprite transformation, and actual generated fighters as proof.

Avoid direct genre iconography that can drift toward protected franchises: fireballs, dragons, skulls, ninjas, military sprite shorthand, plumbers, copied character select layouts, copied announcer phrasing, or sampled arcade audio.

## Original Sound Direction

If sound branding is added, use original recordings and generated effects in the broad coin-op vocabulary:

- coin insert,
- cabinet hum,
- cursor tick,
- select confirm,
- ready cue,
- fight cue,
- victory/continue sting.

Do not sample or imitate recognizable announcers, music, hit sounds, menu sounds, or move calls from legacy games.

## Claude Design / External Design Brief

If using Claude Design or another design tool, use this brief rather than asking for "a logo":

```text
Create three brand directions for Insert Player, a browser product that turns a real person into a playable retro arcade character. The first game is Insert Player: Fight, but the platform should later support other game formats.

The mark should center on P1, insertion, coin-op energy, and the transformation from photo to sprite to playable roster. It must avoid looking like Street Fighter, Mortal Kombat, Metal Slug, Mario, or any existing game franchise. No copied character-select screens, no fireballs, no dragons, no skulls, no ninjas, no military sprites, no sampled arcade assets.

Tone: arcade-native, player-first, competitive, modern, viral, trustworthy enough for account and checkout flows.

Deliver:
1. app icon concept using P1,
2. wordmark concept for Insert Player,
3. social card layout that proves the product by showing photo -> sprite -> fight,
4. palette and typography guidance,
5. notes for how the brand appears in auth, Stripe checkout, community share pages, and mobile.
```

The name is selected and has a favorable owner-directed screen. On 2026-08-19, the owner recorded the decision to launch under `Insert Player` and accept the moderate residual risk without outside counsel in the ignored `.brand-clearance.json`. This clears the repository's brand gate; it is not a legal opinion or guarantee of registrability. Reserve the campaign handles before public promotion.

## Preliminary Clearance Screen — 2026-08-17

- EUIPO-operated TMview searched 142,341,440 marks across participating EU, national, US, and WIPO collections. Exact searches for `Insert Player`, `InsertPlayer`, and `Player Insert`, plus a contains-phrase search for `Insert Player`, returned no rows.
- USPTO Trademark Search returned no exact `INSERT PLAYER` filing and no live mark containing both words in relevant software/entertainment classes 009, 041, or 042.
- Broad web, Steam, Apple App Store, and Google Play searches found phrase uses in instructions and placeholder copy, but no visible game/software product branded `Insert Player` in the reviewed results.
- `insertplayer.ai` is registered through Namecheap until 2028-05-17. DNS delegation to Cloudflare remains operational work, not a name-availability issue.
- Approximate searches naturally return many unrelated marks containing either common word (`INSERT`, `PLAYER`, `PLAYER+`, and similar). None reviewed is the combined `Insert Player` name, but a preliminary search cannot rule out every unregistered/common-law use or future filing.
- Direct handle checks on 2026-08-17 found the exact `@insertplayer` handle occupied on X by an unrelated personal account and on YouTube by a small, active AI/TTRPG entertainment channel. Instagram and TikTok returned no account for the exact handle.
- Use `@playinsertplayer` as the consistent launch handle. Direct public checks returned not-found/unavailable-profile pages for that handle on X, Instagram, TikTok, and YouTube on 2026-08-17. Availability is not ownership: reserve it on product-controlled accounts before launch.

Working assessment: **cleared for launch by owner-directed risk acceptance**, with moderate residual risk from the two common English words, the adjacent exact-name YouTube channel, and the limits of a self-directed screen. Do not describe this as a legal opinion or guaranteed registrability. The owner recorded the decision in `.brand-clearance.json`; reserve `@playinsertplayer` on product-controlled accounts before the public campaign.

## Recheck — 2026-08-19

- Repeat broad web, Steam, Apple App Store, and Google Play searches again found no game, app, or software product branded `Insert Player` in the reviewed results.
- The Spanish OEPM search UI was revisited with `INSERT PLAYER`; its reCAPTCHA prevented an automated second result capture, so the dated TMview and USPTO result evidence above remains the reproducible registry screen rather than claiming a result that could not be captured.
- WHOIS confirms `insertplayer.ai` remains active through 2028-05-17 and delegated to Cloudflare. The apex and `www` currently return the intentionally undeployed Pages origin, while `api.insertplayer.ai` is live.

## Before Clerk / Stripe / Pages Launch

1. Validate `Insert Player` for public launch and keep backups only if clearance fails.
2. Run an initial screen:
   - USPTO Trademark Search: https://www.uspto.gov/trademarks/search
   - USPTO likelihood-of-confusion guidance: https://www.uspto.gov/trademarks/search/likelihood-confusion
   - WIPO Global Brand Database: https://www.wipo.int/en/web/global-brand-database/index
   - EUIPO search if Europe is in scope.
   - Domains, app stores, Steam/itch, TikTok/Instagram/X/YouTube handles, and broad web search.
3. A trademark lawyer remains the strongest route to a clearance/registrability opinion. If the owner chooses to launch without one, record that self-directed decision and residual-risk acceptance instead of implying that counsel reviewed the name. Relevant classes include game software, online entertainment/game services, platform services, and merch if the brand expands there.
4. Reserve the domain and handles only after the name looks clear enough.
5. Replace public surfaces:
   - `index.html`
   - `public/site.webmanifest`
   - `public/assets/*` social card and icons
   - `src/ui/shared/communityShare.ts`
   - Worker share-page metadata in `worker/src/fighters.ts`
   - Cloudflare Pages project/custom domain and Clerk/Stripe public dashboard names
6. Apply the selected brand mechanically:

```bash
npm run brand:apply -- --name "DoppelDojo" --short "DD" --origin "https://your-cleared-domain.example"
npm run brand:rasterize
```

For the selected brand:

```bash
npm run brand:apply -- --name "Insert Player" --short "P1" --origin "https://insertplayer.ai"
npm run brand:rasterize
```

This updates static launch metadata, the web manifest, SVG source assets, and then regenerates PNG social/app-icon assets from those SVGs.

7. Copy `brand-clearance.example.json` to ignored `.brand-clearance.json` and replace every placeholder with concrete evidence.

## Launch Gate

`npm run check:launch` requires `.brand-clearance.json` before the final production pass. It rejects:

- missing or stale clearance evidence;
- public names containing `AI Street Fighter`, `Street Fighter`, or `Capcom`;
- internal `ASF` / `SF` short names;
- production origins that do not match `ASF_FRONTEND_URL`;
- public launch surfaces that still contain the internal/Capcom-adjacent `Street Fighter` name.
