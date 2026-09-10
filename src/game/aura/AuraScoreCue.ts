import type { AuraSlot } from './AuraChart.ts';
import type { AuraLayout } from './AuraLayout.ts';
import { auraHudLayout } from './AuraHud.ts';

/** Secondary HUD feedback shared by the match and its miniature. */
export const AURA_SCORE_CUE = {
  durationMs: 650, fadeMs: 220, rise: 3, fontSize: 9, alpha: 0.8,
} as const;

export function formatAuraScoreDelta(delta: number): string {
  const value = Math.round(delta);
  if (!Number.isFinite(value) || value === 0) return '';
  return `${value > 0 ? '+' : '−'}${Math.abs(value).toLocaleString('en-US')}`;
}

export function auraScoreCueAnchor(layout: AuraLayout, slot: AuraSlot) {
  return { x: slot === 0 ? 24 : layout.width - 24, y: auraHudLayout(layout).cueY, originX: slot === 0 ? 0 : 1 };
}
