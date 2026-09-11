import type { MatchSceneData } from '../match/MatchConfig.ts';
import type { AuraBuiltinPerformerId } from '../../services/AuraBuiltinPerformers.ts';

export interface AuraDemoPerformer { id: 'template-zero' | AuraBuiltinPerformerId; tint: number }

/** Only this explicit local trial can use the bundled celebrity cast directly.
 * A roster name, challenge, or pending cloud identity is not a trial preset. */
export function isAuraTrialPresetMatch(data: MatchSceneData): boolean {
  return data.auraTrialPreset === 'trump-lamine'
    && data.gameMode === 'aura' && data.experience === 'trial'
    && data.vsAI === true && data.cpuVsCpu === false
    && !data.online && !data.auraChallenge
    && !data.p1PhotoHash && !data.p2PhotoHash
    && !data.p1CloudFighterId && !data.p2CloudFighterId;
}

/** Explicit offline presets only. A name collision must never replace a
 * recipient's own identity, a pending cloud pack, or a live online opponent. */
export function auraDemoPerformer(data: MatchSceneData, slot: 0 | 1): AuraDemoPerformer | undefined {
  if (data.online || (slot === 0 ? data.p1PhotoHash || data.p1CloudFighterId : data.p2PhotoHash || data.p2CloudFighterId)) return;
  if (data.auraTrialPreset !== undefined) {
    if (!isAuraTrialPresetMatch(data)) return;
    return { id: slot === 0 ? 'donald-trump' : 'lamine-yamal', tint: 0xffffff };
  }
  const name = slot === 0 ? data.p1Name : data.p2Name;
  if (name === 'NOVA') return { id: 'template-zero', tint: 0xffffff };
  if (name === 'BYTE') return { id: 'template-zero', tint: 0x8cdeff };
}
