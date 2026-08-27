import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider, useAuth, useUser } from '@clerk/react';
import { App } from './ui/App.tsx';
import { AuthDock } from './ui/components/AuthDock.tsx';
import { LoadingScreen } from './ui/components/LoadingScreen.tsx';
import type { AuthStatus } from './ui/authState.ts';
import { configureApiAuth } from './services/ApiClient.ts';
import {
  claimLocalSpriteCacheForCurrentOwner,
  configureSpriteCacheOwner,
  spriteCacheScopeForOwner,
} from './services/SpriteCache.ts';
import { debugWarn } from './services/DebugLog.ts';
import '@fontsource/press-start-2p/latin-400.css';
import '@fontsource/space-grotesk/latin-400.css';
import '@fontsource/space-grotesk/latin-500.css';
import '@fontsource/space-grotesk/latin-700.css';
import './ui/styles.css';

const rootEl = document.getElementById('app');

if (!rootEl) {
  throw new Error('Missing #app root element');
}

function ClerkSessionBridge() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const authReady = isLoaded && (!isSignedIn || Boolean(user?.id));
  const authStatus: AuthStatus = !authReady ? 'loading' : isSignedIn ? 'signed-in' : 'signed-out';
  const authSessionKey = !authReady ? 'loading' : isSignedIn ? user?.id ?? 'signed-in' : 'signed-out';
  const cacheOwnerId = authReady && isSignedIn ? user?.id ?? null : null;
  const cacheScope = spriteCacheScopeForOwner(cacheOwnerId);
  const [preparedCacheScope, setPreparedCacheScope] = useState<string | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);

  useEffect(() => {
    configureApiAuth(isLoaded && isSignedIn ? () => getToken() : null);
    return () => configureApiAuth(null);
  }, [getToken, isLoaded, isSignedIn]);

  useEffect(() => {
    let cancelled = false;
    setPreparedCacheScope(null);
    setCacheError(null);
    if (!authReady) return () => { cancelled = true; };

    configureSpriteCacheOwner(cacheOwnerId);
    const prepare = cacheOwnerId
      ? claimLocalSpriteCacheForCurrentOwner()
      : Promise.resolve();
    void prepare
      .then(() => {
        if (!cancelled) setPreparedCacheScope(cacheScope);
      })
      .catch((error) => {
        debugWarn('[Cache] Failed to prepare account-scoped cache:', error);
        if (!cancelled) setCacheError('Local roster storage is unavailable. Reload to retry.');
      });

    return () => {
      cancelled = true;
    };
  }, [authReady, cacheOwnerId, cacheScope]);

  const cacheReady = authReady && preparedCacheScope === cacheScope;
  const authDock = (
    <AuthDock
      isLoaded={isLoaded}
      isSignedIn={Boolean(isSignedIn)}
      displayName={user?.firstName ?? user?.username ?? 'Player'}
    />
  );

  return (
    cacheReady ? (
      <App authStatus={authStatus} authSessionKey={authSessionKey} authSlot={authDock} />
    ) : (
      <LoadingScreen label={cacheError ?? 'Loading player data...'} />
    )
  );
}

function Root() {
  const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (typeof clerkKey === 'string' && clerkKey.trim()) {
    return (
      <ClerkProvider publishableKey={clerkKey}>
        <ClerkSessionBridge />
      </ClerkProvider>
    );
  }

  configureApiAuth(null);
  return <App authStatus="local" authSessionKey="local" />;
}

createRoot(rootEl).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
