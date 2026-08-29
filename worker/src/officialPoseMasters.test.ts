import { describe, expect, it } from 'vitest';
import { officialPoseMasterFor } from './officialPoseMasters';

describe('official pose masters', () => {
  it('pins the approved four-frame jump atlas for official Champion fighters', () => {
    const master = officialPoseMasterFor('jump', 'champion', 'Approved fighter description');

    expect(master?.id).toBe('arcade-qa-pose-atlas-2026-v1:jump');
    expect(master?.frames).toHaveLength(4);
    expect(master?.frames.map((frame) => frame.sha256)).toEqual([
      '98db8a1f138f19e8ae9dc484aae60395fe4c3c4beffe587336e25400a33a3904',
      '781b3376209a8a1a2cbc12f290cf32446d0dc7d67d94c0347433923c7e369801',
      '08f46afaa557c19f22c387a8a7b4fb1726ad3d402ff11752d2f2f437bb9589da',
      '4c7aa66534fa698ac0666d440a0037f8fbfc8524ea43f989a3d9764d69cb7c49',
    ]);
  });

  it('never injects the atlas into personal, lower-tier, or unrelated generations', () => {
    expect(officialPoseMasterFor('jump', 'champion', undefined)).toBeNull();
    expect(officialPoseMasterFor('jump', 'contender', 'Approved fighter description')).toBeNull();
    expect(officialPoseMasterFor('idle', 'champion', 'Approved fighter description')).toBeNull();
  });
});
