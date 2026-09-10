import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type Phaser from 'phaser';
import {
  MATCH_ACTION_EVENT,
  MATCH_ACTIONS_VISIBILITY_EVENT,
  MATCH_COMPLETE_EVENT,
  PAUSE_EVENT,
  NET_STATE_EVENT,
  ONLINE_REMATCH_STATE_EVENT,
  RUSH_COMPANION_ORDER_EVENT,
  RUSH_RUN_COMPLETE_EVENT,
  AURA_BATTLE_COMPLETE_EVENT,
  RUNTIME_READY_EVENT,
  buildMatchSeed,
  type MatchAction,
  type MatchCompletionDetail,
  type MatchSceneData,
  type NetStateDetail,
  type OnlineRematchStateDetail,
  type RushRunCompleteDetail,
  type AuraBattleCompleteDetail,
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
import { DEFAULT_AURA_STAGE_ID, getStageTheme, pickStageThemeIdFromSeed } from '../../game/match/StageConfig.ts';
import { RushRunResults } from '../components/RushRunResults.tsx';
import { RushCompanionOrders } from '../components/RushCompanionOrders.tsx';
import { getRushDifficulty, type RushCompanionOrder } from '../../game/brawl/RushConfig.ts';
import { FightResultShare } from '../components/FightResultShare.tsx';
import { AuraControls } from '../components/AuraControls.tsx';
import { AuraBattleResults } from '../components/AuraBattleResults.tsx';
import { AuraOnboardingHint } from '../components/AuraOnboardingHint.tsx';
import { shouldGuideAuraBattle, rememberAuraOnboarding } from '../shared/auraOnboarding.ts';
import { AURA_ONBOARDING_EVENT, AURA_ONBOARDING_SKIP_EVENT, isAuraOnboardingDetail, type AuraOnboardingDetail } from '../../game/aura/AuraOnboarding.ts';
import { trackProductEvent } from '../../services/ProductEvents.ts';
import { AURA_CAPTURE_EVENT, type AuraCaptureDetail } from '../../game/aura/AuraCapture.ts';
import {
  AURA_PRESENTATION_EVENT,
  AURA_PRESENTATION_START_EVENT,
  AURA_PRESENTATION_TURN_EVENT,
  isAuraPresentationDetail,
  type AuraPresentationStartDetail,
} from '../../game/aura/AuraPresentationEvents.ts';
import { getAuraCanvasSize } from '../../game/aura/AuraViewport.ts';
import {
  AURA_DEFAULT_LANE_KEYS,
  AURA_LOCAL_P1_LANE_KEYS,
  getAuraDifficulty,
} from '../../game/aura/AuraConfig.ts';

const DevGameplayCapture = import.meta.env.DEV
  ? lazy(() => import('../components/DevGameplayCapture.tsx'))
  : null;

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
  const [onlineRematch, setOnlineRematch] = useState<OnlineRematchStateDetail>({ state: 'idle' });
  const isRush = launchTarget.sceneKey === 'RushScene';
  const isAura = launchTarget.sceneKey === 'AuraScene';
  const online = isRush ? null : (launchTarget.data.online ?? null);
  const trial = launchTarget.data.experience === 'trial';
  const trialPlayerName = launchTarget.data.p1Name?.trim() || 'Player One';
  const [winnerSlot, setWinnerSlot] = useState<'p1' | 'p2' | null>(null);
  const [matchSummary, setMatchSummary] = useState<MatchCompletionDetail | null>(null);
  const [ladderBusy, setLadderBusy] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState<FightLoadingPhase | 'hidden'>('loading');
  const [rushSummary, setRushSummary] = useState<RushRunCompleteDetail | null>(null);
  const [auraSummary, setAuraSummary] = useState<AuraBattleCompleteDetail | null>(null);
  const [auraOnboarding, setAuraOnboarding] = useState<AuraOnboardingDetail | null>(null);
  const guidedThisMount = useRef(false);
  const [auraCapture, setAuraCapture] = useState<AuraCaptureDetail | null>(null);
  const [auraTouchSlot, setAuraTouchSlot] = useState<0 | 1>(0);
  const [auraControlledSlot, setAuraControlledSlot] = useState<0 | 1 | undefined>(
    online?.localSlot ?? launchTarget.data.auraChallenge?.slot ?? (launchTarget.data.vsAI === false ? undefined : 0));
  const [auraPendingStart, setAuraPendingStart] = useState<AuraPresentationStartDetail | null>(null);
  const auraLifecycleRef = useRef<(AuraPresentationStartDetail & {
    phase: 'loading' | 'ready' | 'error' | 'started';
  }) | null>(null);
  const [auraViewport, setAuraViewport] = useState(() => getAuraCanvasSize(
    typeof window === 'undefined' ? 1024 : window.innerWidth,
    typeof window === 'undefined' ? 576 : window.innerHeight,
  ));
  const [rushCompanionOrder, setRushCompanionOrder] = useState<RushCompanionOrder>(
    launchTarget.data.rushCompanionOrder ?? 'follow',
  );
  const trialPrimaryActionRef = useRef<HTMLButtonElement | null>(null);

  const setPauseState = (next: boolean) => {
    setPaused(next);
    window.dispatchEvent(new CustomEvent(PAUSE_EVENT, { detail: { paused: next } }));
  };

  const chooseRushCompanionOrder = (order: RushCompanionOrder) => {
    setRushCompanionOrder(order);
    window.dispatchEvent(new CustomEvent(RUSH_COMPANION_ORDER_EVENT, { detail: { order } }));
  };

  useEffect(() => {
    // A new launch target means a fresh match: clear the previous outcome.
    setWinnerSlot(null);
    setMatchSummary(null);
    setLadderBusy(false);
    setNetState(null);
    setOnlineRematch({ state: 'idle' });
    setLoadingPhase('loading');
    setRushSummary(null);
    setAuraSummary(null);
    setAuraCapture(null);
    setAuraPendingStart(null);
    setAuraTouchSlot(0);
    setAuraControlledSlot(launchTarget.data.online?.localSlot ?? launchTarget.data.auraChallenge?.slot
      ?? (launchTarget.data.vsAI === false ? undefined : 0));
    setRushCompanionOrder(launchTarget.data.rushCompanionOrder ?? 'follow');
  }, [launchTarget]);

  useEffect(() => {
    if (!isAura) return;
    const resize = () => {
      const next = getAuraCanvasSize(window.innerWidth, window.innerHeight);
      setAuraViewport(previous => previous.portrait === next.portrait ? previous : next);
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [isAura]);

  useEffect(() => {
    if (!isAura || loadingPhase !== 'hidden' || !auraPendingStart) return;
    const lifecycle = auraLifecycleRef.current;
    if (!lifecycle || lifecycle.phase !== 'ready'
      || lifecycle.token !== auraPendingStart.token || lifecycle.seed !== auraPendingStart.seed) return;
    // Effects run after React removes the curtain from the committed DOM.
    // Mark first: duplicate renders/StrictMode must never start the clock twice.
    lifecycle.phase = 'started';
    const onboarding = !guidedThisMount.current && shouldGuideAuraBattle(launchTarget.data);
    if (onboarding) {
      guidedThisMount.current = true;
      trackProductEvent('onboarding_started', { game: 'aura' });
    }
    window.dispatchEvent(new CustomEvent(AURA_PRESENTATION_START_EVENT, {
      detail: { ...auraPendingStart, ...(onboarding ? { onboarding: true } : {}) },
    }));
  }, [isAura, loadingPhase, auraPendingStart, launchTarget]);

  useEffect(() => {
    if (!isAura) return;
    const onTurn = (event: WindowEventMap[typeof AURA_PRESENTATION_TURN_EVENT]) => {
      const { token, seed, playerIndex } = event.detail;
      const current = auraLifecycleRef.current;
      if (!current || current.token !== token || current.seed !== seed
        || (playerIndex !== 0 && playerIndex !== 1)) return;
      setAuraTouchSlot(playerIndex);
    };
    window.addEventListener(AURA_PRESENTATION_TURN_EVENT, onTurn);
    return () => window.removeEventListener(AURA_PRESENTATION_TURN_EVENT, onTurn);
  }, [isAura]);

  useEffect(() => {
    if (!isAura) return;
    const onOnboarding = (event: WindowEventMap[typeof AURA_ONBOARDING_EVENT]) => {
      const detail = event.detail;
      const current = auraLifecycleRef.current;
      if (!isAuraOnboardingDetail(detail) || !current || current.phase !== 'started'
        || current.token !== detail.token || current.seed !== detail.seed) return;
      if (detail.phase === 'complete' || detail.phase === 'skipped') {
        rememberAuraOnboarding();
        trackProductEvent(detail.phase === 'complete' ? 'onboarding_completed' : 'onboarding_skipped', { game: 'aura' });
        setAuraOnboarding(null);
      } else setAuraOnboarding(detail);
    };
    window.addEventListener(AURA_ONBOARDING_EVENT, onOnboarding);
    return () => window.removeEventListener(AURA_ONBOARDING_EVENT, onOnboarding);
  }, [isAura]);

  useEffect(() => {
    if (!isRush || launchTarget.data.vsAI !== true || paused || rushSummary) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      const order: RushCompanionOrder | null = event.code === 'Digit1'
        ? 'follow'
        : event.code === 'Digit2'
          ? 'attack'
          : event.code === 'Digit3'
            ? 'cover'
            : null;
      if (order) chooseRushCompanionOrder(order);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isRush, launchTarget.data.vsAI, paused, rushSummary]);

  useEffect(() => {
    if (!isRush) return;
    const onRushComplete = (event: WindowEventMap[typeof RUSH_RUN_COMPLETE_EVENT]) => {
      onComplete();
      setRushSummary(event.detail);
    };
    window.addEventListener(RUSH_RUN_COMPLETE_EVENT, onRushComplete);
    return () => window.removeEventListener(RUSH_RUN_COMPLETE_EVENT, onRushComplete);
  }, [isRush, onComplete]);

  useEffect(() => {
    if (!isAura) return;
    const onCapture = (event: WindowEventMap[typeof AURA_CAPTURE_EVENT]) => {
      const detail = event.detail;
      if (detail.state === 'preparing') {
        setAuraSummary(null);
        setAuraCapture(detail);
      } else {
        setAuraCapture(current => current?.id === detail.id ? detail : current);
      }
    };
    window.addEventListener(AURA_CAPTURE_EVENT, onCapture);
    return () => window.removeEventListener(AURA_CAPTURE_EVENT, onCapture);
  }, [isAura]);

  useEffect(() => {
    if (!isAura) return;
    const onAuraComplete = (event: WindowEventMap[typeof AURA_BATTLE_COMPLETE_EVENT]) => {
      onComplete();
      setAuraSummary(event.detail);
      setWinnerSlot(event.detail.winnerSlot === 'draw' ? null : event.detail.winnerSlot);
    };
    window.addEventListener(AURA_BATTLE_COMPLETE_EVENT, onAuraComplete);
    return () => window.removeEventListener(AURA_BATTLE_COMPLETE_EVENT, onAuraComplete);
  }, [isAura, onComplete]);

  useEffect(() => {
    if (!import.meta.env.DEV || !isRush) return;
    if (new URLSearchParams(window.location.search).get('rushResult') !== '1') return;
    const stage = getStageTheme(launchTarget.data.stageId);
    const timer = window.setTimeout(() => setRushSummary({
      outcome: 'won',
      stageId: stage.id,
      stageLabel: stage.label,
      durationSeconds: 154,
      score: 10_850,
      rank: 'A',
      enemiesDefeated: 18,
      obstaclesDestroyed: 5,
      checkpointsCleared: 3,
      revives: 1,
      damageTaken: 72,
      teamHealthRemaining: 128,
      teamMaxHealth: 200,
      difficulty: launchTarget.data.rushDifficulty ?? 'arcade',
    }), 1_800);
    return () => window.clearTimeout(timer);
  }, [isRush, launchTarget.data.rushDifficulty, launchTarget.data.stageId]);

  useEffect(() => {
    if (!trial || isAura || !matchActionsVisible) return;
    const frame = window.requestAnimationFrame(() => trialPrimaryActionRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [matchActionsVisible, trial, isAura]);

  useEffect(() => {
    if (!online) return;
    const onNetState = (event: WindowEventMap[typeof NET_STATE_EVENT]) => setNetState(event.detail);
    window.addEventListener(NET_STATE_EVENT, onNetState);
    return () => window.removeEventListener(NET_STATE_EVENT, onNetState);
  }, [online]);

  useEffect(() => {
    if (!online) return;
    const onRematchState = (event: WindowEventMap[typeof ONLINE_REMATCH_STATE_EVENT]) => {
      setOnlineRematch(event.detail);
      if (event.detail.state === 'starting') {
        setWinnerSlot(null);
        setMatchSummary(null);
        setAuraSummary(null);
      }
    };
    window.addEventListener(ONLINE_REMATCH_STATE_EVENT, onRematchState);
    return () => window.removeEventListener(ONLINE_REMATCH_STATE_EVENT, onRematchState);
  }, [online]);

  useEffect(() => {
    if (isAura) return;
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
  }, [isAura]);

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
    let startedAt = performance.now();
    auraLifecycleRef.current = null;
    const clearTimers = () => {
      window.clearTimeout(openingTimer);
      window.clearTimeout(hideTimer);
      window.clearTimeout(loadTimeout);
    };
    const armTimeout = () => {
      window.clearTimeout(loadTimeout);
      loadTimeout = window.setTimeout(() => {
        if (disposed || readyHandled) return;
        if (auraLifecycleRef.current) auraLifecycleRef.current.phase = 'error';
        setLoadingPhase('error');
      }, 30_000);
    };
    const revealWhenReady = (identity?: AuraPresentationStartDetail) => {
      if (disposed || readyHandled) return;
      readyHandled = true;
      window.clearTimeout(loadTimeout);
      const minimumClosedMs = isAura ? 3_000 : 1_100;
      // Let the upright face-off register even when asset loading consumed the
      // minimum display time. The match clock still waits for the hidden DOM.
      const readyHoldMs = isAura ? 1_500 : 0;
      const openingDelay = Math.max(readyHoldMs, minimumClosedMs - (performance.now() - startedAt));
      openingTimer = window.setTimeout(() => {
        const current = auraLifecycleRef.current;
        if (disposed || (identity && (!current || current.phase !== 'ready'
          || current.token !== identity.token || current.seed !== identity.seed))) return;
        setLoadingPhase('opening');
        const reduceMotion =
          window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        hideTimer = window.setTimeout(
          () => {
            const latest = auraLifecycleRef.current;
            if (disposed || (identity && (!latest || latest.phase !== 'ready'
              || latest.token !== identity.token || latest.seed !== identity.seed))) return;
            if (identity) setAuraPendingStart(identity);
            setLoadingPhase('hidden');
          },
          reduceMotion ? 180 : isAura ? 1_000 : 720,
        );
      }, openingDelay);
    };
    const onRuntimeReady = () => {
      // Aura waits for its per-restart asset lifecycle, never the legacy event.
      if (!isAura) revealWhenReady();
    };
    const onAuraPresentation = (event: WindowEventMap[typeof AURA_PRESENTATION_EVENT]) => {
      if (!isAura || disposed || !isAuraPresentationDetail(event.detail)) return;
      const detail = event.detail;
      const current = auraLifecycleRef.current;
      if (detail.phase === 'loading') {
        if (current && detail.token <= current.token) return;
        clearTimers();
        readyHandled = false;
        startedAt = performance.now();
        auraLifecycleRef.current = { token: detail.token, seed: detail.seed, phase: 'loading' };
        setAuraControlledSlot(detail.localControlledSlot);
        setAuraPendingStart(null);
        setAuraOnboarding(null);
        setLoadingPhase('loading');
        setPaused(false);
        setMatchActionsVisible(false);
        setWinnerSlot(null);
        setAuraSummary(null);
        setAuraCapture(null);
        armTimeout();
      } else if (current && current.token === detail.token && current.seed === detail.seed
        && current.phase !== 'started' && current.phase !== 'error') {
        if (detail.phase === 'error') {
          clearTimers();
          current.phase = 'error';
          setAuraPendingStart(null);
          setLoadingPhase('error');
        } else if (current.phase === 'loading') {
          current.phase = 'ready';
          revealWhenReady({ token: detail.token, seed: detail.seed });
        }
      }
    };
    window.addEventListener(RUNTIME_READY_EVENT, onRuntimeReady);
    window.addEventListener(AURA_PRESENTATION_EVENT, onAuraPresentation);
    armTimeout();
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
      window.removeEventListener(AURA_PRESENTATION_EVENT, onAuraPresentation);
      clearTimers();
      auraLifecycleRef.current = null;
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
      setMatchSummary(event.detail);
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
      if (!event.detail.visible) setOnlineRematch({ state: 'idle' });
    };
    window.addEventListener(MATCH_ACTIONS_VISIBILITY_EVENT, onVisibilityChange);
    return () => {
      window.removeEventListener(MATCH_ACTIONS_VISIBILITY_EVENT, onVisibilityChange);
    };
  }, []);

  const chooseMatchAction = (action: MatchAction) => {
    window.dispatchEvent(new CustomEvent(MATCH_ACTION_EVENT, { detail: { action } }));
  };

  const loadingStageTheme = getStageTheme(
    launchTarget.data.stageId
      ?? (isAura ? DEFAULT_AURA_STAGE_ID : pickStageThemeIdFromSeed(buildMatchSeed(launchTarget.data))),
  );
  const loadingStageLabel = launchTarget.data.customStageLabel ?? loadingStageTheme.label;

  const content = (
    <>
      <div className="game-shell__surface">
        <div id="game-container" className="game-shell__canvas" />
      </div>
      {DevGameplayCapture && isRush && loadingPhase === 'hidden'
        && new URLSearchParams(window.location.search).get('gameplayCapture') === '1' ? (
          <Suspense fallback={null}><DevGameplayCapture /></Suspense>
        ) : null}
      {isRush || isAura ? null : <FightHud />}
      {isRush || isAura ? null : <FightIntroOverlay />}
      {isRush || isAura ? null : <FightAnnouncement />}
      {isAura && loadingPhase === 'hidden' && !auraSummary && auraCapture?.state === 'recording' ? (
        <p className="aura-capture-status" role="status">{paused ? 'Recording paused' : 'Recording match'} · game only</p>
      ) : null}
      {loadingPhase !== 'hidden' ? (
        <FightLoadingCurtain
          phase={loadingPhase}
          mode={isRush ? 'rush' : isAura ? 'aura' : 'fight'}
          p1Name={launchTarget.data.p1Name ?? 'Player One'}
          p2Name={launchTarget.data.p2Name ?? 'Player Two'}
          p1PhotoHash={launchTarget.data.p1PhotoHash ?? null}
          p2PhotoHash={launchTarget.data.p2PhotoHash ?? null}
          stageLabel={loadingStageLabel}
          stageDescription={loadingStageTheme.blurb}
          stageImageUrl={isRush || isAura
            ? (loadingStageTheme.assetPath ?? loadingStageTheme.rushAssetPath ?? null)
            : null}
          difficultyLabel={isRush
            ? getRushDifficulty(launchTarget.data.rushDifficulty).label
            : isAura
              ? getAuraDifficulty(launchTarget.data.auraDifficulty).label
              : undefined}
          auraLaneKeys={launchTarget.data.online || launchTarget.data.vsAI !== false
            ? AURA_DEFAULT_LANE_KEYS
            : AURA_LOCAL_P1_LANE_KEYS}
          onExit={onExit}
        />
      ) : null}
      {trial && !isAura && !matchActionsVisible ? (
        <div className="trial-match-badge" role="status">Playable demo · free round</div>
      ) : null}
      {online && netState ? <NetStatusBadge state={netState} /> : null}
      {online && !isAura && loadingPhase === 'hidden' && !matchActionsVisible && (
        <MobileFightControls playerIndex={0} hudPlayerIndex={online.localSlot} playerLabel={online.localSlot === 0 ? 'player 1' : 'player 2'} />
      )}
      {!isRush && !isAura && loadingPhase === 'hidden' && !online && !launchTarget.data.cpuVsCpu && launchTarget.data.vsAI !== false && !matchActionsVisible && (
        <MobileFightControls playerIndex={0} playerLabel="player 1" />
      )}
      {!isRush && !isAura && loadingPhase === 'hidden' && !online && !launchTarget.data.cpuVsCpu && launchTarget.data.vsAI === false && !matchActionsVisible && (
        <div className="mobile-versus-unavailable" role="status">
          Touch Versus needs two control sets and is unavailable on this screen. Use a keyboard or controllers,
          or play Arcade Mode on touch.
        </div>
      )}
      {isRush && loadingPhase === 'hidden' && launchTarget.data.vsAI === true && !matchActionsVisible && !rushSummary ? (
        <MobileFightControls mode="rush" playerIndex={0} playerLabel="player 1" />
      ) : null}
      {isRush && loadingPhase === 'hidden' && launchTarget.data.vsAI === true && !matchActionsVisible && !rushSummary && !paused ? (
        <RushCompanionOrders value={rushCompanionOrder} onChange={chooseRushCompanionOrder} />
      ) : null}
      {isRush && loadingPhase === 'hidden' && launchTarget.data.vsAI !== true ? (
        <div className="mobile-versus-unavailable" role="status">
          Online Co-op Rush is not connected in this local preview.
        </div>
      ) : null}
      {isAura && loadingPhase === 'hidden' && auraOnboarding && !paused && !matchActionsVisible && !auraSummary ? (
        <AuraOnboardingHint detail={auraOnboarding} onSkip={() => {
          window.dispatchEvent(new CustomEvent(AURA_ONBOARDING_SKIP_EVENT, {
            detail: { token: auraOnboarding.token, seed: auraOnboarding.seed },
          }));
        }} />
      ) : null}
      {isAura && loadingPhase === 'hidden' && !matchActionsVisible && !auraSummary ? (
        <div className="aura-game-toolbar" aria-label="Aura match controls">
          {!launchTarget.data.cpuVsCpu ? (
            <AuraControls playerIndex={online?.localSlot ?? auraControlledSlot ?? auraTouchSlot} disabled={paused} />
          ) : null}
          <button type="button" className="aura-game-toolbar__back" onClick={onExit}>Back</button>
          {!onlineMatch && !paused ? (
            <button type="button" className="fight-pause-button" aria-label="Pause" onClick={() => setPauseState(true)}>
              <span aria-hidden="true" /><span aria-hidden="true" />
            </button>
          ) : null}
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
      {matchActionsVisible && online && !isAura && (
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
          {onlineRematch.message ? (
            <span className={`match-actions__copy${onlineRematch.state === 'error' ? ' is-error' : ''}`} role="status" aria-live="polite">
              {onlineRematch.message}
            </span>
          ) : null}
          <button
            type="button"
            className="match-actions__button match-actions__button--primary"
            disabled={
              Boolean(netState?.abandoned || netState?.desynced)
              || onlineRematch.state === 'waiting'
              || onlineRematch.state === 'starting'
            }
            onClick={() => chooseMatchAction('run_it_back')}
          >
            {onlineRematch.state === 'waiting'
              ? 'Waiting For Rival…'
              : onlineRematch.state === 'starting'
                ? 'Starting…'
                : onlineRematch.state === 'rival_ready'
                  ? 'Rival Ready · Run It Back'
                : 'Run It Back'}
          </button>
          <button
            type="button"
            className="match-actions__button"
            disabled={onlineRematch.state === 'starting'}
            onClick={() => chooseMatchAction('menu')}
          >
            Back To Lobby
          </button>
          {matchSummary ? (
            <FightResultShare
              summary={matchSummary}
              p1Name={launchTarget.data.p1Name ?? 'Player One'}
              p2Name={launchTarget.data.p2Name ?? 'Player Two'}
            />
          ) : null}
        </div>
      )}
      {matchActionsVisible && trial && !isAura && (
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
      {matchActionsVisible && !isAura && !trial && !online && (!ladder || winnerSlot === null) && (
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
          {matchSummary ? (
            <FightResultShare
              summary={matchSummary}
              p1Name={launchTarget.data.p1Name ?? 'Player One'}
              p2Name={launchTarget.data.p2Name ?? 'Player Two'}
            />
          ) : null}
        </div>
      )}
      {rushSummary ? (
        <RushRunResults
          summary={rushSummary}
          onRetry={() => {
            setRushSummary(null);
            chooseMatchAction('run_it_back');
          }}
          onExit={onExit}
        />
      ) : null}
      {auraSummary && matchActionsVisible ? (
        <AuraBattleResults
          summary={auraSummary}
          trial={trial}
          onCreatePlayer={onCreateFighter}
          capture={auraCapture}
          localSlot={online?.localSlot}
          onlineRematch={online ? onlineRematch : undefined}
          disableRematch={Boolean(netState?.abandoned || netState?.desynced)}
          onRetry={() => {
            setAuraSummary(null);
            chooseMatchAction('run_it_back');
          }}
          onRemix={online ? undefined : () => {
            setAuraSummary(null);
            chooseMatchAction('remix');
          }}
          onExit={() => {
            if (online) chooseMatchAction('menu');
            else onExit();
          }}
        />
      ) : null}
      {!isAura && loadingPhase === 'hidden' && !onlineMatch && !matchActionsVisible && !rushSummary && !auraSummary && !paused && (
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
      {loadingPhase === 'hidden' && paused && (
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
      {!isAura && !launchTarget.data.cpuVsCpu && loadingPhase === 'hidden' && !matchActionsVisible && !rushSummary && (
        <FightControlsHint
          mode={isRush ? 'rush' : 'fight'}
          twoPlayers={!online && (isRush ? launchTarget.data.vsAI !== true : launchTarget.data.vsAI === false)}
          playerLabel={online?.localSlot === 1 ? 'P2' : 'P1'}
        />
      )}
      {!isAura && loadingPhase === 'hidden' && !rushSummary && !auraSummary ? (
        <button type="button" className="game-shell__gallery-link" onClick={onExit}>
          {trial ? 'Exit Demo' : 'Back'}
        </button>
      ) : null}
    </>
  );

  return (
    <div className={`game-shell${isAura ? ` is-aura${auraViewport.portrait ? ' is-portrait' : ''}` : ''}`}>
      {isAura ? <div className="game-shell__aura-frame">{content}</div> : content}
    </div>
  );
}
