import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HomePage } from './routes/HomePage.tsx';
import { PlayPage } from './pages/PlayPage.tsx';
import { GameLandingPage } from './pages/GameLandingPage.tsx';
import { AuraWatchPage } from './pages/AuraWatchPage.tsx';
import { isAuraClipId } from '../services/AuraClips.ts';
import { ChallengePage } from './pages/ChallengePage.tsx';
import { ChallengesPage } from './pages/ChallengesPage.tsx';
import type { FighterGameMode } from '../services/FighterAssetPacks.ts';
import { readLastGame, rememberLastGame } from './shared/playerJourney.ts';
import { trackProductEvent } from '../services/ProductEvents.ts';
import { GamePage } from './routes/GamePage.tsx';
import type { MatchSceneData } from '../game/match/MatchConfig.ts';
import { DEFAULT_AURA_STAGE_ID, getStageThemesForMode } from '../game/match/StageConfig.ts';
import { encodeAuraChallenge } from '../game/aura/AuraChallenge.ts';
import { AppHeader } from './components/AppHeader.tsx';
import { LegalFooter, type LegalRoute } from './components/LegalFooter.tsx';
import { LoadingScreen } from './components/LoadingScreen.tsx';
import { LegalPage } from './routes/LegalPage.tsx';
import { ConfigurationErrorPage } from './routes/ConfigurationErrorPage.tsx';
import { debugInfo, debugWarn } from '../services/DebugLog.ts';
import type { AuthRouteState } from './authState.ts';
import { readStoredMatch, writeStoredMatch } from './shared/storedMatch.ts';
import { buildAuraTrialMatch } from './shared/auraTrialMatch.ts';
import { CacheStatusBanner, type CacheStatus } from './components/CacheStatusBanner.tsx';
import { getActiveSpriteCacheScope } from '../services/SpriteCache.ts';
import {
  advanceArcadeRun,
  buildRungMatchData,
  clearArcadeRun,
  currentRung,
  isMatchForArcadeRun,
  isFinalRung,
  readArcadeRun,
  spendArcadeContinue,
  writeArcadeRun,
} from './shared/arcadeRun.ts';
import type { LadderContext } from './routes/GamePage.tsx';
import {
  buildArcadeSelectionSearch,
  creationDestination,
  buildCreationSearch,
  clearCreationPurchaseIntent,
  consumePostSignUpTrialIntent,
  readCreationPurchaseIntent,
  readCreationNavigationContext,
  readPreferredArcadePlayerPhotoHash,
  rememberCreationPurchaseIntent,
} from './shared/onboardingFlow.ts';
import { readPendingVersusInvite } from './shared/versusInvite.ts';

const GalleryPage = lazy(() => import('./routes/GalleryPage.tsx').then((module) => ({
  default: module.GalleryPage,
})));
const RosterPage = lazy(() => import('./routes/RosterPage.tsx').then((module) => ({
  default: module.RosterPage,
})));
const CreateFighterPage = lazy(() => import('./routes/CreateFighterPage.tsx').then((module) => ({
  default: module.CreateFighterPage,
})));
const StageScoutPage = lazy(() => import('./routes/StageScoutPage.tsx').then((module) => ({
  default: module.StageScoutPage,
})));
const OnlineVersusPage = lazy(() => import('./routes/OnlineVersusPage.tsx').then((module) => ({
  default: module.OnlineVersusPage,
})));
const CommunityPage = lazy(() => import('./routes/CommunityPage.tsx').then((module) => ({
  default: module.CommunityPage,
})));
const ModerationPage = lazy(() => import('./routes/ModerationPage.tsx').then((module) => ({
  default: module.ModerationPage,
})));
const ArcadePage = lazy(() => import('./routes/ArcadePage.tsx').then((module) => ({
  default: module.ArcadePage,
})));

type AppRoute =
  | '/'
  | '/menu'
  | '/credits'
  | '/challenges'
  | '/challenge'
  | `/watch/${string}`
  | '/games/aura'
  | '/games/fight'
  | '/games/rush'
  | '/arcade'
  | '/gallery'
  | '/community'
  | '/moderation'
  | '/fighters/new'
  | '/stages/new'
  | '/roster/watch'
  | '/roster/cpu'
  | '/roster/vs'
  | '/roster/rush'
  | '/roster/aura'
  | '/roster/aura-vs'
  | '/roster/aura-watch'
  | '/versus/online'
  | LegalRoute
  | GameRoute;

export type GameRoute = '/fight' | '/rush' | '/aura';

interface NavigationOptions {
  replace?: boolean;
  state?: Record<string, unknown>;
}

