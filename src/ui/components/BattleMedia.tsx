import { useEffect, useRef, useState } from 'react';
import { battleMediaUrl, loadBattleMedia, type BattleMediaKind, type SavedBattle } from '../../services/BattleFinishers.ts';
import { downloadBlob } from '../shared/downloadBlob.ts';

export function useBattleMedia(battle: SavedBattle, kind: BattleMediaKind, sessionKey: string) {
  const [state, setState] = useState<{ key: string; url?: string; error?: string }>({ key: '' });
  const supplied = kind === 'still' ? battle.stillUrl : kind === 'recording' ? battle.recordingUrl : battle.finisher?.videoUrl;
  const key = `${sessionKey}:${battle.id}:${kind}:${battle.published}:${supplied ?? ''}`;
  useEffect(() => {
    if (!supplied) return;
    const controller = new AbortController();
    let ownedUrl: string | undefined;
    setState({ key });
    try {
      const url = battleMediaUrl(battle, kind);
      if (battle.published) { setState({ key, url }); return; }
      void loadBattleMedia(battle, kind, controller.signal).then(blob => {
        if (controller.signal.aborted) return;
        ownedUrl = URL.createObjectURL(blob); setState({ key, url: ownedUrl });
      }).catch(error => { if (!controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : 'Media could not load.' }); });
    } catch (error) { setState({ key, error: error instanceof Error ? error.message : 'Media could not load.' }); }
    return () => { controller.abort(); if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
  }, [key]);
  return state.key === key ? state : { key };
}

export function BattleMedia({ battle, kind, sessionKey = 'public', onEnded, continuePlayback = false }: { battle: SavedBattle; kind: BattleMediaKind; sessionKey?: string; onEnded?: () => void; continuePlayback?: boolean }) {
  const media = useBattleMedia(battle, kind, sessionKey);
  const [decodeError, setDecodeError] = useState(false);
  const continuationAttempt = useRef<string | null>(null);
  useEffect(() => setDecodeError(false), [media.url]);
  const label = `${battle.summary.game.toUpperCase()} ${kind === 'still' ? 'final battle frame' : kind === 'finisher' ? 'AI finisher' : 'full battle recording'}`;
  if (media.error || decodeError) return <p className="battle-finisher__notice" role="alert">{media.error ?? 'This browser cannot play the video. Use Download below.'}</p>;
  if (!media.url && kind === 'still') return <div className="battle-media__loading" role="status">Loading battle…</div>;
  return kind === 'still' ? <img className="battle-media" src={media.url} alt={label} loading="lazy" />
    : <video className="battle-media" src={media.url} controls playsInline preload="metadata" aria-label={label} onError={() => setDecodeError(true)} onEnded={onEnded}
      onCanPlay={event => { if (continuePlayback && media.url && continuationAttempt.current !== media.url) { continuationAttempt.current = media.url; void event.currentTarget.play().catch(() => undefined); } }} />;
}

export function BattleDownload({ battle, kind }: { battle: SavedBattle; kind: 'recording' | 'finisher' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try { const blob = await loadBattleMedia(battle, kind); downloadBlob(blob, `insert-player-${battle.summary.game}-${kind}.${blob.type.includes('webm') ? 'webm' : 'mp4'}`); }
    catch { setError('Download could not start. Try again.'); }
    finally { setBusy(false); }
  };
  return <span className="battle-download"><button className="battle-text-button" type="button" disabled={busy} onClick={() => void download()}>
    {busy ? 'Preparing download…' : `Download ${kind === 'finisher' ? 'finisher' : 'battle video'}`}</button>{error ? <span role="status">{error}</span> : null}</span>;
}
