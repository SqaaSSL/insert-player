/** Shared, finite vocabulary: never add free-text identifiers or URLs here. */
export const PRODUCT_EVENT_NAMES = [
  'platform_visited', 'account_ready',
  'game_started', 'game_completed', 'creation_started', 'creation_completed',
  'onboarding_started', 'onboarding_completed', 'onboarding_skipped',
  'crew_created', 'invite_created', 'invite_accepted', 'stage_completed',
  'challenge_created', 'challenge_opened', 'challenge_started', 'challenge_completed', 'share_video',
] as const;
export type ProductEventName = typeof PRODUCT_EVENT_NAMES[number];
export const PRODUCT_CHANNELS = ['direct', 'instagram', 'tiktok', 'whatsapp', 'youtube', 'facebook', 'x', 'reddit', 'other'] as const;
export type ProductChannel = typeof PRODUCT_CHANNELS[number];
export const PRODUCT_SOURCES = ['trial', 'roster', 'landing', 'challenge', 'creation', 'onboarding', 'crew', 'referral'] as const;

export interface ProductEventProperties {
  game?: 'aura' | 'fight' | 'rush';
  package?: 'aura' | 'complete';
  tier?: 'rookie' | 'contender' | 'champion';
  source?: typeof PRODUCT_SOURCES[number];
  channel?: ProductChannel;
  durationMs?: number;
  credits?: number;
}
export interface ProductEventPayload { name: ProductEventName; properties: ProductEventProperties }

function member<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return typeof value === 'string' && options.includes(value as T) ? value as T : undefined;
}

export function sanitizeProductEvent(value: unknown): ProductEventPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const name = member(input.name, PRODUCT_EVENT_NAMES);
  if (!name) return null;
  const raw = input.properties && typeof input.properties === 'object' && !Array.isArray(input.properties)
    ? input.properties as Record<string, unknown> : {};
  const properties: ProductEventProperties = {};
  const game = member(raw.game, ['aura', 'fight', 'rush'] as const);
  const pack = member(raw.package, ['aura', 'complete'] as const);
  const tier = member(raw.tier, ['rookie', 'contender', 'champion'] as const);
  const source = member(raw.source, PRODUCT_SOURCES);
  const channel = member(raw.channel, PRODUCT_CHANNELS);
  if (game) properties.game = game;
  if (pack) properties.package = pack;
  if (tier) properties.tier = tier;
  if (source) properties.source = source;
  if (channel) properties.channel = channel;
  if (typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)) {
    properties.durationMs = Math.max(0, Math.min(86_400_000, Math.round(raw.durationMs)));
  }
  if (typeof raw.credits === 'number' && Number.isFinite(raw.credits)) {
    properties.credits = Math.max(0, Math.min(1000, Math.round(raw.credits)));
  }
  return { name, properties };
}

/** Only the fixed source name survives; campaigns, referrers and full URLs do not. */
export function productChannelFromSearch(search: string): ProductChannel {
  const raw = new URLSearchParams(search).get('utm_source')?.trim().toLowerCase();
  if (!raw) return 'direct';
  const aliases: Record<string, ProductChannel> = { ig: 'instagram', wa: 'whatsapp', twitter: 'x', yt: 'youtube', fb: 'facebook' };
  return member(raw, PRODUCT_CHANNELS) ?? (Object.hasOwn(aliases, raw) ? aliases[raw] : 'other');
}
