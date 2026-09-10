import { AURA_CHALLENGE_ASSETS } from '../../src/game/aura/AuraChallengeAssets';

/** Public transport only. The game validates the current rules and score ceiling
 * before play; a preview is never evidence of a verified or ranked result. */
export interface AuraChallengePreview {
  version: 1;
  rules: string;
  seed: number;
  difficulty: 'lowkey' | 'viral' | 'untouchable';
  trackId: string;
  trackVersion: string;
  stageId: string;
  stageVersion: string;
  chartId: string;
  name: string;
  score: number;
  slot: 0 | 1;
}

const KEYS = ['version', 'rules', 'seed', 'difficulty', 'trackId', 'trackVersion', 'stageId', 'stageVersion', 'chartId', 'name', 'score', 'slot'];

export function decodeAuraChallengePreview(token: string): AuraChallengePreview | null {
  if (!token || token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const bytes = Uint8Array.from(atob(token.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
    const json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    const value = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== KEYS.length || Object.keys(value).some(key => !KEYS.includes(key))
      || JSON.stringify(value) !== json
      || btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== token
      || value.version !== 1 || typeof value.rules !== 'string' || !/^aura-1-[a-f0-9]{16}$/.test(value.rules)
      || !Number.isInteger(value.seed) || value.seed < 1 || value.seed > 0xffff_ffff
      || !['lowkey', 'viral', 'untouchable'].includes(value.difficulty)
      || (value.slot !== 0 && value.slot !== 1) || !Number.isSafeInteger(value.score) || value.score < 0
      || typeof value.name !== 'string' || !value.name || value.name !== value.name.normalize('NFC').trim()
      || Array.from(value.name).length > 32
      || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value.name)
      || Array.from(value.name as string).some(character => { const point = character.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff; })
      || typeof value.chartId !== 'string' || !/^[a-f0-9]{16}$/.test(value.chartId)
      || typeof value.trackId !== 'string' || value.trackId.length > 64
      || typeof value.stageId !== 'string' || value.stageId.length > 64) return null;
    const track = AURA_CHALLENGE_ASSETS[`track:${value.trackId}`];
    const stage = AURA_CHALLENGE_ASSETS[`stage:${value.stageId}`];
    if (!track || !stage || value.trackVersion !== track.sha256 || value.stageVersion !== stage.sha256) return null;
    return value as AuraChallengePreview;
  } catch { return null; }
}

export function escapeAuraPreviewHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
