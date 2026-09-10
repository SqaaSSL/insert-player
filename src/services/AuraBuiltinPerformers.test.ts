import { describe, expect, it } from 'vitest';
import {
  builtinAuraPerformerForCachedMeta,
  builtinAuraPerformerForCloud,
  builtinAuraPerformerForIdentity,
} from './AuraBuiltinPerformers.ts';

describe('reviewed official Aura bundle identity', () => {
  it('recognizes the current public Arcade identity independently of its display name', () => {
    const fighter = { id: 'public-trump', public: true, arcade: { slug: 'donald-trump' }, name: 'Renamed' };
    expect(builtinAuraPerformerForCloud(fighter)).toBe('donald-trump');
    expect(builtinAuraPerformerForIdentity(fighter)).toBe('donald-trump');
    expect(builtinAuraPerformerForCloud({ ...fighter, public: false })).toBeNull();
    const sameNamedPrivateCopy = { ...fighter, arcade: undefined, name: 'Donald Trump' };
    expect(builtinAuraPerformerForCloud(sameNamedPrivateCopy)).toBeNull();
    expect(builtinAuraPerformerForCloud({ ...fighter, arcade: { slug: 'other' } })).toBeNull();
  });

  it('requires canonical cache metadata with the matching public manifest id', () => {
    const meta = { photoHash: 'arcade:donald-trump:public-trump', cloudFighterId: 'public-trump', cloudPublic: true };
    expect(builtinAuraPerformerForCachedMeta(meta)).toBe('donald-trump');
    expect(builtinAuraPerformerForIdentity(meta)).toBe('donald-trump');
    for (const rejected of [
      { ...meta, photoHash: 'arcade:donald-trump' },
      { ...meta, photoHash: 'private-trump-photo' },
      { ...meta, photoHash: 'arcade:another-person:public-trump' },
      { ...meta, photoHash: 'arcade:donald-trump:public-trump:copy' },
      { ...meta, cloudPublic: false },
      { ...meta, cloudPublic: undefined },
      { ...meta, cloudFighterId: 'another-id' },
      { ...meta, cloudFighterId: null },
    ]) expect(builtinAuraPerformerForCachedMeta(rejected)).toBeNull();
  });

  it('rejects missing, empty, or malformed identities rather than guessing a performer', () => {
    expect(builtinAuraPerformerForIdentity(null)).toBeNull();
    expect(builtinAuraPerformerForIdentity(undefined)).toBeNull();
    for (const id of ['', ' ', 'a:b', 'with whitespace']) {
      expect(builtinAuraPerformerForCloud({ id, public: true, arcade: { slug: 'donald-trump' } })).toBeNull();
      expect(builtinAuraPerformerForCachedMeta({
        photoHash: `arcade:donald-trump:${id}`, cloudPublic: true, cloudFighterId: id,
      })).toBeNull();
    }
  });
});