interface AppProps extends Partial<AuthRouteState> {
  userImageUrl?: string | null;
  isNewAccount?: boolean;
  authSlot?: ReactNode;
  cacheStatus?: CacheStatus;
  cacheMessage?: string | null;
  onRetryCache?: () => void;
  configurationError?: string | null;
}

function isLegalRoute(route: AppRoute): route is LegalRoute {
  return route === '/legal' || route === '/privacy' || route === '/terms' || route === '/refunds';
}

function isGameRoute(route: AppRoute): route is GameRoute {
  return route === '/fight' || route === '/rush' || route === '/aura';
}

export function gameRouteForMatch(match: Pick<MatchSceneData, 'gameMode'>): GameRoute {
  if (match.gameMode === 'rush') return '/rush';
  if (match.gameMode === 'aura') return '/aura';
  return '/fight';
}

export function legalReturnRouteFromState(state: unknown): AppRoute {
  if (!state || typeof state !== 'object') return '/menu';
  const candidate = (state as { legalReturnTo?: unknown }).legalReturnTo;
  if (typeof candidate === 'string' && candidate.startsWith('/watch/') && isAuraClipId(candidate.slice(7))) return candidate as `/watch/${string}`;
  if (
    candidate === '/' ||
    candidate === '/menu' ||
    candidate === '/credits' ||
    candidate === '/challenges' ||
    candidate === '/challenge' ||
    candidate === '/games/aura' ||
    candidate === '/games/fight' ||
    candidate === '/games/rush' ||
    candidate === '/arcade' ||
    candidate === '/gallery' ||
    candidate === '/community' ||
    candidate === '/moderation' ||
    candidate === '/fighters/new' ||
    candidate === '/stages/new' ||
    candidate === '/roster/watch' ||
    candidate === '/roster/cpu' ||
    candidate === '/roster/vs' ||
    candidate === '/roster/rush' ||
    candidate === '/roster/aura' ||
    candidate === '/roster/aura-vs' ||
    candidate === '/roster/aura-watch' ||
    candidate === '/versus/online'
  ) {
    return candidate;
  }
  return '/menu';
}

