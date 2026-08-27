import { useEffect, useState } from 'react';
import type Phaser from 'phaser';
import {
  MATCH_ACTION_EVENT,
  MATCH_ACTIONS_VISIBILITY_EVENT,
  MATCH_COMPLETE_EVENT,
  type MatchAction,
  type MatchSceneData,
} from '../../game/match/MatchConfig.ts';
import { MobileFightControls } from '../components/MobileFightControls.tsx';
import { reportMatchCompletion } from '../../services/MatchReporting.ts';
import { debugInfo, debugWarn } from '../../services/DebugLog.ts';

interface GamePageProps {
  launchTarget: { sceneKey: string; data: MatchSceneData };
  onComplete: () => void;
  onExit: () => void;
}

export function GamePage({ launchTarget, onComplete, onExit }: GamePageProps) {
  const [matchActionsVisible, setMatchActionsVisible] = useState(false);

  useEffect(() => {
    const win = window as Window & {
      __ASF_EXIT_TO_MENU__?: () => void;
    };
    const previous = win.__ASF_EXIT_TO_MENU__;
    win.__ASF_EXIT_TO_MENU__ = () => onExit();
    return () => {
      win.__ASF_EXIT_TO_MENU__ = previous;
    };
  }, [onExit]);

  useEffect(() => {
    debugInfo('[GamePage] Mounting Phaser runtime', {
      sceneKey: launchTarget.sceneKey,
      hasData: Boolean(launchTarget.data),
    });
    let disposed = false;
    let game: Phaser.Game | null = null;
    void import('../../game/createGame.ts').then(({ createGame }) => {
      if (disposed) return;
      game = createGame('game-container', launchTarget);
    });
    return () => {
      disposed = true;
      debugInfo('[GamePage] Destroying Phaser runtime', {
        sceneKey: launchTarget.sceneKey,
      });
      game?.destroy(true);
      game = null;
    };
  }, [launchTarget]);

  useEffect(() => {
    const onMatchComplete = (event: WindowEventMap[typeof MATCH_COMPLETE_EVENT]) => {
      onComplete();
      void reportMatchCompletion(event.detail).catch((err: any) => {
        debugWarn('[MatchReporting] Failed to report match:', err?.message ?? err);
      });
    };
    window.addEventListener(MATCH_COMPLETE_EVENT, onMatchComplete);
    return () => {
      window.removeEventListener(MATCH_COMPLETE_EVENT, onMatchComplete);
    };
  }, [onComplete]);

  useEffect(() => {
    const onVisibilityChange = (
      event: WindowEventMap[typeof MATCH_ACTIONS_VISIBILITY_EVENT],
    ) => {
      setMatchActionsVisible(event.detail.visible);
    };
    window.addEventListener(MATCH_ACTIONS_VISIBILITY_EVENT, onVisibilityChange);
    return () => {
      window.removeEventListener(MATCH_ACTIONS_VISIBILITY_EVENT, onVisibilityChange);
    };
  }, []);

  const chooseMatchAction = (action: MatchAction) => {
    setMatchActionsVisible(false);
    window.dispatchEvent(new CustomEvent(MATCH_ACTION_EVENT, { detail: { action } }));
  };

  return (
    <div className="game-shell">
      <div className="game-shell__surface">
        <div id="game-container" className="game-shell__canvas" />
      </div>
      {!launchTarget.data.cpuVsCpu && launchTarget.data.vsAI !== false && !matchActionsVisible && (
        <MobileFightControls playerIndex={0} playerLabel="player 1" />
      )}
      {!launchTarget.data.cpuVsCpu && launchTarget.data.vsAI === false && !matchActionsVisible && (
        <div className="mobile-versus-unavailable" role="status">
          Touch Versus needs two control sets and is unavailable on this screen. Use a keyboard or controllers,
          or play Arcade Mode on touch.
        </div>
      )}
      {matchActionsVisible && (
        <div className="match-actions" role="group" aria-label="Match complete actions">
          <span className="match-actions__label">Match Complete</span>
          <button
            type="button"
            className="match-actions__button match-actions__button--primary"
            onClick={() => chooseMatchAction('run_it_back')}
          >
            Run It Back
          </button>
          <button type="button" className="match-actions__button" onClick={() => chooseMatchAction('remix')}>
            Remix
          </button>
          <button type="button" className="match-actions__button" onClick={() => chooseMatchAction('menu')}>
            Menu
          </button>
        </div>
      )}
      <button type="button" className="game-shell__gallery-link" onClick={onExit}>
        Back
      </button>
    </div>
  );
}
