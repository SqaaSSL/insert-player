import { describe, expect, it } from 'vitest';
import { assertOfficialArcadeContract } from './arcade-smoke-contract.mjs';

function fighter(qualityTier = 'contender', kind = 'generated') {
  return {
    qualityTier,
    sprites: ['idle', 'walk', 'high_punch', 'low_punch', 'high_kick', 'low_kick',
      'jump', 'crouch', 'hit', 'ko', 'victory'].map(animationName => ({ animationName, qualityTier })),
    arcade: { reference: kind === 'generated'
      ? { kind, sourceUrl: null, license: 'Insert Player original synthetic artwork', credit: 'Insert Player (2026)' }
      : { kind, sourceUrl: 'https://commons.wikimedia.org/wiki/File:Example.jpg', license: 'CC BY 4.0', credit: 'Source photographer' } },
  };
}

describe('official Arcade smoke follows published Champion and reference contracts', () => {
  it.each(['contender', 'champion'])('accepts a complete same-tier %s pack and generated attribution', tier => {
    expect(() => assertOfficialArcadeContract(fighter(tier))).not.toThrow();
  });

  it.each(['contender', 'champion'])('preserves licensed HTTPS photo support for %s packs', tier => {
    expect(() => assertOfficialArcadeContract(fighter(tier, 'licensed'))).not.toThrow();
  });

  it.each(['rookie', 'unknown', '', null, undefined])('rejects non-Champion fighter quality %s', tier => {
    const value = fighter(); value.qualityTier = tier;
    expect(() => assertOfficialArcadeContract(value)).toThrow(/non-Champion/);
  });

  it.each(['rookie', 'champion', 'unknown', null, undefined])('rejects a contender pack containing sprite tier %s', tier => {
    const value = fighter(); value.sprites[0].qualityTier = tier;
    expect(() => assertOfficialArcadeContract(value)).toThrow(/mixed or invalid quality pack/);
  });

  it('rejects the reverse mixed pack and a missing sprite list', () => {
    const value = fighter('champion'); value.sprites[1].qualityTier = 'contender';
    expect(() => assertOfficialArcadeContract(value)).toThrow(/mixed or invalid quality pack/);
    delete value.sprites;
    expect(() => assertOfficialArcadeContract(value)).toThrow(/mixed or invalid quality pack/);
  });

  it.each(['generated', 'licensed'])('still requires meaningful licence and credit for %s artwork', kind => {
    for (const field of ['license', 'credit']) for (const missing of ['', '   ', null, undefined]) {
      const value = fighter('contender', kind); value.arcade.reference[field] = missing;
      expect(() => assertOfficialArcadeContract(value)).toThrow(/missing public reference attribution/);
    }
  });

  it.each(['http://example.org/photo', '', null, undefined])('rejects a licensed reference without HTTPS: %s', sourceUrl => {
    const value = fighter('champion', 'licensed'); value.arcade.reference.sourceUrl = sourceUrl;
    expect(() => assertOfficialArcadeContract(value)).toThrow(/invalid public reference provenance/);
  });

  it('rejects unknown provenance and a generated reference claiming a licensed-photo URL', () => {
    const value = fighter(); value.arcade.reference.kind = 'unknown';
    expect(() => assertOfficialArcadeContract(value)).toThrow(/invalid public reference provenance/);
    value.arcade.reference.kind = 'generated'; value.arcade.reference.sourceUrl = 'https://example.org/photo';
    expect(() => assertOfficialArcadeContract(value)).toThrow(/invalid public reference provenance/);
  });

});
