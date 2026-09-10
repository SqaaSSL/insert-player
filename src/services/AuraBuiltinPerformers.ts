const AURA_BUILTIN_PERFORMER_IDS = ['donald-trump', 'rosalia-v2', 'lamine-yamal'] as const;
export type AuraBuiltinPerformerId = typeof AURA_BUILTIN_PERFORMER_IDS[number];

export function isAuraBuiltinPerformerId(value: unknown): value is AuraBuiltinPerformerId {
  return typeof value === 'string' && AURA_BUILTIN_PERFORMER_IDS.some(id => id === value);
}

/** Identity supplied by the public Arcade manifest, never by a display name. */
export interface AuraBuiltinCloudIdentity {
  id: string;
  public: boolean;
  arcade?: { slug: string };
}

/** Canonical public Arcade identity retained when its assets are cached. */
export interface AuraBuiltinCachedIdentity {
  photoHash: string;
  cloudFighterId?: string | null;
  cloudPublic?: boolean;
}

export type AuraBuiltinPerformerIdentity = AuraBuiltinCloudIdentity | AuraBuiltinCachedIdentity;

export function builtinAuraPerformerForCloud(
  fighter: AuraBuiltinCloudIdentity | null | undefined,
): AuraBuiltinPerformerId | null {
  const slug = fighter?.arcade?.slug;
  return fighter?.public === true
    && isAuraBuiltinPerformerId(slug)
    && /^[^:\s]+$/.test(fighter.id)
    ? slug
    : null;
}

export function builtinAuraPerformerForCachedMeta(
  meta: AuraBuiltinCachedIdentity | null | undefined,
): AuraBuiltinPerformerId | null {
  const identity = meta?.photoHash.match(/^arcade:([^:\s]+):([^:\s]+)$/);
  return identity && isAuraBuiltinPerformerId(identity[1])
    && meta?.cloudPublic === true && meta.cloudFighterId === identity[2]
    ? identity[1]
    : null;
}

/**
 * The reviewed local bundle grants only its own official identity Aura
 * presentation. Loading still verifies every required image and content hash;
 * this predicate never grants a paid pack or fills an unrelated character.
 */
export function builtinAuraPerformerForIdentity(
  identity: AuraBuiltinPerformerIdentity | null | undefined,
): AuraBuiltinPerformerId | null {
  if (!identity) return null;
  return 'id' in identity
    ? builtinAuraPerformerForCloud(identity)
    : builtinAuraPerformerForCachedMeta(identity);
}
