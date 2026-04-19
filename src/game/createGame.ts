import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.ts';
import { TitleScene } from './scenes/TitleScene.ts';
import { CharacterCreationScene } from './scenes/CharacterCreationScene.ts';
import { RosterScene } from './scenes/RosterScene.ts';
import { FightScene } from './scenes/FightScene.ts';
import { GalleryScene } from './scenes/GalleryScene.ts';
import { GAME_WIDTH, GAME_HEIGHT } from './constants.ts';
import { setPendingLaunchTarget, type GameLaunchTarget } from './launchState.ts';

export function createGame(parent: string, launchTarget?: GameLaunchTarget | null): Phaser.Game {
  setPendingLaunchTarget(launchTarget ?? null);
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    parent,
    backgroundColor: '#000000',
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      parent,
      expandParent: true,
    },
    scene: [BootScene, TitleScene, RosterScene, CharacterCreationScene, FightScene, GalleryScene],
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
