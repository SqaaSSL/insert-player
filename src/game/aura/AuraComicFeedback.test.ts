import { describe, expect, it, vi } from 'vitest';

vi.mock('phaser', () => ({ default: {} }));
vi.mock('./AuraComicArt.ts', () => ({ drawAuraComicIcon: vi.fn() }));

import { AuraComicFeedback, AURA_COMIC_COPY, AURA_COMIC_LAYOUT } from './AuraComicFeedback.ts';
import { drawAuraComicIcon } from './AuraComicArt.ts';
import { CREAM, HEAT, INK, PIXEL_FONT } from '../ui/CabinetGraphics.ts';
import { auraComicAnchor, createAuraLayout } from './AuraLayout.ts';

function textObject(x: number, y: number, value: string, textOptions: Record<string, unknown>) {
  const object = { x, y, value, textOptions,
    setOrigin: vi.fn().mockReturnThis(), setText: vi.fn(), setColor: vi.fn() };
  object.setText.mockImplementation((next: string) => { object.value = next; return object; });
  object.setColor.mockImplementation((next: string) => { object.textOptions.color = next; return object; });
  return object;
}

function container(x: number, y: number) {
  const object = {
    x, y, alpha: 1, children: [] as unknown[],
    add: vi.fn(), setY: vi.fn(), setAlpha: vi.fn(), destroy: vi.fn(),
  };
  object.add.mockImplementation((children: unknown) => {
    object.children.push(...(Array.isArray(children) ? children : [children]));
    return object;
  });
  object.setY.mockImplementation((value: number) => { object.y = value; return object; });
  object.setAlpha.mockImplementation((value: number) => { object.alpha = value; return object; });
  return object;
}

function graphics() {
  return Object.fromEntries(['fillStyle', 'fillRoundedRect', 'lineStyle', 'strokeRoundedRect',
    'fillTriangle', 'lineBetween', 'setPosition'].map(name => [name, vi.fn().mockReturnThis()]));
}

function harness(reduceMotion = false) {
  const onMove = vi.fn();
  const objects: ReturnType<typeof container>[] = [];
  const drawings: ReturnType<typeof graphics>[] = [];
  const texts: ReturnType<typeof textObject>[] = [];
  const timers: { duration: number; callback: () => void; remove: ReturnType<typeof vi.fn> }[] = [];
  const layer = container(0, 0);
  const scene = {
    add: {
      container: (x: number, y: number) => { const object = container(x, y); objects.push(object); return object; },
      graphics: () => { const drawing = graphics(); drawings.push(drawing); return drawing; },
      text: (x: number, y: number, value: string, textOptions: Record<string, unknown>) => {
        const text = textObject(x, y, value, textOptions);
        texts.push(text); return text;
      },
    },
    time: { delayedCall: vi.fn((duration: number, callback: () => void) => {
      const timer = { duration, callback, remove: vi.fn() }; timers.push(timer); return timer;
    }) },
    tweens: { add: vi.fn(), killTweensOf: vi.fn() },
  };
  const feedback = new AuraComicFeedback(
    scene as unknown as ConstructorParameters<typeof AuraComicFeedback>[0],
    layer as unknown as ConstructorParameters<typeof AuraComicFeedback>[1],
    reduceMotion,
    onMove,
  );
  return { feedback, scene, layer, objects, drawings, texts, timers, onMove };
}

