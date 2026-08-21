import { useEffect, useState } from 'react';
import { LegalFooter, type LegalRoute } from './components/LegalFooter.tsx';
import { LegalPage } from './routes/LegalPage.tsx';
import { PUBLIC_APP_NAME } from './publicBrand.ts';

type PrelaunchRoute = '/' | LegalRoute;

function routeFromPath(pathname: string): PrelaunchRoute {
  const cleaned = pathname.replace(/\/+$/, '') || '/';
  if (cleaned === '/legal' || cleaned === '/privacy' || cleaned === '/terms' || cleaned === '/refunds') {
    return cleaned;
  }
  return '/';
}

export function PrelaunchApp() {
  const [route, setRoute] = useState<PrelaunchRoute>(() => routeFromPath(window.location.pathname));

  useEffect(() => {
    const syncRoute = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener('popstate', syncRoute);
    return () => window.removeEventListener('popstate', syncRoute);
  }, []);

  const navigate = (nextRoute: PrelaunchRoute) => {
    window.history.pushState({}, '', nextRoute);
    setRoute(nextRoute);
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const content = route === '/'
    ? (
        <main className="prelaunch-home">
          <img
            className="prelaunch-home__image"
            src="/assets/app-icon-512.png"
            alt=""
            aria-hidden="true"
          />
          <div className="prelaunch-home__content">
            <p className="gallery-eyebrow">Player One</p>
            <h1>{PUBLIC_APP_NAME}</h1>
            <p className="prelaunch-home__status" role="status">Production access is opening shortly.</p>
          </div>
        </main>
      )
    : (
        <LegalPage
          kind={route.slice(1) as 'legal' | 'privacy' | 'terms' | 'refunds'}
          backLabel="Back to Insert Player"
          onBack={() => navigate('/')}
          onNavigate={navigate}
        />
      );

  return (
    <div className="app-route-shell">
      {content}
      <LegalFooter onNavigate={navigate} />
    </div>
  );
}
