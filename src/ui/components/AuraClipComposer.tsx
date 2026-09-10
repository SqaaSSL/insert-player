import { useEffect, useRef, useState } from 'react';
import { encodeAuraChallenge, type AuraChallenge } from '../../game/aura/AuraChallenge.ts';
import { AuraClipError, auraClipShareData, getAuraClip, hasAuthenticatedAuraClipSession, prepareAuraClip, rememberAuraClipOwner, uploadAuraClip,
  validateAuraClipFile, type AuraClip, type AuraClipUpload } from '../../services/AuraClips.ts';
import { shareAuraChallenge } from '../shared/auraChallengeShare.ts';
import { copyToClipboard } from '../shared/communityShare.ts';
import { TurnstileChallenge } from './TurnstileChallenge.tsx';
import { downloadAuraVideo } from './AuraMatchShare.ts';
import { rememberAuraChallenge } from '../shared/auraChallenges.ts';
import { trackProductEvent } from '../../services/ProductEvents.ts';
import '../aura-clips.css';

interface AuraClipComposerProps {
  file: File;
  challenge: AuraChallenge | null;
  onLockChange: (locked: boolean) => void;
  onCreated?: (challenge: AuraChallenge) => void;
}

export function AuraClipComposer({ file, challenge, onLockChange, onCreated }: AuraClipComposerProps) {
  const [clip, setClip] = useState<AuraClip | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const active = useRef(false);
  const upload = useRef<AuraClipUpload | null>(null);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const siteKey = String(import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim();
  let fileError: string | null = null;
  try { validateAuraClipFile(file); } catch (reason) { fileError = (reason as Error).message; }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);

  const publish = async (token?: string) => {
    if (!challenge || active.current || clip || fileError) return;
    active.current = true;
    onLockChange(true);
    setBusy(true); setError(false); setStatus(null); setProgress(null); setVerifying(false);
    controller.current = new AbortController();
    try {
      // A response can be lost after the server finishes. Recover that same link
      // before retrying bytes or consuming another publishing reservation.
      let ready: AuraClip | null = null;
      if (upload.current) {
        for (let attempt = 0; attempt < 13; attempt += 1) {
          try { ready = await getAuraClip(upload.current.id, controller.current.signal, upload.current.uploadToken); break; }
          catch (reason) {
            if (!(reason instanceof AuraClipError)) throw reason;
            if (reason.status === 404 || reason.status === 410) {
              upload.current = null;
              if (siteKey && !await hasAuthenticatedAuraClipSession()) {
                if (mounted.current) { setStatus(null); setTurnstileToken(null); setVerifying(true); }
                return;
              }
              if (!mounted.current) return;
              break;
            }
            if (reason.status === 409 && reason.code === 'clip_pending') break;
            if (reason.status !== 409 || reason.code !== 'clip_uploading') throw reason;
            if (attempt === 12) throw new Error('The upload is still finishing. Wait a moment, then retry to recover the same link.');
            setStatus('Your upload is still finishing. Recovering the same link…');
            await new Promise(resolve => setTimeout(resolve, 5_000));
            if (!mounted.current) return;
          }
        }
      }
      if (!ready) {
        if (!upload.current) upload.current = await prepareAuraClip(file, encodeAuraChallenge(challenge), token);
        if (!mounted.current) return;
        setProgress(0);
        ready = await uploadAuraClip(file, upload.current, value => { if (mounted.current) setProgress(value); }, controller.current.signal);
      }
      if (!mounted.current || !ready) return;
      if (upload.current) rememberAuraClipOwner(ready.id, upload.current.deleteToken, ready.expiresAt);
      setClip(ready);
      setStatus('Your battle link is ready. Share it or copy it below.');
      rememberAuraChallenge(challenge, 'created');
      trackProductEvent('challenge_created', { game: 'aura', source: 'challenge' });
      onCreated?.(challenge);
    } catch (reason) {
      if (!mounted.current) return;
      setError(true);
      setStatus(reason instanceof Error ? reason.message : 'Publishing failed. Your video is still on this device.');
      if (!upload.current) onLockChange(false);
      setTurnstileToken(null); setReset(value => value + 1);
    } finally {
      active.current = false;
      if (mounted.current) { setBusy(false); setProgress(null); }
    }
  };

  useEffect(() => {
    if (verifying && turnstileToken) void publish(turnstileToken);
  }, [verifying, turnstileToken]);

  const prepare = async () => {
    if (!challenge || active.current || fileError) return;
    setStatus(null); setError(false);
    if (siteKey && !upload.current) {
      active.current = true; setBusy(true); onLockChange(true);
      const signedIn = await hasAuthenticatedAuraClipSession();
      active.current = false;
      if (!mounted.current) return;
      setBusy(false);
      if (!signedIn) { setVerifying(true); return; }
    }
    void publish();
  };
  const handoff = async (copy: boolean) => {
    if (!clip || active.current) return;
    active.current = true; setBusy(true); setError(false);
    try {
      const result = copy ? await copyToClipboard(clip.shareUrl) ? 'copied' : 'manual'
        : await shareAuraChallenge(auraClipShareData(clip, challenge));
      setManualCopy(result === 'manual');
      setStatus(result === 'shared' ? 'Battle link handed to your sharing app.'
        : result === 'copied' ? 'Battle link copied.' : result === 'cancelled' ? 'Your battle link is ready whenever you want to share it.'
          : 'Select and copy your battle link below.');
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  };
  return (
    <div className="aura-clip-composer">
      <p className="aura-challenge-composer__notice">{clip ? 'Watch, download and play your challenge, all from one Insert Player link.'
        : 'Publish your match video on Insert Player. Anyone with the link can watch and download it for 30 days.'}</p>
      {verifying ? <div className="aura-clip-composer__verification">
        <p role="status">Verifying before publishing…</p>
        <TurnstileChallenge siteKey={siteKey} action="aura_share" resetSignal={reset} onTokenChange={setTurnstileToken} />
        <button className="asf-btn asf-btn--ghost" type="button" onClick={() => { setVerifying(false); onLockChange(false); }}>Cancel publishing</button>
      </div> : <div className="aura-clip-composer__actions">
        {clip ? <>
          <button type="button" className="asf-btn asf-btn--primary" disabled={busy} onClick={() => void handoff(false)}>Share battle link</button>
          <button type="button" className="asf-btn" disabled={busy} onClick={() => void handoff(true)}>Copy battle link</button>
          <a className="aura-challenge-composer__link" href={clip.shareUrl} target="_blank" rel="noopener noreferrer">Watch your battle</a>
        </> : <button type="button" className="asf-btn asf-btn--primary" disabled={busy || !challenge || Boolean(fileError)} onClick={() => void prepare()}>
          {busy ? progress === null ? 'Preparing your link…' : progress === 100 ? 'Finishing upload…' : `Uploading ${progress}%…`
            : status && error ? 'Retry publishing' : 'Create battle link'}
        </button>}
        <button type="button" className="asf-btn asf-btn--ghost" onClick={() => {
          try { downloadAuraVideo(file); } catch { setError(true); setStatus('Download could not start. Try the video player’s download option.'); }
        }}>Download video</button>
      </div>}
      {progress !== null ? <progress className="aura-clip-composer__progress" value={progress} max={100} aria-label="Battle video upload" /> : null}
      {busy && !clip ? <p className="aura-challenge-composer__notice" role="status">Keep this page open until your link is ready.</p> : null}
      {fileError || status ? <p className={`aura-challenge-composer__notice${error || fileError ? ' is-error' : ''}`} role="status">{fileError || status}</p> : null}
      {clip && manualCopy ? <label>Battle link<input readOnly value={clip.shareUrl} onFocus={event => event.currentTarget.select()} /></label> : null}
    </div>
  );
}
