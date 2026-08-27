import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { HomePage } from './routes/HomePage.tsx';
import { GamePage } from './routes/GamePage.tsx';
import type { MatchSceneData } from '../game/match/MatchConfig.ts';
import { AppHeader } from './components/AppHeader.tsx';
import { LegalFooter, type LegalRoute } from './components/LegalFooter.tsx';
import { LoadingScreen } from './components/LoadingScreen.tsx';
import { LegalPage } from './routes/LegalPage.tsx';
import { debugInfo, debugWarn } from '../services/DebugLog.ts';
import type { AuthRouteState } from './authState.ts';

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
const LAST_MATCH_STORAGE_KEY = 'ai-street-fighter:last-match';

function readStoredMatch(): MatchSceneData | null {
  try {
    const raw = window.sessionStorage.getItem(LAST_MATCH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MatchSceneData | null;
    debugInfo('[AppRouter] Read stored match from sessionStorage', {
      hasMatch: Boolean(parsed),
      p1: parsed?.p1Name ?? null,
      p2: parsed?.p2Name ?? null,
    });
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    debugWarn('[AppRouter] Failed to parse stored match from sessionStorage');
    return null;
  }
}

function writeStoredMatch(data: MatchSceneData | null): void {
  try {
    if (!data) {
      window.sessionStorage.removeItem(LAST_MATCH_STORAGE_KEY);
      debugInfo('[AppRouter] Cleared stored match');
      return;
    }
    window.sessionStorage.setItem(LAST_MATCH_STORAGE_KEY, JSON.stringify(data));
    debugInfo('[AppRouter] Stored match', {
      p1: data.p1Name ?? null,
      p2: data.p2Name ?? null,
      vsAI: data.vsAI ?? null,
      cpuVsCpu: data.cpuVsCpu ?? null,
    });
  } catch {
    debugWarn('[AppRouter] Failed to write match to sessionStorage');
  }
}

function normalizeRoute(pathname: string, hash: string): AppRoute {
  const cleanedPath = (pathname || '/menu').replace(/\/+$/, '') || '/menu';
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

function useHashRoute(): [AppRoute, (route: AppRoute, search?: string) => void] {
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

  const navigate = (nextRoute: AppRoute, search = '') => {
    const normalizedSearch = search && !search.startsWith('?') ? `?${search}` : search;
    if (
      normalizeRoute(window.location.pathname, window.location.hash) === nextRoute &&
      window.location.search === normalizedSearch
    ) {
      setRoute(nextRoute);
      return;
    }
    window.history.pushState({}, '', `${nextRoute}${normalizedSearch}`);
    setRoute(nextRoute);
  };

  return [route, navigate];
}

export function App({
  authStatus = 'local',
  authSessionKey = 'local',
  authSlot = null,
}: Partial<AuthRouteState> & { authSlot?: ReactNode }) {
  const [route, navigate] = useHashRoute();
  const [pendingMatch, setPendingMatch] = useState<MatchSceneData | null>(() => readStoredMatch());

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
      writeStoredMatch(data);
      setPendingMatch(data);
      debugInfo('[AppRouter] Starting fight from roster', {
        p1: data.p1Name ?? null,
        p2: data.p2Name ?? null,
      });
      navigate('/fight');
    },
    [navigate],
  );

  const homePage = useMemo(
    () => (
      <HomePage
        authStatus={authStatus}
        authSessionKey={authSessionKey}
        onCreateFighter={() => navigate('/fighters/new')}
        onNavigateLegal={(route) => navigate(route)}
        onOpenGallery={() => navigate('/gallery')}
        onOpenCommunity={() => navigate('/community')}
        onOpenWatchMode={() => navigate('/roster/watch')}
        onOpenVsCpu={() => navigate('/roster/cpu')}
        onOpenVsPlayer={() => navigate('/roster/vs')}
        onOpenModeration={() => navigate('/moderation')}
      />
    ),
    [authStatus, authSessionKey, navigate],
  );

  const content = useMemo(() => {
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
          onNavigateLegal={(route: LegalRoute) => navigate(route)}
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
          onNavigateLegal={(route: LegalRoute) => navigate(route)}
        />
      );
    }
    if (route === '/legal' || route === '/privacy' || route === '/terms' || route === '/refunds') {
      return (
        <LegalPage
          kind={route.slice(1) as 'legal' | 'privacy' | 'terms' | 'refunds'}
          onBack={() => navigate('/menu')}
          onNavigate={navigate}
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
      debugWarn('[AppRouter] /fight requested without pending match. Falling back to menu shell.', {
        pathname: window.location.pathname,
        hash: window.location.hash,
      });
      return homePage;
    }
    return <GamePage launchTarget={{ sceneKey: 'FightScene', data: pendingMatch }} onExit={() => navigate('/menu')} />;
  }, [route, navigate, pendingMatch, startFight, authStatus, authSessionKey, homePage]);

  const routedContent = (
    <Suspense fallback={<LoadingScreen label="Loading cabinet..." />}>
      {content}
    </Suspense>
  );

  if (route === '/fight') return routedContent;

  return (
    <div className="app-route-shell">
      <AppHeader currentRoute={route} onNavigate={navigate} authSlot={authSlot} />
      <main className="app-main">{routedContent}</main>
      <LegalFooter onNavigate={navigate} />
    </div>
  );
}
