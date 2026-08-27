import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HomePage } from './routes/HomePage.tsx';
import { GamePage } from './routes/GamePage.tsx';
import type { MatchSceneData } from '../game/match/MatchConfig.ts';
import { AppHeader } from './components/AppHeader.tsx';
import { LegalFooter, type LegalRoute } from './components/LegalFooter.tsx';
import { LoadingScreen } from './components/LoadingScreen.tsx';
import { LegalPage } from './routes/LegalPage.tsx';
import { ConfigurationErrorPage } from './routes/ConfigurationErrorPage.tsx';
import { debugInfo, debugWarn } from '../services/DebugLog.ts';
import type { AuthRouteState } from './authState.ts';
import { readStoredMatch, writeStoredMatch } from './shared/storedMatch.ts';
import { CacheStatusBanner, type CacheStatus } from './components/CacheStatusBanner.tsx';

const GalleryPage = lazy(() => import('./routes/GalleryPage.tsx').then((module) => ({
  default: module.GalleryPage,
})));
const RosterPage = lazy(() => import('./routes/RosterPage.tsx').then((module) => ({
  default: module.RosterPage,
})));
const CreateFighterPage = lazy(() => import('./routes/CreateFighterPage.tsx').then((module) => ({
  default: module.CreateFighterPage,
})));
const CommunityPage = lazy(() => import('./routes/CommunityPage.tsx').then((module) => ({
  default: module.CommunityPage,
})));
const ModerationPage = lazy(() => import('./routes/ModerationPage.tsx').then((module) => ({
  default: module.ModerationPage,
})));

type AppRoute =
  | '/menu'
  | '/gallery'
  | '/community'
  | '/moderation'
  | '/fighters/new'
  | '/roster/watch'
  | '/roster/cpu'
  | '/roster/vs'
  | LegalRoute
  | '/fight';

interface NavigationOptions {
  replace?: boolean;
  state?: Record<string, unknown>;
}

interface AppProps extends Partial<AuthRouteState> {
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
    candidate === '/menu' ||
    candidate === '/gallery' ||
    candidate === '/community' ||
    candidate === '/moderation' ||
    candidate === '/fighters/new' ||
    candidate === '/roster/watch' ||
    candidate === '/roster/cpu' ||
    candidate === '/roster/vs'
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
      : (cleanedHash || '/menu');
  if (cleaned === '/gallery') return '/gallery';
  if (cleaned === '/community') return '/community';
  if (cleaned === '/moderation') return '/moderation';
  if (cleaned === '/fighters/new') return '/fighters/new';
  if (cleaned === '/roster/watch') return '/roster/watch';
  if (cleaned === '/roster/cpu') return '/roster/cpu';
  if (cleaned === '/roster/vs') return '/roster/vs';
  if (cleaned === '/legal') return '/legal';
  if (cleaned === '/privacy') return '/privacy';
  if (cleaned === '/terms') return '/terms';
  if (cleaned === '/refunds') return '/refunds';
  if (cleaned === '/fight') return '/fight';
  return '/menu';
}

type Navigate = (route: AppRoute, search?: string, options?: NavigationOptions) => void;

function useHashRoute(): [AppRoute, Navigate] {
  const [route, setRoute] = useState<AppRoute>(() =>
    normalizeRoute(window.location.pathname, window.location.hash),
  );

  useEffect(() => {
    if (!window.location.hash && (window.location.pathname === '/' || window.location.pathname === '')) {
      window.history.replaceState({}, '', '/menu');
      setRoute('/menu');
    }
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
  }>(() => ({ authSessionKey, data: readStoredMatch(authSessionKey) }));
  const pendingMatch = pendingMatchState.authSessionKey === authSessionKey
    ? pendingMatchState.data
    : null;
  const previousRouteRef = useRef<AppRoute>(route);

  useEffect(() => {
    setPendingMatchState({
      authSessionKey,
      data: readStoredMatch(authSessionKey),
    });
  }, [authSessionKey]);

  useEffect(() => {
    if (route !== '/fight' || pendingMatch) return;
    debugWarn('[AppRouter] /fight requested without a valid match. Redirecting to the arcade.', {
      pathname: window.location.pathname,
      authSessionKey,
    });
    navigate('/menu', '', { replace: true });
  }, [authSessionKey, navigate, pendingMatch, route]);

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

  const finishFight = useCallback(() => {
    writeStoredMatch(null, authSessionKey);
    debugInfo('[AppRouter] Cleared completed match recovery state');
  }, [authSessionKey]);

  const exitFight = useCallback(() => {
    writeStoredMatch(null, authSessionKey);
    setPendingMatchState({ authSessionKey, data: null });
    navigate('/menu');
  }, [authSessionKey, navigate]);

  const launchTarget = useMemo(
    () => pendingMatch ? { sceneKey: 'FightScene', data: pendingMatch } : null,
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

  const homePage = useMemo(
    () => (
      <HomePage
        authStatus={authStatus}
        authSessionKey={authSessionKey}
        onCreateFighter={() => navigate('/fighters/new')}
        onNavigateLegal={navigateToLegal}
        onOpenGallery={() => navigate('/gallery')}
        onOpenCommunity={() => navigate('/community')}
        onOpenWatchMode={() => navigate('/roster/watch')}
        onOpenVsCpu={() => navigate('/roster/cpu')}
        onOpenVsPlayer={() => navigate('/roster/vs')}
        onOpenModeration={() => navigate('/moderation')}
      />
    ),
    [authStatus, authSessionKey, navigate, navigateToLegal],
  );

  const content = useMemo(() => {
    if (configurationError && route !== '/community' && !isLegalRoute(route)) {
      return (
        <ConfigurationErrorPage
          message={configurationError}
          onOpenCommunity={() => navigate('/community')}
          onOpenLegal={() => navigateToLegal('/legal')}
        />
      );
    }
    if (route === '/menu') {
      return homePage;
    }
    if (route === '/gallery') {
      return (
        <GalleryPage
          authStatus={authStatus}
          authSessionKey={authSessionKey}
          onBack={() => navigate('/menu')}
          onCreateFighter={() => navigate('/fighters/new')}
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
    if (route === '/fighters/new') {
      return (
        <CreateFighterPage
          authStatus={authStatus}
          authSessionKey={authSessionKey}
          onBack={() => navigate('/gallery')}
          onComplete={() => navigate('/gallery')}
          onNavigateLegal={navigateToLegal}
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
    if (route === '/roster/watch' || route === '/roster/cpu' || route === '/roster/vs') {
      const mode = route === '/roster/watch' ? 'watch' : route === '/roster/vs' ? 'vs' : 'cpu';
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
    return <GamePage launchTarget={launchTarget!} onComplete={finishFight} onExit={exitFight} />;
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
    startFight,
    authStatus,
    authSessionKey,
    homePage,
    configurationError,
  ]);

  const routedContent = (
    <Suspense fallback={<LoadingScreen label="Loading cabinet..." />}>
      {content}
    </Suspense>
  );

  if (route === '/fight' && !configurationError) return routedContent;

  return (
    <div className="app-route-shell">
      <AppHeader currentRoute={route} onNavigate={navigate} />
      {authSlot}
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
