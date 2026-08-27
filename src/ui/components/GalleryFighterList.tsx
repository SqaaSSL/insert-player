import type { CloudFighter } from '../../services/CloudFighters.ts';
import { arcadeFighterPhotoHash } from '../../services/CloudFighters.ts';
import type { CachedMeta } from '../../services/SpriteCache.ts';
import { QUALITY_TIERS } from '../../services/QualityTiers.ts';
import { isArcadeCachedMeta } from '../shared/fighterPreview.ts';
import { cachedArcadeSlug, findCachedArcadeMeta } from '../shared/galleryArcadeRoster.ts';
import { ownedRosterMetas } from '../shared/arcadeRosterIdentity.ts';

export type GalleryArcadeState = 'loading' | 'ready' | 'unavailable';

interface GalleryFighterListProps {
  metas: CachedMeta[];
  arcadeFighters: CloudFighter[];
  selectedPhotoHash: string | null;
  loadingArcadeId: string | null;
  disabled?: boolean;
  onSelectMeta: (meta: CachedMeta) => void;
  onSelectArcade: (fighter: CloudFighter) => void;
  arcadeState: GalleryArcadeState;
}

export interface GalleryGlobalFighter {
  fighter: CloudFighter | null;
  photoHash: string;
  cachedMeta: CachedMeta | null;
}

export interface GalleryFighterSections {
  globals: GalleryGlobalFighter[];
  owned: CachedMeta[];
}

export function buildGalleryFighterSections(
  metas: CachedMeta[],
  arcadeFighters: CloudFighter[],
  includeCachedFallback = false,
): GalleryFighterSections {
  const seenGlobalHashes = new Set<string>();
  const matchedCachedHashes = new Set<string>();
  const globals: GalleryGlobalFighter[] = [];

  for (const fighter of arcadeFighters) {
    const photoHash = arcadeFighterPhotoHash(fighter);
    if (seenGlobalHashes.has(photoHash)) continue;
    seenGlobalHashes.add(photoHash);
    const cachedMeta = findCachedArcadeMeta(metas, fighter);
    if (cachedMeta) matchedCachedHashes.add(cachedMeta.photoHash);
    globals.push({
      fighter,
      photoHash,
      cachedMeta,
    });
  }

  if (includeCachedFallback) {
    const representedIds = new Set(arcadeFighters.map((fighter) => fighter.id));
    const representedSlugs = new Set(
      arcadeFighters
        .map((fighter) => fighter.arcade?.slug)
        .filter((slug): slug is string => Boolean(slug)),
    );
    const cachedFallbacks = metas
      .filter(isArcadeCachedMeta)
      .sort((left, right) => {
        const leftSlug = cachedArcadeSlug(left.photoHash);
        const rightSlug = cachedArcadeSlug(right.photoHash);
        const leftHasCurrentKey = leftSlug !== null && left.photoHash !== `arcade:${leftSlug}`;
        const rightHasCurrentKey = rightSlug !== null && right.photoHash !== `arcade:${rightSlug}`;
        return Number(rightHasCurrentKey) - Number(leftHasCurrentKey);
      });
    for (const cachedMeta of cachedFallbacks) {
      if (matchedCachedHashes.has(cachedMeta.photoHash)) continue;
      const cachedSlug = cachedArcadeSlug(cachedMeta.photoHash);
      if (cachedMeta.cloudFighterId && representedIds.has(cachedMeta.cloudFighterId)) continue;
      if (cachedSlug && representedSlugs.has(cachedSlug)) continue;
      globals.push({
        fighter: null,
        photoHash: cachedMeta.photoHash,
        cachedMeta,
      });
      if (cachedMeta.cloudFighterId) representedIds.add(cachedMeta.cloudFighterId);
      if (cachedSlug) representedSlugs.add(cachedSlug);
    }
  }

  return {
    globals,
    owned: ownedRosterMetas(metas, arcadeFighters),
  };
}

export function distinctArcadeAnimationCount(fighter: CloudFighter): number {
  return new Set(
    fighter.sprites
      .map((sprite) => sprite.animationName.trim())
      .filter(Boolean),
  ).size;
}

function tierLabel(tier: CloudFighter['qualityTier'] | CachedMeta['qualityTier']): string {
  return QUALITY_TIERS.find((definition) => definition.id === tier)?.label ?? 'Contender';
}

function animationLabel(count: number): string {
  return `${count} ${count === 1 ? 'anim' : 'anims'}`;
}

