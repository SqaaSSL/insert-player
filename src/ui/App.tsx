import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HomePage } from './routes/HomePage.tsx';
import { LandingPage } from './routes/LandingPage.tsx';
import { GamePage } from './routes/GamePage.tsx';
import type { MatchSceneData } from '../game/match/MatchConfig.ts';
import { AppHeader } from './components/AppHeader.tsx';
import { LegalFooter, type LegalRoute } from './components/LegalFooter.tsx';
import { LoadingScreen } from './components/LoadingScreen.tsx';
import { LegalPage } from './routes/LegalPage.tsx';
import { ConfigurationErrorPage } from './routes/ConfigurationErrorPage.tsx';
import { debugInfo, debugWarn } from '../services/DebugLog.ts';
import type { AuthRouteState } from './authState.ts';
import type { BillingProfile } from '../services/Billing.ts';
import { readStoredMatch, writeStoredMatch } from './shared/storedMatch.ts';
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
  | '/versus/online'
  | LegalRoute
  | '/fight';

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

export function legalReturnRouteFromState(state: unknown): AppRoute {
  if (!state || typeof state !== 'object') return '/menu';
  const candidate = (state as { legalReturnTo?: unknown }).legalReturnTo;
  if (
    candidate === '/' ||
    candidate === '/menu' ||
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
  if (cleaned === '/versus/online') return '/versus/online';
  if (cleaned === '/legal') return '/legal';
  if (cleaned === '/privacy') return '/privacy';
  if (cleaned === '/terms') return '/terms';
  if (cleaned === '/refunds') return '/refunds';
  if (cleaned === '/fight') return '/fight';
  return '/menu';
}

export function shouldCommitTrialLaunch(
  launchEpoch: number,
  currentEpoch: number,
  pathname: string,
  hash: string,
): boolean {
  return launchEpoch === currentEpoch && normalizeRoute(pathname, hash) === '/';
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

function useHashRoute(): [AppRoute, Navigate] {
  const [route, setRoute] = useState<AppRoute>(() =>
    normalizeRoute(window.location.pathname, window.location.hash),
  );

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

  return [route, navigate];
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
  const [route, navigate] = useHashRoute();
  const [pendingMatchState, setPendingMatchState] = useState<{
    authSessionKey: string;
    data: MatchSceneData | null;
  }>(() => ({ authSessionKey, data: readPendingMatchForRoute(authSessionKey) }));
  const pendingMatch = pendingMatchState.authSessionKey === authSessionKey
    ? pendingMatchState.data
    : null;
  const previousRouteRef = useRef<AppRoute>(route);
  const trialLaunchEpochRef = useRef(0);
  const [landingBillingProfile, setLandingBillingProfile] = useState<BillingProfile | null>(null);
  const [landingBillingChecked, setLandingBillingChecked] = useState(authStatus !== 'signed-in');
  const [postSignUpTrialRequested, setPostSignUpTrialRequested] = useState(false);
  const creationPurchaseIntent = useMemo(
    () => route === '/menu' ? readCreationPurchaseIntent(authSessionKey) : null,
    [authSessionKey, route],
  );

  useEffect(() => {
    setPendingMatchState({
      authSessionKey,
      data: readPendingMatchForRoute(authSessionKey),
    });
  }, [authSessionKey]);

  useEffect(() => {
    let cancelled = false;
    setLandingBillingProfile(null);
    setLandingBillingChecked(authStatus !== 'signed-in');
    if (route !== '/' || authStatus !== 'signed-in') return () => { cancelled = true; };
    void Promise.all([
      import('../services/Billing.ts'),
      import('../services/ApiClient.ts'),
    ]).then(async ([{ getBillingProfile }, { captureApiRequestContext }]) => {
      const profile = await getBillingProfile(captureApiRequestContext());
      if (!cancelled) {
        setLandingBillingProfile(profile);
        setLandingBillingChecked(true);
      }
    }).catch((error: unknown) => {
      debugWarn('[Landing] Rookie pass check failed:', error instanceof Error ? error.message : error);
      if (!cancelled) setLandingBillingChecked(true);
    });
    return () => { cancelled = true; };
  }, [authSessionKey, authStatus, route]);

  useEffect(() => {
    trialLaunchEpochRef.current += 1;
  }, [route]);

  useEffect(() => {
    if (route !== '/fight' || pendingMatch) return;
    debugWarn('[AppRouter] /fight requested without a valid match. Redirecting to the arcade.', {
      pathname: window.location.pathname,
      authSessionKey,
    });
    navigate('/menu', '', { replace: true });
  }, [authSessionKey, navigate, pendingMatch, route]);

  useEffect(() => {
    if (authStatus !== 'signed-in' || route === '/versus/online' || route === '/fight') return;
    const pendingInvite = readPendingVersusInvite();
    if (!pendingInvite) return;
    const inviteSearch = new URLSearchParams({ invite: pendingInvite.token });
    if (pendingInvite.inviterName) inviteSearch.set('from', pendingInvite.inviterName);
    navigate('/versus/online', inviteSearch.toString(), { replace: true });
  }, [authStatus, navigate, route]);

  useEffect(() => {
    const previousRoute = previousRouteRef.current;
    previousRouteRef.current = route;
    if (previousRoute !== '/fight' || route === '/fight') return;
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
      setPendingMatchState({ authSessionKey, data });
      debugInfo('[AppRouter] Starting fight from roster', {
        p1: data.p1Name ?? null,
        p2: data.p2Name ?? null,
      });
      navigate('/fight');
    },
    [authSessionKey, navigate],
  );

  const startTrial = useCallback(async () => {
    const launchEpoch = ++trialLaunchEpochRef.current;
    const [cloud, trial, api] = await Promise.all([
      import('../services/CloudFighters.ts'),
      import('./shared/trialMatch.ts'),
      import('../services/ApiClient.ts'),
    ]);
    const context = api.captureApiRequestContext();
    const cloudPair = (async () => {
      const officials = await cloud.listArcadeFighters().catch((error: unknown) => {
        debugWarn('[Landing] Public trial roster unavailable; using built-in fighters:',
          error instanceof Error ? error.message : error);
        return [];
      });
      const pair = trial.selectTrialFighters(officials);
      const downloadTrialFighter = async (
        fighter: typeof pair.player,
        slot: 'player' | 'opponent',
      ) => {
        if (!fighter) return null;
        try {
          await cloud.downloadArcadeFighterToLocal(fighter, context, {
            includeHighResolutionAssets: false,
            includeSourceAssets: false,
          });
          return fighter;
        } catch (error) {
          debugWarn(`[Landing] Trial ${slot} download failed; using built-in fighter:`,
            error instanceof Error ? error.message : error);
          return null;
        }
      };
      const [player, opponent] = await Promise.all([
        downloadTrialFighter(pair.player, 'player'),
        downloadTrialFighter(pair.opponent, 'opponent'),
      ]);
      return { player, opponent };
    })();
    const loadedPair = await trial.trialAssetsBeforeDeadline(cloudPair);
    if (!shouldCommitTrialLaunch(
      launchEpoch,
      trialLaunchEpochRef.current,
      window.location.pathname,
      window.location.hash,
    )) return;
    if (!loadedPair) {
      debugWarn('[Landing] Trial cloud assets exceeded the startup deadline; using built-in fighters');
    }
    startFight(trial.buildTrialMatchData(loadedPair ?? { player: null, opponent: null }));
  }, [startFight]);

  useEffect(() => {
    if (authStatus !== 'signed-in') return;
    if (!consumePostSignUpTrialIntent()) return;
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
    void startTrial().catch((error: unknown) => {
      debugWarn('[Onboarding] Post-sign-up trial failed to start:',
        error instanceof Error ? error.message : error);
    });
  }, [authStatus, postSignUpTrialRequested, route, startTrial]);

  const finishFight = useCallback(() => {
    writeStoredMatch(null, authSessionKey);
    debugInfo('[AppRouter] Cleared completed match recovery state');
  }, [authSessionKey]);

  const leaveFight = useCallback((nextRoute: AppRoute, search = '') => {
    writeStoredMatch(null, authSessionKey);
    setPendingMatchState({ authSessionKey, data: null });
    navigate(nextRoute, search);
  }, [authSessionKey, navigate]);

  const exitFight = useCallback(() => {
    leaveFight(fightExitRoute(pendingMatch));
  }, [leaveFight, pendingMatch]);

  const launchTarget = useMemo(
    () => pendingMatch
      ? { sceneKey: pendingMatch.gameMode === 'rush' ? 'RushScene' : 'FightScene', data: pendingMatch }
      : null,
    [pendingMatch],
  );

  const navigateToLegal = useCallback((nextRoute: LegalRoute) => {
    const returnTo = isLegalRoute(route)
      ? legalReturnRouteFromState(window.history.state)
      : route === '/fight' ? '/menu' : route;
    navigate(nextRoute, '', { state: { legalReturnTo: returnTo } });
  }, [navigate, route]);

  const navigateWithinLegal = useCallback((nextRoute: LegalRoute) => {
    navigate(nextRoute, '', {
      state: { legalReturnTo: legalReturnRouteFromState(window.history.state) },
    });
  }, [navigate]);

  const leaveLegal = useCallback(() => {
    navigate(legalReturnRouteFromState(window.history.state), '', { replace: true });
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
    if (pendingMatch.experience === 'trial' || pendingMatch.gameMode === 'rush') return null;
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
        authStatus={authStatus}
        authSessionKey={authSessionKey}
        creationPurchaseIntent={creationPurchaseIntent}
        onContinuePurchaseIntent={creationPurchaseIntent ? () => {
          clearCreationPurchaseIntent(authSessionKey);
          navigate('/fighters/new', buildCreationSearch({
            tier: creationPurchaseIntent.tier,
            returnTo: creationPurchaseIntent.returnTo,
            source: creationPurchaseIntent.source,
          }));
        } : undefined}
        onCreateFighter={() => navigate('/fighters/new')}
        onCreateStage={() => navigate('/stages/new')}
        onNavigateLegal={navigateToLegal}
        onOpenArcade={() => navigate('/arcade')}
        onOpenCoopRush={() => navigate('/roster/rush')}
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

  const landingPage = useMemo(
    () => (
      <LandingPage
        authStatus={authStatus}
        billingProfile={landingBillingProfile}
        billingProfileChecked={landingBillingChecked}
        onPlayTrial={startTrial}
        onCreateFighter={() => navigate('/fighters/new', buildCreationSearch({
          tier: 'rookie',
          returnTo: 'arcade',
          source: 'landing',
        }))}
        onOpenArcade={() => navigate('/arcade')}
        onOpenWatchMode={() => navigate('/roster/watch')}
        onOpenCommunity={() => navigate('/community')}
        userImageUrl={userImageUrl}
      />
    ),
    [
      authStatus,
      landingBillingChecked,
      landingBillingProfile,
      navigate,
      startTrial,
      userImageUrl,
    ],
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
    if (route === '/') {
      return landingPage;
    }
    if (route === '/menu') {
      return homePage;
    }
    if (route === '/arcade') {
      return (
        <ArcadePage
          authStatus={authStatus}
          authSessionKey={authSessionKey}
          preferredPlayerPhotoHash={readPreferredArcadePlayerPhotoHash(window.location.search)}
          onBack={() => navigate('/menu')}
          onCreateFighter={() => navigate('/fighters/new', buildCreationSearch({
            tier: 'rookie',
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
      const returnToArcade = creationContext.returnTo === 'arcade';
      const backRoute: AppRoute = creationContext.source === 'landing' || creationContext.source === 'trial'
        ? '/'
        : returnToArcade ? '/arcade' : '/gallery';
      return (
        <CreateFighterPage
          authStatus={authStatus}
          authSessionKey={authSessionKey}
          completionLabel={returnToArcade ? 'Enter Arcade' : 'Open In Gallery'}
          onBack={() => navigate(backRoute)}
          onComplete={(photoHash) => returnToArcade
            ? navigate('/arcade', buildArcadeSelectionSearch(photoHash))
            : navigate('/gallery')}
          onGetCredits={(tier) => {
            const stored = rememberCreationPurchaseIntent(authSessionKey, {
              tier,
              returnTo: creationContext.returnTo,
              source: creationContext.source ?? 'menu',
            });
            if (!stored) {
              debugWarn('[Create] Could not preserve the selected tier before opening credits');
            }
            navigate('/menu');
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
    ) {
      const mode = route === '/roster/watch'
        ? 'watch'
        : route === '/roster/vs'
          ? 'vs'
          : route === '/roster/rush'
            ? 'rush'
            : 'cpu';
      return (
        <RosterPage
          authStatus={authStatus}
          authSessionKey={authSessionKey}
          mode={mode}
          onBack={() => navigate('/menu')}
          onCreateFighter={() => navigate('/fighters/new', 'tier=rookie')}
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
          returnTo: 'arcade',
          source: 'trial',
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
    homePage,
    landingPage,
    configurationError,
    ladderContext,
  ]);

  const routedContent = (
    <Suspense fallback={<LoadingScreen label="Loading cabinet..." />}>
      {content}
    </Suspense>
  );

  if (route === '/fight' && !configurationError) return routedContent;

  return (
    <div className="app-route-shell">
      <AppHeader currentRoute={route} onNavigate={navigate} authSlot={authSlot} />
      <CacheStatusBanner
        status={cacheStatus}
        message={cacheMessage}
        onRetry={onRetryCache}
      />
      <main className="app-main">{routedContent}</main>
      <LegalFooter onNavigate={navigateToLegal} />
    </div>
  );
}
