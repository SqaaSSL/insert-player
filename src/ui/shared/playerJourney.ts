import type { FighterGameMode } from '../../services/FighterAssetPacks.ts';

export function rememberLastGame(scope: string, game: FighterGameMode): void {
  try { localStorage.setItem(`ip:last-game:${encodeURIComponent(scope)}`, game); } catch { /* Optional convenience. */ }
}

export function readLastGame(scope: string): FighterGameMode | null {
  try {
    const game = localStorage.getItem(`ip:last-game:${encodeURIComponent(scope)}`);
    return game === 'aura' || game === 'fight' || game === 'rush' ? game : null;
  } catch { return null; }
}
