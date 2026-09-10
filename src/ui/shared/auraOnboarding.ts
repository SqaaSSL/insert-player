import { canGuideAuraFirstBattle } from '../../game/aura/AuraOnboarding.ts';
import type { MatchSceneData } from '../../game/match/MatchConfig.ts';

const KEY = 'ip:aura-first-battle:v1';
/** Device preference only; an interrupted practice remains available. */
export function shouldGuideAuraBattle(data: MatchSceneData): boolean {
  if (!canGuideAuraFirstBattle(data)) return false;
  try { return window.localStorage.getItem(KEY) !== 'done'; } catch { return true; }
}
export function rememberAuraOnboarding(): void {
  try { window.localStorage.setItem(KEY, 'done'); } catch { /* The battle still works without storage. */ }
}
