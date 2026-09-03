import type { StageThemeId } from '../match/StageConfig.ts';
import {
  RUSH_ROUTE_MAP,
  LA_JAULA_ROUTE_MAP,
  type BrawlMapDefinition,
  type BrawlObstacleSkin,
} from './BrawlMap.ts';

export interface RushStageProfile {
  id: string;
  routeLabel: string;
  segmentLabels: readonly [string, string, string, string];
  encounterLabels: readonly [string, string, string];
  obstacleSkin: BrawlObstacleSkin;
  accent: number;
  shadow: number;
  backdropVeil: number;
  backdropVeilAlpha: number;
}

const PROFILES: Partial<Record<StageThemeId, RushStageProfile>> = {
  'insert-player-arena': {
    id: 'arena-service-route',
    routeLabel: 'ARENA SERVICE RUN',
    segmentLabels: ['LOADING BAY', 'CABINET ROW', 'SERVICE DECK', 'MAIN FLOOR'],
    encounterLabels: ['BACKSTAGE CREW', 'CABINET SECURITY', 'HOUSE CAPTAIN'],
    obstacleSkin: 'arena',
    accent: 0xffce3a,
    shadow: 0x7b3dff,
    backdropVeil: 0x050507,
    backdropVeilAlpha: 0.1,
  },
  'executive-rumble': {
    id: 'executive-perimeter',
    routeLabel: 'EXECUTIVE PERIMETER',
    segmentLabels: ['SOUTH GATE', 'PRESS LINE', 'WEST WING', 'MOTORCADE'],
    encounterLabels: ['GATE DETAIL', 'PRESS LOCKDOWN', 'EXECUTIVE GUARD'],
    obstacleSkin: 'executive',
    accent: 0x8ac5ff,
    shadow: 0x17345c,
    backdropVeil: 0x08111d,
    backdropVeilAlpha: 0.08,
  },
  'mars-incorporated': {
    id: 'mars-cargo-line',
    routeLabel: 'MARS CARGO LINE',
    segmentLabels: ['LANDING PAD', 'CARGO LOCK', 'HABITAT', 'LAUNCH RAIL'],
    encounterLabels: ['DOCK RAIDERS', 'LOCKDOWN UNIT', 'LAUNCH WARDEN'],
    obstacleSkin: 'mars',
    accent: 0xff8c42,
    shadow: 0x5f1d17,
    backdropVeil: 0x170806,
    backdropVeilAlpha: 0.09,
  },
  'tablao-3000': {
    id: 'tablao-backline',
    routeLabel: 'TABLAO BACKLINE',
    segmentLabels: ['BACKSTAGE', 'WORKSHOP', 'MAIN HALL', 'CURTAIN CALL'],
    encounterLabels: ['STAGE HANDS', 'RHYTHM BREAKERS', 'HOUSE ENFORCER'],
    obstacleSkin: 'tablao',
    accent: 0xffce3a,
    shadow: 0x7a1026,
    backdropVeil: 0x19050b,
    backdropVeilAlpha: 0.08,
  },
  'la-jaula-304': {
    id: 'jaula-neighborhood-run',
    routeLabel: 'JAULA NEIGHBORHOOD RUN',
    segmentLabels: ['SUNSET BLOCK', 'CAGE GATE', 'TOUCHLINE', 'ROOFTOPS'],
    encounterLabels: ['STREET CREW', 'TOUCHLINE PRESS', 'CAGE CAPTAIN'],
    obstacleSkin: 'jaula',
    accent: 0xffe066,
    shadow: 0x174a32,
    backdropVeil: 0x07130d,
    backdropVeilAlpha: 0.07,
  },
  'side-street': {
    id: 'side-street-level-1',
    routeLabel: 'SIDE STREET RUN',
    segmentLabels: ['SUNSET WORKSHOP', 'SERVICE LANE', 'UNDERPASS', 'LAST GATE'],
    encounterLabels: ['STREET CONTACT', 'UNDERPASS LOCK', 'GATE CAPTAIN'],
    obstacleSkin: 'side-street',
    accent: 0xffcf33,
    shadow: 0x111827,
    backdropVeil: 0x080a12,
    backdropVeilAlpha: 0.025,
  },
};

const CUSTOM_PROFILE: RushStageProfile = {
  id: 'custom-stage-adapter',
  routeLabel: 'CUSTOM STAGE RUN',
  segmentLabels: ['ENTRY', 'MIDWAY', 'BACKLINE', 'EXIT'],
  encounterLabels: ['FIRST CONTACT', 'CROSSFIRE', 'FINAL BLOCKADE'],
  obstacleSkin: 'custom',
  accent: 0xffce3a,
  shadow: 0x4fb3ff,
  backdropVeil: 0x050507,
  backdropVeilAlpha: 0.1,
};

export function getRushStageProfile(
  stageId: StageThemeId,
  hasCustomStage = false,
): RushStageProfile {
  if (hasCustomStage) return CUSTOM_PROFILE;
  return PROFILES[stageId] ?? PROFILES['insert-player-arena']!;
}

/**
 * Fight stages provide the visual plate. This adapter supplies the authored
 * traversal metadata a Rush route needs without pretending a flat image has
 * collision, entrances, or encounter pacing embedded in it.
 */
export function buildRushRouteMap(profile: RushStageProfile): Readonly<BrawlMapDefinition> {
  const baseMap = profile.id === 'jaula-neighborhood-run'
    ? LA_JAULA_ROUTE_MAP
    : RUSH_ROUTE_MAP;
  return {
    ...baseMap,
    id: `${baseMap.id}:${profile.id}`,
    label: profile.routeLabel,
    obstacles: (baseMap.obstacles ?? []).map((obstacle) => ({
      ...obstacle,
      skin: profile.obstacleSkin,
    })),
    encounters: baseMap.encounters.map((encounter, index) => ({
      ...encounter,
      label: profile.encounterLabels[index] ?? encounter.label,
      enemies: encounter.enemies.map((enemy) => ({
        ...enemy,
        entrance: enemy.entrance ? { ...enemy.entrance } : undefined,
      })),
    })),
  };
}
