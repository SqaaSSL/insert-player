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
  /** Immediate co-op recovery granted when a player lands the breaking hit. */
  healthReward?: number;
  /** Ground clearance needed to pass over it. */
  jumpClearance?: number;
  /** Exact ground footprint that hurts actors; independent from the prop art. */
  hazardWidth?: number;
  hazardLaneDepth?: number;
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
  /** Rolling fights let the team keep moving until the authored soft gate. */
  mode?: 'rolling' | 'roadblock';
  triggerX: number;
  lockLeft: number;
  lockRight: number;
  advanceLimit?: number;
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
      healthReward: 24,
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
      hazardWidth: 130,
      hazardLaneDepth: 42,
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
      healthReward: 32,
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
      hazardWidth: 112,
      hazardLaneDepth: 38,
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
      mode: 'rolling',
      triggerX: 920,
      lockLeft: 760,
      lockRight: 1470,
      advanceLimit: 1760,
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
        {
          id: 'checkpoint-1-d', archetype: 'bruiser', x: 1320, lane: 382, level: 1,
          entrance: { kind: 'drop', sourceHeight: 220, delayTicks: 56 },
        },
      ],
    },
    {
      label: 'UNDERPASS',
      threat: 2,
      mode: 'rolling',
      triggerX: 1980,
      lockLeft: 1800,
      lockRight: 2530,
      advanceLimit: 2800,
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
        {
          id: 'checkpoint-2-e', archetype: 'shooter', x: 2050, lane: 488, level: 2,
          entrance: { kind: 'right', sourceX: 2600, delayTicks: 68 },
        },
      ],
    },
    {
      label: 'FINAL BLOCKADE',
      threat: 3,
      mode: 'roadblock',
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
        {
          id: 'checkpoint-3-e', archetype: 'shooter', x: 3440, lane: 362, level: 3,
          entrance: { kind: 'door', sourceX: 3470, sourceLane: 304, delayTicks: 70 },
        },
        {
          id: 'checkpoint-3-f', archetype: 'grunt', x: 3260, lane: 458, level: 3,
          entrance: { kind: 'right', sourceX: 3590, delayTicks: 84 },
        },
      ],
    },
  ],
};

export const RUSH_ROUTE_MAP: Readonly<BrawlMapDefinition> = Object.freeze(rushRouteMap);

