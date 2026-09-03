import { describe, expect, it } from 'vitest';
import { RUSH_ROUTE_MAP } from './BrawlMap.ts';
import { buildRushRouteMap, getRushStageProfile } from './RushStageProfile.ts';

describe('RushStageProfile', () => {
  it('adapts a Fight stage into themed Rush metadata without mutating the base route', () => {
    const profile = getRushStageProfile('mars-incorporated');
    const map = buildRushRouteMap(profile);

    expect(profile.segmentLabels).toEqual(['LANDING PAD', 'CARGO LOCK', 'HABITAT', 'LAUNCH RAIL']);
    expect(map.label).toBe('MARS CARGO LINE');
    expect(map.encounters.map((encounter) => encounter.label)).toEqual([
      'DOCK RAIDERS',
      'LOCKDOWN UNIT',
      'LAUNCH WARDEN',
    ]);
    expect(map.obstacles?.every((obstacle) => obstacle.skin === 'mars')).toBe(true);
    expect(RUSH_ROUTE_MAP.obstacles?.every((obstacle) => obstacle.skin === undefined)).toBe(true);
  });

  it('uses a neutral authored adapter for custom photo stages', () => {
    const profile = getRushStageProfile('tablao-3000', true);
    const map = buildRushRouteMap(profile);

    expect(profile.id).toBe('custom-stage-adapter');
    expect(map.label).toBe('CUSTOM STAGE RUN');
    expect(map.obstacles?.every((obstacle) => obstacle.skin === 'custom')).toBe(true);
  });

  it('authors Side Street as the shared Level 1 route instead of a repeated Fight plate', () => {
    const profile = getRushStageProfile('side-street');
    const map = buildRushRouteMap(profile);

    expect(profile.id).toBe('side-street-level-1');
    expect(profile.segmentLabels).toEqual([
      'SUNSET WORKSHOP',
      'SERVICE LANE',
      'UNDERPASS',
      'LAST GATE',
    ]);
    expect(map.obstacles?.every((obstacle) => obstacle.skin === 'side-street')).toBe(true);
  });
});