export function normalizeRoute(pathname: string, hash: string): AppRoute {
  const cleanedPath = (pathname || '/').replace(/\/+$/, '') || '/';
  const cleanedHash = hash.replace(/^#/, '').replace(/\/+$/, '');
  const cleaned =
    cleanedPath !== '/' && cleanedPath !== ''
      ? cleanedPath
      : (cleanedHash || '/');
  if (cleaned === '/') return '/';
  if (cleaned === '/credits') return '/credits';
  if (cleaned === '/challenges') return '/challenges';
  if (cleaned === '/challenge') return '/challenge';
  if (cleaned.startsWith('/watch/') && isAuraClipId(cleaned.slice(7))) return cleaned as `/watch/${string}`;
  if (cleaned === '/games/aura') return '/games/aura';
  if (cleaned === '/games/fight') return '/games/fight';
  if (cleaned === '/games/rush') return '/games/rush';
  if (cleaned === '/arcade') return '/arcade';
  if (cleaned === '/gallery') return '/gallery';
  if (cleaned === '/community') return '/community';
  if (cleaned === '/moderation') return '/moderation';
  if (cleaned === '/fighters/new') return '/fighters/new';
  if (cleaned === '/stages/new') return '/stages/new';
  if (cleaned === '/roster/watch') return '/roster/watch';
  if (cleaned === '/roster/cpu') return '/roster/cpu';
  if (cleaned === '/roster/vs') return '/roster/vs';
  if (cleaned === '/roster/rush') return '/roster/rush';
  if (cleaned === '/roster/aura') return '/roster/aura';
  if (cleaned === '/roster/aura-vs') return '/roster/aura-vs';
  if (cleaned === '/roster/aura-watch') return '/roster/aura-watch';
  if (cleaned === '/versus/online') return '/versus/online';
  if (cleaned === '/legal') return '/legal';
  if (cleaned === '/privacy') return '/privacy';
  if (cleaned === '/terms') return '/terms';
  if (cleaned === '/refunds') return '/refunds';
  if (cleaned === '/fight') return '/fight';
  if (cleaned === '/rush') return '/rush';
  if (cleaned === '/aura') return '/aura';
  return '/menu';
}

export function shouldCommitTrialLaunch(
  launchEpoch: number,
  currentEpoch: number,
  pathname: string,
  hash: string,
  entryRoute: AppRoute = '/',
): boolean {
  return launchEpoch === currentEpoch && normalizeRoute(pathname, hash) === entryRoute;
}

type Navigate = (route: AppRoute, search?: string, options?: NavigationOptions) => void;

export function fightExitRoute(
  match?: Pick<MatchSceneData, 'experience' | 'online'> | null,
): '/' | '/menu' | '/versus/online' {
  if (match?.experience === 'trial') return '/';
  if (match?.online) return '/versus/online';
  return '/menu';
}

function readPendingMatchForRoute(authSessionKey: string): MatchSceneData | null {
  // Deterministic local-only fixture for real-canvas QA and marketing captures.
  // Vite removes this branch from production builds.
  const params = new URLSearchParams(window.location.search);
  if (import.meta.env.DEV && params.get('auraDemo') === '1') {
    const auraAutoplay = params.get('auraAutoplay') === '1';
    const auraCanary = params.get('auraCanary');
    const requestedStage = params.get('auraStage');
    const stageId = getStageThemesForMode('aura').find((stage) => stage.id === requestedStage)?.id
      ?? DEFAULT_AURA_STAGE_ID;
    const auraDifficulty = params.get('auraDifficulty') === 'lowkey'
      ? 'lowkey'
      : params.get('auraDifficulty') === 'untouchable'
        ? 'untouchable'
        : 'viral';
    return {
      gameMode: 'aura',
      vsAI: true,
      cpuVsCpu: auraAutoplay,
      p1Name: auraCanary === 'donald-trump' ? 'DONALD TRUMP' : 'NOVA',
      p2Name: 'BYTE',
      stageId,
      auraDifficulty,
      seed: 0x41555241,
    };
  }
  if (import.meta.env.DEV && params.get('rushDemo') === '1') {
    const stageId = params.get('rushStage') === 'la-jaula-304'
      ? 'la-jaula-304'
      : 'side-street';
    const rushDifficulty = params.get('rushDifficulty') === 'rookie'
      ? 'rookie'
      : params.get('rushDifficulty') === 'mayhem'
        ? 'mayhem'
        : 'arcade';
    return {
      gameMode: 'rush',
      vsAI: true,
      cpuVsCpu: false,
      p1Name: 'NOVA',
      p2Name: 'BYTE',
      stageId,
      rushDifficulty,
      seed: 0x52555348,
    };
  }
  if (import.meta.env.DEV && params.get('fightDemo') === '1') {
    const stageId = params.get('fightStage') === 'side-street'
      ? 'side-street'
      : 'la-jaula-304';
    const p2Difficulty = params.get('fightDifficulty') === 'rookie'
      ? 0.45
      : params.get('fightDifficulty') === 'champion'
        ? 1
        : 0.76;
    return {
      gameMode: 'fight',
      vsAI: true,
      cpuVsCpu: false,
      p1Name: 'NOVA',
      p2Name: 'BYTE',
      stageId,
      p2Difficulty,
      seed: 0x46494748,
    };
  }
  return readStoredMatch(authSessionKey);
}

function useHashRoute(): [AppRoute, Navigate, string] {
  const [location, setLocation] = useState(() => ({ route: normalizeRoute(window.location.pathname, window.location.hash), search: window.location.search }));
  const setRoute = (route: AppRoute) => setLocation({ route, search: window.location.search });

  useEffect(() => {
    const syncRoute = () => setRoute(normalizeRoute(window.location.pathname, window.location.hash));
    const onHashChange = () => syncRoute();
    const onPopState = () => syncRoute();
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  const navigate = useCallback((
    nextRoute: AppRoute,
    search = '',
    options: NavigationOptions = {},
  ) => {
    const normalizedSearch = search && !search.startsWith('?') ? `?${search}` : search;
    if (
      normalizeRoute(window.location.pathname, window.location.hash) === nextRoute &&
      window.location.search === normalizedSearch
    ) {
      setRoute(nextRoute);
      return;
    }
    const method = options.replace ? 'replaceState' : 'pushState';
    window.history[method](options.state ?? {}, '', `${nextRoute}${normalizedSearch}`);
    setRoute(nextRoute);
  }, []);

  return [location.route, navigate, location.search];
}

export function App({
  authStatus = 'local',
  authSessionKey = 'local',
  userImageUrl = null,
  isNewAccount = false,
  authSlot = null,
  cacheStatus = 'ready',
  cacheMessage = null,
  onRetryCache,
  configurationError = null,
}: AppProps) {
  const [route, navigate, routeSearch] = useHashRoute();
  const [pendingMatchState, setPendingMatchState] = useState<{
    authSessionKey: string;
    data: MatchSceneData | null;
  }>(() => ({ authSessionKey, data: readPendingMatchForRoute(authSessionKey) }));
  const pendingMatch = pendingMatchState.authSessionKey === authSessionKey
    ? pendingMatchState.data
    : null;
  const previousRouteRef = useRef<AppRoute>(route);
  const trialLaunchEpochRef = useRef(0);
  const [postSignUpTrialRequested, setPostSignUpTrialRequested] = useState(false);
  const creationPurchaseIntent = useMemo(
    () => route === '/credits' || route === '/menu' ? readCreationPurchaseIntent(authSessionKey) : null,
    [authSessionKey, route],
  );

  useEffect(() => {
    setPendingMatchState({
      authSessionKey,
      data: readPendingMatchForRoute(authSessionKey),
    });
  }, [authSessionKey]);


  useEffect(() => {
    trialLaunchEpochRef.current += 1;
    return () => { trialLaunchEpochRef.current += 1; };
  }, [route, authSessionKey]);

  useEffect(() => {
    if (!isGameRoute(route)) return;
    if (pendingMatch) {
      const expectedRoute = gameRouteForMatch(pendingMatch);
      if (route !== expectedRoute) {
        navigate(expectedRoute, window.location.search, { replace: true });
      }
      return;
    }
    debugWarn('[AppRouter] Game route requested without a valid match. Redirecting to Play.', {
      pathname: window.location.pathname,
      authSessionKey,
    });
    navigate('/menu', '', { replace: true });
  }, [authSessionKey, navigate, pendingMatch, route]);

  useEffect(() => {
    if (authStatus !== 'signed-in' || route === '/versus/online' || isGameRoute(route)) return;
    const pendingInvite = readPendingVersusInvite();
    if (!pendingInvite) return;
    const inviteSearch = new URLSearchParams({ invite: pendingInvite.token });
    if (pendingInvite.inviterName) inviteSearch.set('from', pendingInvite.inviterName);
    navigate('/versus/online', inviteSearch.toString(), { replace: true });
  }, [authStatus, navigate, route]);

  useEffect(() => {
    const previousRoute = previousRouteRef.current;
    previousRouteRef.current = route;
    if (!isGameRoute(previousRoute) || isGameRoute(route)) return;
    writeStoredMatch(null, authSessionKey);
    setPendingMatchState({ authSessionKey, data: null });
  }, [authSessionKey, route]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);

  useEffect(() => {
    debugInfo('[AppRouter] Route changed', {
      route,
      pathname: window.location.pathname,
      hash: window.location.hash,
      hasPendingMatch: Boolean(pendingMatch),
    });
  }, [route, pendingMatch]);

  const startFight = useCallback(
    (data: MatchSceneData) => {
      if (!writeStoredMatch(data, authSessionKey)) {
        debugWarn('[AppRouter] Match could not be persisted for reload recovery');
      }
      rememberLastGame(authSessionKey, data.gameMode ?? 'fight');
      trackProductEvent('game_started', { game: data.gameMode ?? 'fight', source: data.experience === 'trial' ? 'trial' : 'roster' });
      setPendingMatchState({ authSessionKey, data });
      debugInfo('[AppRouter] Starting game from roster', {
        gameMode: data.gameMode ?? 'fight',
        p1: data.p1Name ?? null,
        p2: data.p2Name ?? null,
      });
      navigate(gameRouteForMatch(data));
    },
    [authSessionKey, navigate],
  );

  const openGame = useCallback((mode: FighterGameMode) => {
    navigate(mode === 'aura' ? '/roster/aura' : mode === 'rush' ? '/roster/rush' : '/arcade');
  }, [navigate]);
  const createForGame = useCallback((mode: FighterGameMode, source: 'landing' | 'roster' = 'landing') => {
    navigate('/fighters/new', buildCreationSearch({ tier: 'rookie', returnTo: mode, creationPackage: mode === 'aura' ? 'aura' : 'complete', source }));
  }, [navigate]);
  const tryGame = useCallback(async (mode: FighterGameMode) => {
    const launchEpoch = ++trialLaunchEpochRef.current;
    const entryRoute = normalizeRoute(window.location.pathname, window.location.hash);
    const ownerScope = getActiveSpriteCacheScope();
    const seed = Math.floor(Math.random() * 0x7fffffff);
    if (mode === 'aura') {
      startFight(buildAuraTrialMatch(seed));
      return;
    }

    const [cloud, trial, api, packs] = await Promise.all([
      import('../services/CloudFighters.ts'),
      import('./shared/trialMatch.ts'),
      import('../services/ApiClient.ts'),
      import('../services/FighterAssetPacks.ts'),
    ]);
    const apiContext = api.captureApiRequestContext();
    let pair: import('./shared/trialMatch.ts').TrialFighterPair = { player: null, opponent: null };
    if (String(import.meta.env.VITE_API_BASE_URL ?? '').trim()) {
      const cloudPair = (async () => {
        const officials = await cloud.listArcadeFighters();
        const selected = trial.selectTrialFighters(officials.filter((fighter) => (
          packs.resolveFighterModeReadiness(fighter.sprites, mode).kind !== 'unavailable'
        )));
        const download = async (fighter: typeof selected.player) => {
          if (!fighter) return null;
          try {
            await cloud.downloadArcadeFighterToLocal(fighter, apiContext, {
              includeHighResolutionAssets: false,
              includeSourceAssets: false,
            });
            return fighter;
          } catch (error: unknown) {
            debugWarn('[Play] Trial character unavailable; using the built-in fallback:', error instanceof Error ? error.message : error);
            return null;
          }
        };
        const [player, opponent] = await Promise.all([download(selected.player), download(selected.opponent)]);
        return { player, opponent };
      })();
      pair = await trial.trialAssetsBeforeDeadline(cloudPair) ?? pair;
    }
    if (getActiveSpriteCacheScope() !== ownerScope || !shouldCommitTrialLaunch(
      launchEpoch, trialLaunchEpochRef.current, window.location.pathname, window.location.hash, entryRoute,
    )) return;
    startFight({ ...trial.buildTrialMatchData(pair), gameMode: mode, seed,
      ...(mode === 'rush' ? { stageId: 'side-street', rushDifficulty: 'rookie' as const, p2Name: pair.opponent?.name ?? 'CPU Ally' } : {}),
    });
  }, [startFight]);

  useEffect(() => {
    if (route === '/menu' && new URLSearchParams(routeSearch).has('checkout')) {
      navigate('/credits', routeSearch, { replace: true });
    }
  }, [route, routeSearch, navigate]);


  useEffect(() => {
    if (authStatus !== 'signed-in') return;
    if (!consumePostSignUpTrialIntent()) return;
    if (route !== '/') return;
    if (!isNewAccount) {
      debugInfo('[Onboarding] Ignored a stale sign-up trial intent for an existing account');
      return;
    }
    setPostSignUpTrialRequested(true);
    if (route !== '/') navigate('/', '', { replace: true });
  }, [authStatus, isNewAccount, navigate, route]);

  useEffect(() => {
    if (!postSignUpTrialRequested || authStatus !== 'signed-in' || route !== '/') return;
    setPostSignUpTrialRequested(false);
    void tryGame('aura').catch((error: unknown) => {
      debugWarn('[Onboarding] Aura trial could not start:', error instanceof Error ? error.message : error);
    });
  }, [authStatus, postSignUpTrialRequested, route, tryGame]);

  const finishFight = useCallback(() => {
    trackProductEvent('game_completed', { game: pendingMatch?.gameMode ?? 'fight', source: pendingMatch?.experience === 'trial' ? 'trial' : 'roster' });
    writeStoredMatch(null, authSessionKey);
    debugInfo('[AppRouter] Cleared completed match recovery state');
  }, [authSessionKey, pendingMatch]);

  const leaveFight = useCallback((nextRoute: AppRoute, search = '') => {
    writeStoredMatch(null, authSessionKey);
    setPendingMatchState({ authSessionKey, data: null });
    navigate(nextRoute, search);
  }, [authSessionKey, navigate]);

  const exitFight = useCallback(() => {
    if (pendingMatch?.auraChallenge) { leaveFight('/challenges'); return; }
    if (pendingMatch?.experience === 'trial' && pendingMatch.gameMode) { leaveFight(`/games/${pendingMatch.gameMode}`); return; }
    leaveFight(fightExitRoute(pendingMatch));
  }, [leaveFight, pendingMatch]);

  const launchTarget = useMemo(
    () => pendingMatch
      ? {
          sceneKey: pendingMatch.gameMode === 'rush'
            ? 'RushScene'
            : pendingMatch.gameMode === 'aura'
              ? 'AuraScene'
              : 'FightScene',
          data: pendingMatch,
        }
      : null,
    [pendingMatch],
  );

  const navigateToLegal = useCallback((nextRoute: LegalRoute) => {
    const returnTo = isLegalRoute(route)
      ? legalReturnRouteFromState(window.history.state)
      : isGameRoute(route) ? '/menu' : route;
    navigate(nextRoute, '', { state: { legalReturnTo: returnTo, legalReturnSearch: window.location.search } });
  }, [navigate, route]);

  const navigateWithinLegal = useCallback((nextRoute: LegalRoute) => {
    navigate(nextRoute, '', {
      state: { legalReturnTo: legalReturnRouteFromState(window.history.state), legalReturnSearch: window.history.state?.legalReturnSearch ?? '' },
    });
  }, [navigate]);

  const leaveLegal = useCallback(() => {
    navigate(legalReturnRouteFromState(window.history.state), typeof window.history.state?.legalReturnSearch === 'string' ? window.history.state.legalReturnSearch : '', { replace: true });
  }, [navigate]);

  const prepareChallenger = useCallback(async (fighterId: string | null) => {
    if (!fighterId) return;
    try {
      const [{ listArcadeFighters, downloadArcadeFighterToLocal }, { captureApiRequestContext }] =
        await Promise.all([
          import('../services/CloudFighters.ts'),
          import('../services/ApiClient.ts'),
        ]);
      const officials = await listArcadeFighters();
      const challenger = officials.find((fighter) => fighter.id === fighterId);
      if (challenger) await downloadArcadeFighterToLocal(challenger, captureApiRequestContext());
    } catch (err: any) {
      debugWarn('[Arcade] Challenger prefetch failed:', err?.message ?? err);
    }
  }, []);

  const ladderContext = useMemo<LadderContext | null>(() => {
    if (route !== '/fight' || !pendingMatch) return null;
    if (
      pendingMatch.experience === 'trial'
      || pendingMatch.gameMode === 'rush'
      || pendingMatch.gameMode === 'aura'
    ) return null;
    const run = readArcadeRun(getActiveSpriteCacheScope());
    if (!run) return null;
    const rung = currentRung(run);
    const isLadderMatch = isMatchForArcadeRun(pendingMatch, run);
    if (!isLadderMatch) return null;
    const nextRungMeta = isFinalRung(run) ? null : run.rungs[run.currentRung + 1];
    return {
      rungIndex: run.currentRung,
      rungTotal: run.rungs.length,
      continuesLeft: run.continuesLeft,
      continuesUsed: run.continuesUsed,
      isFinal: isFinalRung(run),
      nextName: nextRungMeta?.name ?? null,
      onNext: async () => {
        const latest = readArcadeRun(getActiveSpriteCacheScope());
        if (!latest) return;
        const advanced = advanceArcadeRun(latest);
        await prepareChallenger(currentRung(advanced).fighterId);
        writeArcadeRun(advanced);
        startFight(buildRungMatchData(advanced));
      },
      onContinue: async () => {
        const latest = readArcadeRun(getActiveSpriteCacheScope());
        const next = latest ? spendArcadeContinue(latest) : null;
        if (!next) return;
        writeArcadeRun(next);
        startFight(buildRungMatchData(next));
      },
      onExitLadder: () => {
        clearArcadeRun();
        navigate('/menu');
      },
      onPrefetchNext: () => {
        if (nextRungMeta) void prepareChallenger(nextRungMeta.fighterId);
      },
    };
  }, [route, pendingMatch, prepareChallenger, startFight, navigate]);

  const homePage = useMemo(
    () => (
      <HomePage
        key={authSessionKey}
        walletOnly
        authStatus={authStatus}
        authSessionKey={authSessionKey}
        creationPurchaseIntent={creationPurchaseIntent}
        onContinuePurchaseIntent={creationPurchaseIntent ? () => {
          clearCreationPurchaseIntent(authSessionKey);
          navigate('/fighters/new', buildCreationSearch({
            tier: creationPurchaseIntent.tier,
            creationPackage: creationPurchaseIntent.creationPackage,
            challenge: creationPurchaseIntent.challenge,
            returnTo: creationPurchaseIntent.returnTo,
            source: creationPurchaseIntent.source,
          }));
        } : undefined}
        onCreateFighter={() => navigate('/fighters/new')}
        onCreateStage={() => navigate('/stages/new')}
        onNavigateLegal={navigateToLegal}
        onOpenArcade={() => navigate('/arcade')}
        onOpenCoopRush={() => navigate('/roster/rush')}
        onOpenAuraCpu={() => navigate('/roster/aura')}
        onOpenAuraPlayer={() => navigate('/roster/aura-vs')}
        onOpenAuraOnline={() => navigate('/versus/online', 'mode=aura')}
        onOpenAuraWatch={() => navigate('/roster/aura-watch')}
        onOpenGallery={() => navigate('/gallery')}
        onOpenCommunity={() => navigate('/community')}
        onOpenWatchMode={() => navigate('/roster/watch')}
        onOpenVsCpu={() => navigate('/roster/cpu')}
        onOpenVsPlayer={() => navigate('/roster/vs')}
        onOpenOnlineVersus={() => navigate('/versus/online')}
        onOpenModeration={() => navigate('/moderation')}
      />
    ),
    [authStatus, authSessionKey, creationPurchaseIntent, navigate, navigateToLegal],
  );

  const content = useMemo(() => {
    if (configurationError && route !== '/' && route !== '/community' && !isLegalRoute(route)) {
      return (
        <ConfigurationErrorPage
          message={configurationError}
          onOpenCommunity={() => navigate('/community')}
          onOpenLegal={() => navigateToLegal('/legal')}
        />
      );
    }
    if ((route === '/' && !readLastGame(authSessionKey)) || route.startsWith('/games/')) {
      const mode: FighterGameMode = route === '/games/fight' ? 'fight' : route === '/games/rush' ? 'rush' : 'aura';
      return <GameLandingPage mode={mode} onPlay={tryGame} onCreate={createForGame} onExplore={(game) => navigate(`/games/${game}`)}
        onChooseCharacter={mode === 'aura' ? () => navigate('/roster/aura') : undefined}
        onLocalVersus={mode === 'rush' ? undefined : () => navigate(mode === 'aura' ? '/roster/aura-vs' : '/roster/vs')}
        onOnlineVersus={mode === 'rush' ? undefined : () => navigate('/versus/online', mode === 'aura' ? 'mode=aura' : '')}
        onWatch={mode === 'rush' ? undefined : () => navigate(mode === 'aura' ? '/roster/aura-watch' : '/roster/watch')}
        onOpenCharacters={() => navigate('/gallery')} onOpenCredits={() => navigate('/credits')} onBack={() => navigate('/menu')} />;
    }
    if (route === '/menu' || route === '/') return <PlayPage lastGame={readLastGame(authSessionKey)} onPlay={(mode) => readLastGame(authSessionKey) ? openGame(mode) : tryGame(mode)}
      onExplore={(mode) => navigate(`/games/${mode}`)} onOpenCharacters={() => navigate('/gallery')}
      onOpenChallenges={() => navigate('/challenges')} onChooseCharacter={() => navigate('/roster/aura')} />;
    if (route === '/credits') return homePage;
    if (route.startsWith('/watch/')) return <AuraWatchPage clipId={route.slice(7)} preferredPlayerPhotoHash={readPreferredArcadePlayerPhotoHash(routeSearch)}
      onPlay={startFight} onExplore={() => navigate('/games/aura')} onCreatePlayer={token => navigate('/fighters/new', buildCreationSearch({
        tier: 'rookie', creationPackage: 'aura', returnTo: 'aura', source: 'challenge', challenge: token,
      }))} />;
    if (route === '/challenge') return <ChallengePage preferredPlayerPhotoHash={readPreferredArcadePlayerPhotoHash(routeSearch)} token={new URLSearchParams(routeSearch).get('challenge')}
      onPlay={startFight} onBack={() => navigate('/challenges')} onCreatePlayer={() => navigate('/fighters/new', buildCreationSearch({
        tier: 'rookie', creationPackage: 'aura', returnTo: 'aura', source: 'challenge', challenge: new URLSearchParams(routeSearch).get('challenge') ?? undefined,
      }))} />;
    if (route === '/challenges') return <ChallengesPage onPlay={startFight}
      onOpenChallenge={(token) => navigate('/challenge', new URLSearchParams({challenge: token}).toString())} onBack={() => navigate('/menu')} />;
    if (route === '/arcade') {
      return (
        <ArcadePage
          authStatus={authStatus}
          authSessionKey={authSessionKey}
          preferredPlayerPhotoHash={readPreferredArcadePlayerPhotoHash(window.location.search)}
          onBack={() => navigate('/menu')}
          onCreateFighter={() => navigate('/fighters/new', buildCreationSearch({
            tier: 'rookie',
            creationPackage: 'complete',
            returnTo: 'arcade',
            source: 'arcade',
          }))}
          onStartFight={startFight}
        />
      );
    }
    if (route === '/gallery') {
      return (
        <GalleryPage
          authStatus={authStatus}
          authSessionKey={authSessionKey}
          onBack={() => navigate('/menu')}
          onCreateFighter={() => navigate('/fighters/new')}
          onCreateStage={() => navigate('/stages/new')}
          onNavigateLegal={navigateToLegal}
        />
      );
    }
    if (route === '/community') {
      return (
        <CommunityPage
          authStatus={authStatus}
          onBack={() => navigate('/menu')}
          onOpenGallery={() => navigate('/gallery')}
        />
      );
    }
    if (route === '/moderation') {
      return <ModerationPage onBack={() => navigate('/menu')} />;
    }
    if (route === '/versus/online') {
      return (
        <OnlineVersusPage
          authStatus={authStatus}
          onBack={() => navigate('/menu')}
          onStartFight={startFight}
        />
      );
    }
    if (route === '/fighters/new') {
      const creationContext = readCreationNavigationContext(window.location.search);
      const destination = creationDestination(creationContext.returnTo);
      return (
        <CreateFighterPage
          key={authSessionKey}
          authSlot={authSlot}
          onPlayTrial={() => void tryGame('aura')}
          authStatus={authStatus}
          authSessionKey={authSessionKey}
          completionLabel={creationContext.challenge ? 'Return to challenge' : creationContext.returnTo === 'gallery' ? 'Open my characters' : `Play ${creationContext.returnTo === 'arcade' ? 'Fight' : creationContext.returnTo}`}
          onBack={() => creationContext.challenge
            ? navigate('/challenge', new URLSearchParams({ challenge: creationContext.challenge }).toString())
            : navigate(destination)}
          onComplete={(photoHash) => creationContext.challenge
            ? navigate('/challenge', new URLSearchParams({challenge: creationContext.challenge, player: photoHash}).toString())
            : navigate(destination, destination === '/gallery' ? '' : buildArcadeSelectionSearch(photoHash))}
          onGetCredits={(tier, creationPackage, draftPersisted) => {
            rememberCreationPurchaseIntent(authSessionKey, {
              tier, creationPackage, challenge: creationContext.challenge,
              ...(draftPersisted === false ? { draftNotPersisted: true } : {}),
              returnTo: creationContext.returnTo, source: creationContext.source ?? 'menu',
            });
            navigate('/credits');
          }}
          onNavigateLegal={navigateToLegal}
        />
      );
    }
    if (route === '/stages/new') {
      return (
        <StageScoutPage
          onBack={() => navigate('/gallery', 'tab=stages')}
          onComplete={() => navigate('/gallery', 'tab=stages')}
        />
      );
    }
    if (isLegalRoute(route)) {
      return (
        <LegalPage
          kind={route.slice(1) as 'legal' | 'privacy' | 'terms' | 'refunds'}
          onBack={leaveLegal}
          onNavigate={navigateWithinLegal}
        />
      );
    }
    if (
      route === '/roster/watch'
      || route === '/roster/cpu'
      || route === '/roster/vs'
      || route === '/roster/rush'
      || route === '/roster/aura'
      || route === '/roster/aura-vs'
      || route === '/roster/aura-watch'
    ) {
      const mode = route === '/roster/watch'
        ? 'watch'
        : route === '/roster/vs'
          ? 'vs'
          : route === '/roster/rush'
            ? 'rush'
            : route === '/roster/aura'
              ? 'aura'
              : route === '/roster/aura-vs'
                ? 'aura-vs'
                : route === '/roster/aura-watch'
                  ? 'aura-watch'
                  : 'cpu';
      return (
        <RosterPage
          authStatus={authStatus}
          authSessionKey={authSessionKey}
          mode={mode}
          onBack={() => navigate('/menu')}
          preferredPlayerPhotoHash={readPreferredArcadePlayerPhotoHash(routeSearch)}
          onCreateFighter={() => createForGame(mode.startsWith('aura') ? 'aura' : mode === 'rush' ? 'rush' : 'fight', 'roster')}
          onStartFight={startFight}
        />
      );
    }
    if (!pendingMatch) {
      return <LoadingScreen label="Returning to the arcade..." />;
    }
    return (
      <GamePage
        launchTarget={launchTarget!}
        onComplete={finishFight}
        onExit={exitFight}
        onCreateFighter={() => leaveFight('/fighters/new', buildCreationSearch({
          tier: 'rookie',
          returnTo: pendingMatch.gameMode ?? 'fight',
          creationPackage: pendingMatch.gameMode === 'aura' ? 'aura' : 'complete',
          source: pendingMatch.auraChallenge ? 'challenge' : pendingMatch.experience === 'trial' ? 'trial' : 'roster',
          challenge: pendingMatch.auraChallenge ? encodeAuraChallenge(pendingMatch.auraChallenge) : undefined,
        }))}
        onOpenArcade={() => leaveFight('/arcade')}
        ladder={ladderContext}
      />
    );
  }, [
    route,
    navigate,
    navigateToLegal,
    navigateWithinLegal,
    leaveLegal,
    pendingMatch,
    launchTarget,
    finishFight,
    exitFight,
    leaveFight,
    startFight,
    authStatus,
    authSessionKey,
    authSlot,
    homePage,
    routeSearch,
    openGame,
    tryGame,
    createForGame,
    configurationError,
    ladderContext,
  ]);

  const routedContent = (
    <Suspense fallback={<LoadingScreen label="Loading cabinet..." />}>
      {content}
    </Suspense>
  );

  if (isGameRoute(route) && !configurationError) return routedContent;

  return (
    <div className="app-route-shell">
      <AppHeader currentRoute={route} onNavigate={navigate} authSlot={authSlot} />
      <CacheStatusBanner
        status={cacheStatus}
        message={cacheMessage}
        onRetry={onRetryCache}
      />
      <main className="app-main">{routedContent}</main>
      <nav className="product-entry__collection" aria-label="Community"><a href="/community" onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate('/community'); }}>Explore community characters →</a></nav>
      <LegalFooter onNavigate={navigateToLegal} />
    </div>
  );
}
