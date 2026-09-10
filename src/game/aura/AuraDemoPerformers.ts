import type { MatchSceneData } from '../match/MatchConfig.ts';

export interface AuraDemoPerformer { id: 'template-zero'; tint: number }

/** Explicit offline presets only. A name collision must never replace a
 * recipient's own identity, a pending cloud pack, or a live online opponent. */
export function auraDemoPerformer(data: MatchSceneData, slot: 0 | 1): AuraDemoPerformer | undefined {
  if (data.online || (slot === 0 ? data.p1PhotoHash || data.p1CloudFighterId : data.p2PhotoHash || data.p2CloudFighterId)) return;
  const name = slot === 0 ? data.p1Name : data.p2Name;
  if (name === 'NOVA') return { id: 'template-zero', tint: 0xffffff };
  if (name === 'BYTE') return { id: 'template-zero', tint: 0x8cdeff };
}
