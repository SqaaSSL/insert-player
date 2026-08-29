---
version: alpha
name: Broadside — Frame (video / frame layer)
description: >
  Insert Player launch system built on Broadside's declarative frame grammar. Real transformation
  imagery and real gameplay dominate. Press Start 2P is reserved for short arcade statements;
  Space Grotesk carries readable copy and chrome. Cabinet black, coin red, coin gold, CRT cream,
  and glass blue make the frame feel like Insert Player rather than the source preset.
unit: the frame — 1920×1080 primary; 9:16 and 1:1 documented
principle: real proof first · one arcade statement per frame · composition is free

colors:
  canvas: "#04040D"
  ink-black: "#04040D"
  ink-black-alt: "#0A0A20"
  fire-orange: "#FF2A2A"
  cream: "#FFF4D6"
  cream-muted: "#FFCE3A"
  cream-hint: "#C9C0A8"
  border-dark: "rgba(255,206,58,0.52)"
  glass-blue: "#4FB3FF"
  player-green: "#30E07A"
  ink-on-orange-muted: "rgba(4,4,13,0.75)"
  ink-on-orange-hint: "rgba(4,4,13,0.55)"
  ink-on-orange-faint: "rgba(4,4,13,0.40)"
  ink-on-orange-border: "rgba(4,4,13,0.20)"

typography:
  # — reading ramp —
  body:    { fontFamily: "Space Grotesk", cqw: 1.2, weight: 400, lineHeight: 1.45, tracking: "0" }
  lead:    { fontFamily: "Space Grotesk", cqw: 1.6, weight: 500, lineHeight: 1.35, tracking: "0" }
  caption: { fontFamily: "Space Grotesk", cqw: 0.9, weight: 500, lineHeight: 1.35, tracking: "0" }
  label:   { fontFamily: "Space Grotesk", cqw: 0.78, weight: 700, tracking: "0", upper: true }
  # — display / hero ramp (short uppercase arcade statements only) —
  h3:      { fontFamily: "Press Start 2P", cqw: 2.8, weight: 400, lineHeight: 1.2, tracking: "0", upper: true }
  quote-text:{ fontFamily: "Press Start 2P", cqw: 3.8, weight: 400, lineHeight: 1.15, tracking: "0", upper: true }
  h2:      { fontFamily: "Press Start 2P", cqw: 4.5, weight: 400, lineHeight: 1.1, tracking: "0", upper: true }
  stat-value:{ fontFamily: "Press Start 2P", cqw: 5.5, weight: 400, lineHeight: 1.0, tracking: "0" }
  h1:      { fontFamily: "Press Start 2P", cqw: 7.5, weight: 400, lineHeight: 0.95, tracking: "0", upper: true }
  fadelist-item:{ fontFamily: "Press Start 2P", cqw: 7.5, weight: 400, lineHeight: 1.0, tracking: "0", upper: true }
  quote-mark:{ fontFamily: "Press Start 2P", cqw: 10.0, weight: 400, lineHeight: 0.6 }
  fadelist-title:{ fontFamily: "Press Start 2P", cqw: 10.5, weight: 400, lineHeight: 0.95, tracking: "0", upper: true }
  display: { fontFamily: "Press Start 2P", cqw: 13.0, weight: 400, lineHeight: 0.92, tracking: "0", upper: true }

spacing:
  pad-x: "5.5cqw"
  pad-y: "5.5cqw"
  gap-lg: "3.5cqw"
  gap-md: "2cqw"
  gap-sm: "1cqw"

