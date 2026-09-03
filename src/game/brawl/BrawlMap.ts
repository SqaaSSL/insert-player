export type BrawlEnemyArchetype = 'grunt' | 'bruiser' | 'shooter' | 'captain';
export type BrawlEnemyEntranceKind = 'right' | 'door' | 'background' | 'drop';
export type BrawlObstacleType = 'barricade' | 'steam-vent' | 'explosive-barrel';
export type BrawlObstacleSkin = 'arena' | 'executive' | 'mars' | 'tablao' | 'jaula' | 'side-street' | 'custom';

export interface BrawlEnemyEntrance {
  kind: BrawlEnemyEntranceKind;
  /** Authored world-space origin. Defaults depend on the entrance kind. */
  sourceX?: number;
  sourceLane?: number;
  /** Drop entrances begin above the lane and descend into combat. */
  sourceHeight?: number;
  /** Lets a group arrive as a readable sequence instead of one blob. */
  delayTicks?: number;
}

export interface BrawlEnemySpawn {
  id: string;
  archetype: BrawlEnemyArchetype;
  x: number;
  lane: number;
  facingRight?: boolean;
  /** 1..3 authored threat tier. Higher tiers react faster and hit harder. */
  level?: 1 | 2 | 3;
  entrance?: BrawlEnemyEntrance;
}

export interface BrawlObstacleDefinition {
  id: string;
  type: BrawlObstacleType;
  x: number;
  lane: number;
  width: number;
  laneDepth: number;
  /** Breakable obstacles only. */
  health?: number;
  /** Ground clearance needed to pass over it. */
  jumpClearance?: number;
  /** Hazard animation offset so multiple vents do not pulse in sync. */
  cycleOffset?: number;
  /** Stage-specific material treatment without changing collision rules. */
  skin?: BrawlObstacleSkin;
  /** Explosive obstacles damage every nearby combatant once destroyed. */
  explosionRadius?: number;
  explosionDamage?: number;
}

export interface BrawlEncounterDefinition {
  label: string;
  threat?: 1 | 2 | 3;
  triggerX: number;
  lockLeft: number;
  lockRight: number;
  enemies: BrawlEnemySpawn[];
}

export interface BrawlMapDefinition {
  id: string;
  label: string;
  worldWidth: number;
  worldHeight: number;
  exitX: number;
  maxPlayerSeparation: number;
  maxBacktrack: number;
  walkArea: {
    left: number;
    right: number;
    back: number;
    front: number;
  };
  playerSpawns: [
    { x: number; lane: number },
    { x: number; lane: number },
  ];
  obstacles?: BrawlObstacleDefinition[];
  encounters: BrawlEncounterDefinition[];
}

/**
 * A four-screen route whose combat geometry is independent from its artwork.
 * Fight and custom stages can skin the route as repeating visual segments;
 * bespoke Rush stages can later use the same authored checkpoints directly.
 */
