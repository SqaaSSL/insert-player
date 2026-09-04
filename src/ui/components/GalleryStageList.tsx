import type { GalleryStageEntry } from '../shared/galleryStages.ts';

interface GalleryStageListProps {
  entries: GalleryStageEntry[];
  selectedIndex: number;
  disabled?: boolean;
  onSelect: (index: number) => void;
}

function formatDate(value: number): string {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function GalleryStageList({
  entries,
  selectedIndex,
  disabled = false,
  onSelect,
}: GalleryStageListProps) {
  const globals = entries.flatMap((entry, index) => (
    entry.scope === 'global' ? [{ entry, index }] : []
  ));
  const owned = entries.flatMap((entry, index) => (
    entry.scope === 'owned' ? [{ entry, index }] : []
  ));

  return (
    <div className="gallery-sidebar__list gallery-fighter-list">
      <section className="gallery-fighter-list__group" aria-labelledby="gallery-global-stages-title">
        <header className="gallery-fighter-list__header">
          <h2 id="gallery-global-stages-title" className="gallery-fighter-list__title">
            Global stages
          </h2>
          <span
            className="gallery-fighter-list__count"
            aria-label={`${globals.length} global ${globals.length === 1 ? 'stage' : 'stages'}`}
          >
            {globals.length}
          </span>
        </header>

        {globals.map(({ entry, index }) => (
          <button
            type="button"
            key={entry.key}
            className={`gallery-fighter-card${index === selectedIndex ? ' is-active' : ''}`}
            aria-pressed={index === selectedIndex}
            disabled={disabled}
            onClick={() => onSelect(index)}
          >
            <span className="gallery-fighter-card__name">{entry.theme.label}</span>
            <span className="gallery-fighter-card__meta">Official Arcade arena</span>
          </button>
        ))}
      </section>

      <section className="gallery-fighter-list__group" aria-labelledby="gallery-owned-stages-title">
        <header className="gallery-fighter-list__header">
          <h2 id="gallery-owned-stages-title" className="gallery-fighter-list__title">
            Your stages
          </h2>
          <span
            className="gallery-fighter-list__count"
            aria-label={`${owned.length} owned ${owned.length === 1 ? 'stage' : 'stages'}`}
          >
            {owned.length}
          </span>
        </header>

        {owned.length === 0 ? (
          <p className="gallery-fighter-list__status">No personal stages yet.</p>
        ) : null}

        {owned.map(({ entry, index }) => (
          <button
            type="button"
            key={entry.key}
            className={`gallery-fighter-card${index === selectedIndex ? ' is-active' : ''}`}
            aria-pressed={index === selectedIndex}
            disabled={disabled}
            onClick={() => onSelect(index)}
          >
            <span className="gallery-fighter-card__name">
              {(entry.stage.label ?? 'PHOTO STAGE').toUpperCase()}
            </span>
            <span className="gallery-fighter-card__meta">
              {formatDate(entry.stage.createdAt)} · {entry.stage.kind === 'photo-direct' ? 'direct photo' : 'forged'}
            </span>
          </button>
        ))}
      </section>
    </div>
  );
}