function formatDate(value: number): string {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function GalleryFighterList({
  metas,
  arcadeFighters,
  selectedPhotoHash,
  loadingArcadeId,
  disabled = false,
  onSelectMeta,
  onSelectArcade,
  arcadeState,
}: GalleryFighterListProps) {
  const { globals, owned } = buildGalleryFighterSections(
    metas,
    arcadeFighters,
    arcadeState !== 'ready',
  );
  const globalStatus = arcadeState === 'loading'
    ? 'Loading global roster…'
    : arcadeState === 'unavailable'
      ? globals.length > 0
        ? 'Global roster unavailable. Showing saved globals.'
        : 'Global roster unavailable. Your fighters are still available.'
      : globals.length === 0
        ? 'No global fighters available.'
        : null;

  return (
    <div className="gallery-sidebar__list gallery-fighter-list">
      <section
        className="gallery-fighter-list__group"
        aria-labelledby="gallery-global-roster-title"
        aria-busy={arcadeState === 'loading'}
      >
        <header className="gallery-fighter-list__header">
          <h2 id="gallery-global-roster-title" className="gallery-fighter-list__title">
            Global roster
          </h2>
          <span
            className="gallery-fighter-list__count"
            aria-label={`${globals.length} global ${globals.length === 1 ? 'fighter' : 'fighters'}`}
          >
            {globals.length}
          </span>
        </header>

        {globalStatus ? (
          <p
            className="gallery-fighter-list__status"
            role={arcadeState === 'unavailable' ? 'alert' : 'status'}
          >
            {globalStatus}
          </p>
        ) : null}

        {globals.map(({ fighter, photoHash, cachedMeta }) => {
          const animationCount = fighter
            ? distinctArcadeAnimationCount(fighter)
            : cachedMeta?.animationsReady.length ?? 0;
          const isLoading = fighter !== null && loadingArcadeId === fighter.id;
          const isSelected = selectedPhotoHash === (cachedMeta?.photoHash ?? photoHash);
          const name = fighter?.name ?? cachedMeta?.characterName ?? 'Saved global fighter';
          const qualityTier = fighter?.qualityTier ?? cachedMeta?.qualityTier;
          return (
            <button
              key={photoHash}
              type="button"
              className={`gallery-fighter-card gallery-fighter-list__card${isSelected ? ' is-active' : ''}`}
              aria-pressed={isSelected}
              aria-busy={isLoading}
              disabled={disabled || (fighter !== null && loadingArcadeId !== null)}
              onClick={() => {
                if (fighter) {
                  onSelectArcade(fighter);
                } else if (cachedMeta) {
                  onSelectMeta(cachedMeta);
                }
              }}
            >
              <span className="gallery-fighter-card__name">{name}</span>
              <span className="gallery-fighter-card__meta">
                {tierLabel(qualityTier)} · {animationLabel(animationCount)} · {
                  isLoading
                    ? 'Loading…'
                    : fighter
                      ? cachedMeta ? 'Ready locally' : 'Load on select'
                      : 'Saved offline'
                }
              </span>
            </button>
          );
        })}
      </section>

      <section
        className="gallery-fighter-list__group"
        aria-labelledby="gallery-owned-fighters-title"
      >
        <header className="gallery-fighter-list__header">
          <h2 id="gallery-owned-fighters-title" className="gallery-fighter-list__title">
            Your fighters
          </h2>
          <span
            className="gallery-fighter-list__count"
            aria-label={`${owned.length} owned ${owned.length === 1 ? 'fighter' : 'fighters'}`}
          >
            {owned.length}
          </span>
        </header>

        {owned.length === 0 ? (
          <p className="gallery-fighter-list__status">No personal fighters yet.</p>
        ) : null}

        {owned.map((meta) => {
          const isSelected = selectedPhotoHash === meta.photoHash;
          return (
            <button
              key={meta.photoHash}
              type="button"
              className={`gallery-fighter-card gallery-fighter-list__card${isSelected ? ' is-active' : ''}`}
              aria-pressed={isSelected}
              disabled={disabled}
              onClick={() => onSelectMeta(meta)}
            >
              <span className="gallery-fighter-card__name">{meta.characterName}</span>
              <span className="gallery-fighter-card__meta">
                {tierLabel(meta.qualityTier)} · {formatDate(meta.createdAt)} · {animationLabel(meta.animationsReady.length)}
              </span>
            </button>
          );
        })}
      </section>
    </div>
  );
}
