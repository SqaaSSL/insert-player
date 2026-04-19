import { useCallback, useEffect, useMemo, useState } from 'react';
import type Phaser from 'phaser';
import { createGame } from '../game/createGame.ts';
import { GalleryPage } from './routes/GalleryPage.tsx';
import { HomePage } from './routes/HomePage.tsx';
import { RosterPage } from './routes/RosterPage.tsx';
import type { MatchSceneData } from '../game/match/MatchConfig.ts';

type AppRoute = '/menu' | '/gallery' | '/roster/watch' | '/roster/cpu' | '/roster/vs' | '/fight';
const LAST_MATCH_STORAGE_KEY = 'ai-street-fighter:last-match';

function readStoredMatch(): MatchSceneData | null {
  try {
    const raw = window.sessionStorage.getItem(LAST_MATCH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MatchSceneData | null;
    console.info('[AppRouter] Read stored match from sessionStorage', {
      hasMatch: Boolean(parsed),
      p1: parsed?.p1Name ?? null,
      p2: parsed?.p2Name ?? null,
    });
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    console.warn('[AppRouter] Failed to parse stored match from sessionStorage');
    return null;
  }
}

function writeStoredMatch(data: MatchSceneData | null): void {
  try {
    if (!data) {
      window.sessionStorage.removeItem(LAST_MATCH_STORAGE_KEY);
      console.info('[AppRouter] Cleared stored match');
      return;
    }
    window.sessionStorage.setItem(LAST_MATCH_STORAGE_KEY, JSON.stringify(data));
    console.info('[AppRouter] Stored match', {
      p1: data.p1Name ?? null,
      p2: data.p2Name ?? null,
      vsAI: data.vsAI ?? null,
      cpuVsCpu: data.cpuVsCpu ?? null,
    });
  } catch {
    // Ignore storage failures; in-memory state still works.
    console.warn('[AppRouter] Failed to write match to sessionStorage');
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
  if (cleaned === '/roster/watch') return '/roster/watch';
  if (cleaned === '/roster/cpu') return '/roster/cpu';
  if (cleaned === '/roster/vs') return '/roster/vs';
  if (cleaned === '/fight') return '/fight';
  return '/menu';
}

function useHashRoute(): [AppRoute, (route: AppRoute) => void] {
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

  const navigate = (nextRoute: AppRoute) => {
    if (normalizeRoute(window.location.pathname, window.location.hash) === nextRoute) {
      setRoute(nextRoute);
      return;
    }
    window.history.pushState({}, '', nextRoute);
    setRoute(nextRoute);
  };

  return [route, navigate];
}

function GamePage({
  launchTarget,
  onExit,
}: {
  launchTarget: { sceneKey: string; data?: object };
  onExit: () => void;
}) {
  useEffect(() => {
    const win = window as Window & {
      __ASF_OPEN_GALLERY__?: () => void;
      __ASF_DISABLE_PHASER_TITLE__?: boolean;
    };
    const originalOpenGallery = win.__ASF_OPEN_GALLERY__;
    const originalDisablePhaserTitle = win.__ASF_DISABLE_PHASER_TITLE__;
    win.__ASF_OPEN_GALLERY__ = () => {
      window.history.pushState({}, '', '/gallery');
      window.dispatchEvent(new PopStateEvent('popstate'));
    };
    win.__ASF_DISABLE_PHASER_TITLE__ = true;
    return () => {
      win.__ASF_OPEN_GALLERY__ = originalOpenGallery;
      win.__ASF_DISABLE_PHASER_TITLE__ = originalDisablePhaserTitle;
    };
  }, []);

  useEffect(() => {
    console.info('[GamePage] Mounting Phaser runtime', {
      sceneKey: launchTarget.sceneKey,
      hasData: Boolean(launchTarget.data),
    });
    let game: Phaser.Game | null = createGame('game-container', launchTarget);
    return () => {
      console.info('[GamePage] Destroying Phaser runtime', {
        sceneKey: launchTarget.sceneKey,
      });
      game?.destroy(true);
      game = null;
    };
  }, [launchTarget]);

  return (
    <div className="game-shell">
      <div className="game-shell__surface">
        <div id="game-container" className="game-shell__canvas" />
      </div>
      <button className="game-shell__gallery-link" onClick={onExit}>
        Back
      </button>
    </div>
  );
}

export function App() {
  const [route, navigate] = useHashRoute();
  const [pendingMatch, setPendingMatch] = useState<MatchSceneData | null>(() => readStoredMatch());

  useEffect(() => {
    console.info('[AppRouter] Route changed', {
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
      console.info('[AppRouter] Starting fight from roster', {
        p1: data.p1Name ?? null,
        p2: data.p2Name ?? null,
      });
      navigate('/fight');
    },
    [navigate],
  );

  const content = useMemo(() => {
    if (route === '/menu') {
      return (
        <HomePage
          onOpenGallery={() => navigate('/gallery')}
          onOpenWatchMode={() => navigate('/roster/watch')}
          onOpenVsCpu={() => navigate('/roster/cpu')}
          onOpenVsPlayer={() => navigate('/roster/vs')}
        />
      );
    }
    if (route === '/gallery') {
      return <GalleryPage onBack={() => navigate('/menu')} />;
    }
    if (route === '/roster/watch' || route === '/roster/cpu' || route === '/roster/vs') {
      const mode = route === '/roster/watch' ? 'watch' : route === '/roster/vs' ? 'vs' : 'cpu';
      return <RosterPage mode={mode} onBack={() => navigate('/menu')} onStartFight={startFight} />;
    }
    if (!pendingMatch) {
      console.warn('[AppRouter] /fight requested without pending match. Falling back to menu shell.', {
        pathname: window.location.pathname,
        hash: window.location.hash,
      });
      return (
        <HomePage
          onOpenGallery={() => navigate('/gallery')}
          onOpenWatchMode={() => navigate('/roster/watch')}
          onOpenVsCpu={() => navigate('/roster/cpu')}
          onOpenVsPlayer={() => navigate('/roster/vs')}
        />
      );
    }
    return <GamePage launchTarget={{ sceneKey: 'FightScene', data: pendingMatch }} onExit={() => navigate('/menu')} />;
  }, [route, navigate, pendingMatch, startFight]);

  return <>{content}</>;
}
