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
  it('uses the existing song lead-in for the versus and three beat count-in ending at the first actual hit without advancing the chart', () => {
    const startup = new AuraStartup(false, { firstNoteMs: 3_566, beatMs: 400 });
    startup.syncMusic(30_000);
    expect(startup.snapshot.phase).toBe('preparing');
    startup.begin();
    expect(startup.snapshot).toEqual({ phase: 'versus', remainingMs: 2_366, count: null });
    startup.advance(60_000);
    expect(startup.snapshot.remainingMs).toBe(2_366);
    startup.syncMusic(2_365);
    expect(startup.snapshot.phase).toBe('versus');
    for (const [elapsed, count] of [[2_366, 3], [2_766, 2], [3_166, 1]]) {
      startup.syncMusic(elapsed);
      expect(startup.snapshot).toEqual({ phase: 'countdown', remainingMs: 3_566 - elapsed, count });
    }
    startup.syncMusic(3_566);
    expect(startup.snapshot).toEqual({ phase: 'playing', remainingMs: 0, count: null });
  });

  it('freezes musical presentation on absent/invalid or backwards samples without replaying old counts', () => {
    const startup = new AuraStartup(false, { firstNoteMs: 3_000, beatMs: 400 });
    startup.begin(); startup.syncMusic(2_300);
    const frozen = startup.snapshot;
    for (const elapsed of [NaN, Infinity, -1, 0, 2_299]) startup.syncMusic(elapsed);
    startup.advance(60_000);
    expect(startup.snapshot).toEqual(frozen);
    startup.syncMusic(10_000);
    expect(startup.snapshot.phase).toBe('playing');
    startup.syncMusic(0);
    expect(startup.snapshot.phase).toBe('playing');
  });

  it('keeps the network deadline authoritative even if a musical lead-in is supplied', () => {
    const startup = new AuraStartup(true, { firstNoteMs: 3_000, beatMs: 400 });
    startup.begin(); startup.syncMusic(30_000);
    expect(startup.snapshot).toEqual({ phase: 'versus', remainingMs: 1_500, count: null });
    for (let frame = 0; frame < 15; frame += 1) startup.advance(100);
    expect(startup.readyForOnline).toBe(true);
    startup.countdown(2_500); startup.syncMusic(30_000);
    expect(startup.snapshot).toEqual({ phase: 'countdown', remainingMs: 2_500, count: 3 });
  });

  it.each([
    { firstNoteMs: NaN, beatMs: 400 }, { firstNoteMs: 3_000, beatMs: 0 },
    { firstNoteMs: 3_000, beatMs: Infinity }, { firstNoteMs: 100, beatMs: 400 },
  ])('falls back to the ready sequence for invalid musical timing %o', leadIn => {
    const startup = new AuraStartup(false, leadIn);
    startup.begin(); startup.syncMusic(30_000);
    expect(startup.snapshot).toEqual({ phase: 'versus', remainingMs: 1_500, count: null });
    for (let frame = 0; frame < 15; frame += 1) startup.advance(100);
    expect(startup.snapshot).toEqual({ phase: 'countdown', remainingMs: 3_000, count: 3 });
  });

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
