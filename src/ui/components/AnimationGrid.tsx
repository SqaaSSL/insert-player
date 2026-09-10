import type { GenerationPackage } from '../../services/GenerationPackages';
import { AURA_ANIMATION_NAMES } from '../../services/FighterAssetPacks';
import { getAnimationList } from '../../services/CharacterPipeline.ts';
import type {
  CachedFailedAnimationArtifact,
  CachedSprite,
} from '../../services/SpriteCache.ts';
import { animLabel } from '../shared/fighterPreview.ts';

type AnimState = 'ready' | 'failed' | 'generating' | 'pending';

interface AnimationGridProps {
  sprites: CachedSprite[];
  creationPackage?: GenerationPackage;
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
  creationPackage,
  failedArtifacts,
  generating,
  selectedName,
  onSelect,
}: AnimationGridProps) {
  const hasAura = sprites.some((sprite) => sprite.animationName.startsWith('aura_'));
  const hasCombat = sprites.some((sprite) => !sprite.animationName.startsWith('aura_'));
  const chosenPackage = creationPackage ?? (hasAura && !hasCombat ? 'aura' : 'complete');
  const names = [...getAnimationList(chosenPackage).map((animation) => animation.name),
    ...(chosenPackage === 'complete' && hasAura ? AURA_ANIMATION_NAMES : [])];
  return (
    <div className="gallery-anim-grid" role="group" aria-label="Animations">
      {names.map((name) => {
        const state = resolveState(name, sprites, failedArtifacts, generating);
        const isActive = selectedName === name;
        return (
          <button
            type="button"
            key={name}
            className={`gallery-anim-tile is-${state}${isActive ? ' is-active' : ''}`}
            aria-pressed={isActive}
            aria-label={`${animLabel(name)} animation, ${state}`}
            onClick={() => onSelect(name)}
          >
            <span>{animLabel(name)}</span>
            <small>{state}</small>
          </button>
        );
      })}
    </div>
  );
}
