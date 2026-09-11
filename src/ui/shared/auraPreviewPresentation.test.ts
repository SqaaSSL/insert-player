import { describe, expect, it, vi } from 'vitest';
import { AURA_CAMERA_FINALE_MS, AURA_CAMERA_HANDOFF_MS } from '../../game/aura/AuraCamera.ts';
import { auraComicAnchor, createAuraLayout } from '../../game/aura/AuraLayout.ts';
import { AURA_PERFORMANCE_DEFINITIONS } from '../../game/aura/AuraPerformance.ts';
import { auraHudLayout, auraHudState } from '../../game/aura/AuraHud.ts';
import {
  AURA_PREVIEW_CHART, AURA_PREVIEW_CYCLE_MS, AURA_PREVIEW_PERFORMERS,
  AURA_PREVIEW_GAIN_LIFETIME_MS, AURA_PREVIEW_RESULT_MS, AURA_PREVIEW_TURN_MS, auraPreviewDuelAt,
} from './auraPreviewDuel.ts';
import { auraPreviewPresentation } from './auraPreviewPresentation.ts';
import { auraPreviewExpectedHash, type AuraPreviewAnimation } from './auraPreviewGeometry.ts';
import { drawAuraPreview, type AuraPreviewAtlases } from './auraPreviewCanvas.ts';

const at = (time: number) => auraPreviewPresentation(auraPreviewDuelAt(time), time);
const end = AURA_PREVIEW_CYCLE_MS - AURA_PREVIEW_RESULT_MS;

function canvasRecorder() {
  let saves = 0;
  const context = {
    globalAlpha: 1,
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(),
    fill: vi.fn(), stroke: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
    arc: vi.fn(), ellipse: vi.fn(), translate: vi.fn(), scale: vi.fn(),
    drawImage: vi.fn(), fillText: vi.fn(), strokeText: vi.fn(),
    save: () => { saves += 1; }, restore: () => { saves -= 1; },
  };
  return { context, get saves() { return saves; } };
}

function atlases(): AuraPreviewAtlases {
  const animations: AuraPreviewAnimation[] = ['aura_unbothered', 'aura_one_leg', 'aura_shrug', 'aura_six_seven', 'aura_floor_worm'];
  return new Map(AURA_PREVIEW_PERFORMERS.flatMap(({ subject }) => animations.map(animation => [
    `${subject}/${animation}`,
    { image: { key: `${subject}/${animation}` } as unknown as HTMLImageElement, contentHash: auraPreviewExpectedHash(subject, animation) },
  ] as const)));
}

