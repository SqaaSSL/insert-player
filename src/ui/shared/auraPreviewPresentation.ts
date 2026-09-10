import { auraCameraComposition, AURA_CAMERA_FINALE_MS, AURA_CAMERA_HANDOFF_MS } from '../../game/aura/AuraCamera.ts';
import { auraComicAnchor, createAuraLayout } from '../../game/aura/AuraLayout.ts';
import { AURA_PERFORMANCE_DEFINITIONS } from '../../game/aura/AuraPerformance.ts';
import { AURA_SCORE_CUE, auraScoreCueAnchor } from '../../game/aura/AuraScoreCue.ts';
import type { AuraSlot } from '../../game/aura/AuraChart.ts';
import {
  AURA_PREVIEW_CHART, AURA_PREVIEW_CYCLE_MS, AURA_PREVIEW_GAIN_LIFETIME_MS,
  AURA_PREVIEW_MOVES, AURA_PREVIEW_RESULT_MS, AURA_PREVIEW_TURN_MS,
  auraPreviewFloatingGainsAt, type AuraPreviewDuelState,
} from './auraPreviewDuel.ts';
import type { AuraPreviewAnimation } from './auraPreviewGeometry.ts';

const LAYOUT = createAuraLayout(1024, 576);

/** Presentation only: camera time and reactions never modify chart or scores. */
export function auraPreviewPresentation(duel: AuraPreviewDuelState, elapsedMs: number) {
  const now = (Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0) % AURA_PREVIEW_CYCLE_MS;
  const resultAge = Math.max(0, now - (AURA_PREVIEW_CYCLE_MS - AURA_PREVIEW_RESULT_MS));
  const turnIndex = Math.min(AURA_PREVIEW_CHART.turns.length - 1, Math.floor(now / AURA_PREVIEW_TURN_MS));
  const activeSlot = duel.finished ? AURA_PREVIEW_CHART.turns.at(-1)!.slot : duel.activeSlot ?? 0;
  const camera = auraCameraComposition(LAYOUT, {
    activeSlot,
    fromSlot: !duel.finished && turnIndex > 0 ? (1 - activeSlot) as AuraSlot : undefined,
    transitionProgress: duel.turnElapsedMs / AURA_CAMERA_HANDOFF_MS,
    finaleProgress: duel.finished ? resultAge / AURA_CAMERA_FINALE_MS : undefined,
  });
  const move = AURA_PREVIEW_MOVES[duel.moveIndex];
  const actors = camera.performers.map((placement, index) => {
    const winner = duel.finished && (duel.winner === null || duel.winner === index);
    const loser = duel.finished && duel.winner !== null && duel.winner !== index;
    const animation: AuraPreviewAnimation = winner ? 'aura_one_leg' : loser ? 'aura_shrug'
      : duel.phase === 'performing' && index === activeSlot ? move.animation : 'aura_unbothered';
    const clock = duel.finished ? resultAge : duel.phase === 'performing' ? duel.turnElapsedMs : now;
    const duration = AURA_PERFORMANCE_DEFINITIONS[animation].durationMs;
    const frame = Math.floor(clock / duration * 8);
    return { ...placement, animation, frameIndex: loser ? Math.min(7, frame) : frame % 8, winner, loser };
  });
  const gains = auraPreviewFloatingGainsAt(elapsedMs).map(gain => {
    const progress = gain.ageMs / AURA_PREVIEW_GAIN_LIFETIME_MS;
    const anchor = auraScoreCueAnchor(LAYOUT, gain.slot);
    const fade = Math.max(0, (gain.ageMs - (AURA_SCORE_CUE.durationMs - AURA_SCORE_CUE.fadeMs)) / AURA_SCORE_CUE.fadeMs);
    return { ...gain, ...anchor,
      y: anchor.y - progress * AURA_SCORE_CUE.rise,
      alpha: AURA_SCORE_CUE.alpha * (1 - fade * fade),
    };
  });
  const iconAnchor = auraComicAnchor(LAYOUT, activeSlot);
  const performanceAge = Math.max(0, duel.turnElapsedMs - AURA_PREVIEW_CHART.noteTravelMs);
  const iconProgress = Math.min(1, performanceAge / 1800);
  const remainingSeconds = Math.max(0, Math.ceil((AURA_PREVIEW_TURN_MS - duel.turnElapsedMs) / 1000));
  const statusLabel = duel.finished ? `ROUND ${duel.round}/3 · FINAL RESULT`
    : `ROUND ${duel.round}/3 · P${activeSlot + 1} ON CAM · ${remainingSeconds}S`;
  // This demo never misses, so the real crowd's combo/40 floor determines its
  // heat; every successful note's incremental heat is at most 1/40 as well.
  const crowdHeat = Math.min(1, duel.combo / 40);
  const crowdLabel = crowdHeat >= 0.92 ? 'UNHINGED' : crowdHeat >= 0.68 ? 'FERAL'
    : crowdHeat >= 0.4 ? 'LOUD' : crowdHeat >= 0.18 ? 'WARMING UP' : 'WATCHING';
  return { camera, actors, gains,
    statusLabel, crowdHeat, crowdLabel,
    icon: { animation: move.animation, x: iconAnchor.x,
      y: iconAnchor.moveY - iconProgress * ('moveRise' in iconAnchor ? iconAnchor.moveRise : 24),
      alpha: duel.phase === 'performing' ? Math.min(1, (1 - iconProgress) * 3) : 0 },
  };
}
