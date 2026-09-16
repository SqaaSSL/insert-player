import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertForeignMatchOwnershipRejection, assertOfficialArcadeContract,
  MATCH_FIGHTER_OWNERSHIP_ERROR } from './arcade-smoke-contract.mjs';

describe('foreign match ownership smoke contract', () => {
  it('requires the exact current ownership error and HTTP 403', () => {
    expect(() => assertForeignMatchOwnershipRejection(403, { error: MATCH_FIGHTER_OWNERSHIP_ERROR })).not.toThrow();
  });

  it.each([200, 400, 401, 404, 429, 500, '403', undefined])('rejects status %s even with the correct error', status => {
    expect(() => assertForeignMatchOwnershipRejection(status, { error: MATCH_FIGHTER_OWNERSHIP_ERROR })).toThrow(/expected 403/);
  });

  it.each(['Forbidden', 'Unauthorized', 'Internal error', 'not owned or an active Arcade fighter',
    `${MATCH_FIGHTER_OWNERSHIP_ERROR}.`, '', null, undefined])('rejects generic, obsolete, or altered error %s', error => {
    expect(() => assertForeignMatchOwnershipRejection(403, { error })).toThrow(/did not reject by ownership/);
  });

  it('rejects missing response bodies', () => {
    expect(() => assertForeignMatchOwnershipRejection(403, null)).toThrow(/did not reject by ownership/);
  });

  it('stays aligned with both Worker player-slot guards and the live smoke call', () => {
    const worker = readFileSync(new URL('../worker/src/index.ts', import.meta.url), 'utf8');
    const response = `return json({ error: '${MATCH_FIGHTER_OWNERSHIP_ERROR}' }, 403);`;
    for (const slot of ['p1', 'p2']) {
      expect(worker).toContain(`if (body.${slot}FighterId && !${slot}FighterId) {\n            ${response}`);
    }
    const smoke = readFileSync(new URL('./smoke-live.mjs', import.meta.url), 'utf8');
    expect(smoke).toContain('assertForeignMatchOwnershipRejection(foreignMatchRes.status, foreignMatch);');
  });
});

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
