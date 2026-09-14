import { useEffect, useState } from 'react';
import { BattleFinisherError, battleHeadline, deleteSavedBattle, getSavedBattle, savedBattleShareData, type SavedBattle } from '../../services/BattleFinishers.ts';
import type { BattleSummary } from '../../shared/BattleFinisher.ts';
import type { AuthRouteState } from '../authState.ts';
import { BattleDownload, BattleMedia } from '../components/BattleMedia.tsx';
import { BattleFinisherPanel } from '../components/BattleFinisherPanel.tsx';
import { shareAuraChallenge } from '../shared/auraChallengeShare.ts';
import '../battle-finishers.css';

interface BattleWatchPageProps extends AuthRouteState {
  battleId: string;
  finisherOnly?: boolean;
  onExplore: (game: BattleSummary['game']) => void;
  onSignIn?: () => void;
  onBuyCredits?: () => void;
}
export function BattleWatchPage({ battleId, ...props }: BattleWatchPageProps) {
  const [loaded, setLoaded] = useState<{ key: string; battle: SavedBattle } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const key = `${props.authSessionKey}:${battleId}`;
  useEffect(() => {
    const controller = new AbortController(); setLoaded(null); setError(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => getSavedBattle(battleId, controller.signal).then(battle => { if (!controller.signal.aborted) {
      setLoaded({ key, battle });
      if (battle.finisher?.status === 'queued' || battle.finisher?.status === 'generating') timer = setTimeout(() => void refresh(), 3_000);
    } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof BattleFinisherError && [401, 404].includes(reason.status)
        ? 'This battle is private, removed or unavailable. If it is yours, sign in to see it.' : 'The battle could not load. Try again.'); });
    void refresh();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [key, retry]);
  if (loaded?.key === key) return <BattleWatchContent {...props} battle={loaded.battle} onRemoved={() => { setLoaded(null); setError('This battle has been removed.'); }} onBattleChange={battle => setLoaded({ key, battle })} />;
  return <section className="battle-watch"><div className="battle-history__empty"><p className="battle-finisher__eyebrow">INSERT PLAYER</p><h1>{error ? 'This battle is not available.' : 'Loading the battle…'}</h1>{error ? <><p role="status">{error}</p><div className="battle-finisher__actions"><button className="asf-btn" type="button" onClick={() => setRetry(value => value + 1)}>Try again</button>{props.authStatus !== 'signed-in' && props.onSignIn ? <button className="asf-btn" type="button" onClick={props.onSignIn}>Sign in</button> : null}<button className="asf-btn asf-btn--primary" type="button" onClick={() => props.onExplore('aura')}>Play Aura free</button></div></> : null}</div></section>;
}

export function BattleWatchContent({ battle, finisherOnly = false, authStatus, authSessionKey, onExplore, onSignIn, onBuyCredits, onRemoved, onBattleChange }: Omit<BattleWatchPageProps, 'battleId'> & { battle: SavedBattle; onRemoved: () => void; onBattleChange?: (battle: SavedBattle) => void }) {
  const [part, setPart] = useState<'recording' | 'finisher'>(finisherOnly || !battle.recordingUrl ? 'finisher' : 'recording');
  const [message, setMessage] = useState<string | null>(null);
  const [copyLink, setCopyLink] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [continuePlayback, setContinuePlayback] = useState(false);
  const ready = battle.finisher?.status === 'ready';
  const hasVideo = part === 'recording' ? Boolean(battle.recordingUrl) : ready;
  const share = async () => {
    const data = savedBattleShareData(battle, finisherOnly);
    const result = await shareAuraChallenge(data);
    setCopyLink(result === 'manual' ? data.url : null);
    setMessage(result === 'shared' ? 'Insert Player link handed to your sharing app.' : result === 'copied' ? 'Insert Player link copied.' : result === 'cancelled' ? null : 'Select and copy the link below.');
  };
  const remove = async () => {
    if (removing) return; setRemoving(true);
    try { await deleteSavedBattle(battle.id); onRemoved(); }
    catch { setMessage('This battle could not be removed. Try again.'); setRemoving(false); }
  };
  const next = () => { if (!finisherOnly && ready && part === 'recording') { setContinuePlayback(true); setPart('finisher'); } };
  const choosePart = (value: 'recording' | 'finisher') => { setContinuePlayback(false); setPart(value); };
  return <section className="battle-watch"><div className="battle-watch__layout">
    <div className="battle-watch__screen">
      <BattleMedia battle={battle} kind={hasVideo ? part : 'still'} sessionKey={authSessionKey} onEnded={next} continuePlayback={continuePlayback} />
      {!finisherOnly && battle.recordingUrl && ready ? <div className="battle-watch__chapters" aria-label="Battle chapters"><button className={part === 'recording' ? 'is-active' : ''} type="button" onClick={() => choosePart('recording')}>1 · The battle</button><button className={part === 'finisher' ? 'is-active' : ''} type="button" onClick={() => choosePart('finisher')}>2 · The finisher</button></div> : null}
    </div>
    <div className="battle-watch__copy"><p className="battle-finisher__eyebrow">INSERT PLAYER · {battle.summary.game.toUpperCase()}{finisherOnly ? ' FINISHER' : ''}</p><h1>{battleHeadline(battle.summary)}</h1><p>{battle.summary.p1Name} vs {battle.summary.p2Name} · {battle.summary.stageLabel}</p>
      {finisherOnly && !ready ? <p role="status">This finisher is not ready yet.</p> : null}
      {part === 'finisher' && ready ? <p className="battle-watch__label">AI-generated finale from the real final frame.</p> : null}
      <div className="battle-finisher__actions"><button className="asf-btn asf-btn--primary" type="button" onClick={() => onExplore(battle.summary.game)}>Play {battle.summary.game === 'aura' ? 'Aura' : battle.summary.game === 'fight' ? 'Fight' : 'Rush'} free</button>{battle.published ? <button className="asf-btn" type="button" onClick={() => void share().catch(() => setMessage('Sharing could not start. Try again.'))}>Share {finisherOnly ? 'finisher' : 'battle'} link</button> : null}</div>
      <div className="battle-watch__secondary">{finisherOnly ? <a className="battle-text-button" href={`/battles/${battle.id}`}>Watch the full battle</a> : ready ? <a className="battle-text-button" href={`/battles/${battle.id}/finisher`}>Open finisher only</a> : null}{hasVideo ? <BattleDownload battle={battle} kind={part} /> : null}</div>
      {message ? <p role="status">{message}</p> : null}{copyLink ? <label className="battle-finisher__copy">Share link<input readOnly value={copyLink} onFocus={event => event.currentTarget.select()} /></label> : null}
    </div>
  </div>
    {battle.isOwner ? <div className="battle-watch__owner"><BattleFinisherPanel capture={null} initialBattle={battle} battleId={battle.id} authStatus={authStatus} authSessionKey={authSessionKey} onSignIn={onSignIn} onBuyCredits={onBuyCredits} onBattleChange={onBattleChange} />
      {confirmDelete ? <div className="battle-watch__delete"><p>Delete this saved battle and its finisher? Shared links will stop working.</p><button className="asf-btn asf-btn--danger" type="button" disabled={removing} onClick={() => void remove()}>{removing ? 'Deleting…' : 'Delete battle and finisher'}</button><button className="asf-btn" type="button" disabled={removing} onClick={() => setConfirmDelete(false)}>Keep battle</button></div> : <button className="battle-text-button" type="button" onClick={() => setConfirmDelete(true)}>Delete my battle</button>}
    </div> : null}
  </section>;
}