const rushRouteMap: BrawlMapDefinition = {
  id: 'rush-route-v1',
  label: 'CO-OP RUSH',
  worldWidth: 3840,
  worldHeight: 576,
  exitX: 3690,
  maxPlayerSeparation: 430,
  maxBacktrack: 220,
  walkArea: {
    left: 72,
    right: 3760,
    back: 342,
    front: 516,
  },
  playerSpawns: [
    { x: 260, lane: 412 },
    { x: 370, lane: 468 },
  ],
  obstacles: [
    {
      id: 'cargo-barricade',
      type: 'barricade',
      x: 690,
      lane: 410,
      width: 86,
      laneDepth: 58,
      health: 95,
      jumpClearance: 58,
    },
    {
      id: 'freight-cell',
      type: 'explosive-barrel',
      x: 1125,
      lane: 478,
      width: 54,
      laneDepth: 44,
      health: 42,
      jumpClearance: 48,
      explosionRadius: 152,
      explosionDamage: 34,
    },
    {
      id: 'underpass-vent',
      type: 'steam-vent',
      x: 1640,
      lane: 468,
      width: 92,
      laneDepth: 54,
      jumpClearance: 48,
      cycleOffset: 18,
    },
    {
      id: 'roadwork-barricade',
      type: 'barricade',
      x: 2705,
      lane: 390,
      width: 104,
      laneDepth: 62,
      health: 140,
      jumpClearance: 64,
    },
    {
      id: 'final-vent',
      type: 'steam-vent',
      x: 2875,
      lane: 486,
      width: 78,
      laneDepth: 48,
      jumpClearance: 48,
      cycleOffset: 92,
    },
    {
      id: 'final-fuel-cell',
      type: 'explosive-barrel',
      x: 3270,
      lane: 490,
      width: 60,
      laneDepth: 48,
      health: 64,
      jumpClearance: 52,
      explosionRadius: 176,
      explosionDamage: 42,
    },
  ],
  encounters: [
    {
      label: 'FIRST CONTACT',
      threat: 1,
      triggerX: 920,
      lockLeft: 760,
      lockRight: 1470,
      enemies: [
        {
          id: 'checkpoint-1-a', archetype: 'grunt', x: 1060, lane: 366, level: 1,
          entrance: { kind: 'door', sourceX: 1060, sourceLane: 314 },
        },
        {
          id: 'checkpoint-1-b', archetype: 'grunt', x: 1260, lane: 430, level: 1,
          entrance: { kind: 'right', sourceX: 1540, delayTicks: 16 },
        },
        {
          id: 'checkpoint-1-c', archetype: 'shooter', x: 1390, lane: 492, level: 1,
          entrance: { kind: 'background', sourceLane: 304, delayTicks: 34 },
        },
      ],
    },
    {
      label: 'UNDERPASS',
      threat: 2,
      triggerX: 1980,
      lockLeft: 1800,
      lockRight: 2530,
      enemies: [
        {
          id: 'checkpoint-2-a', archetype: 'bruiser', x: 2140, lane: 374, level: 2,
          entrance: { kind: 'background', sourceLane: 296 },
        },
        {
          id: 'checkpoint-2-b', archetype: 'grunt', x: 2280, lane: 430, level: 2,
          entrance: { kind: 'door', sourceX: 2240, sourceLane: 316, delayTicks: 18 },
        },
        {
          id: 'checkpoint-2-c', archetype: 'shooter', x: 2430, lane: 498, level: 2,
          entrance: { kind: 'right', sourceX: 2600, delayTicks: 32 },
        },
        {
          id: 'checkpoint-2-d', archetype: 'grunt', x: 2350, lane: 400, level: 2,
          entrance: { kind: 'drop', sourceHeight: 230, delayTicks: 48 },
        },
      ],
    },
    {
      label: 'FINAL BLOCKADE',
      threat: 3,
      triggerX: 3020,
      lockLeft: 2840,
      lockRight: 3520,
      enemies: [
        {
          id: 'checkpoint-3-a', archetype: 'captain', x: 3340, lane: 430, level: 3,
          entrance: { kind: 'door', sourceX: 3310, sourceLane: 300, delayTicks: 22 },
        },
        {
          id: 'checkpoint-3-b', archetype: 'shooter', x: 3150, lane: 370, level: 3,
          entrance: { kind: 'background', sourceLane: 300 },
        },
        {
          id: 'checkpoint-3-c', archetype: 'grunt', x: 3160, lane: 496, level: 3,
          entrance: { kind: 'right', sourceX: 3590, delayTicks: 38 },
        },
        {
          id: 'checkpoint-3-d', archetype: 'bruiser', x: 3430, lane: 486, level: 3,
          entrance: { kind: 'drop', sourceHeight: 260, delayTicks: 54 },
        },
      ],
    },
  ],
};

export const RUSH_ROUTE_MAP: Readonly<BrawlMapDefinition> = Object.freeze(rushRouteMap);
