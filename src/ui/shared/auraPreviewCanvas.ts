import { createAuraLayout } from '../../game/aura/AuraLayout.ts';
import { AURA_LANES, auraUsesTouchControls } from '../../game/aura/AuraLanes.ts';
import { drawAuraComicIcon, type AuraComicGraphics } from '../../game/aura/AuraComicArt.ts';
import { AURA_DOCKED_MOVE_NAMES } from '../../game/aura/AuraComicFeedback.ts';
import { AURA_SCORE_CUE, formatAuraScoreDelta } from '../../game/aura/AuraScoreCue.ts';
import { getAuraDifficulty } from '../../game/aura/AuraConfig.ts';
import { auraHudLayout, auraHudState, drawAuraDuelMeter, type AuraHudGraphics } from '../../game/aura/AuraHud.ts';
import { CREAM, DANGER, HEAT, HEAT_DEEP, INK, PIXEL_FONT, SLOT_COLOR_CSS, STEEL, STEEL_DIM } from '../../game/ui/CabinetTheme.ts';
import { AURA_PREVIEW_CHART, AURA_PREVIEW_KEYS, AURA_PREVIEW_PERFORMERS, type AuraPreviewDuelState } from './auraPreviewDuel.ts';
import { auraPreviewFrameGeometry } from './auraPreviewGeometry.ts';
import { auraPreviewPresentation } from './auraPreviewPresentation.ts';

export interface AuraPreviewAtlas { image: HTMLImageElement; contentHash: string }
export type AuraPreviewAtlases = ReadonlyMap<string, AuraPreviewAtlas>;
export const AURA_PREVIEW_FRAME = { canvasWidth: 480, canvasHeight: 512, bodyHeight: 360, rootX: 240, rootY: 474 };
const WIDTH = 1024;
const HEIGHT = 576;
const COLORS = AURA_LANES.map(lane => lane.tone);
const css = (color: number) => `#${color.toString(16).padStart(6, '0')}`;

