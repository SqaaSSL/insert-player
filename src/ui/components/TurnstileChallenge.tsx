import { useCallback, useEffect, useRef, useState } from 'react';

const TURNSTILE_SCRIPT_ID = 'cloudflare-turnstile-script';
const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileRenderOptions {
  sitekey: string;
  action: string;
  theme: 'dark';
  size: 'flexible';
  appearance: 'interaction-only';
  'response-field': false;
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': () => void;
}

interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

interface TurnstileChallengeProps {
  siteKey: string;
  action?: 'anonymous_rookie' | 'aura_share';
  resetSignal: number;
  onTokenChange: (token: string | null) => void;
}

let turnstileScriptPromise: Promise<void> | null = null;

export function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;

  const scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');

    let deadline: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(deadline);
      script.removeEventListener('load', loaded);
      script.removeEventListener('error', failed);
    };
    const failed = () => {
      cleanup();
      script.remove();
      reject(new Error('Turnstile script failed to load'));
    };
    const loaded = () => {
      if (!window.turnstile) { failed(); return; }
      cleanup(); resolve();
    };
    deadline = setTimeout(failed, 15_000);

    script.addEventListener('load', loaded, { once: true });
    script.addEventListener('error', failed, { once: true });
    if (!existing) {
      script.id = TURNSTILE_SCRIPT_ID;
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
  }).catch((error) => {
    turnstileScriptPromise = null;
    throw error;
  });
  turnstileScriptPromise = scriptPromise;

  return scriptPromise;
}

export function TurnstileChallenge({
  siteKey,
  action = 'anonymous_rookie',
  resetSignal,
  onTokenChange,
}: TurnstileChallengeProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenChangeRef = useRef(onTokenChange);
  const [loadFailed, setLoadFailed] = useState(false);
  const [responseToken, setResponseToken] = useState('');
  const [retry, setRetry] = useState(0);

  const publishToken = useCallback((token: string | null) => {
    setResponseToken(token ?? '');
    onTokenChangeRef.current(token);
  }, []);

  useEffect(() => {
    onTokenChangeRef.current = onTokenChange;
  }, [onTokenChange]);

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    publishToken(null);

    if (!siteKey) {
      setLoadFailed(true);
      return undefined;
    }

    void loadTurnstileScript()
      .then(() => {
        if (cancelled || !mountRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(mountRef.current, {
          sitekey: siteKey,
          action,
          theme: 'dark',
          size: 'flexible',
          appearance: 'interaction-only',
          'response-field': false,
          callback: publishToken,
          'expired-callback': () => publishToken(null),
          'error-callback': () => { publishToken(null); setLoadFailed(true); },
        });
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });

    return () => {
      cancelled = true;
      const widgetId = widgetIdRef.current;
      widgetIdRef.current = null;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
      onTokenChangeRef.current(null);
    };
  }, [publishToken, siteKey, action, retry]);

  useEffect(() => {
    const widgetId = widgetIdRef.current;
    if (!widgetId || !window.turnstile) return;
    publishToken(null);
    window.turnstile.reset(widgetId);
  }, [publishToken, resetSignal]);

  return (
    <div className="turnstile-challenge" aria-live="polite">
      <div ref={mountRef} className="turnstile-challenge__mount" />
      <input
        type="hidden"
        name="cf-turnstile-response"
        value={responseToken}
        readOnly
      />
      {loadFailed ? (
        <div className="turnstile-challenge__error">
          <p role="alert">Verification could not load. Retry here to keep your progress.</p>
          <button className="asf-btn" type="button" onClick={() => setRetry(value => value + 1)}>Retry verification</button>
        </div>
      ) : null}
    </div>
  );
}
