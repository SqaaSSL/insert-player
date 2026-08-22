const DEBUG_EVENT_NAME = 'asf-debug-log';
const MAX_DEBUG_LINES = 40;
const serverDebugLines: string[] = [];

declare global {
  interface Window {
    __ASF_DEBUG_LINES__?: string[];
    __ASF_DEBUG_LOGS__?: boolean;
  }
}

function isDebugLoggingEnabled(): boolean {
  const metaEnv = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
  if (metaEnv?.DEV) return true;
  try {
    return typeof window !== 'undefined' && (
      window.__ASF_DEBUG_LOGS__ === true || window.localStorage.getItem('asf:debug') === '1'
    );
  } catch {
    return false;
  }
}

export function debugInfo(message: string, ...args: unknown[]): void {
  if (isDebugLoggingEnabled()) {
    console.info(message, ...args);
  }
}

export function debugWarn(message: string, ...args: unknown[]): void {
  if (isDebugLoggingEnabled()) {
    console.warn(message, ...args);
  }
}

function getDebugStore(): string[] {
  if (typeof window === 'undefined') return serverDebugLines;
  if (!window.__ASF_DEBUG_LINES__) {
    window.__ASF_DEBUG_LINES__ = [];
  }
  return window.__ASF_DEBUG_LINES__;
}

export function publishDebugLog(message: string): void {
  const store = getDebugStore();
  store.push(message);
  if (store.length > MAX_DEBUG_LINES) {
    store.splice(0, store.length - MAX_DEBUG_LINES);
  }
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DEBUG_EVENT_NAME, { detail: message }));
  }
}

export function clearDebugLog(): void {
  if (typeof window === 'undefined') {
    serverDebugLines.length = 0;
    return;
  }
  window.__ASF_DEBUG_LINES__ = [];
  if (typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DEBUG_EVENT_NAME, { detail: '' }));
  }
}

export function publishDebugMultiline(message: string): void {
  for (const line of message.split('\n')) {
    publishDebugLog(line);
  }
}

export function getDebugLogLines(): string[] {
  return getDebugStore().slice();
}

export { DEBUG_EVENT_NAME };
