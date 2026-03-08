import Phaser from 'phaser';
import { BootScene } from './game/scenes/BootScene.ts';
import { TitleScene } from './game/scenes/TitleScene.ts';
import { CharacterCreationScene } from './game/scenes/CharacterCreationScene.ts';
import { RosterScene } from './game/scenes/RosterScene.ts';
import { FightScene } from './game/scenes/FightScene.ts';
import { GalleryScene } from './game/scenes/GalleryScene.ts';
import { GAME_WIDTH, GAME_HEIGHT } from './game/constants.ts';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  parent: 'game-container',
  backgroundColor: '#000000',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    parent: 'game-container',
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

new Phaser.Game(config);