components:
  registers:
    dark: "ground {colors.ink-black}, text {colors.cream}, accent {colors.fire-orange}"
    orange: "ground {colors.fire-orange}, text {colors.ink-black}"
    description: "Two surfaces only — no cream/paper register. One register per frame."
  slide-chrome:
    rule: "1px solid {colors.border-dark} (dark) / 20% ink (orange)"
    placement: "top + bottom bars (label left, number right)"
    description: "SUPPRESSED on cover/chapter/statement/quote/end — declarative frames let type fill the field."
  kicker:
    typography: "{typography.label}"
    color: "{colors.fire-orange} (dark) / 55% ink (orange)"
    description: "Uppercase mono eyebrow."
  rule:
    backgroundColor: "{colors.fire-orange} (dark) / {colors.ink-black} (orange)"
    size: "36×2px"
    description: "Stub accent bar — the system's only ornament."
  broadside-num:
    typography: "{typography.label}"
    placement: "top-left of orange cover/chapter, low opacity"
    description: "Mono catalogue numeral."
  stat-card:
    borderTop: "1px solid {colors.border-dark}"
    typography: "{typography.stat-value} (orange on dark / ink on orange) + {typography.body} + {typography.label}"
    description: "Top-border-only block, no other borders."
  bullet:
    marker: "orange `/` mono via ::before"
    typography: "{typography.lead}"
    description: "Capped at THREE items."
  bar-track:
    borderLeft: "1px solid {colors.border-dark}"
    bars: "{colors.cream-hint}, one .accent {colors.fire-orange}"
    typography: "{typography.label} axis"
    description: "Vertical bar chart, left axis only."
  compare-panel:
    layout: "two equal panels split by a 1px vertical rule"
    payoff: "right panel may fill {colors.fire-orange}"
    description: "Before/after."
  fadelist:
    typography: "{typography.fadelist-item} ×3 at opacity 1.0/0.5/0.22 + {typography.fadelist-title}"
    description: "Three stacked words + one oversized title opposite."
---

# Broadside — Frame (video / frame layer)

## Brand adaptation (READ FIRST — the frontmatter is the source of truth)

This is the **broadside** preset remixed onto the captured brand. The YAML frontmatter above (colors · typography · components) is **normative and already correct — use it verbatim.** The prose below is the ORIGINAL preset's intent; read it THROUGH the frontmatter:

- **Fonts** — **Press Start 2P** is display-only; **Space Grotesk** owns body, labels, and chrome. Ignore any preset font name lingering in prose.
- **Weights** — the brand font ships `{400, 500, 700}` only; every weight is clamped to these — ignore higher preset weights (e.g. 600/700) in prose.
- **Colors** — use the frontmatter values. Coin red is the primary action, coin gold the highlight, and glass blue the cool counterpoint.
- **Case and tracking** — arcade display is uppercase with `letter-spacing: 0`. Ignore every later lowercase or negative-tracking instruction inherited from Broadside.
- **Media** — real transformation art and real gameplay take priority over type-only poster treatments.


## Overview

Broadside at frame scale is a **protest-poster system where type is so large it stops reading as
text and becomes graphic primitive.** Press Start 2P `display` at 13cqw puts a single lowercase word
nearly across the frame. The system runs in **two registers**: a dark ink-black ground with cream
text for documentation, and a fire-orange ground with dark ink for declaration. Fire-orange is the
_only_ color — accent on dark, environment on orange. The plane is flat; hierarchy is weight, size,
and 1px hairlines.

**Press Start 2P** carries every text role from display to body — expressive range from weight (400–900)
and size, not face contrast. **IBM Plex Mono** is chrome only (numbers, kickers, tags, axis labels,
the `/` bullet marker), always uppercase and tracked. Display is **lowercase** — the system's most
distinctive single decision, a deliberate inversion of the brutalist norm.

**Key characteristics at frame scale:**

- **Two registers** — dark (cream text) / orange (ink text). No cream/paper register.
- **Massive lowercase Press Start 2P 900**, negative-tracked, as graphic primitive (display 13cqw).
- **Fire-orange is the only color** — accent on dark, full environment on orange.
- **IBM Plex Mono chrome** — uppercase, 0.14em; the `/` bullet marker; mono catalogue numbers.
- **Flat plane** — no shadow, no radius (save nav dots), no gradient; 1px hairlines carry structure.
- **Low density** — one statement per frame, bullets capped at three, chrome suppressed on declarative frames.

## The Frame

### Frame Craft Bar

Three eyeball tests gate every frame before any structural check:

