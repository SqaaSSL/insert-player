import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.ts';
import { FightScene } from './scenes/FightScene.ts';
import { RushScene } from './scenes/RushScene.ts';
import { AuraScene } from './scenes/AuraScene.ts';
import { GAME_WIDTH, GAME_HEIGHT } from './constants.ts';
import { setPendingLaunchTarget, type GameLaunchTarget } from './launchState.ts';
import { getAuraCanvasSize } from './aura/AuraViewport.ts';

/**
 * Portrait phones: a 16:9 arena in a tall screen left fighters tiny and a
 * black band under the HUD. Give Fight a canvas shaped like the space between
 * the HUD and the touch cabinet; the camera shows that slice of the 1024px
 * stage and follows the fighters. Null keeps the full stage.
 */
export function portraitFightCanvasWidth(viewportWidth: number, viewportHeight: number): number | null {
  if (viewportHeight <= viewportWidth) return null;
  const arenaHeight = viewportHeight - PORTRAIT_FIGHT_CHROME_PX;
  if (arenaHeight <= 0) return null;
  const width = Math.round((GAME_HEIGHT * viewportWidth) / arenaHeight);
  return Math.max(PORTRAIT_FIGHT_MIN_WIDTH, Math.min(GAME_WIDTH, width));
}
/** Touch cabinet (~250px) plus the HUD row (~64px) on a portrait phone. */
const PORTRAIT_FIGHT_CHROME_PX = 314;
/** Never narrower than this many world px, so two fighters always fit. */
const PORTRAIT_FIGHT_MIN_WIDTH = 520;

export function createGame(parent: string, launchTarget?: GameLaunchTarget | null): Phaser.Game {
  setPendingLaunchTarget(launchTarget ?? null);
  // Touch devices render inside the CSS-rotated portrait shell, whose
  // post-transform bounds confuse Phaser's FIT measurement (and expandParent
  // fights the fixed shell). There stylesheet rules (aspect-ratio + max
  // constraints on the canvas) own the fit and Phaser must not manage scale.
  const coarsePointer =
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  const isAura = launchTarget?.sceneKey === 'AuraScene';
  const auraSize = getAuraCanvasSize(
    typeof window === 'undefined' ? GAME_WIDTH : window.innerWidth,
    typeof window === 'undefined' ? GAME_HEIGHT : window.innerHeight,
  );
  const portraitFight = !isAura && coarsePointer && launchTarget?.sceneKey === 'FightScene'
    ? portraitFightCanvasWidth(window.innerWidth, window.innerHeight) : null;
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    width: isAura ? auraSize.width : portraitFight ?? GAME_WIDTH,
    height: isAura ? auraSize.height : GAME_HEIGHT,
    parent,
    backgroundColor: '#000000',
    scale: coarsePointer || isAura
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

  const game = new Phaser.Game(config);
  if (isAura && typeof window !== 'undefined') {
    let previous = auraSize;
    const resizeAura = () => {
      const next = getAuraCanvasSize(window.innerWidth, window.innerHeight);
      if (next.width !== previous.width || next.height !== previous.height) {
        previous = next;
        // Keep the same scene, simulation, media recorder and canvas element.
        game.scale.resize(next.width, next.height);
      } else {
        game.scale.refresh();
      }
    };
    window.addEventListener('resize', resizeAura);
    game.events.once('destroy', () => window.removeEventListener('resize', resizeAura));
  }
  return game;
}
