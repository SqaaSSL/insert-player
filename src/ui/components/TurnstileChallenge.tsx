import { useEffect, useRef, useState } from 'react';

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
  resetSignal: number;
  onTokenChange: (token: string | null) => void;
}

let turnstileScriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;

  const scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');

    const loaded = () => window.turnstile
      ? resolve()
      : reject(new Error('Turnstile did not initialize'));
    const failed = () => reject(new Error('Turnstile script failed to load'));

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
  resetSignal,
  onTokenChange,
}: TurnstileChallengeProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenChangeRef = useRef(onTokenChange);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    onTokenChangeRef.current = onTokenChange;
  }, [onTokenChange]);

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    onTokenChangeRef.current(null);

    if (!siteKey) {
      setLoadFailed(true);
      return undefined;
    }

    void loadTurnstileScript()
      .then(() => {
        if (cancelled || !mountRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(mountRef.current, {
          sitekey: siteKey,
          action: 'anonymous_rookie',
          theme: 'dark',
          size: 'flexible',
          appearance: 'interaction-only',
          'response-field': false,
          callback: (token) => onTokenChangeRef.current(token),
          'expired-callback': () => onTokenChangeRef.current(null),
          'error-callback': () => onTokenChangeRef.current(null),
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
  }, [siteKey]);

  useEffect(() => {
    const widgetId = widgetIdRef.current;
    if (!widgetId || !window.turnstile) return;
    onTokenChangeRef.current(null);
    window.turnstile.reset(widgetId);
  }, [resetSignal]);

  return (
    <div className="turnstile-challenge" aria-live="polite">
      <div ref={mountRef} className="turnstile-challenge__mount" />
      {loadFailed ? (
        <p className="turnstile-challenge__error" role="alert">
          Verification is unavailable. Refresh to retry.
        </p>
      ) : null}
    </div>
  );
}
