# Aura comic feedback

Presentation-only follow-up to shared fighter pose calibration. No sprite PNGs,
animation timings, judgement windows, score rules, input bindings or React fonts
are changed.

## Feedback outside the character

- Seven hand-authored comic icons and short move labels, including 67 with
  alternating palms and an original square-jaw portrait for MOG CHECK.
- The cue follows the actual loaded Aura move, once per change, not every note.
  A combat-only fighter does not advertise an Aura animation it cannot play.
- A short synthesized sound accompanies each newly shown move. Seven distinct
  motifs share the existing sound/recording bus; they do not trigger on each
  hit, repeated move request, streak, or expired bubble. Pause and shutdown
  stop scheduled voices. The landing preview offers the same sounds, opt-in.
- Score gains stay subordinate: a single 9px signed delta under the active HUD
  score replaces the previous value, expires after 650ms and moves only 3px.
  “AURA” remains in the total, not every gain. Above the notes, a compact grade
  and timing meter convey accuracy without another copy of the score.
- Positive cue at each ten-note combo milestone. Negative cue after two mistakes,
  then every fourth additional failure; a clean note resets that sequence.
- Two bounded UI objects per seat (move and streak), cancelled at handoff,
  replacement, expiry and scene shutdown. No extra textures or model calls.
- Transparent move artwork and outlined cream/gold text sit outside the note
  highway. There are no plates, speech-bubble tails, rectangular shadows or fills.
  Each icon has a crisp 1.6px cream contour; all original interior art is preserved.
- Move cues rise continuously by 24px over 1.8s; streak cues by 12px over 1.3s.
  Both fade over their last 420ms. The full paths stay below the score HUD and
  separate from each other. Reduced motion keeps the same information without
  translation or opacity tweens.

No sprite tints, additive body bursts, spark showers, failure spotlight dips,
streak-driven light intensification, handoff light sweep, note camera shakes or
beat-driven camera zoom remain. The fixed floor marker and smooth turn framing
remain; source sprite colour and opacity stay unchanged.

## Waiting turns

Handoffs reset both performers to a neutral hold. A loaded `aura_unbothered`
uses calibrated frame zero without advancing its clock; absent that asset, the
base combat idle is frozen. The inactive Fighter is not updated at all, because
`Fighter.update(0)` still advances `stateFrame`. Automatic rival shrug reactions
are disabled. A late network judgement still scores but cannot wake the waiting
performer. Match-end presentation remains separate.

## Verification

78 focused tests cover visual feedback, full ascent bounds, art contours and
preservation, actual move selection, frozen waiting actors, late network scoring,
controls, reduced motion and cleanup. Previous full baseline: 1,564 passed,
6 skipped. Production build succeeds (existing bundle-size warnings).
Browser QA covers all seven transparent illustrations on actual stage art,
their ascent/expiry, and the prior two-player arena integration.
These changes are local, not a production deployment.

The quieter score and sound follow-up adds checks for a single bounded HUD cue,
late timer cleanup, one sound per visible move, silent waiting seats, audio
lifecycle and recording routing. It preserves the scoring and chart rules.
Current validation: 2,048 tests passed, 6 skipped; production build succeeds.

Copy references: [Dictionary.com on six-seven](https://www.dictionary.com/articles/word-of-the-year-2025)
and [Merriam-Webster on mog](https://www.merriam-webster.com/slang/mog).
Other move captions are game copy, not attributed names of viral trends.
