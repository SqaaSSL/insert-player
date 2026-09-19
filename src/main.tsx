import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ClerkProvider,
  useAuth,
  useClerk,
  useOrganization,
  useOrganizationList,
  useUser,
} from '@clerk/react';
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
  const { openSignIn, openSignUp } = useClerk();
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const { organization } = useOrganization();
  const organizationList = useOrganizationList({
    userMemberships: { infinite: true, pageSize: 50 },
  });
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
  const activeCrew = useMemo(() => organization ? {
    id: organization.id,
    name: organization.name,
    slug: organization.slug ?? null,
  } : null, [organization?.id, organization?.name, organization?.slug]);
  const crews = useMemo(() => (
    organizationList.userMemberships.data?.map((membership) => ({
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug ?? null,
      role: membership.role ?? null,
    })) ?? []
  ), [organizationList.userMemberships.data]);
  const createCrew = useCallback(async (name: string) => {
    if (!organizationList.isLoaded || !organizationList.createOrganization || !organizationList.setActive) {
      throw new Error('Crew setup is still loading. Try again in a moment.');
    }
    const created = await organizationList.createOrganization({ name });
    await organizationList.setActive({ organization: created.id });
    return { id: created.id, name: created.name, slug: created.slug ?? null };
  }, [organizationList.createOrganization, organizationList.isLoaded, organizationList.setActive]);
  const selectCrew = useCallback(async (organizationId: string) => {
    if (!organizationList.isLoaded || !organizationList.setActive) {
      throw new Error('Crew setup is still loading. Try again in a moment.');
    }
    await organizationList.userMemberships.revalidate();
    await organizationList.setActive({ organization: organizationId });
  }, [organizationList.isLoaded, organizationList.setActive, organizationList.userMemberships]);

  useEffect(() => {
    configureApiAuth(isLoaded && isSignedIn ? () => getToken() : null);
    return () => configureApiAuth(null);
  }, [getToken, isLoaded, isSignedIn, user?.id, organization?.id]);

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
        playerName={user?.firstName ?? user?.username ?? 'Player'}
        userImageUrl={authReady && isSignedIn ? user?.imageUrl ?? null : null}
        activeCrew={activeCrew}
        crews={crews}
        onCreateCrew={createCrew}
        onSelectCrew={selectCrew}
        authSlot={authDock}
        onSignIn={() => { clearPostSignUpTrialIntent(); void openSignIn(); }}
        onSignUp={() => { clearPostSignUpTrialIntent(); void openSignUp(); }}
        cacheStatus={cacheState.status}
        cacheMessage={cacheState.message}
        onRetryCache={() => setCacheAttempt((current) => current + 1)}
      />
    ) : (
      <LoadingScreen label={authReady ? 'Loading player data...' : 'Loading player account...'} />
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