describe('Aura preview camera and result', () => {
  it.each([1, 2, 3, 4, 5])('starts turn %i from the preceding camera instead of cutting between bodies', turn => {
    const boundary = turn * AURA_PREVIEW_TURN_MS;
    const before = at(boundary - 0.001);
    const after = at(boundary + 0.001);
    for (const slot of [0, 1]) {
      expect(after.actors[slot].x).toBeCloseTo(before.actors[slot].x, 5);
      expect(after.actors[slot].alpha).toBeCloseTo(before.actors[slot].alpha, 5);
      expect(after.actors[slot].height).toBeCloseTo(before.actors[slot].height, 5);
    }
    const midway = at(boundary + AURA_CAMERA_HANDOFF_MS / 2);
    expect(midway.camera.transitioning).toBe(true);
    expect(midway.actors.every(actor => actor.visible)).toBe(true);
    expect(midway.actors[0].x).toBeLessThan(midway.actors[1].x);
    expect(at(boundary + AURA_CAMERA_HANDOFF_MS).camera.transitioning).toBe(false);
  });

  it('opens from the final performer to both bodies with the correct dedicated reactions', () => {
    const before = at(end - 0.001);
    const start = at(end);
    for (const slot of [0, 1]) {
      expect(start.actors[slot].x).toBeCloseTo(before.actors[slot].x);
      expect(start.actors[slot].alpha).toBeCloseTo(before.actors[slot].alpha);
    }
    const result = at(end + AURA_CAMERA_FINALE_MS);
    const winner = auraPreviewDuelAt(end).winner!;
    expect(result.actors.every(actor => actor.visible && actor.alpha === 1)).toBe(true);
    expect(result.actors[winner].animation).toBe('aura_one_leg');
    expect(result.actors[1 - winner].animation).toBe('aura_shrug');
    expect(result.actors[0].x).toBeLessThan(result.actors[1].x);
    expect(result.gains).toEqual([]);
  });

  it('finishes the loser shrug on the game clock and holds its last frame on direct seeks', () => {
    const loser = 1 - auraPreviewDuelAt(end).winner!;
    const duration = AURA_PERFORMANCE_DEFINITIONS.aura_shrug.durationMs;
    for (const age of [duration, duration * 2, AURA_PREVIEW_RESULT_MS - 1]) {
      expect(at(end + age).actors[loser]).toMatchObject({ animation: 'aura_shrug', frameIndex: 7 });
    }
    expect(at(end + duration / 4).actors[loser].frameIndex).toBe(2);
    expect(at(end).actors[loser].frameIndex).toBe(0);
  });

  it('lets both performers keep celebrating when the result is tied', () => {
    const time = end + AURA_PERFORMANCE_DEFINITIONS.aura_one_leg.durationMs;
    const tie = { ...auraPreviewDuelAt(time), winner: null };
    const result = auraPreviewPresentation(tie, time);
    for (const actor of result.actors) {
      expect(actor).toMatchObject({ visible: true, alpha: 1, animation: 'aura_one_leg', frameIndex: 0, winner: true, loser: false });
    }
  });

  it('keeps one discreet delta within the active score HUD and docks the move inside its instrument rail', () => {
    const first = AURA_PREVIEW_CHART.turns[0].notes[0];
    const early = at(first.atMs + 20).gains.find(gain => gain.noteId === first.id)!;
    const later = at(first.atMs + 200).gains.find(gain => gain.noteId === first.id)!;
    expect(early.scoreDelta).toBe(1000);
    expect(early).toMatchObject({ x: 24, originX: 0, alpha: 0.8 });
    const rival = AURA_PREVIEW_CHART.turns[1].notes[0];
    expect(at(rival.atMs).gains[0]).toMatchObject({ x: 1000, y: auraHudLayout(createAuraLayout()).cueY, originX: 1 });
    expect(later.y).toBeLessThan(early.y);
    expect(at(first.atMs + AURA_PREVIEW_GAIN_LIFETIME_MS).gains.some(gain => gain.noteId === first.id)).toBe(false);
    expect(at(AURA_PREVIEW_TURN_MS).gains).toEqual([]);
    const layout = createAuraLayout();
    const highwayLeft = layout.highwayX + layout.laneOffsets[0] - 42;
    expect(at(first.atMs).icon.x + 38).toBeLessThan(highwayLeft);
    expect(later.x).toBe(early.x);
    expect(later.y).toBeCloseTo(early.y - 180 / AURA_PREVIEW_GAIN_LIFETIME_MS * 3);
    const comic = auraComicAnchor(layout, 0);
    expect(at(first.atMs).icon.y).toBe(comic.moveY);
    expect(at(first.atMs + 1200).icon.y - 38).toBeGreaterThan(layout.hudHeight);
    expect(at(first.atMs + 1200).icon.y).toBe(comic.moveY);
    expect(comic.x - 65).toBeGreaterThan(layout.moveRail.left);
    expect(comic.x + 65).toBeLessThan(layout.moveRail.right);
    expect(comic.moveY + 110).toBe(layout.laneTargetY);
  });

  it('keeps the move card visible while successful notes arrive, then clears it for the next performer', () => {
    const finalHit = AURA_PREVIEW_CHART.turns[0].notes.at(-1)!;
    const time = finalHit.atMs + 160;
    expect(time - AURA_PREVIEW_CHART.turns[0].firstNoteMs).toBeGreaterThan(1200);
    expect(at(time).icon.alpha).toBe(1);
    expect(at(AURA_PREVIEW_CHART.turns[0].firstNoteMs - 0.01).icon.alpha).toBe(0);
    expect(at(AURA_PREVIEW_TURN_MS).icon.alpha).toBe(0);
    expect(at(end).icon.alpha).toBe(0);
  });

  it('replaces the previous cue with the latest real delta and fades without moving over the main score', () => {
    let sawFade = false;
    const cueY = auraHudLayout(createAuraLayout()).cueY;
    for (let time = 0; time < end; time += 20) {
      const gains = at(time).gains;
      expect(gains.length).toBeLessThanOrEqual(1);
      for (const gain of gains) {
        expect(gain.y).toBeGreaterThanOrEqual(cueY - 3);
        expect(gain.y).toBeLessThanOrEqual(cueY);
        if (gain.alpha < 0.8) sawFade = true;
        const hit = auraPreviewDuelAt(time).recentHit;
        if (hit) expect(gain).toMatchObject({ noteId: hit.noteId, scoreDelta: hit.scoreDelta });
      }
    }
    expect(sawFade).toBe(true);
    const second = AURA_PREVIEW_CHART.turns[0].notes[1];
    expect(at(second.atMs + 150).gains).toHaveLength(1);
    expect(at(second.atMs + 150).gains[0].scoreDelta).toBe(375);
  });

  it('draws the winner and loser assets together and keeps the result title above their bodies', () => {
    const recorder = canvasRecorder();
    const time = end + AURA_CAMERA_FINALE_MS;
    const duel = auraPreviewDuelAt(time);
    drawAuraPreview(recorder.context as unknown as CanvasRenderingContext2D, null, atlases(), duel, time);
    const images = recorder.context.drawImage.mock.calls.map(call => (call[0] as { key: string }).key);
    expect(images).toContain(`${AURA_PREVIEW_PERFORMERS[duel.winner!].subject}/aura_one_leg`);
    expect(images).toContain(`${AURA_PREVIEW_PERFORMERS[1 - duel.winner!].subject}/aura_shrug`);
    const title = recorder.context.fillText.mock.calls.find(call => String(call[0]).endsWith(' WINS'));
    expect(title?.[2]).toBe(createAuraLayout().hudHeight + 22);
    expect(recorder.context.fillText.mock.calls.filter(call => /^P[12] · /.test(String(call[0]))
      && call[2] === createAuraLayout().performerLabel.y)).toHaveLength(0);
    expect(recorder.saves).toBe(0);
  });

  it('uses the actual movement icon art and draws only the discreet numeric delta under the HUD', () => {
    const recorder = canvasRecorder();
    const time = AURA_PREVIEW_CHART.turns[0].firstNoteMs + 30;
    const duel = auraPreviewDuelAt(time, 1);
    drawAuraPreview(recorder.context as unknown as CanvasRenderingContext2D, null, atlases(), duel, time);
    expect(recorder.context.fillText.mock.calls.some(call => call[0] === '67')).toBe(true);
    expect(recorder.context.fillText.mock.calls.some(call => call[0] === 'SIX')).toBe(true);
    expect(recorder.context.fillText.mock.calls.some(call => call[0] === 'SEVEN!')).toBe(true);
    expect(recorder.context.fillText.mock.calls.some(call => call[0] === 'LAST HITS')).toBe(true);
    expect(recorder.context.fillText.mock.calls.filter(call => call[2] === 103).map(call => call[0])).toEqual([
      ['D', 'F', 'J', 'K'][duel.moveInputs[0].lane], '·', '·', '·',
    ]);
    expect(recorder.context.fillText.mock.calls.some(call => call[0] === '+1,000' && call[1] === 24 && call[2] < auraHudLayout(createAuraLayout()).cueY)).toBe(true);
    expect(recorder.context.fillText.mock.calls.some(call => String(call[0]).startsWith('+') && String(call[0]).includes('AURA'))).toBe(false);
    expect(recorder.saves).toBe(0);
  });

  it('keeps scores, lead and status in the shared HUD and confines FLOW to the instrument header', () => {
    const recorder = canvasRecorder();
    const time = AURA_PREVIEW_CHART.turns[1].firstNoteMs + 30;
    const duel = auraPreviewDuelAt(time);
    const layout = createAuraLayout();
    const hud = auraHudLayout(layout);
    drawAuraPreview(recorder.context as unknown as CanvasRenderingContext2D, null, atlases(), duel, time);
    const calls = recorder.context.fillText.mock.calls;
    expect(calls.some(call => call[0] === 'P1 · TRUMP' && call[2] === hud.nameY)).toBe(true);
    expect(calls.some(call => call[0] === 'P2 · NOVA' && call[2] === hud.nameY)).toBe(true);
    expect(calls.some(call => call[0] === auraHudState(duel.scores).leadLabel && call[2] === hud.leadY)).toBe(true);
    expect(calls.filter(call => String(call[0]).includes('ON CAM'))).toEqual([
      [at(time).statusLabel, layout.width / 2, hud.statusY, layout.width - 48],
    ]);
    expect(calls.filter(call => String(call[0]).includes('FLOW'))).toEqual([
      [duel.comboLabel, layout.instrument.comboX, layout.instrument.comboY],
    ]);
    expect(calls.some(call => call[0] === 'AUTO RHYTHM' && call[2] === layout.instrument.top + 9)).toBe(true);
    expect(calls.some(call => String(call[0]).startsWith('CROWD · ') && call[2] === layout.instrument.crowdY)).toBe(true);
    expect(calls.filter(call => call[2] === layout.performerLabel.y)).toEqual([
      ['P2 · NOVA', layout.performerLabel.x, layout.performerLabel.y, 330],
    ]);
    expect(at(AURA_PREVIEW_TURN_MS - 1).statusLabel).toBe('ROUND 1/3 · P1 ON CAM · 1S');
    expect(at(AURA_PREVIEW_TURN_MS).statusLabel).toBe(`ROUND 1/3 · P2 ON CAM · ${Math.ceil(AURA_PREVIEW_TURN_MS / 1000)}S`);
    expect(at(end).statusLabel).toBe('ROUND 3/3 · FINAL RESULT');
  });
});
