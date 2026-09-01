export type BrawlEnemyArchetype = 'grunt' | 'bruiser' | 'captain';
export type BrawlEnemyEntranceKind = 'right' | 'door' | 'background';
export type BrawlObstacleType = 'barricade' | 'steam-vent';

export interface BrawlEnemyEntrance {
  kind: BrawlEnemyEntranceKind;
  /** Authored world-space origin. Defaults depend on the entrance kind. */
  sourceX?: number;
  sourceLane?: number;
  /** Lets a group arrive as a readable sequence instead of one blob. */
  delayTicks?: number;
}

export interface BrawlEnemySpawn {
  id: string;
  archetype: BrawlEnemyArchetype;
  x: number;
  lane: number;
  facingRight?: boolean;
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
}

export interface BrawlEncounterDefinition {
  label: string;
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
  ],
  encounters: [
    {
      label: 'FIRST CONTACT',
      triggerX: 920,
      lockLeft: 760,
      lockRight: 1470,
      enemies: [
        {
          id: 'checkpoint-1-a', archetype: 'grunt', x: 1110, lane: 366,
          entrance: { kind: 'door', sourceX: 1060, sourceLane: 314 },
        },
        {
          id: 'checkpoint-1-b', archetype: 'grunt', x: 1210, lane: 424,
          entrance: { kind: 'right', sourceX: 1540, delayTicks: 12 },
        },
        {
          id: 'checkpoint-1-c', archetype: 'grunt', x: 1300, lane: 492,
          entrance: { kind: 'background', sourceLane: 304, delayTicks: 24 },
        },
        {
          id: 'checkpoint-1-d', archetype: 'grunt', x: 1400, lane: 454,
          entrance: { kind: 'door', sourceX: 1420, sourceLane: 318, delayTicks: 36 },
        },
      ],
    },
    {
      label: 'UNDERPASS',
      triggerX: 1980,
      lockLeft: 1800,
      lockRight: 2530,
      enemies: [
        {
          id: 'checkpoint-2-a', archetype: 'bruiser', x: 2170, lane: 374,
          entrance: { kind: 'background', sourceLane: 296 },
        },
        {
          id: 'checkpoint-2-b', archetype: 'grunt', x: 2300, lane: 430,
          entrance: { kind: 'door', sourceX: 2240, sourceLane: 316, delayTicks: 18 },
        },
        {
          id: 'checkpoint-2-c', archetype: 'bruiser', x: 2400, lane: 500,
          entrance: { kind: 'right', sourceX: 2600, delayTicks: 34 },
        },
      ],
    },
    {
      label: 'FINAL BLOCKADE',
      triggerX: 3020,
      lockLeft: 2840,
      lockRight: 3520,
      enemies: [
        {
          id: 'checkpoint-3-a', archetype: 'captain', x: 3290, lane: 430,
          entrance: { kind: 'door', sourceX: 3310, sourceLane: 300, delayTicks: 22 },
        },
        {
          id: 'checkpoint-3-b', archetype: 'grunt', x: 3150, lane: 370,
          entrance: { kind: 'background', sourceLane: 300 },
        },
        {
          id: 'checkpoint-3-c', archetype: 'grunt', x: 3160, lane: 496,
          entrance: { kind: 'right', sourceX: 3590, delayTicks: 38 },
        },
      ],
    },
  ],
};

export const RUSH_ROUTE_MAP: Readonly<BrawlMapDefinition> = Object.freeze(rushRouteMap);
