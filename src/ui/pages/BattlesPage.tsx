import { useEffect, useState } from 'react';
import { battleHeadline, listSavedBattles, type SavedBattle } from '../../services/BattleFinishers.ts';
import type { AuthRouteState } from '../authState.ts';
import { BattleFinisherPanel } from '../components/BattleFinisherPanel.tsx';
import { BattleMedia } from '../components/BattleMedia.tsx';
import { listBattleDrafts, removeBattleDraft, type BattleDraft } from '../shared/battleDrafts.ts';
import '../battle-finishers.css';

interface BattlesPageProps extends AuthRouteState {
  onSignIn?: () => void;
  onBuyCredits?: () => void;
  onExplore: () => void;
  onOpenBattle: (id: string) => void;
}
export function BattlesPage({ authStatus, authSessionKey, onSignIn, onBuyCredits, onExplore, onOpenBattle }: BattlesPageProps) {
  const [items, setItems] = useState<SavedBattle[]>([]);
  const [drafts, setDrafts] = useState<BattleDraft[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [loadedScope, setLoadedScope] = useState(authSessionKey);
  useEffect(() => {
    const controller = new AbortController(); setItems([]); setDrafts([]); setError(null); setSelected(null); setLoadedScope(authSessionKey);
    void listBattleDrafts(authSessionKey).then(value => { if (!controller.signal.aborted) setDrafts(value); });
    if (authStatus !== 'signed-in') { setLoading(false); return () => controller.abort(); }
    setLoading(true);
    void listSavedBattles(controller.signal).then(value => { if (!controller.signal.aborted) setItems(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Your battles could not load.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [authStatus, authSessionKey, retry]);
  const visibleItems = loadedScope === authSessionKey ? items : [];
  const visibleDrafts = loadedScope === authSessionKey ? drafts : [];
  const pending = visibleDrafts.filter(draft => !draft.battleId || !visibleItems.some(battle => battle.id === draft.battleId));
  return <section className="battle-history">
    <div className="battle-history__header"><div><p className="battle-finisher__eyebrow">INSERT PLAYER</p><h1>My battles</h1><p>Every victory. Every last move.</p></div><button className="asf-btn" type="button" onClick={onExplore}>Play again</button></div>
    {pending.length ? <div className="battle-history__drafts"><h2>Ready to save</h2><p>These final frames are on this device. Choose a battle to save it or make its finisher.</p>{pending.map(draft => <div className="battle-history__draft" key={draft.capture.clientBattleId}>
      <div className="battle-history__draft-heading"><span>{draft.capture.summary.game.toUpperCase()} · {battleHeadline(draft.capture.summary)}</span><button className="battle-text-button" type="button" onClick={() => setSelected(selected === draft.capture.clientBattleId ? null : draft.capture.clientBattleId)}>{selected === draft.capture.clientBattleId ? 'Close' : 'Continue'}</button><button className="battle-text-button" type="button" onClick={() => void removeBattleDraft(draft.scope, draft.capture.clientBattleId).then(() => setDrafts(rows => rows.filter(row => row !== draft)))}>Discard local frame</button></div>
      {selected === draft.capture.clientBattleId ? <BattleFinisherPanel capture={draft.capture} battleId={draft.battleId} authStatus={authStatus} authSessionKey={authSessionKey} onSignIn={onSignIn} onBuyCredits={onBuyCredits} onBattleChange={battle => setItems(rows => [battle, ...rows.filter(row => row.id !== battle.id)])} /> : null}
    </div>)}</div> : null}
    {authStatus !== 'signed-in' ? <div className="battle-history__empty"><h2>Keep your battles together.</h2><p>Sign in to save final frames and finishers privately. Sharing is always your choice.</p><button className="asf-btn asf-btn--primary" type="button" disabled={authStatus === 'loading' || !onSignIn} onClick={onSignIn}>{authStatus === 'loading' ? 'Checking your account…' : 'Sign in'}</button></div> : null}
    {loading ? <p role="status">Loading your battles…</p> : null}
    {error ? <div role="alert"><p>{error}</p><button className="asf-btn" type="button" onClick={() => setRetry(value => value + 1)}>Retry loading</button></div> : null}
    {!loading && !error && authStatus === 'signed-in' && !visibleItems.length && !pending.length ? <div className="battle-history__empty"><h2>Your next win goes here.</h2><p>Finish a match of Aura, Fight or Rush, then choose Save battle.</p></div> : null}
    <div className="battle-history__grid">{visibleItems.map(battle => <article className="battle-history__card" key={battle.id}><button type="button" className="battle-history__open" onClick={() => onOpenBattle(battle.id)}>
      <BattleMedia battle={battle} kind="still" sessionKey={authSessionKey} /><div className="battle-history__card-copy"><p>{battle.summary.game.toUpperCase()} · {battle.published ? 'PUBLIC LINK' : 'PRIVATE'}</p><h2>{battleHeadline(battle.summary)}</h2><p>{battle.finisher?.status === 'ready' ? 'Finisher ready' : battle.finisher?.status === 'generating' || battle.finisher?.status === 'queued' ? 'Finisher in progress' : battle.finisher?.status === 'failed' ? 'Finisher needs attention' : battle.summary.stageLabel}</p></div>
    </button></article>)}</div>
  </section>;
}
