import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.ts';
import { FightScene } from './scenes/FightScene.ts';
import { RushScene } from './scenes/RushScene.ts';
import { AuraScene } from './scenes/AuraScene.ts';
import { GAME_WIDTH, GAME_HEIGHT } from './constants.ts';
import { setPendingLaunchTarget, type GameLaunchTarget } from './launchState.ts';

export function createGame(parent: string, launchTarget?: GameLaunchTarget | null): Phaser.Game {
  setPendingLaunchTarget(launchTarget ?? null);
  // Touch devices render inside the CSS-rotated portrait shell, whose
  // post-transform bounds confuse Phaser's FIT measurement (and expandParent
  // fights the fixed shell). There stylesheet rules (aspect-ratio + max
  // constraints on the canvas) own the fit and Phaser must not manage scale.
  const coarsePointer =
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    parent,
    backgroundColor: '#000000',
    scale: coarsePointer
      ? {
          mode: Phaser.Scale.NONE,
          parent,
          expandParent: false,
        }
      : {
          mode: Phaser.Scale.FIT,
          autoCenter: Phaser.Scale.CENTER_BOTH,
          parent,
          expandParent: true,
        },
    scene: [BootScene, FightScene, RushScene, AuraScene],
    physics: {
      default: 'arcade',
      arcade: { debug: false },
    },
    render: {
      pixelArt: false,
      antialias: true,
    },
  };

  return new Phaser.Game(config);
}
