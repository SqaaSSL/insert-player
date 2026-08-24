import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  findCurrentArcadeEntry,
  planFighterResume,
  validateManifest,
} from './seed-arcade-roster.mjs';

const manifest = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));

const animations = [
  'idle',
  'walk',
  'high_punch',
  'low_punch',
  'high_kick',
  'low_kick',
  'jump',
  'crouch',
  'hit',
  'ko',
  'victory',
];

function completeSources(overrides = {}) {
  return {
    original: '/original.png',
    side: '/side.png',
    sideRaw: '/side-raw.png',
    upright: '/upright.png',
    uprightRaw: '/upright-raw.png',
    crouch: '/crouch.png',
    crouchRaw: '/crouch-raw.png',
    ...overrides,
  };
}

function championSprites(names) {
  return names.map((animationName) => ({ animationName, qualityTier: 'champion' }));
}

describe('Arcade roster resume planning', () => {
  it('requires every official prompt to preserve its licensed reference identity', () => {
    expect(() => validateManifest(manifest)).not.toThrow();

    const missingReference = structuredClone(manifest);
    missingReference.fighters[0].referencePrompt = 'Create a premium realistic 2.5D full-body arcade fighter on green.';
    expect(() => validateManifest(missingReference)).toThrow(/licensed-photo identity/);

    const identityErasing = structuredClone(manifest);
    identityErasing.fighters[0].referencePrompt = 'Use the licensed reference photo, then replace it from the written description only.';
    expect(() => validateManifest(identityErasing)).toThrow(/text-only replacement face/);
  });

  it('builds every canonical source and animation for an empty draft', () => {
    expect(planFighterResume({ sources: { original: '/original.png' }, sprites: [] })).toEqual({
      sourceNames: ['side', 'upright', 'crouch'],
      animationNames: animations,
      ready: false,
    });
  });

  it('rebuilds the dependent source chain and every animation after a source gap', () => {
    const sources = completeSources({ uprightRaw: null });
    expect(planFighterResume({ sources, sprites: championSprites(['idle', 'walk']) })).toEqual({
      sourceNames: ['upright', 'crouch'],
      animationNames: animations,
      ready: false,
    });
  });

  it('keeps complete sources and fills only missing Champion animations', () => {
    const current = ['idle', 'walk', 'high_punch', 'high_kick'];
    expect(planFighterResume({
      sources: completeSources(),
      sprites: [
        ...championSprites(current),
        { animationName: 'low_punch', qualityTier: 'rookie' },
      ],
    })).toEqual({
      sourceNames: [],
      animationNames: animations.filter((name) => !current.includes(name)),
      ready: false,
    });
  });

  it('recognizes a complete Champion fighter', () => {
    expect(planFighterResume({
      sources: completeSources(),
      sprites: championSprites(animations),
    })).toEqual({ sourceNames: [], animationNames: [], ready: true });
  });

  it('ignores retired entries and fails closed on a current slug collision', () => {
    expect(findCurrentArcadeEntry([
      { fighterId: 'retired', slug: 'donald-trump', status: 'retired' },
      { fighterId: 'current', slug: 'donald-trump', status: 'draft' },
    ], 'donald-trump')).toMatchObject({ fighterId: 'current' });

    expect(() => findCurrentArcadeEntry([
      { fighterId: 'one', slug: 'donald-trump', status: 'draft' },
      { fighterId: 'two', slug: 'donald-trump', status: 'active' },
    ], 'donald-trump')).toThrow(/Multiple current Arcade fighters/);
  });
});
