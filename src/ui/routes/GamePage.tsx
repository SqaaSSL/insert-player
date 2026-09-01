import { useEffect, useRef, useState } from 'react';
import type Phaser from 'phaser';
import {
  MATCH_ACTION_EVENT,
  MATCH_ACTIONS_VISIBILITY_EVENT,
  MATCH_COMPLETE_EVENT,
  PAUSE_EVENT,
  NET_STATE_EVENT,
  RUNTIME_READY_EVENT,
  buildMatchSeed,
  type MatchAction,
  type MatchSceneData,
  type NetStateDetail,
} from '../../game/match/MatchConfig.ts';
import { MobileFightControls } from '../components/MobileFightControls.tsx';
import { FightControlsHint } from '../components/FightControlsHint.tsx';
import { FightHud } from '../components/FightHud.tsx';
import { FightIntroOverlay } from '../components/FightIntroOverlay.tsx';
import { FightAnnouncement } from '../components/FightAnnouncement.tsx';
import {
  FightLoadingCurtain,
  type FightLoadingPhase,
} from '../components/FightLoadingCurtain.tsx';
import { reportMatchCompletion } from '../../services/MatchReporting.ts';
import { debugInfo, debugWarn } from '../../services/DebugLog.ts';
import { getStageTheme, pickStageThemeIdFromSeed } from '../../game/match/StageConfig.ts';

export interface LadderContext {
  rungIndex: number;
  rungTotal: number;
  continuesLeft: number;
  continuesUsed: number;
  isFinal: boolean;
  nextName: string | null;
  onNext: () => Promise<void>;
  onContinue: () => Promise<void>;
  onExitLadder: () => void;
  onPrefetchNext: () => void;
}

interface GamePageProps {
  launchTarget: { sceneKey: string; data: MatchSceneData };
  onComplete: () => void;
  onExit: () => void;
  onCreateFighter: () => void;
  onOpenArcade: () => void;
  ladder?: LadderContext | null;
}

function NetStatusBadge({ state }: { state: NetStateDetail }) {
  const quality = state.rttMs === null ? 'unknown' : state.rttMs < 60 ? 'great' : state.rttMs < 140 ? 'good' : 'rough';
  const label = state.abandoned
    ? 'Rival left'
    : state.desynced
      ? 'Desync — match void'
      : !state.connected
        ? 'Reconnecting…'
        : state.stalled
          ? 'Waiting for rival…'
          : state.path === 'p2p' ? 'P2P' : 'Relay';
  return (
    <div className={`net-badge is-${quality}${state.abandoned || state.desynced ? ' is-alert' : ''}`} role="status" aria-live="polite">
      <span className="net-badge__label">{label}</span>
      <span className="net-badge__rtt">{state.rttMs === null ? '—' : `${Math.round(state.rttMs)} ms`}</span>
      {state.rollbacks > 0 ? <span className="net-badge__rollbacks">rb {state.rollbacks}</span> : null}
    </div>
  );
}