describe('Aura comic feedback', () => {
  it('sounds only a newly shown move, never repeated notes, hidden feedback, expiry or a streak', () => {
    const h = harness();
    h.feedback.move(0, 'aura_glide');
    for (let note = 0; note < 12; note++) h.feedback.move(0, 'aura_glide');
    h.feedback.milestone(0, 10);
    h.feedback.judgement(0, true); h.feedback.judgement(0, true);
    expect(h.onMove.mock.calls).toEqual([['aura_glide']]);
    h.timers[0].callback();
    h.feedback.move(0, 'aura_glide');
    expect(h.onMove).toHaveBeenCalledOnce();
    h.feedback.setSlotVisible(1, false);
    h.feedback.move(1, 'aura_six_seven');
    expect(h.onMove).toHaveBeenCalledOnce();
    h.feedback.move(0, 'aura_one_leg');
    h.feedback.beginTurn();
    h.feedback.move(0, 'aura_one_leg');
    expect(h.onMove.mock.calls).toEqual([['aura_glide'], ['aura_one_leg'], ['aura_one_leg']]);
  });

  it('supports shorter per-slot flights with disjoint desktop move/streak/body bands, preserving other defaults', () => {
    const h = harness();
    h.feedback.setAnchor(0, { x: 196, moveY: 140, streakY: 198, moveRise: 8, streakRise: 8 });
    h.feedback.move(0, 'aura_glide'); h.feedback.milestone(0, 10);
    h.feedback.move(1, 'aura_glide'); h.feedback.milestone(1, 10);
    const flights = h.scene.tweens.add.mock.calls.filter(([config]) => 'y' in config).map(([config]) => config);
    expect(flights.map(config => config.y)).toEqual([132, 190, 168, 106]);
    const bands = h.objects.slice(0, 2).map((object, index) => {
      const halfHeight = (index === 0 ? AURA_COMIC_LAYOUT.moveHeight : AURA_COMIC_LAYOUT.streakHeight) / 2;
      return { top: flights[index].y - halfHeight, bottom: object.y + halfHeight };
    });
    expect(bands).toEqual([{ top: 95, bottom: 177 }, { top: 178, bottom: 210 }]);
    expect(bands[0].top).toBeGreaterThan(92);
    expect(bands[0].bottom).toBeLessThan(bands[1].top);
    expect(bands[1].bottom).toBeLessThan(212);
  });

  it.each(['moveRise', 'streakRise'] as const)('resets a changed %s even at the same anchor, but not an equivalent repeated setting', key => {
    const h = harness();
    const anchor = { x: 196, moveY: 140, streakY: 198 };
    h.feedback.setAnchor(0, anchor);
    h.feedback.move(0, 'aura_glide'); h.feedback.milestone(0, 10);
    h.feedback.setAnchor(0, { ...anchor, moveRise: 24, streakRise: 12 });
    expect(h.objects[0].destroy).not.toHaveBeenCalled();
    h.feedback.setAnchor(0, { ...anchor, [key]: 8 });
    expect(h.objects[0].destroy).toHaveBeenCalledOnce();
    expect(h.objects[1].destroy).toHaveBeenCalledOnce();
    h.feedback.move(0, 'aura_glide');
    h.feedback.setAnchor(0, { ...anchor, [key]: 8 });
    expect(h.objects[2].destroy).not.toHaveBeenCalled();
    h.feedback.setAnchor(0, anchor); // Removing an override restores the default flight.
    expect(h.objects[2].destroy).toHaveBeenCalledOnce();
    h.feedback.move(0, 'aura_glide'); h.feedback.milestone(0, 10);
    const flights = h.scene.tweens.add.mock.calls.filter(([config]) => 'y' in config).map(([config]) => config.y);
    expect(flights.slice(-2)).toEqual([116, 186]);
  });

  it('honors zero flight distances without changing fade, duration or reduced-motion behavior', () => {
    for (const reduced of [false, true]) {
      const h = harness(reduced);
      h.feedback.setAnchor(0, { x: 196, moveY: 140, streakY: 198, moveRise: 0, streakRise: 0 });
      h.feedback.move(0, 'aura_glide'); h.feedback.milestone(0, 10);
      expect(h.timers.map(timer => timer.duration)).toEqual([1_800, 1_300]);
      const flights = h.scene.tweens.add.mock.calls.filter(([config]) => 'y' in config).map(([config]) => config.y);
      expect(flights).toEqual(reduced ? [] : [140, 198]);
    }
  });

  it('uses independent configured safe-zone anchors without inheriting camera or fighter positions', () => {
    const h = harness();
    const desktop = { x: 300, moveY: 140, streakY: 104 };
    h.feedback.setAnchor(0, desktop);
    h.feedback.setAnchor(1, { x: 400, moveY: 240, streakY: 180 });
    desktop.x = 999; // Caller mutation cannot move a stored layout.
    h.feedback.move(0, 'aura_glide'); h.feedback.milestone(0, 10);
    h.feedback.move(1, 'aura_glide'); h.feedback.milestone(1, 10);
    expect(h.objects.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 300, y: 140 }, { x: 300, y: 104 },
      { x: 400, y: 240 }, { x: 400, y: 180 },
    ]);
    expect(h.scene.tweens.add.mock.calls.filter(([config]) => 'y' in config).map(([config]) => config.y))
      .toEqual([116, 92, 216, 168]);
  });

  it('retires only a changed layout slot instead of flying its old bubbles across the stage', () => {
    const h = harness();
    h.feedback.move(0, 'aura_glide'); h.feedback.milestone(0, 10);
    h.feedback.move(1, 'aura_glide');
    h.feedback.setAnchor(0, { x: AURA_COMIC_LAYOUT.x[0], moveY: AURA_COMIC_LAYOUT.moveY, streakY: AURA_COMIC_LAYOUT.streakY });
    expect(h.objects[0].destroy).not.toHaveBeenCalled();
    h.feedback.setAnchor(0, { x: 300, moveY: 140, streakY: 104 });
    expect(h.objects[0].destroy).toHaveBeenCalledOnce();
    expect(h.objects[1].destroy).toHaveBeenCalledOnce();
    expect(h.objects[2].destroy).not.toHaveBeenCalled();
    h.feedback.move(0, 'aura_glide');
    expect(h.objects[3]).toMatchObject({ x: 300, y: 140 });
    h.timers[0].callback();
    expect(h.objects[3].destroy).not.toHaveBeenCalled();
  });

  it('hides and resets an inactive slot and ignores late moves, milestones and missed-key accumulation', () => {
    const h = harness();
    h.feedback.move(0, 'aura_glide'); h.feedback.milestone(0, 10);
    h.feedback.move(1, 'aura_glide');
    h.feedback.judgement(0, true);
    h.feedback.setSlotVisible(0, false);
    for (const index of [0, 1]) {
      expect(h.objects[index].destroy).toHaveBeenCalledOnce();
      expect(h.timers[index].remove).toHaveBeenCalledExactlyOnceWith(false);
      expect(h.scene.tweens.killTweensOf).toHaveBeenCalledWith(h.objects[index]);
    }
    expect(h.objects[2].destroy).not.toHaveBeenCalled();
    h.feedback.move(0, 'aura_one_leg'); h.feedback.milestone(0, 20);
    for (let index = 0; index < 10; index += 1) h.feedback.judgement(0, true);
    expect(h.objects).toHaveLength(3);
    h.feedback.setSlotVisible(0, false); // Idempotent.
    h.feedback.setSlotVisible(0, true);
    expect(h.objects).toHaveLength(3); // No automatic replay.
    h.feedback.move(0, 'aura_glide');
    h.feedback.judgement(0, true);
    expect(h.objects).toHaveLength(4); // Failures from the previous turn are gone.
    h.feedback.judgement(0, true);
    expect(h.objects).toHaveLength(5);
    h.timers[0].callback();
    expect(h.objects[3].destroy).not.toHaveBeenCalled();
  });

  it('preserves configured anchors and waiting-seat visibility across turn cleanup', () => {
    const h = harness(true);
    h.feedback.setAnchor(1, { x: 400, moveY: 240, streakY: 180 });
    h.feedback.setSlotVisible(0, false);
    h.feedback.move(1, 'aura_glide');
    h.feedback.beginTurn();
    h.feedback.move(0, 'aura_glide');
    h.feedback.move(1, 'aura_glide');
    expect(h.objects).toHaveLength(2);
    expect(h.objects[1]).toMatchObject({ x: 400, y: 240 });
    expect(h.scene.tweens.add).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -Infinity])('rejects a non-finite anchor (%s) atomically', invalid => {
    const h = harness();
    h.feedback.move(0, 'aura_glide');
    for (const key of ['x', 'moveY', 'streakY', 'moveRise', 'streakRise']) {
      expect(() => h.feedback.setAnchor(0, { x: 300, moveY: 140, streakY: 104, [key]: invalid })).toThrow(RangeError);
    }
    expect(h.objects[0].destroy).not.toHaveBeenCalled();
    h.feedback.milestone(0, 10);
    expect(h.objects[1]).toMatchObject({ x: AURA_COMIC_LAYOUT.x[0], y: AURA_COMIC_LAYOUT.streakY });
  });

  it('rejects negative flight overrides without retiring a valid bubble', () => {
    const h = harness();
    h.feedback.move(0, 'aura_glide');
    for (const key of ['moveRise', 'streakRise']) {
      expect(() => h.feedback.setAnchor(0, { x: 196, moveY: 140, streakY: 198, [key]: -1 })).toThrow(RangeError);
    }
    expect(h.objects[0].destroy).not.toHaveBeenCalled();
  });

  it('keeps the full continuous flight outside the highway, below scores and separate from the other message', () => {
    const h = harness();
    h.feedback.move(0, 'aura_glide'); h.feedback.move(1, 'aura_glide');
    h.feedback.milestone(0, 10); h.feedback.milestone(1, 10);
    // The existing highway outer frame spans x=362..662; scores end at y=92.
    const flightBounds = h.objects.map((object, index) => {
      const isMove = index < 2;
      const width = isMove ? AURA_COMIC_LAYOUT.moveWidth : AURA_COMIC_LAYOUT.streakWidth;
      const height = isMove ? AURA_COMIC_LAYOUT.moveHeight : AURA_COMIC_LAYOUT.streakHeight;
      const flight = h.scene.tweens.add.mock.calls.map(([config]) => config)
        .find(config => config.targets === object && 'y' in config)!;
      const left = object.x - width / 2;
      const right = object.x + width / 2;
      const top = Math.min(object.y, flight.y) - height / 2;
      const bottom = Math.max(object.y, flight.y) + height / 2;
      expect(left >= 0 && right <= 1_024).toBe(true);
      expect(right < 362 || left > 662).toBe(true);
      expect(top).toBeGreaterThan(92);
      expect(bottom).toBeLessThan(260);
      return { top, bottom };
    });
    // Entire swept ranges are disjoint, even when messages start at different times.
    expect(flightBounds[2].bottom).toBeLessThan(flightBounds[0].top);
    expect(flightBounds[3].bottom).toBeLessThan(flightBounds[1].top);
    expect(flightBounds).toEqual([
      { top: 131, bottom: 229 }, { top: 131, bottom: 229 },
      { top: 94, bottom: 130 }, { top: 94, bottom: 130 },
    ]);
    expect(h.layer.children).toHaveLength(4);
  });

  it.each([
    ['aura_unbothered', 'UNBOTHERED', 'ZERO STRESS'],
    ['aura_six_seven', '67', 'SIX SEVEN!'],
    ['aura_mog_check', 'MOG CHECK', 'GIGACHAD'],
    ['aura_glide', 'SMOOTH!', 'NO FRICTION'],
    ['aura_floor_worm', 'WORM MODE', 'FLOOR IS YOURS'],
    ['aura_one_leg', 'HOP MODE', 'ONE FOOT.'],
    ['aura_shrug', 'WHO, ME?', 'NO IDEA.'],
  ] as const)('renders the intended copy and icon for %s', (name, title, caption) => {
    const h = harness(true);
    h.feedback.move(0, name);
    expect(AURA_COMIC_COPY[name]).toEqual([title, caption]);
    expect(h.texts.map(text => text.value.replace(/\s+/g, ' '))).toEqual([title, caption]);
    expect(drawAuraComicIcon).toHaveBeenLastCalledWith(h.drawings[0], name);
    expect(h.drawings).toHaveLength(1); // Icon only, no plate graphics.
    for (const text of h.texts) {
      expect(text.textOptions.fontFamily).toBe(PIXEL_FONT);
      expect(['#fff4d6', '#ffce3a']).toContain(text.textOptions.color);
      expect(text.textOptions.stroke).toBe('#050507');
      expect(text.textOptions.strokeThickness).toBeGreaterThanOrEqual(3);
      expect(text.textOptions).not.toHaveProperty('backgroundColor');
    }
  });

  it('never draws opaque message plates, outlines or tails behind moves or streaks', () => {
    const h = harness();
    for (const name of Object.keys(AURA_COMIC_COPY) as (keyof typeof AURA_COMIC_COPY)[]) h.feedback.move(0, name);
    h.feedback.milestone(0, 10);
    h.feedback.judgement(1, true); h.feedback.judgement(1, true);
    for (const drawing of h.drawings) {
      for (const method of ['fillStyle', 'fillRoundedRect', 'strokeRoundedRect', 'fillTriangle']) {
        expect(drawing[method]).not.toHaveBeenCalled();
      }
    }
    expect(h.texts.every(text => !('backgroundColor' in text.textOptions))).toBe(true);
  });

  it('starts readable and rises throughout each lifetime, fading only over the final 420ms', () => {
    const h = harness();
    h.feedback.move(0, 'aura_glide'); h.feedback.milestone(1, 10);
    for (const [index, object] of h.objects.entries()) {
      const duration = index === 0 ? 1_800 : 1_300;
      const rise = index === 0 ? 24 : 12;
      const tweens = h.scene.tweens.add.mock.calls.map(([config]) => config)
        .filter(config => config.targets === object);
      expect(object.alpha).toBe(1);
      expect(object.setAlpha).not.toHaveBeenCalled();
      expect(object.setY).not.toHaveBeenCalled();
      expect(tweens).toEqual([
        { targets: object, y: object.y - rise, duration, ease: 'Linear' },
        { targets: object, alpha: 0, delay: duration - 420, duration: 420, ease: 'Quad.easeIn' },
      ]);
      expect(tweens[0]).not.toHaveProperty('delay');
      expect(tweens[1]).not.toHaveProperty('y');
      expect(h.timers[index].duration).toBe(duration);
    }
  });

  it('deduplicates a move per seat for the whole turn, even after its bubble expires', () => {
    const h = harness();
    h.feedback.move(0, 'aura_glide');
    h.feedback.move(0, 'aura_glide');
    expect(h.objects).toHaveLength(1);
    expect(h.timers).toHaveLength(1);
    h.timers[0].callback();
    h.feedback.move(0, 'aura_glide');
    expect(h.objects).toHaveLength(1);
    h.feedback.move(1, 'aura_glide');
    expect(h.objects).toHaveLength(2);
    h.feedback.beginTurn();
    h.feedback.move(0, 'aura_glide');
    expect(h.objects).toHaveLength(3);
  });

  it('replaces only the same move slot and ignores an obsolete timer callback', () => {
    const h = harness();
    h.feedback.move(0, 'aura_glide');
    h.feedback.milestone(0, 10);
    h.feedback.move(0, 'aura_one_leg');
    expect(h.timers[0].remove).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.scene.tweens.killTweensOf).toHaveBeenCalledWith(h.objects[0]);
    expect(h.objects[0].destroy).toHaveBeenCalledOnce();
    expect(h.objects[1].destroy).not.toHaveBeenCalled();
    h.timers[0].callback();
    expect(h.objects[2].destroy).not.toHaveBeenCalled();
    h.timers[2].callback();
    expect(h.objects[2].destroy).toHaveBeenCalledOnce();
    expect(h.objects[1].destroy).not.toHaveBeenCalled();
    expect(h.timers[0].duration).toBe(1_800);
    expect(h.timers[1].duration).toBe(1_300);
  });

  it('calls out two failures, then every fourth extra failure, not every missed note', () => {
    const h = harness(true);
    h.feedback.judgement(0, true);
    expect(h.objects).toHaveLength(0);
    h.feedback.judgement(0, true);
    expect(h.texts.map(text => text.value)).toEqual(['AURA LEAK']);
    for (let count = 3; count <= 5; count += 1) h.feedback.judgement(0, true);
    expect(h.objects).toHaveLength(1);
    h.feedback.judgement(0, true);
    expect(h.objects).toHaveLength(2);
    expect(h.objects[0].destroy).toHaveBeenCalledOnce();
    h.feedback.judgement(1, true);
    expect(h.objects).toHaveLength(2); // Failures are isolated per seat.
  });

  it('resets failure accumulation on recovery and at the next turn', () => {
    const h = harness(true);
    h.feedback.judgement(0, true);
    h.feedback.judgement(0, false);
    h.feedback.judgement(0, true);
    expect(h.objects).toHaveLength(0);
    h.feedback.judgement(0, true);
    expect(h.objects).toHaveLength(1);
    h.feedback.beginTurn();
    h.feedback.judgement(0, true);
    expect(h.objects).toHaveLength(1);
    h.feedback.judgement(0, true);
    expect(h.objects).toHaveLength(2);
  });

  it('uses positive copy, gold and an upward arrow for a combo milestone', () => {
    const h = harness(true);
    h.feedback.milestone(1, 20);
    expect(h.texts[0].value).toBe('20x  LOCKED IN');
    expect(h.texts[0].textOptions.color).toBe('#ffce3a');
    expect(h.drawings[0].lineStyle.mock.calls).toEqual([[6, INK, 1], [2, HEAT, 1]]);
    expect(h.drawings[0].lineBetween.mock.calls.slice(-3)).toEqual([
      [-87, 5, -87, -5], [-87, -5, -91, -1], [-87, -5, -83, -1],
    ]);
    h.feedback.judgement(1, true); h.feedback.judgement(1, true);
    expect(h.texts[1].textOptions.color).toBe('#fff4d6');
    expect(h.drawings[1].lineStyle.mock.calls).toEqual([[6, INK, 1], [2, CREAM, 1]]);
    expect(h.drawings[1].lineBetween.mock.calls.slice(-3)).toEqual([
      [-87, -5, -87, 5], [-87, 5, -91, 1], [-87, 5, -83, 1],
    ]);
  });

  it.each(['beginTurn', 'destroy'] as const)('%s flushes every slot, timer and tween idempotently', method => {
    const h = harness();
    for (const slot of [0, 1] as const) {
      h.feedback.move(slot, 'aura_six_seven'); h.feedback.milestone(slot, 10);
    }
    expect(h.scene.tweens.add).toHaveBeenCalledTimes(8);
    h.feedback[method]();
    for (const timer of h.timers) expect(timer.remove).toHaveBeenCalledExactlyOnceWith(false);
    for (const object of h.objects) {
      expect(object.destroy).toHaveBeenCalledOnce();
      expect(h.scene.tweens.killTweensOf).toHaveBeenCalledWith(object);
    }
    expect(h.scene.tweens.killTweensOf).toHaveBeenCalledTimes(4);
    h.feedback[method]();
    for (const timer of h.timers) timer.callback();
    for (const object of h.objects) expect(object.destroy).toHaveBeenCalledOnce();
    expect(h.scene.tweens.killTweensOf).toHaveBeenCalledTimes(4);
  });

  it('keeps the same content and expiry without flight or fade in reduced motion', () => {
    const h = harness(true);
    h.feedback.move(0, 'aura_six_seven');
    h.feedback.milestone(1, 10);
    h.feedback.judgement(0, true); h.feedback.judgement(0, true);
    expect(h.texts.map(text => text.value)).toEqual(['67', 'SIX\nSEVEN!', '10x  LOCKED IN', 'AURA LEAK']);
    expect(h.layer.children).toHaveLength(3);
    expect(h.scene.tweens.add).not.toHaveBeenCalled();
    for (const object of h.objects) {
      expect(object.alpha).toBe(1);
      expect(object.setY).not.toHaveBeenCalled();
      expect(object.setAlpha).not.toHaveBeenCalled();
    }
    for (const timer of h.timers) timer.callback();
    for (const object of h.objects) expect(object.destroy).toHaveBeenCalledOnce();
  });
});

