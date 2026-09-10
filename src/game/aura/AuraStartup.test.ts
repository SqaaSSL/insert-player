import { describe, expect, it, vi } from 'vitest';
import { AuraStartup, isAuraStartupDetail, waitForAuraRenderedFrames } from './AuraStartup.ts';

class RenderEmitter {
  private listeners = new Map<string, Set<() => void>>();
  on(event: string, listener: () => void): void {
    const group = this.listeners.get(event) ?? new Set();
    group.add(listener); this.listeners.set(event, group);
  }
  off(event: string, listener: () => void): void { this.listeners.get(event)?.delete(listener); }
  emit(event: string): void { for (const listener of [...this.listeners.get(event) ?? []]) listener(); }
  listenerCount(event: string): number { return this.listeners.get(event)?.size ?? 0; }
}

describe('Aura preparation timeline', () => {
  it('keeps the full versus and all three seconds before allowing the song to start', () => {
    const startup = new AuraStartup();
    startup.advance(60_000);
    expect(startup.snapshot.phase).toBe('preparing');
    startup.begin();
    for (let frame = 0; frame < 15; frame += 1) startup.advance(100);
    expect(startup.snapshot).toEqual({ phase: 'countdown', count: 3, remainingMs: 3_000 });
    for (const count of [2, 1]) {
      for (let frame = 0; frame < 10; frame += 1) startup.advance(100);
      expect(startup.snapshot.count).toBe(count);
    }
    startup.advance(30_000); // One delayed render must not swallow the rest.
    expect(startup.snapshot.phase).toBe('countdown');
    for (let frame = 0; frame < 9; frame += 1) startup.advance(100);
    expect(startup.snapshot).toEqual({ phase: 'playing', count: null, remainingMs: 0 });
  });

  it('does not start online time locally or add an extra countdown to the shared deadline', () => {
    const startup = new AuraStartup(true);
    startup.begin();
    for (let frame = 0; frame < 15; frame += 1) startup.advance(100);
    expect(startup.readyForOnline).toBe(true);
    startup.advance(60_000);
    expect(startup.snapshot.phase).toBe('preparing');
    startup.countdown(2_940); // Shared 3s deadline minus transport latency.
    startup.advance(10_000);
    expect(startup.snapshot.remainingMs).toBe(2_940);
    startup.countdown(990);
    expect(startup.snapshot.count).toBe(1);
    startup.play();
    expect(startup.snapshot.phase).toBe('playing');
  });

  it('requires actual postrender events and cancels obsolete lifecycle waiters', async () => {
    const events = new RenderEmitter();
    const abort = new AbortController();
    const completed = vi.fn();
    const ready = waitForAuraRenderedFrames(events, abort.signal).then(completed);
    events.emit('update'); events.emit('postrender');
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    events.emit('postrender');
    await ready;
    expect(completed).toHaveBeenCalledWith(true);
    expect(events.listenerCount('postrender')).toBe(0);
    const cancelled = waitForAuraRenderedFrames(events, abort.signal);
    abort.abort();
    await expect(cancelled).resolves.toBe(false);
    expect(events.listenerCount('postrender')).toBe(0);
  });

  it('validates current-token startup states without accepting malformed countdowns', () => {
    const state = { token: 8, seed: 67, phase: 'awaiting-input', remainingMs: 0, count: null };
    expect(isAuraStartupDetail(state)).toBe(true);
    expect(isAuraStartupDetail({ ...state, phase: 'countdown', count: 3 })).toBe(true);
    for (const patch of [{ token: 0 }, { seed: -1 }, { phase: 'loaded' }, { remainingMs: Infinity }, { count: 4 }]) {
      expect(isAuraStartupDetail({ ...state, ...patch })).toBe(false);
    }
  });
});
