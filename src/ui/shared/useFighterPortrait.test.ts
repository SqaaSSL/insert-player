import { describe, expect, it } from 'vitest';
import { selectFighterPortrait } from './useFighterPortrait.ts';

describe('fighter portrait policy', () => {
  const sideViewCleanBlob = new Blob(['clean side']);
  const sideViewBlob = new Blob(['side']);
  const uprightViewBlob = new Blob(['processed upright']);
  const originalPhotoBlob = new Blob(['private original']);
  const all = { sideViewCleanBlob, sideViewBlob, uprightViewBlob, originalPhotoBlob };

  it('Aura uses the processed upright even when a Fight portrait exists', () => {
    expect(selectFighterPortrait(all, 'upright')).toBe(uprightViewBlob);
  });
  it('Aura never substitutes a lateral pose, raw upright, or original photo', () => {
    expect(selectFighterPortrait({ ...all, uprightViewBlob: null }, 'upright')).toBeNull();
    expect(selectFighterPortrait({ uprightViewRawBlob: new Blob(['raw']) } as never, 'upright')).toBeNull();
    expect(selectFighterPortrait(null, 'upright')).toBeNull();
  });
  it('preserves the Fight/Rush priority and fallback behavior', () => {
    expect(selectFighterPortrait(all)).toBe(sideViewCleanBlob);
    expect(selectFighterPortrait({ ...all, sideViewCleanBlob: null })).toBe(sideViewBlob);
    expect(selectFighterPortrait({ ...all, sideViewCleanBlob: null, sideViewBlob: null })).toBe(uprightViewBlob);
    expect(selectFighterPortrait({ ...all, sideViewCleanBlob: null, sideViewBlob: null, uprightViewBlob: null })).toBe(originalPhotoBlob);
  });
});