- **Squint** — exactly **one display moment dominates** at 3–6× everything else; nothing competes.
- **Silence** — declarative frames read **45–55% empty**; the **stat grid is the one dense exception**.
- **Restraint** — **one register per frame**; **fire-orange is the only color** (accent on dark, environment on orange); one display moment; bullets capped at three.
- **Reference** — aim at **broadside printing / a SPACE10 report / a Wim Crouwel grid with one loud color**; failure looks like a **multi-accent corporate slide deck**.

- **Primary:** 1920×1080 (16:9). Type authored in **`cqw`** (`px ÷ 1920 × 100 = cqw`; or carry the source's `vw` 1:1).
- **Vertical:** 1080×1920 (9:16). **Square:** 1080×1080 (1:1).
- **Safe area:** `pad-x`/`pad-y` 5.5cqw — deliberately tight so the massive type crowds the frame edge.

**The container law (load-bearing).** Every frame ground sets `container-type: size`; ALL
frame-relative units are `cqw`/`cqh` against it — never `vw` (a `vw`-sized frame inflates when not
full-screen). 1px hairlines stay 1px.

## Colors

Tokens identical to the source, in two registers. **Dark:** `{colors.ink-black}` ground,
`{colors.cream}` text, `{colors.fire-orange}` accent (kickers, accent stat, bullet `/`, lead bar,
quote mark, rule stub). **Orange:** `{colors.fire-orange}` ground, `{colors.ink-black}` headlines +
body, with the dark-ink overlays (75/55/40/20%) as the muted tones. Choose one register per frame
and commit. **No second accent color** — on orange, emphasis is weight/opacity on the ink, never a
new hue. Cream text on orange does not exist (ink-on-fire is absolute).

## Typography

Two ramps. The **reading ramp** (Press Start 2P body 1.2cqw, mono label 0.72cqw) carries copy + chrome; the
**display ramp** (Press Start 2P `h2` 4.5cqw → `display` 13cqw, weight 700–900) carries every statement.

- **Legibility floor:** any load-bearing line ≥ **1.4cqw**; mono labels are chrome only.
- **Fit-to-measure:** size the headline to its length. Cap the block at **≤ 78cqw**; ≤2 words → `display`; 3–4 → `h1`; 5+ → `h2`. Broadside packs only ONE display moment per frame.
- **Press Start 2P display is lowercase, weight 700–900, negative-tracked** (−0.04em largest, −0.02em h2). **Mono chrome is uppercase, 0.1em+.** No italic, no underline, no uppercase display.

## Depth & Surface

Flat plane, the only technique. Hierarchy from:

- **Weight + size contrast** — the dominant signal (900 lowercase display).
- **1px hairlines** — chrome bars, stat-card top, compare divider, bar-track left, chart baseline.
- **Color shift** — orange on ink, ink on cream, cream-muted on cream.
- **Negative space** — generous, intentional empty regions.

**Ceiling:** no box-shadow, no elevation, no rounded surface (save nav dots), no gradient ground.

## Shapes

- **0 radius everywhere** except nav dots (50%). Cards, panels, tags, stat blocks, bars — sharp rectangles.

## Components

- **registers** — the two-surface system. **slide-chrome** — optional hairline bars, suppressed on declarative frames.
- **kicker** (mono eyebrow) / **rule** (36×2 stub) / **broadside-num** (catalogue mark) — the chrome ornament set.
- **stat-card** (top-border only) / **bullet** (orange `/`, max 3) / **bar-track** (one accent bar) / **compare-panel** (orange payoff) / **fadelist** (1.0/0.5/0.22 stack).

## Frame Treatments

> Recipe: ground · register · composes · focal · chrome · accent · silence · Fixed/Free · density.
> One statement per frame; chrome suppressed on declarative frames.

### 1 · Cover (identity · move: massive type · ORANGE register · left)

**Ground** fire-orange. **Composes** broadside-num, rule, kicker, display, lead. **Focal** a 1–2 word
Press Start 2P `display` (13cqw) lowercase in ink, left-anchored, over a small ink rule stub + mono kicker; a
Press Start 2P lead line beneath in 75% ink. **Chrome** mono catalogue number top-left, mono meta top-right
(no chrome bars). **Accent** the ink itself is the pop on orange. **Silence** ~45%. **Fixed** ink-on-fire,
lowercase 900, flat. **Free** the word, kicker, lead. **Density** low.

### 2 · Statement (declarative · move: type IS composition · DARK register · left)

**Ground** ink-black. **Composes** kicker, display. **Focal** a 2–4 word Press Start 2P `display`/`h1`
lowercase in cream, with ONE clause inked `{colors.fire-orange}`. **Chrome** mono kicker; no bars.
**Accent** the orange clause. **Silence** ~55%. **Fixed** lowercase 900, one orange clause, flat.
**Free** the statement, which clause is orange. **Density** low.

### 3 · Stat Grid (data · move: top-border cards · DARK · the dense frame)

**Ground** ink-black, chrome bars present. **Composes** slide-chrome, kicker, 3× stat-card. **Focal** a
row of three top-border-only stat-cards — big Press Start 2P-900 numeral in `{colors.fire-orange}`, Press Start 2P
label, mono note. **Chrome** top + bottom hairline bars (label + number). **Accent** the orange
numerals. **Silence** moderate — the density exception. **Fixed** top-border-only cards, orange
numerals, 1px hairlines. **Free** figures (from script), labels. **Density** dense-exception.

### 4 · Fadelist (narrative · move: opacity stack · DARK)

**Ground** ink-black. **Composes** fadelist (3 stacked Press Start 2P-900 words at 1.0/0.5/0.22), fadelist-title.
**Focal** the three-stage word stack opposite an oversized display title in `{colors.fire-orange}`
(before/during/after). **Accent** the orange title. **Silence** moderate. **Fixed** the opacity
ladder, lowercase 900. **Free** the three words, the title. **Density** low-moderate.

### 5 · Pull Quote (quote · move: oversized mark · DARK · left)

**Ground** ink-black, chrome suppressed. **Composes** quote-mark, quote-text, attribution. **Focal** a
Press Start 2P `quote-text` (700, lowercase) at ≤78cqw under an oversized fire-orange `quote-mark` (10cqw,
line-height 0.6). **Chrome** mono attribution (name + role). **Accent** the orange quote mark. **Silence**
~50%. **Fixed** orange mark, lowercase quote. **Free** quote, attribution. **Density** low.

### 6 · Compare (argument · move: split + orange payoff · DARK→ORANGE)

**Ground** ink-black left panel + fire-orange right (payoff) panel, 1px divider. **Composes**
compare-panel pair, kicker, h3. **Focal** two panels — left documents (cream on dark), right declares
(ink on orange). **Chrome** mono panel labels. **Accent** the orange payoff panel. **Silence** moderate.
**Fixed** ink-on-fire right panel, 1px divider, flat. **Free** the before/after content. **Density** standard.

## Composition Rules

### Do

- Set every Press Start 2P display in **lowercase weight 900**, negative-tracked — the system's signature.
- Use **fire-orange as full environment** on declarative frames, the **lone accent** on dark.
- Keep chrome in **IBM Plex Mono uppercase, 0.14em**; use the `/` mono bullet marker.
- **Cap bullets at three; one statement per frame**; build hierarchy from weight, size, 1px hairlines.
- Suppress chrome bars on cover/chapter/statement/quote/end; let type fill the field.
- Lean left on most frames; the type IS the composition.

### Don't

- Never uppercase Press Start 2P display; never add a second accent color.
- Never put cream text on orange (ink-on-fire is absolute); never a cream/paper register.
- No drop shadow, no rounded surface (save nav dots), no gradient ground.
- No serif companion; chrome is never Press Start 2P.
- Don't pack two display moments into one frame; don't blow a long line edge-to-edge — step down.

## Aspect-Ratio Behavior

| Treatment  | 16:9                       | 9:16                       | 1:1              |
| ---------- | -------------------------- | -------------------------- | ---------------- |
| Cover      | word left, lead below      | word top, lead below       | centered word    |
| Statement  | display left               | display stacked taller     | display centered |
| Stat Grid  | 3 across                   | 3 stacked                  | 2+1              |
| Fadelist   | stack + title side-by-side | stack over title           | stack over title |
| Pull Quote | mark + quote left          | mark top, quote below      | centered         |
| Compare    | side-by-side panels        | stacked (dark over orange) | stacked          |

`pad-x` holds tight on the short edge; re-step display so the one big line stays ≤78cqw and above the
1.4cqw floor. Mono chrome stays Latin/digit-only.

## Approved Entities

No real customers, logos, or vendors are defined in the source — render any such mark as a
placeholder (the dashed `img-placeholder` at 55cqh). The system supplies type and one color, not brands.

## Numerals & Claims (hard rule)

Never invent figures, percentages, dates, or counts at frame scale. Render slots as `— figure —`,
`{metric}`, `NN%`. Stat-card numerals and bar heights carry placeholders until the script supplies
them. Catalogue numbers (No. 01) are decorative chrome and may be sequential.

## Pre-Render Self-Audit

- **Squint** — exactly one display moment dominates; nothing competes.
- **Silence** — declarative frames ~45–55% empty; only the stat grid runs dense.
- **Register** — one register per frame; ink-on-fire on orange, cream on dark; no second hue.
- **Type** — Press Start 2P lowercase 900 negative-tracked, fit-to-measure; mono chrome uppercase 0.14em; ≥1.4cqw floor.
- **Depth** — 0 shadow, 0 radius (save nav dots); 1px hairlines only.
- **Bullets** — capped at three, orange `/` marker.
- **Fabrication** — every numeral traces to the script, else placeholder.

## Known Gaps

- **Motion intentionally out of scope.** frame.md specifies composition only; the source's 0.8s deck slide + per-element entry animations are deck mechanics.
- **Press Start 2P + IBM Plex Mono via Google Fonts**; Noto Sans SC is the CJK fallback (the lowercase-display signal has no CJK equivalent — the two-register color system carries the identity, per the source).
- **9:16 / 1:1 are guidance**; verify the one big line stays ≤78cqw and above the floor per ratio.
- Bars, compare panels, and the dashed image placeholder are CSS-only; no external imagery is required.


## Font loading (auto-generated)

The brand font ships as local files in `assets/fonts/` — do NOT link Google Fonts for it. Paste this `<style>` into every frame's `<head>`/`<template>` (captions use the same files) so `font-family` resolves in preview, snapshot, and render alike:

```html
<style>
@font-face{font-family:"Press Start 2P";font-weight:400;font-style:normal;font-display:block;src:url("assets/fonts/PressStart2P-400.woff") format("woff");}
@font-face{font-family:"Press Start 2P";font-weight:400;font-style:normal;font-display:block;src:url("assets/fonts/PressStart2P-400.woff2") format("woff2");}
@font-face{font-family:"Space Grotesk";font-weight:400;font-style:normal;font-display:block;src:url("assets/fonts/SpaceGrotesk-400.woff") format("woff");}
@font-face{font-family:"Space Grotesk";font-weight:400;font-style:normal;font-display:block;src:url("assets/fonts/SpaceGrotesk-400.woff2") format("woff2");}
@font-face{font-family:"Space Grotesk";font-weight:500;font-style:normal;font-display:block;src:url("assets/fonts/SpaceGrotesk-500.woff") format("woff");}
@font-face{font-family:"Space Grotesk";font-weight:500;font-style:normal;font-display:block;src:url("assets/fonts/SpaceGrotesk-500.woff2") format("woff2");}
@font-face{font-family:"Space Grotesk";font-weight:700;font-style:normal;font-display:block;src:url("assets/fonts/SpaceGrotesk-700.woff") format("woff");}
@font-face{font-family:"Space Grotesk";font-weight:700;font-style:normal;font-display:block;src:url("assets/fonts/SpaceGrotesk-700.woff2") format("woff2");}
</style>
```
