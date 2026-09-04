import { apiUrl } from './ApiClient.ts';
import { getDebugLogLines } from './DebugLog.ts';

const MAX_REPORTS_PER_SESSION = 3;
const DEBUG_TAIL_LINES = 20;

let installed = false;
let reportsSent = 0;
const reportedMessages = new Set<string>();

interface CrashPayload {
  message: string;
  stack?: string;
  route: string;
  debugTail?: string;
  appContext?: string;
  userAgent?: string;
}

function buildPayload(message: string, stack: string | undefined, kind: string): CrashPayload {
  return {
    message: message.slice(0, 600),
    stack: stack?.slice(0, 4000),
    route: window.location.pathname.slice(0, 120),
    debugTail: getDebugLogLines().slice(-DEBUG_TAIL_LINES).join('\n').slice(0, 4000) || undefined,
    appContext: `${kind} · ${import.meta.env.MODE}`,
    userAgent: navigator.userAgent.slice(0, 300),
  };
}

function send(payload: CrashPayload): void {
  if (reportsSent >= MAX_REPORTS_PER_SESSION) return;
  if (reportedMessages.has(payload.message)) return;
  reportedMessages.add(payload.message);
  reportsSent += 1;
  try {
    // keepalive lets the report survive a page teardown mid-crash; failures
    // are swallowed — crash reporting must never cause its own errors.
    void fetch(apiUrl('/api/client-errors'), {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    // Ignore: reporting is best-effort only.
  }
}

/** Global first-party crash reporter. Bounded, throttled, no user content. */
export function installCrashReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    const error = event.error instanceof Error ? event.error : null;
    const message = error?.message ?? String(event.message ?? 'Unknown script error');
    send(buildPayload(message, error?.stack, 'window.error'));
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const error = reason instanceof Error ? reason : null;
    const message = error?.message ?? (typeof reason === 'string' ? reason : 'Unhandled promise rejection');
    send(buildPayload(message, error?.stack, 'unhandledrejection'));
  });
}