const laJaulaRouteMap: BrawlMapDefinition = {
  id: 'la-jaula-route-v1',
  label: 'JAULA NEIGHBORHOOD RUN',
  worldWidth: 3840,
  worldHeight: 576,
  exitX: 3690,
  maxPlayerSeparation: 400,
  maxBacktrack: 190,
  walkArea: {
    left: 72,
    right: 3760,
    back: 342,
    front: 516,
  },
  playerSpawns: [
    { x: 235, lane: 402 },
    { x: 350, lane: 474 },
  ],
  obstacles: [
    {
      id: 'jaula-gate-cache', type: 'barricade', x: 640, lane: 474,
      width: 82, laneDepth: 54, health: 84, healthReward: 20, jumpClearance: 56,
    },
    {
      id: 'jaula-court-cell', type: 'explosive-barrel', x: 1080, lane: 390,
      width: 54, laneDepth: 44, health: 48, jumpClearance: 48,
      explosionRadius: 158, explosionDamage: 38,
    },
    {
      id: 'jaula-touchline-vent', type: 'steam-vent', x: 1480, lane: 478,
      width: 84, laneDepth: 48, jumpClearance: 48,
      hazardWidth: 122, hazardLaneDepth: 38, cycleOffset: 48,
    },
    {
      id: 'jaula-maintenance-cache', type: 'barricade', x: 2020, lane: 398,
      width: 96, laneDepth: 60, health: 126, healthReward: 28, jumpClearance: 62,
    },
    {
      id: 'jaula-floodlight-vent', type: 'steam-vent', x: 2440, lane: 486,
      width: 92, laneDepth: 50, jumpClearance: 50,
      hazardWidth: 132, hazardLaneDepth: 40, cycleOffset: 112,
    },
    {
      id: 'jaula-lockdown-cell', type: 'explosive-barrel', x: 2890, lane: 408,
      width: 58, laneDepth: 46, health: 58, jumpClearance: 50,
      explosionRadius: 174, explosionDamage: 44,
    },
    {
      id: 'jaula-final-cache', type: 'barricade', x: 3370, lane: 482,
      width: 108, laneDepth: 62, health: 154, healthReward: 34, jumpClearance: 66,
    },
  ],
  encounters: [
    {
      label: 'STREET CREW', threat: 1, mode: 'rolling',
      triggerX: 790, lockLeft: 650, lockRight: 1390, advanceLimit: 1660,
      enemies: [
        { id: 'jaula-1-a', archetype: 'grunt', x: 940, lane: 366, level: 1, entrance: { kind: 'door', sourceX: 880, sourceLane: 312 } },
        { id: 'jaula-1-b', archetype: 'grunt', x: 1160, lane: 446, level: 1, entrance: { kind: 'right', sourceX: 1510, delayTicks: 14 } },
        { id: 'jaula-1-c', archetype: 'shooter', x: 1360, lane: 492, level: 1, entrance: { kind: 'background', sourceLane: 298, delayTicks: 30 } },
        { id: 'jaula-1-d', archetype: 'bruiser', x: 1490, lane: 388, level: 1, entrance: { kind: 'drop', sourceHeight: 230, delayTicks: 48 } },
        { id: 'jaula-1-e', archetype: 'grunt', x: 1260, lane: 412, level: 1, entrance: { kind: 'door', sourceX: 1320, sourceLane: 312, delayTicks: 64 } },
      ],
    },
    {
      label: 'TOUCHLINE PRESS', threat: 2, mode: 'rolling',
      triggerX: 1810, lockLeft: 1670, lockRight: 2500, advanceLimit: 2780,
      enemies: [
        { id: 'jaula-2-a', archetype: 'bruiser', x: 1960, lane: 376, level: 2, entrance: { kind: 'background', sourceLane: 300 } },
        { id: 'jaula-2-b', archetype: 'shooter', x: 2200, lane: 482, level: 2, entrance: { kind: 'door', sourceX: 2140, sourceLane: 308, delayTicks: 16 } },
        { id: 'jaula-2-c', archetype: 'grunt', x: 2370, lane: 420, level: 2, entrance: { kind: 'right', sourceX: 2670, delayTicks: 28 } },
        { id: 'jaula-2-d', archetype: 'shooter', x: 2500, lane: 366, level: 2, entrance: { kind: 'drop', sourceHeight: 240, delayTicks: 42 } },
        { id: 'jaula-2-e', archetype: 'bruiser', x: 2620, lane: 492, level: 2, entrance: { kind: 'right', sourceX: 2820, delayTicks: 58 } },
        { id: 'jaula-2-f', archetype: 'grunt', x: 2300, lane: 456, level: 2, entrance: { kind: 'background', sourceLane: 296, delayTicks: 72 } },
      ],
    },
    {
      label: 'CAGE CAPTAIN', threat: 3, mode: 'roadblock',
      triggerX: 3000, lockLeft: 2840, lockRight: 3540,
      enemies: [
        { id: 'jaula-3-a', archetype: 'captain', x: 3340, lane: 424, level: 3, entrance: { kind: 'door', sourceX: 3400, sourceLane: 296, delayTicks: 20 } },
        { id: 'jaula-3-b', archetype: 'shooter', x: 3100, lane: 366, level: 3, entrance: { kind: 'background', sourceLane: 294 } },
        { id: 'jaula-3-c', archetype: 'bruiser', x: 3180, lane: 490, level: 3, entrance: { kind: 'right', sourceX: 3600, delayTicks: 32 } },
        { id: 'jaula-3-d', archetype: 'grunt', x: 3440, lane: 476, level: 3, entrance: { kind: 'drop', sourceHeight: 260, delayTicks: 44 } },
        { id: 'jaula-3-e', archetype: 'shooter', x: 3480, lane: 360, level: 3, entrance: { kind: 'door', sourceX: 3500, sourceLane: 300, delayTicks: 58 } },
        { id: 'jaula-3-f', archetype: 'grunt', x: 3240, lane: 450, level: 3, entrance: { kind: 'right', sourceX: 3600, delayTicks: 72 } },
        { id: 'jaula-3-g', archetype: 'bruiser', x: 3280, lane: 392, level: 3, entrance: { kind: 'background', sourceLane: 294, delayTicks: 86 } },
      ],
    },
  ],
};

export const LA_JAULA_ROUTE_MAP: Readonly<BrawlMapDefinition> = Object.freeze(laJaulaRouteMap);
