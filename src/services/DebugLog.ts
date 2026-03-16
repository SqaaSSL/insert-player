const DEBUG_EVENT_NAME = 'asf-debug-log';
const MAX_DEBUG_LINES = 40;

declare global {
  interface Window {
    __ASF_DEBUG_LINES__?: string[];
  }
}

function getDebugStore(): string[] {
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
  window.dispatchEvent(new CustomEvent(DEBUG_EVENT_NAME, { detail: message }));
}

export function clearDebugLog(): void {
  window.__ASF_DEBUG_LINES__ = [];
  window.dispatchEvent(new CustomEvent(DEBUG_EVENT_NAME, { detail: '' }));
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