function plate(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number,
  fill: string, stroke?: string, chamfer = 5) {
  ctx.beginPath();
  ctx.moveTo(x + chamfer, y); ctx.lineTo(x + width - chamfer, y);
  ctx.lineTo(x + width, y + chamfer); ctx.lineTo(x + width, y + height - chamfer);
  ctx.lineTo(x + width - chamfer, y + height); ctx.lineTo(x + chamfer, y + height);
  ctx.lineTo(x, y + height - chamfer); ctx.lineTo(x, y + chamfer); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number,
  color = css(CREAM), align: CanvasTextAlign = 'left', maxWidth?: number) {
  ctx.font = `${size}px ${PIXEL_FONT}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'top';
  if (maxWidth) ctx.fillText(text, x, y, maxWidth); else ctx.fillText(text, x, y);
}
function glyph(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, filled: boolean) {
  plate(ctx, x - 22, y - 7, 44, 14, filled ? color : css(INK), color, 3);
  if (filled) { ctx.fillStyle = '#05050788'; ctx.fillRect(x - 1, y - 5, 2, 10); }
}
const formatAura = (value: number) => Math.max(0, Math.round(value)).toLocaleString('en-US');

/** Run the actual game's vector icon drawing against Canvas, without Phaser. */
function canvasAuraGraphics(ctx: CanvasRenderingContext2D): AuraComicGraphics & AuraHudGraphics {
  const color = (value: number, alpha = 1) => `rgba(${value >> 16 & 255},${value >> 8 & 255},${value & 255},${alpha})`;
  const graphics: AuraComicGraphics & AuraHudGraphics = {
    lineStyle(width, tone, alpha = 1) { ctx.lineWidth = width; ctx.strokeStyle = color(tone, alpha); return graphics; },
    fillStyle(tone, alpha = 1) { ctx.fillStyle = color(tone, alpha); return graphics; },
    beginPath() { ctx.beginPath(); return graphics; },
    moveTo(x, y) { ctx.moveTo(x, y); return graphics; },
    lineTo(x, y) { ctx.lineTo(x, y); return graphics; },
    lineBetween(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); return graphics; },
    closePath() { ctx.closePath(); return graphics; },
    strokePath() { ctx.stroke(); return graphics; },
    fillPath() { ctx.fill(); return graphics; },
    fillRect(x, y, width, height) { ctx.fillRect(x, y, width, height); return graphics; },
    fillCircle(x, y, radius) { ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); return graphics; },
    fillEllipse(x, y, width, height) { ctx.beginPath(); ctx.ellipse(x, y, width / 2, height / 2, 0, 0, Math.PI * 2); ctx.fill(); return graphics; },
  };
  return graphics;
}

/** Canvas counterpart of the real cabinet HUD and instrument. Layout, colours,
 * calibrated sprite geometry, chart projection and scoring come from game modules. */
export function drawAuraPreview(ctx: CanvasRenderingContext2D, stage: HTMLImageElement | null,
  atlases: AuraPreviewAtlases | null, duel: AuraPreviewDuelState, elapsedMs: number) {
  const touch = auraUsesTouchControls();
  const layout = createAuraLayout(WIDTH, HEIGHT);
  const hud = auraHudLayout(layout);
  const hudState = auraHudState(duel.scores);
  const slot = duel.activeSlot ?? duel.winner ?? 0;
  const presentation = auraPreviewPresentation(duel, elapsedMs);
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = css(INK); ctx.fillRect(0, 0, WIDTH, HEIGHT);
  if (stage) {
    const floorRatio = 0.82;
    const scale = Math.max(WIDTH / stage.naturalWidth,
      (layout.active.footY - layout.stage.y) / (stage.naturalHeight * floorRatio),
      (HEIGHT - layout.active.footY) / (stage.naturalHeight * (1 - floorRatio)));
    const width = stage.naturalWidth * scale * presentation.camera.backdropScale;
    const height = stage.naturalHeight * scale * presentation.camera.backdropScale;
    ctx.drawImage(stage, (WIDTH - width) / 2 + presentation.camera.backdropOffsetX,
      layout.active.footY - height * floorRatio, width, height);
    ctx.fillStyle = '#05050738'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }

  for (const [index, performer] of AURA_PREVIEW_PERFORMERS.entries()) {
    const placement = presentation.actors[index];
    if (!placement.visible) continue;
    const { animation, frameIndex } = placement;
    const atlas = atlases?.get(`${performer.subject}/${animation}`);
    if (!atlas) continue;
    const frame = auraPreviewFrameGeometry({ subject: performer.subject, animation, frameIndex, contentHash: atlas.contentHash, ...AURA_PREVIEW_FRAME });
    if (!frame) continue;
    ctx.save();
    ctx.globalAlpha = placement.alpha;
    ctx.fillStyle = placement.winner ? '#ffce3a44' : '#00000077'; ctx.beginPath();
    ctx.ellipse(placement.x, placement.footY - 2, placement.height * 0.2, 9, 0, 0, Math.PI * 2); ctx.fill();
    const scale = placement.height / AURA_PREVIEW_FRAME.bodyHeight;
    ctx.save();
    ctx.translate(placement.x, placement.footY);
    if (index === 1) ctx.scale(-1, 1);
    ctx.scale(scale, scale);
    const { source, destination } = frame;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(atlas.image, source.x, source.y, source.width, source.height,
      destination.x - AURA_PREVIEW_FRAME.rootX, destination.y - AURA_PREVIEW_FRAME.rootY, destination.width, destination.height);
    ctx.restore();
    ctx.restore();
  }

  // Match and miniature draw the same meter and preserve the same score hierarchy.
  ctx.fillStyle = '#050507f5'; ctx.fillRect(0, 0, WIDTH, layout.hudHeight);
  drawAuraDuelMeter(canvasAuraGraphics(ctx), layout, hudState);
  AURA_PREVIEW_PERFORMERS.forEach((performer, index) => {
    const x = index === 0 ? 24 : WIDTH - 24;
    const align = index === 0 ? 'left' : 'right';
    label(ctx, `P${index + 1} · ${performer.name.toUpperCase()}`, x, hud.nameY, hud.nameSize, SLOT_COLOR_CSS[index], align, hud.seatWidth);
    label(ctx, `${formatAura(duel.scores[index])} AURA`, x, hud.scoreY, hud.scoreSize, css(CREAM), align, hud.seatWidth);
  });
  if (hud.headingVisible) label(ctx, 'AURA DUEL', WIDTH / 2, hud.headingY, hud.headingSize, css(CREAM), 'center', hud.centerWidth);
  label(ctx, hudState.leadLabel, WIDTH / 2, hud.leadY, hud.leadSize, hudState.leader === null ? css(CREAM) : css(HEAT), 'center', hud.centerWidth);
  label(ctx, presentation.statusLabel, WIDTH / 2, hud.statusY, hud.statusSize, css(CREAM), 'center', WIDTH - 48);
  ctx.strokeStyle = css(STEEL_DIM); ctx.beginPath(); ctx.moveTo(0, layout.hudHeight); ctx.lineTo(WIDTH, layout.hudHeight); ctx.stroke();

  if (duel.finished) {
    const resultY = layout.hudHeight + 10;
    plate(ctx, 250, resultY, 524, 42, '#050507dd', css(HEAT), 8);
    label(ctx, duel.winner === null ? 'AURA EQUILIBRIUM' : `${AURA_PREVIEW_PERFORMERS[duel.winner].name.toUpperCase()} WINS`, WIDTH / 2, resultY + 12, 18, css(HEAT), 'center', 476);
    return;
  }

  if (!presentation.camera.transitioning) {
    label(ctx, `P${slot + 1} · ${AURA_PREVIEW_PERFORMERS[slot].name.toUpperCase()}`, layout.performerLabel.x,
      layout.performerLabel.y, 12, SLOT_COLOR_CSS[slot], 'center', 330);
  }
  const { left, right, top, bottom } = layout.instrument;
  plate(ctx, left, top, right - left, bottom - top, '#050507d6', SLOT_COLOR_CSS[slot], 10);
  const rail = layout.moveRail;
  plate(ctx, rail.left, rail.top, rail.right - rail.left, rail.bottom - rail.top,
    '#050507d6', SLOT_COLOR_CSS[slot], 10);
  ctx.strokeStyle = '#fff4d6a6'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(rail.right - 8, layout.laneTargetY); ctx.lineTo(left + 12, layout.laneTargetY);
  ctx.moveTo(rail.right - 3, layout.laneTargetY - 5); ctx.lineTo(rail.right - 8, layout.laneTargetY);
  ctx.lineTo(rail.right - 3, layout.laneTargetY + 5); ctx.stroke();
  ctx.strokeStyle = '#fff4d6d9'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(left + 12, layout.laneTargetY); ctx.lineTo(right - 12, layout.laneTargetY); ctx.stroke();
  label(ctx, 'AUTO RHYTHM', left + 10, top + 9, 9, css(CREAM));
  label(ctx, duel.comboLabel, layout.instrument.comboX, layout.instrument.comboY, 11, css(HEAT), 'right');
  for (let lane = 0; lane < 4; lane++) {
    const x = layout.highwayX + layout.laneOffsets[lane];
    const tone = css(COLORS[lane]);
    ctx.fillStyle = `${tone}17`; ctx.fillRect(x - 30, layout.laneStartY, 60, layout.laneTargetY - layout.laneStartY);
    ctx.strokeStyle = `${tone}4d`; ctx.lineWidth = 1;
    ctx.strokeRect(x - 30, layout.laneStartY, 60, layout.laneTargetY - layout.laneStartY);
    ctx.fillStyle = `${tone}15`; ctx.fillRect(x - 29, layout.laneTargetY - 22, 58, 44);
    const hit = duel.receptors[lane]?.hit;
    if (hit) { ctx.fillStyle = `${tone}50`; ctx.fillRect(x - 30, layout.laneTargetY - 74, 60, 76); }
    plate(ctx, x - 28, layout.laneTargetY - 13, 56, 26, '#0b0c14', hit ? '#ffffff' : css(STEEL), 4);
    glyph(ctx, x, layout.laneTargetY, hit ? '#ffffff' : tone, hit);
    plate(ctx, x - 22, layout.keyLabelY - 17, 44, 34, touch || hit ? tone : css(INK), tone, 4);
    if (!touch) label(ctx, AURA_PREVIEW_KEYS[lane], x, layout.keyLabelY - 9, 19, hit ? css(INK) : css(CREAM), 'center');
  }
  for (const progress of [0.25, 0.5, 0.75]) {
    const y = layout.laneStartY + (layout.laneTargetY - layout.laneStartY) * progress;
    ctx.strokeStyle = '#9aa1b433'; ctx.beginPath(); ctx.moveTo(left + 12, y); ctx.lineTo(right - 12, y); ctx.stroke();
  }
  for (const note of duel.notes) {
    const x = layout.highwayX + layout.laneOffsets[note.lane];
    const y = layout.laneStartY + (layout.laneTargetY - layout.laneStartY) * note.progress;
    glyph(ctx, x, y, css(COLORS[note.lane]), true);
  }
  if (duel.feedbackLabel) {
    const hit = duel.recentHit!;
    const tone = hit.grade === 'perfect' ? css(HEAT) : hit.grade === 'great' ? css(CREAM) : css(STEEL);
    ctx.save();
    ctx.globalAlpha = Math.min(1, (420 - hit.ageMs) / 140);
    ctx.font = `13px ${PIXEL_FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.strokeStyle = css(INK); ctx.lineWidth = 4; ctx.lineJoin = 'round';
    ctx.strokeText(duel.feedbackLabel, layout.feedback.x, layout.feedback.y);
    label(ctx, duel.feedbackLabel, layout.feedback.x, layout.feedback.y, 13, tone, 'center');
    const meterY = layout.feedback.y + 23;
    const ratio = Math.max(-1, Math.min(1, hit.offsetMs / getAuraDifficulty(AURA_PREVIEW_CHART.difficulty).goodWindowMs));
    ctx.fillStyle = css(INK); ctx.fillRect(layout.feedback.x - 44, meterY, 88, 6);
    ctx.fillStyle = css(STEEL); ctx.fillRect(layout.feedback.x - 42, meterY + 2, 84, 2);
    ctx.fillStyle = css(CREAM); ctx.fillRect(layout.feedback.x - 1, meterY - 1, 2, 8);
    ctx.fillStyle = tone; ctx.fillRect(layout.feedback.x + Math.round(ratio * 40) - 2, meterY - 2, 4, 10);
    if (Math.abs(hit.offsetMs) >= 12) {
      const early = hit.offsetMs < 0;
      label(ctx, `${early ? 'EARLY' : 'LATE'} ${Math.round(Math.abs(hit.offsetMs))}MS`,
        layout.feedback.x + (early ? -52 : 52), meterY - 1, 7, css(STEEL), early ? 'right' : 'left');
    }
    ctx.restore();
  } else if (duel.phase === 'count-in') {
    label(ctx, 'GET READY', layout.feedback.x, layout.feedback.y, 16, css(CREAM), 'center');
    label(ctx, String(duel.countIn ?? ''), layout.highwayX, layout.laneStartY + 68, 40, css(HEAT), 'center');
  }
  for (const gain of presentation.gains) {
    ctx.save();
    ctx.globalAlpha = gain.alpha;
    label(ctx, formatAuraScoreDelta(gain.scoreDelta), gain.x, gain.y, AURA_SCORE_CUE.fontSize,
      css(CREAM), gain.originX === 0 ? 'left' : 'right');
    ctx.restore();
  }
  if (presentation.icon.alpha > 0) {
    const icon = presentation.icon;
    ctx.save();
    ctx.globalAlpha = icon.alpha;
    ctx.translate(icon.x, icon.y);
    label(ctx, 'MOVE', 0, -77, 10, css(CREAM), 'center');
    ctx.save();
    ctx.translate(0, -18);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    drawAuraComicIcon(canvasAuraGraphics(ctx), icon.animation);
    ctx.restore();
    if (icon.animation === 'aura_six_seven') {
      ctx.font = `28px ${PIXEL_FONT}`;
      ctx.strokeStyle = css(INK); ctx.lineWidth = 3;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.strokeText('67', 0, -39);
      label(ctx, '67', 0, -39, 28, css(HEAT), 'center');
    }
    const lines = AURA_DOCKED_MOVE_NAMES[icon.animation].split('\n');
    lines.forEach((line, index) => label(ctx, line, 0, 34 - lines.length * 8 + index * 16, 13, css(HEAT), 'center', 144));
    label(ctx, 'LAST HITS', 0, 72.5, 9, css(CREAM), 'center');
    [-51, -17, 17, 51].forEach((x, index) => {
      const hit = duel.moveInputs[index];
      plate(ctx, x - 14, 95, 28, 30, css(INK), '#fff4d659', 3);
      if (touch && hit) plate(ctx, x - 12, 102, 24, 16, css(COLORS[hit.lane]), undefined, 2);
      else label(ctx, hit ? AURA_PREVIEW_KEYS[hit.lane] : '·', x, 103, 14,
        hit ? css(COLORS[hit.lane]) : css(CREAM), 'center');
    });
    ctx.restore();
  }
  label(ctx, touch ? 'AUTO · FOUR COLOURS' : 'AUTO · D F J K', layout.highwayX, layout.keyLabelY + 47, 10, css(CREAM), 'center');
  label(ctx, `CROWD · ${presentation.crowdLabel}`, layout.instrument.crowdX, layout.instrument.crowdY, 8, css(CREAM), 'right');
  const segmentColors = [STEEL, STEEL, STEEL, CREAM, CREAM, HEAT, HEAT_DEEP, DANGER];
  const trackLeft = layout.instrument.crowdX - 204;
  plate(ctx, trackLeft - 4, layout.instrument.crowdMeterY, 212, 10, '#050507d9', undefined, 3);
  for (let index = 0; index < 8; index++) {
    ctx.fillStyle = css(index < Math.ceil(presentation.crowdHeat * 8) ? segmentColors[index] : STEEL_DIM);
    ctx.fillRect(trackLeft + index * 26, layout.instrument.crowdMeterY + 2, 22, 6);
  }
}
