export type BrawlEnemyArchetype = 'grunt' | 'bruiser' | 'captain';

export interface BrawlEnemySpawn {
  id: string;
  archetype: BrawlEnemyArchetype;
  x: number;
  lane: number;
  facingRight?: boolean;
}

export interface BrawlWaveDefinition {
  label: string;
  enemies: BrawlEnemySpawn[];
}

export interface BrawlMapDefinition {
  id: string;
  label: string;
  worldWidth: number;
  worldHeight: number;
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
  waves: BrawlWaveDefinition[];
}

/**
 * Gameplay geometry is deliberately independent from the stage artwork.
 * Any Fight stage can skin this arena today; a future scrolling map can
 * increase `worldWidth` and add authored visual segments without changing
 * combat or network state.
 */
const rushArenaMap: BrawlMapDefinition = {
  id: 'rush-arena-v1',
  label: 'CO-OP RUSH',
  worldWidth: 1024,
  worldHeight: 576,
  walkArea: {
    left: 72,
    right: 952,
    back: 342,
    front: 516,
  },
  playerSpawns: [
    { x: 272, lane: 412 },
    { x: 382, lane: 468 },
  ],
  waves: [
    {
      label: 'FIRST CONTACT',
      enemies: [
        { id: 'wave-1-a', archetype: 'grunt', x: 744, lane: 366 },
        { id: 'wave-1-b', archetype: 'grunt', x: 830, lane: 424 },
        { id: 'wave-1-c', archetype: 'grunt', x: 710, lane: 492 },
        { id: 'wave-1-d', archetype: 'grunt', x: 902, lane: 470 },
      ],
    },
    {
      label: 'HOLD THE FLOOR',
      enemies: [
        { id: 'wave-2-a', archetype: 'bruiser', x: 850, lane: 374 },
        { id: 'wave-2-b', archetype: 'grunt', x: 922, lane: 430 },
        { id: 'wave-2-c', archetype: 'bruiser', x: 790, lane: 500 },
      ],
    },
    {
      label: 'LAST ONE STANDING',
      enemies: [
        { id: 'wave-3-a', archetype: 'captain', x: 862, lane: 430 },
        { id: 'wave-3-b', archetype: 'grunt', x: 756, lane: 370 },
        { id: 'wave-3-c', archetype: 'grunt', x: 750, lane: 496 },
      ],
    },
  ],
};

export const RUSH_ARENA_MAP: Readonly<BrawlMapDefinition> = Object.freeze(rushArenaMap);