export function GamePage({
  launchTarget,
  onComplete,
  onExit,
  onCreateFighter,
  onOpenArcade,
  ladder,
}: GamePageProps) {
  const [paused, setPaused] = useState(false);
  const onlineMatch = Boolean(launchTarget.data.online);
  const [matchActionsVisible, setMatchActionsVisible] = useState(false);
  const [netState, setNetState] = useState<NetStateDetail | null>(null);
  const isRush = launchTarget.sceneKey === 'RushScene';
  const online = isRush ? null : (launchTarget.data.online ?? null);
  const trial = launchTarget.data.experience === 'trial';
  const trialPlayerName = launchTarget.data.p1Name?.trim() || 'Player One';
  const [winnerSlot, setWinnerSlot] = useState<'p1' | 'p2' | null>(null);
  const [ladderBusy, setLadderBusy] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState<FightLoadingPhase | 'hidden'>('loading');
  const trialPrimaryActionRef = useRef<HTMLButtonElement | null>(null);

  const setPauseState = (next: boolean) => {
    setPaused(next);
    window.dispatchEvent(new CustomEvent(PAUSE_EVENT, { detail: { paused: next } }));
  };

  useEffect(() => {
    // A new launch target means a fresh match: clear the previous outcome.
    setWinnerSlot(null);
    setLadderBusy(false);
    setNetState(null);
    setLoadingPhase('loading');
  }, [launchTarget]);

  useEffect(() => {
    if (!trial || !matchActionsVisible) return;
    const frame = window.requestAnimationFrame(() => trialPrimaryActionRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [matchActionsVisible, trial]);

  useEffect(() => {
    if (!online) return;
    const onNetState = (event: WindowEventMap[typeof NET_STATE_EVENT]) => setNetState(event.detail);
    window.addEventListener(NET_STATE_EVENT, onNetState);
    return () => window.removeEventListener(NET_STATE_EVENT, onNetState);
  }, [online]);

  useEffect(() => {
    if (window.matchMedia?.('(pointer: coarse)').matches) {
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (mode: string) => Promise<void>;
      };
      orientation?.lock?.('landscape').catch(() => {
        // iOS and non-fullscreen contexts reject; the rotate overlay covers it.
      });
    }
    return () => {
      const orientation = screen.orientation as ScreenOrientation & { unlock?: () => void };
      try { orientation?.unlock?.(); } catch { /* best effort */ }
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    };
  }, []);

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
    let readyHandled = false;
    let openingTimer: number | undefined;
    let hideTimer: number | undefined;
    let loadTimeout: number | undefined;
    const startedAt = performance.now();
    const onRuntimeReady = () => {
      if (disposed || readyHandled) return;
      readyHandled = true;
      window.clearTimeout(loadTimeout);
      const minimumClosedMs = 1_100;
      const openingDelay = Math.max(0, minimumClosedMs - (performance.now() - startedAt));
      openingTimer = window.setTimeout(() => {
        setLoadingPhase('opening');
        const reduceMotion =
          window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        hideTimer = window.setTimeout(
          () => setLoadingPhase('hidden'),
          reduceMotion ? 180 : 720,
        );
      }, openingDelay);
    };
    window.addEventListener(RUNTIME_READY_EVENT, onRuntimeReady);
    loadTimeout = window.setTimeout(() => {
      if (!disposed && !readyHandled) setLoadingPhase('error');
    }, 30_000);
    void import('../../game/createGame.ts')
      .then(({ createGame }) => {
        if (disposed) return;
        game = createGame('game-container', launchTarget);
      })
      .catch((err: unknown) => {
        if (!disposed) {
          debugWarn('[GamePage] Phaser runtime failed to mount:', err instanceof Error ? err.message : err);
          setLoadingPhase('error');
        }
      });
    return () => {
      disposed = true;
      window.removeEventListener(RUNTIME_READY_EVENT, onRuntimeReady);
      window.clearTimeout(openingTimer);
      window.clearTimeout(hideTimer);
      window.clearTimeout(loadTimeout);
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
      setWinnerSlot(event.detail.winnerSlot);
      if (ladder && event.detail.winnerSlot === 'p1' && !ladder.isFinal) {
        ladder.onPrefetchNext();
      }
      void reportMatchCompletion(event.detail).catch((err: any) => {
        debugWarn('[MatchReporting] Failed to report match:', err?.message ?? err);
      });
    };
    window.addEventListener(MATCH_COMPLETE_EVENT, onMatchComplete);
    return () => {
      window.removeEventListener(MATCH_COMPLETE_EVENT, onMatchComplete);
    };
  }, [onComplete, ladder]);

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
      {isRush ? null : <FightHud />}
      {isRush ? null : <FightIntroOverlay />}
      {isRush ? null : <FightAnnouncement />}
      {loadingPhase !== 'hidden' ? (
        <FightLoadingCurtain
          phase={loadingPhase}
          p1Name={launchTarget.data.p1Name ?? 'Player One'}
          p2Name={launchTarget.data.p2Name ?? 'Player Two'}
          p1PhotoHash={launchTarget.data.p1PhotoHash ?? null}
          p2PhotoHash={launchTarget.data.p2PhotoHash ?? null}
          stageLabel={
            launchTarget.data.customStageLabel ??
            getStageTheme(
              launchTarget.data.stageId ??
              pickStageThemeIdFromSeed(buildMatchSeed(launchTarget.data)),
            ).label
          }
          onExit={onExit}
        />
      ) : null}
      {trial && !matchActionsVisible ? (
        <div className="trial-match-badge" role="status">Playable demo · free round</div>
      ) : null}
      {online && netState ? <NetStatusBadge state={netState} /> : null}
      {online && !matchActionsVisible && (
        <MobileFightControls playerIndex={0} playerLabel={online.localSlot === 0 ? 'player 1' : 'player 2'} />
      )}
      {!isRush && !online && !launchTarget.data.cpuVsCpu && launchTarget.data.vsAI !== false && !matchActionsVisible && (
        <MobileFightControls playerIndex={0} playerLabel="player 1" />
      )}
      {!isRush && !online && !launchTarget.data.cpuVsCpu && launchTarget.data.vsAI === false && !matchActionsVisible && (
        <div className="mobile-versus-unavailable" role="status">
          Touch Versus needs two control sets and is unavailable on this screen. Use a keyboard or controllers,
          or play Arcade Mode on touch.
        </div>
      )}
      {isRush && launchTarget.data.vsAI === true && !matchActionsVisible ? (
        <MobileFightControls playerIndex={0} playerLabel="player 1" />
      ) : null}
      {isRush && launchTarget.data.vsAI !== true ? (
        <div className="mobile-versus-unavailable" role="status">
          Online Co-op Rush is not connected in this local preview.
        </div>
      ) : null}
      {matchActionsVisible && ladder && winnerSlot === 'p1' && ladder.isFinal && (
        <div className="match-actions" role="group" aria-label="Arcade champion">
          <span className="match-actions__label">
            You Conquered The Arcade · {ladder.rungTotal} challengers down · {ladder.continuesUsed}{' '}
            {ladder.continuesUsed === 1 ? 'continue' : 'continues'} used
          </span>
          <button
            type="button"
            className="match-actions__button match-actions__button--primary"
            onClick={ladder.onExitLadder}
          >
            Take The Crown
          </button>
        </div>
      )}
      {matchActionsVisible && ladder && winnerSlot === 'p1' && !ladder.isFinal && (
        <div className="match-actions" role="group" aria-label="Ladder victory actions">
          <span className="match-actions__label">
            Rung {ladder.rungIndex + 1}/{ladder.rungTotal} cleared
          </span>
          <button
            type="button"
            className="match-actions__button match-actions__button--primary"
            disabled={ladderBusy}
            onClick={() => {
              setLadderBusy(true);
              void ladder.onNext().catch(() => setLadderBusy(false));
            }}
          >
            {ladderBusy ? 'Loading...' : `Next: ${ladder.nextName ?? 'Challenger'}`}
          </button>
          <button type="button" className="match-actions__button" disabled={ladderBusy} onClick={ladder.onExitLadder}>
            Quit Run
          </button>
        </div>
      )}
      {matchActionsVisible && ladder && winnerSlot === 'p2' && ladder.continuesLeft > 0 && (
        <div className="match-actions" role="group" aria-label="Ladder continue actions">
          <span className="match-actions__label">
            Defeated at rung {ladder.rungIndex + 1}/{ladder.rungTotal}
          </span>
          <button
            type="button"
            className="match-actions__button match-actions__button--primary"
            disabled={ladderBusy}
            onClick={() => {
              setLadderBusy(true);
              void ladder.onContinue().catch(() => setLadderBusy(false));
            }}
          >
            {ladderBusy ? 'Loading...' : `Continue · ${ladder.continuesLeft} left`}
          </button>
          <button type="button" className="match-actions__button" disabled={ladderBusy} onClick={ladder.onExitLadder}>
            Give Up
          </button>
        </div>
      )}
      {matchActionsVisible && ladder && winnerSlot === 'p2' && ladder.continuesLeft <= 0 && (
        <div className="match-actions" role="group" aria-label="Game over">
          <span className="match-actions__label">
            Game Over · Reached rung {ladder.rungIndex + 1}/{ladder.rungTotal}
          </span>
          <button
            type="button"
            className="match-actions__button match-actions__button--primary"
            onClick={ladder.onExitLadder}
          >
            Back To The Arcade
          </button>
        </div>
      )}
      {matchActionsVisible && online && (
        <div className="match-actions" role="group" aria-label="Online match complete">
          <span className="match-actions__label">
            {netState?.abandoned
              ? 'Your rival left the match'
              : netState?.desynced
                ? 'The match desynced and cannot continue'
                : winnerSlot === null
                  ? 'Match Complete'
                  : (winnerSlot === 'p1') === (online.localSlot === 0) ? 'You Win' : 'You Lose'}
          </span>
          <button
            type="button"
            className="match-actions__button match-actions__button--primary"
            onClick={() => chooseMatchAction('menu')}
          >
            Back To Lobby
          </button>
        </div>
      )}
      {matchActionsVisible && trial && (
        <div className="match-actions match-actions--trial" role="group" aria-label="Free round complete">
          <span className="match-actions__eyebrow">Free round complete</span>
          <span className="match-actions__label">
            {winnerSlot === 'p1'
              ? `You won with ${trialPlayerName}.`
              : `${trialPlayerName} was the demo. Your fighter is next.`}
          </span>
          <span className="match-actions__copy">Create your Rookie, make yourself playable, and enter the Arcade.</span>
          <button
            ref={trialPrimaryActionRef}
            type="button"
            className="match-actions__button match-actions__button--primary"
            onClick={onCreateFighter}
          >
            Create My Fighter
          </button>
          <button type="button" className="match-actions__button" onClick={() => chooseMatchAction('run_it_back')}>
            Play Again
          </button>
          <button type="button" className="match-actions__button" onClick={onOpenArcade}>
            Explore Arcade
          </button>
        </div>
      )}
      {matchActionsVisible && !trial && !online && (!ladder || winnerSlot === null) && (
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
      {!onlineMatch && !matchActionsVisible && !paused && (
        <button
          type="button"
          className="fight-pause-button"
          aria-label="Pause"
          onClick={() => setPauseState(true)}
        >
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </button>
      )}
      {paused && (
        <div className="fight-pause-overlay" role="dialog" aria-label="Game paused">
          <p className="fight-pause-overlay__title">Paused</p>
          <div className="fight-pause-overlay__actions">
            <button type="button" className="asf-btn asf-btn--primary" onClick={() => setPauseState(false)}>
              Resume
            </button>
            <button
              type="button"
              className="asf-btn asf-btn--ghost"
              onClick={() => {
                setPauseState(false);
                onExit();
              }}
            >
              Quit
            </button>
          </div>
        </div>
      )}
      {isRush ? null : <FightControlsHint />}
      <button type="button" className="game-shell__gallery-link" onClick={onExit}>
        {trial ? 'Exit Demo' : 'Back'}
      </button>
    </div>
  );
}
