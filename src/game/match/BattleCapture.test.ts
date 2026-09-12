import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Phaser from 'phaser';
import { BattleCaptureSession, BATTLE_CAPTURE_EVENT, battleWinnerSide, type BattleCaptureEventDetail } from './BattleCapture.ts';
import type { BattleSummary } from '../../shared/BattleFinisher.ts';

const summary: BattleSummary = { game: 'aura', winner: 'p1', p1Name: 'Trump', p2Name: 'Lamine', stageLabel: 'Aura Plaza', durationSeconds: 45 };
let events: BattleCaptureEventDetail[];
let snapshot: ReturnType<typeof vi.fn>;
let drawImage: ReturnType<typeof vi.fn>;
let canvas: { width: number; height: number; getContext: ReturnType<typeof vi.fn>; toDataURL: ReturnType<typeof vi.fn> };
const scene = () => ({ game: { renderer: { snapshot } } }) as unknown as Phaser.Scene;
const render = (image: unknown = { src: 'data:image/jpeg;base64,c291cmNl', width: 1920, height: 1080 }) => snapshot.mock.calls[0][0](image);

beforeEach(() => {
  vi.useFakeTimers(); events = []; snapshot = vi.fn(); drawImage = vi.fn();
  const target = new EventTarget();
  target.addEventListener(BATTLE_CAPTURE_EVENT, event => events.push((event as CustomEvent).detail));
  vi.stubGlobal('window', target);
  canvas = { width: 0, height: 0, getContext: vi.fn(() => ({ drawImage })), toDataURL: vi.fn(() => 'data:image/jpeg;base64,c3RpbGw=') };
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('final battle still session', () => {
  it('waits for a rendered frame and associates one bounded JPEG with the same battle identity', async () => {
    const session = new BattleCaptureSession();
    const completion = session.capture(scene(), summary);
    const settled = vi.fn(); void completion.then(settled);
    await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    expect(events).toEqual([{ state: 'started', clientBattleId: session.clientBattleId }]);
    expect(snapshot).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
    render();
    expect(canvas).toMatchObject({ width: 1280, height: 720 });
    expect(drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 1920, 1080, 0, 0, 1280, 720);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.88);
    expect(events.at(-1)).toEqual({ state: 'ready', clientBattleId: session.clientBattleId,
      capture: { clientBattleId: session.clientBattleId, summary, stillBase64: 'data:image/jpeg;base64,c3RpbGw=' } });
    await expect(completion).resolves.toBe('ready');
    expect(session.capture(scene(), summary)).toBe(completion); render(); vi.advanceTimersByTime(10_000);
    expect(snapshot).toHaveBeenCalledOnce(); expect(events).toHaveLength(2);
  });
  it('preserves portrait framing without enlarging small canvases', () => {
    const session = new BattleCaptureSession(); session.capture(scene(), summary);
    render({ src: 'data:image/jpeg;base64,c291cmNl', width: 576, height: 1024 });
    expect(canvas).toMatchObject({ width: 576, height: 1024 });
  });
  it('can omit the empty retired instrument while retaining the entire portrait stage', () => {
    const session = new BattleCaptureSession(); session.capture(scene(), summary, { heightRatio: 524 / 1024 });
    render({ src: 'data:image/jpeg;base64,c291cmNl', width: 576, height: 1024 });
    expect(canvas).toMatchObject({ width: 576, height: 524 });
    expect(drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 576, 524, 0, 0, 576, 524);
  });
  it('cannot attach a late frame or timer from a cancelled match to its replacement', async () => {
    const first = new BattleCaptureSession(); const completion = first.capture(scene(), summary); first.cancel();
    await expect(completion).resolves.toBe('cancelled');
    const second = new BattleCaptureSession();
    expect(second.clientBattleId).not.toBe(first.clientBattleId);
    render(); vi.advanceTimersByTime(10_000); first.capture(scene(), summary);
    expect(events.map(event => event.state)).toEqual(['started', 'started']);
    expect(drawImage).not.toHaveBeenCalled(); expect(snapshot).toHaveBeenCalledOnce();
  });
  it('reports unavailable once on a missing render and ignores a late success', async () => {
    const session = new BattleCaptureSession(); const completion = session.capture(scene(), summary);
    vi.advanceTimersByTime(8_000); render();
    await expect(completion).resolves.toBe('unavailable');
    expect(events.map(event => event.state)).toEqual(['started', 'unavailable']);
    expect(drawImage).not.toHaveBeenCalled();
  });
  it('settles cancellation before capture and never replaces a completed outcome', async () => {
    const cancelled = new BattleCaptureSession(); cancelled.cancel();
    await expect(cancelled.capture(scene(), summary)).resolves.toBe('cancelled');
    expect(snapshot).not.toHaveBeenCalled();
    const ready = new BattleCaptureSession(); const completion = ready.capture(scene(), summary); render(); ready.cancel();
    await expect(completion).resolves.toBe('ready');
    expect(events.map(event => event.state)).toEqual(['started', 'started', 'ready']);
  });
  it.each([{ r: 0, g: 0, b: 0 }, { src: '', width: 0, height: 0 }])('rejects invalid snapshot results', image => {
    const session = new BattleCaptureSession(); session.capture(scene(), summary); render(image);
    expect(events.at(-1)?.state).toBe('unavailable');
  });
  it('keeps a renderer or tainted-canvas failure local without throwing or retrying', () => {
    snapshot.mockImplementationOnce(() => { throw new Error('renderer gone'); });
    const first = new BattleCaptureSession(); expect(() => first.capture(scene(), summary)).not.toThrow();
    expect(events.at(-1)?.state).toBe('unavailable');
    snapshot.mockReset(); canvas.toDataURL.mockImplementation(() => { throw new Error('tainted'); });
    const second = new BattleCaptureSession(); second.capture(scene(), summary); render();
    expect(events.at(-1)?.state).toBe('unavailable');
    vi.advanceTimersByTime(10_000);
    expect(events.filter(event => event.state === 'unavailable')).toHaveLength(2);
  });
});

describe('physical winner side', () => {
  it('uses visible group positions and omits ambiguous, missing or invalid geometry', () => {
    expect(battleWinnerSide([700, 820], [250, 400])).toBe('right');
    expect(battleWinnerSide([100, 240], [700, 820])).toBe('left');
    for (const [winners, losers] of [[[240], [240]], [[240, 800], [500]], [[], [500]], [[240], []], [[NaN], [500]]]) {
      expect(battleWinnerSide(winners, losers)).toBeUndefined();
    }
  });
});
