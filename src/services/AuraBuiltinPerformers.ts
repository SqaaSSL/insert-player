export type AuraBuiltinPerformerId = 'donald-trump';

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
  return fighter?.public === true
    && fighter.arcade?.slug === 'donald-trump'
    && /^[^:\s]+$/.test(fighter.id)
    ? 'donald-trump'
    : null;
}

export function builtinAuraPerformerForCachedMeta(
  meta: AuraBuiltinCachedIdentity | null | undefined,
): AuraBuiltinPerformerId | null {
  const identity = meta?.photoHash.match(/^arcade:donald-trump:([^:\s]+)$/);
  return identity && meta?.cloudPublic === true && meta.cloudFighterId === identity[1]
    ? 'donald-trump'
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
