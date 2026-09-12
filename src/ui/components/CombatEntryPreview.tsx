import { GameplayEntryPreview } from './GameplayEntryPreview.tsx';

export function CombatEntryPreview({ mode, compact = false }: { mode: 'fight' | 'rush'; compact?: boolean }) {
  return <GameplayEntryPreview mode={mode} compact={compact} />;
}
