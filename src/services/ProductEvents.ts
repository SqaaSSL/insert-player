import type { FighterGameMode } from './FighterAssetPacks.ts';
import type { GenerationPackage } from './GenerationPackages.ts';
import type { QualityTier } from './QualityTiers.ts';

export type ProductEventName = 'game_started' | 'game_completed' | 'creation_started' | 'creation_completed'
  | 'challenge_created' | 'challenge_opened' | 'challenge_started' | 'challenge_completed' | 'share_video';
export interface ProductEventProperties {
  game?: FighterGameMode;
  package?: GenerationPackage;
  tier?: QualityTier;
  source?: 'trial' | 'roster' | 'landing' | 'challenge' | 'creation';
  durationMs?: number;
  credits?: number;
}
export interface ProductEvent { name: ProductEventName; at: number; properties: ProductEventProperties }
const KEY = 'ip:product-diagnostics:v1';

/** Device-only pilot diagnostics. No identifiers, photos, URLs or network delivery. */
export function trackProductEvent(name: ProductEventName, properties: ProductEventProperties = {}): void {
  if (typeof window === 'undefined') return;
  const safe: ProductEventProperties = {};
  if (['aura', 'fight', 'rush'].includes(properties.game ?? '')) safe.game = properties.game;
  if (['aura', 'complete'].includes(properties.package ?? '')) safe.package = properties.package;
  if (['rookie', 'contender', 'champion'].includes(properties.tier ?? '')) safe.tier = properties.tier;
  if (['trial', 'roster', 'landing', 'challenge', 'creation'].includes(properties.source ?? '')) safe.source = properties.source;
  if (Number.isFinite(properties.durationMs)) safe.durationMs = Math.max(0, Math.min(86_400_000, Math.round(properties.durationMs!)));
  if (Number.isFinite(properties.credits)) safe.credits = Math.max(0, Math.min(1000, properties.credits!));
  const event: ProductEvent = { name, at: Date.now(), properties: safe };
  try {
    const previous: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    const events = Array.isArray(previous) ? previous.slice(-199) : [];
    localStorage.setItem(KEY, JSON.stringify([...events, event]));
  } catch { /* Diagnostics must never interrupt gameplay or purchases. */ }
}

export function readProductEvents(): ProductEvent[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? value.slice(-200) : [];
  } catch { return []; }
}
