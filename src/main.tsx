import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider, useAuth, useUser } from '@clerk/react';
import { App } from './ui/App.tsx';
import { AuthDock } from './ui/components/AuthDock.tsx';
import { LoadingScreen } from './ui/components/LoadingScreen.tsx';
import { resolveAuthBootstrapMode, type AuthStatus } from './ui/authState.ts';
import { configureApiAuth } from './services/ApiClient.ts';
import {
  claimLocalSpriteCacheForCurrentOwner,
  configureSpriteCacheOwner,
  spriteCacheScopeForOwner,
} from './services/SpriteCache.ts';
import { debugWarn } from './services/DebugLog.ts';
import { installCrashReporting } from './services/CrashReporting.ts';
import {
  clearPostSignUpTrialIntent,
  isNewAccountForOnboarding,
  rememberPostSignUpTrialIntent,
} from './ui/shared/onboardingFlow.ts';
import '@fontsource/press-start-2p/latin-400.css';
import '@fontsource/space-grotesk/latin-400.css';
import '@fontsource/space-grotesk/latin-500.css';
import '@fontsource/space-grotesk/latin-700.css';
import './ui/styles.css';

installCrashReporting();

const CACHE_PREPARE_TIMEOUT_MS = 3_000;
interface CachePreparationState {
  scope: string | null;
  status: 'pending' | 'ready' | 'degraded';
  bootstrapped: boolean;
  message: string | null;
}

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
  const isNewAccount = Boolean(
    authReady
    && isSignedIn
    && isNewAccountForOnboarding(user?.createdAt),
  );
  const cacheScope = spriteCacheScopeForOwner(cacheOwnerId);
  const [cacheAttempt, setCacheAttempt] = useState(0);
  const [cacheState, setCacheState] = useState<CachePreparationState>({
    scope: null,
    status: 'pending',
    bootstrapped: false,
    message: null,
  });

  useEffect(() => {
    configureApiAuth(isLoaded && isSignedIn ? () => getToken() : null);
    return () => configureApiAuth(null);
  }, [getToken, isLoaded, isSignedIn]);

  useEffect(() => {
    let cancelled = false;
    if (!authReady) return () => { cancelled = true; };

    setCacheState((current) => ({
      scope: cacheScope,
      status: 'pending',
      bootstrapped: current.scope === cacheScope && current.bootstrapped,
      message: current.scope === cacheScope && current.bootstrapped
        ? 'Trying local roster storage again...'
        : null,
    }));

    configureSpriteCacheOwner(cacheOwnerId);
    const prepare = cacheOwnerId
      ? claimLocalSpriteCacheForCurrentOwner()
      : Promise.resolve();
    const timeout = window.setTimeout(() => {
      if (cancelled) return;
      setCacheState({
        scope: cacheScope,
        status: 'degraded',
        bootstrapped: true,
        message: 'Local storage took too long to respond. Cloud and public pages remain available.',
      });
    }, CACHE_PREPARE_TIMEOUT_MS);
    void prepare
      .then(() => {
        if (cancelled) return;
        window.clearTimeout(timeout);
        setCacheState({
          scope: cacheScope,
          status: 'ready',
          bootstrapped: true,
          message: null,
        });
      })
      .catch((error) => {
        debugWarn('[Cache] Failed to prepare account-scoped cache:', error);
        if (cancelled) return;
        window.clearTimeout(timeout);
        setCacheState({
          scope: cacheScope,
          status: 'degraded',
          bootstrapped: true,
          message: 'Local roster storage could not open. Cloud and public pages remain available.',
        });
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [authReady, cacheAttempt, cacheOwnerId, cacheScope]);

  const cacheBootstrapped = authReady && cacheState.scope === cacheScope && cacheState.bootstrapped;
  const authDock = (
    <AuthDock
      isLoaded={isLoaded}
      isSignedIn={Boolean(isSignedIn)}
      displayName={user?.firstName ?? user?.username ?? 'Player'}
      onBeginSignIn={clearPostSignUpTrialIntent}
      onBeginSignUp={rememberPostSignUpTrialIntent}
    />
  );

  return (
    cacheBootstrapped ? (
      <App
        authStatus={authStatus}
        authSessionKey={authSessionKey}
        isNewAccount={isNewAccount}
        userImageUrl={authReady && isSignedIn ? user?.imageUrl ?? null : null}
        authSlot={authDock}
        cacheStatus={cacheState.status}
        cacheMessage={cacheState.message}
        onRetryCache={() => setCacheAttempt((current) => current + 1)}
      />
    ) : (
      <>
        {authDock}
        <LoadingScreen label={authReady ? 'Loading player data...' : 'Loading player account...'} />
      </>
    )
  );
}

function Root() {
  const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  const mode = resolveAuthBootstrapMode(clerkKey, import.meta.env.DEV);
  if (mode === 'clerk') {
    return (
      <ClerkProvider publishableKey={String(clerkKey).trim()}>
        <ClerkSessionBridge />
      </ClerkProvider>
    );
  }

  configureApiAuth(null);
  if (mode === 'local-dev') {
    return <App authStatus="local" authSessionKey="local" />;
  }
  return (
    <App
      authStatus="signed-out"
      authSessionKey="auth-misconfigured"
      configurationError="This production build is missing its Clerk publishable key. Account, roster, billing, and fight actions are disabled until the deployment is fixed."
    />
  );
}

createRoot(rootEl).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
