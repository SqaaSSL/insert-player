export type BrawlEnemyArchetype = 'grunt' | 'bruiser' | 'captain';

export interface BrawlEnemySpawn {
  id: string;
  archetype: BrawlEnemyArchetype;
  x: number;
  lane: number;
  facingRight?: boolean;
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
  encounters: [
    {
      label: 'FIRST CONTACT',
      triggerX: 920,
      lockLeft: 760,
      lockRight: 1470,
      enemies: [
        { id: 'checkpoint-1-a', archetype: 'grunt', x: 1110, lane: 366 },
        { id: 'checkpoint-1-b', archetype: 'grunt', x: 1210, lane: 424 },
        { id: 'checkpoint-1-c', archetype: 'grunt', x: 1300, lane: 492 },
        { id: 'checkpoint-1-d', archetype: 'grunt', x: 1400, lane: 454 },
      ],
    },
    {
      label: 'UNDERPASS',
      triggerX: 1980,
      lockLeft: 1800,
      lockRight: 2530,
      enemies: [
        { id: 'checkpoint-2-a', archetype: 'bruiser', x: 2170, lane: 374 },
        { id: 'checkpoint-2-b', archetype: 'grunt', x: 2300, lane: 430 },
        { id: 'checkpoint-2-c', archetype: 'bruiser', x: 2400, lane: 500 },
      ],
    },
    {
      label: 'FINAL BLOCKADE',
      triggerX: 3020,
      lockLeft: 2840,
      lockRight: 3520,
      enemies: [
        { id: 'checkpoint-3-a', archetype: 'captain', x: 3290, lane: 430 },
        { id: 'checkpoint-3-b', archetype: 'grunt', x: 3150, lane: 370 },
        { id: 'checkpoint-3-c', archetype: 'grunt', x: 3160, lane: 496 },
      ],
    },
  ],
};

export const RUSH_ROUTE_MAP: Readonly<BrawlMapDefinition> = Object.freeze(rushRouteMap);
