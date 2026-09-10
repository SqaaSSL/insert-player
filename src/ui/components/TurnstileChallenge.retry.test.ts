import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
let load: typeof import('./TurnstileChallenge.tsx')['loadTurnstileScript'];
let current: FakeScript | null;
let scripts: FakeScript[];
class FakeScript extends EventTarget {
  id = ''; src = ''; async = false; defer = false;
  remove = vi.fn(() => { if (current === this) current = null; });
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules();
  current = null; scripts = [];
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', {
    getElementById: () => current,
    createElement: () => new FakeScript(),
    head: { append: (script: FakeScript) => { current = script; scripts.push(script); } },
  });
  load = (await import('./TurnstileChallenge.tsx')).loadTurnstileScript;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('Turnstile recovery without losing the recording', () => {
  it('removes an errored script and loads a fresh one on retry without page navigation', async () => {
    const first = load(); const rejected = expect(first).rejects.toThrow('failed to load');
    const failed = current!; failed.dispatchEvent(new Event('error')); await rejected;
    expect(failed.remove).toHaveBeenCalledTimes(1); expect(current).toBeNull();
    const second = load(); const retry = current!;
    expect(scripts).toHaveLength(2); expect(retry).not.toBe(failed);
    window.turnstile = { render: vi.fn(), remove: vi.fn(), reset: vi.fn() };
    retry.dispatchEvent(new Event('load')); await second;
    expect(retry.remove).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('also removes a loaded script whose API failed to initialize', async () => {
    const first = load(); const rejected = expect(first).rejects.toThrow('failed to load');
    current!.dispatchEvent(new Event('load')); await rejected;
    expect(current).toBeNull();
    const retry = load(); expect(scripts).toHaveLength(2);
    window.turnstile = { render: vi.fn(), remove: vi.fn(), reset: vi.fn() };
    current!.dispatchEvent(new Event('load')); await retry;
  });
  it('bounds a stalled script load and permits retry in the same page', async () => {
    const pending = load(); const rejected = expect(pending).rejects.toThrow('failed to load');
    await vi.advanceTimersByTimeAsync(15_000); await rejected;
    expect(current).toBeNull();
    const retry = load(); expect(scripts).toHaveLength(2);
    window.turnstile = { render: vi.fn(), remove: vi.fn(), reset: vi.fn() };
    current!.dispatchEvent(new Event('load')); await retry;
  });
});
