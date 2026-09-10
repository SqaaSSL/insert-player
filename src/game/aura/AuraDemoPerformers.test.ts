import { describe, expect, it } from 'vitest';
import { auraDemoPerformer } from './AuraDemoPerformers.ts';
import type { MatchSceneData } from '../match/MatchConfig.ts';

describe('isolated generic Aura demo performers', () => {
  const demo: MatchSceneData = { gameMode: 'aura', p1Name: 'NOVA', p2Name: 'BYTE' };
  it('uses the reviewed neutral pack with distinct demo presentation tints', () => {
    expect(auraDemoPerformer(demo, 0)).toEqual({ id: 'template-zero', tint: 0xffffff });
    expect(auraDemoPerformer(demo, 1)).toEqual({ id: 'template-zero', tint: 0x8cdeff });
  });
  it('never substitutes private, pending cloud, unknown, or online identities', () => {
    for (const data of [{ ...demo, p1PhotoHash: 'owned' }, { ...demo, p1CloudFighterId: 'pending' },
      { ...demo, p1Name: 'Donald Trump' }, { ...demo, p1Name: 'Player One' },
      { ...demo, online: { localSlot: 0 } }]) {
      expect(auraDemoPerformer(data as MatchSceneData, 0)).toBeUndefined();
    }
    expect(auraDemoPerformer({ ...demo, p2PhotoHash: 'owned' }, 1)).toBeUndefined();
    expect(auraDemoPerformer({ ...demo, p2CloudFighterId: 'pending' }, 1)).toBeUndefined();
  });
});
