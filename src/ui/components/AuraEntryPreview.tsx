import { GameplayEntryPreview } from './GameplayEntryPreview.tsx';

/** Portrait and landscape captures of the same Aura game reached by Play. */
export function AuraEntryPreview({ compact = false }: { compact?: boolean }) {
  return <GameplayEntryPreview mode="aura" compact={compact} />;
}
