import { getAnimationList } from '../../services/CharacterPipeline.ts';
import type {
  CachedFailedAnimationArtifact,
  CachedSprite,
} from '../../services/SpriteCache.ts';
import { animLabel } from '../shared/fighterPreview.ts';

type AnimState = 'ready' | 'failed' | 'generating' | 'pending';

interface AnimationGridProps {
  sprites: CachedSprite[];
  failedArtifacts?: Record<string, CachedFailedAnimationArtifact> | null;
  generating?: ReadonlySet<string>;
  selectedName?: string | null;
  onSelect: (name: string) => void;
}

function resolveState(
  name: string,
  sprites: CachedSprite[],
  failedArtifacts?: Record<string, CachedFailedAnimationArtifact> | null,
  generating?: ReadonlySet<string>,
): AnimState {
  if (generating?.has(name)) return 'generating';
  if (sprites.some((item) => item.animationName === name)) return 'ready';
  if (failedArtifacts?.[name]) return 'failed';
  return 'pending';
}

export function AnimationGrid({
  sprites,
  failedArtifacts,
  generating,
  selectedName,
  onSelect,
}: AnimationGridProps) {
  return (
    <div className="gallery-anim-grid" role="group" aria-label="Animations">
      {getAnimationList().map((anim) => {
        const state = resolveState(anim.name, sprites, failedArtifacts, generating);
        const isActive = selectedName === anim.name;
        return (
          <button
            type="button"
            key={anim.name}
            className={`gallery-anim-tile is-${state}${isActive ? ' is-active' : ''}`}
            aria-pressed={isActive}
            aria-label={`${animLabel(anim.name)} animation, ${state}`}
            onClick={() => onSelect(anim.name)}
          >
            <span>{animLabel(anim.name)}</span>
            <small>{state}</small>
          </button>
        );
      })}
    </div>
  );
}
