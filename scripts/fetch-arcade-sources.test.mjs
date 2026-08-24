import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  arcadeSourceObjectPath,
  selectArcadeSourceFighters,
  verifyArcadeSourceBytes,
} from './fetch-arcade-sources.mjs';

const pngBytes = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('approved source'),
]);
const sourceSha256 = createHash('sha256').update(pngBytes).digest('hex');
const fighter = {
  slug: 'donald-trump',
  reference: { sourceSha256 },
};
const manifest = { fighters: [fighter, { ...fighter, slug: 'javier-milei' }] };

describe('private Arcade source fetch planning', () => {
  it('uses a content-addressed production R2 key', () => {
    expect(arcadeSourceObjectPath('production', fighter)).toBe(
      `insert-player-assets/official-roster-inputs/donald-trump/${sourceSha256}.png`,
    );
  });

  it('keeps sandbox source storage physically separate', () => {
    expect(arcadeSourceObjectPath('sandbox', fighter)).toBe(
      `insert-player-sandbox-assets/official-roster-inputs/donald-trump/${sourceSha256}.png`,
    );
  });

  it('selects one fighter or the full manifest, never an ambiguous request', () => {
    expect(selectArcadeSourceFighters(manifest, { slug: 'javier-milei' })).toEqual([manifest.fighters[1]]);
    expect(selectArcadeSourceFighters(manifest, { all: true })).toEqual(manifest.fighters);
    expect(() => selectArcadeSourceFighters(manifest, {})).toThrow(/exactly one/);
    expect(() => selectArcadeSourceFighters(manifest, { all: true, slug: 'donald-trump' })).toThrow(/exactly one/);
  });

  it('rejects changed bytes before they become a generation input', () => {
    expect(verifyArcadeSourceBytes(fighter, pngBytes)).toBe(sourceSha256);
    expect(() => verifyArcadeSourceBytes(fighter, Buffer.concat([pngBytes, Buffer.from('changed')]))).toThrow(
      /hash mismatch/,
    );
  });
});
