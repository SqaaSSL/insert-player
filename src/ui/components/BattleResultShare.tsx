import { useEffect, useRef, useState } from 'react';
import { publishSavedBattle, savedBattleShareData, type SavedBattle } from '../../services/BattleFinishers.ts';
import { assertApiRequestContextCurrent, captureApiRequestContext } from '../../services/ApiClient.ts';
import { shareAuraChallenge } from '../shared/auraChallengeShare.ts';

/** Once saved, every result's main share action follows the durable battle,
 * including its finale, instead of publishing a second clip without it. */
export function BattleResultShare({ battle, onBattleChange }: { battle: SavedBattle; onBattleChange?: (battle: SavedBattle) => void }) {
  const hasFinale = Boolean(battle.finisher && battle.finisher.status !== 'failed');
  const label = hasFinale ? 'battle + finale' : 'battle';
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const share = async () => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setMessage(null);
    try {
      const context = captureApiRequestContext();
      const published = battle.published ? battle : await publishSavedBattle(battle.id, context);
      assertApiRequestContextCurrent(context);
      if (!mounted.current) return;
      onBattleChange?.(published);
      const data = savedBattleShareData(published);
      const outcome = await shareAuraChallenge(data);
      if (!mounted.current) return;
      setManualUrl(outcome === 'manual' ? data.url : null);
      setMessage(outcome === 'copied' ? hasFinale ? 'Battle link copied, including its finisher.' : 'Battle link copied.' : outcome === 'shared' ? 'Battle link shared.' : outcome === 'manual' ? 'Copy your battle link below.' : null);
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'Sharing could not finish. Try again.'); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className="battle-result-share">
    <button type="button" className="asf-btn" disabled={busy} onClick={() => void share()}>{busy ? 'Preparing battle link…' : battle.published ? `Share ${label}` : `Publish & share ${label}`}</button>
    {!battle.published ? <small>Sharing makes this battle{hasFinale ? ' and its finisher' : ''} public.</small> : null}
    {message ? <small role="status">{message}</small> : null}
    {manualUrl ? <input aria-label="Battle share link" readOnly value={manualUrl} onFocus={event => event.currentTarget.select()} /> : null}
  </div>;
}