describe('Aura move rail feedback', () => {
  function dockedHarness(reduceMotion = false) {
    const h = harness(reduceMotion);
    const layout = createAuraLayout(576, 1024);
    for (const slot of [0, 1] as const) h.feedback.setAnchor(slot, auraComicAnchor(layout, slot));
    const trail = () => h.texts.filter(text => text.y === 110).slice(-4);
    return { ...h, layout, trail };
  }
  const hit = (key: string, phrase = 'r0-p0', tone = 0x4fdced) => ({ key, phrase, tone });

  it('updates the last four successful inputs in one card without repeating its icon, entrance or sound', () => {
    const h = dockedHarness();
    h.feedback.move(0, 'aura_six_seven', hit('D'));
    const entranceCount = h.scene.tweens.add.mock.calls.length;
    for (const key of ['F', 'J', 'K', 'D', 'F']) h.feedback.move(0, 'aura_six_seven', hit(key, 'r0-p0', 0x0000ff));
    expect(h.objects).toHaveLength(1);
    expect(h.objects[0]).toMatchObject({ x: h.layout.comic.x, y: h.layout.comic.moveY, alpha: 1 });
    expect(h.trail().map(text => text.value)).toEqual(['J', 'K', 'D', 'F']);
    expect(h.trail().map(text => text.textOptions.color)).toEqual(Array(4).fill('#0000ff'));
    expect(h.texts.filter(text => text.value === 'LAST HITS')).toHaveLength(1);
    expect(h.onMove.mock.calls).toEqual([['aura_six_seven']]);
    expect(h.scene.tweens.add).toHaveBeenCalledTimes(entranceCount);
    expect(h.trail().every(text => text.setText.mock.calls.length === 6)).toBe(true);
    expect(h.timers.at(-1)?.duration).toBe(1_800);
    expect(h.timers.slice(0, -1).every(timer => timer.remove.mock.calls.length > 0)).toBe(true);
  });

  it('expires after the latest input, then rebuilds an empty history without replaying the same move sound', () => {
    const h = dockedHarness();
    h.feedback.move(0, 'aura_glide', hit('D'));
    const firstLifetime = h.timers.at(-1)!;
    h.feedback.move(0, 'aura_glide', hit('F'));
    expect(firstLifetime.remove).toHaveBeenCalledWith(false);
    expect(h.objects[0].destroy).not.toHaveBeenCalled();
    h.timers.at(-1)!.callback();
    expect(h.objects[0].destroy).toHaveBeenCalledOnce();
    h.feedback.move(0, 'aura_glide', hit('J'));
    expect(h.objects).toHaveLength(2);
    expect(h.trail().map(text => text.value)).toEqual(['J', '·', '·', '·']);
    expect(h.onMove.mock.calls).toEqual([['aura_glide']]);
  });

  it('starts a new phrase history even when a partial pack renders the same fallback move', () => {
    const h = dockedHarness();
    h.feedback.move(0, 'aura_glide', hit('D'));
    h.feedback.move(0, 'aura_glide', hit('F'));
    const retired = h.timers.at(-1)!;
    h.feedback.move(0, 'aura_glide', hit('K', 'r0-p1'));
    expect(h.objects).toHaveLength(2);
    expect(h.objects[0].destroy).toHaveBeenCalledOnce();
    expect(h.trail().map(text => text.value)).toEqual(['K', '·', '·', '·']);
    expect(h.onMove.mock.calls).toEqual([['aura_glide']]);
    retired.callback();
    expect(h.objects[1].destroy).not.toHaveBeenCalled();
    h.feedback.move(0, 'aura_floor_worm', hit('J', 'r0-p2'));
    expect(h.trail().map(text => text.value)).toEqual(['J', '·', '·', '·']);
    expect(h.onMove.mock.calls).toEqual([['aura_glide'], ['aura_floor_worm']]);
  });

  it('clears a failed sequence immediately and starts recovery with only the new successful key', () => {
    const h = dockedHarness();
    h.feedback.move(0, 'aura_glide', hit('D'));
    h.feedback.move(0, 'aura_glide', hit('F'));
    h.feedback.judgement(0, true);
    expect(h.objects[0].destroy).toHaveBeenCalledOnce();
    expect(h.texts.some(text => text.value === 'AURA LEAK')).toBe(false);
    h.feedback.judgement(0, true);
    expect(h.texts.filter(text => text.value === 'AURA LEAK')).toHaveLength(1);
    h.feedback.move(0, 'aura_glide', hit('K'));
    h.feedback.judgement(0, false);
    expect(h.trail().map(text => text.value)).toEqual(['K', '·', '·', '·']);
    expect(h.onMove.mock.calls).toEqual([['aura_glide']]);
    h.feedback.judgement(0, true);
    expect(h.texts.filter(text => text.value === 'AURA LEAK')).toHaveLength(1);
  });

  it.each(['turn', 'hidden', 'resize'] as const)('discards the old history on %s and cannot replay a stale timeout', boundary => {
    const h = dockedHarness();
    h.feedback.move(0, 'aura_six_seven', hit('D'));
    h.feedback.move(0, 'aura_six_seven', hit('F'));
    const oldTimers = [...h.timers];
    if (boundary === 'turn') h.feedback.beginTurn();
    else if (boundary === 'hidden') {
      h.feedback.setSlotVisible(0, false);
      h.feedback.move(0, 'aura_six_seven', hit('J'));
      expect(h.objects).toHaveLength(1);
      h.feedback.setSlotVisible(0, true);
    } else h.feedback.setAnchor(0, auraComicAnchor(createAuraLayout(), 0));
    expect(h.objects[0].destroy).toHaveBeenCalledOnce();
    h.feedback.move(0, 'aura_six_seven', hit('K'));
    expect(h.trail().map(text => text.value)).toEqual(['K', '·', '·', '·']);
    expect(h.onMove.mock.calls).toEqual([['aura_six_seven'], ['aura_six_seven']]);
    for (const timer of oldTimers) timer.callback();
    expect(h.objects[1].destroy).not.toHaveBeenCalled();
  });

  it('keeps the same readable inputs and expiry without motion', () => {
    const h = dockedHarness(true);
    h.feedback.move(0, 'aura_one_leg', hit('D'));
    h.feedback.move(0, 'aura_one_leg', hit('F'));
    expect(h.trail().map(text => text.value)).toEqual(['D', 'F', '·', '·']);
    expect(h.scene.tweens.add).not.toHaveBeenCalled();
    expect(h.objects[0].alpha).toBe(1);
    h.timers.at(-1)!.callback();
    expect(h.objects[0].destroy).toHaveBeenCalledOnce();
  });
});
