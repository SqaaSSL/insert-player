import { useEffect, useRef, useState } from 'react';
import { BattleFinisherError, generateBattleFinisher, getSavedBattle, publishSavedBattle, saveBattleCapture, savedBattleShareData,
  type BattleCaptureDetail, type SavedBattle } from '../../services/BattleFinishers.ts';
import { assertApiRequestContextCurrent, captureApiRequestContext, type ApiRequestContext } from '../../services/ApiClient.ts';
import { BATTLE_FINISHER_CREDIT_COST } from '../../shared/BattleFinisher.ts';
import type { AuthRouteState } from '../authState.ts';
import { currentGenerationLegalAttestation } from '../legal.ts';
import { battleFinisherRequestId, removeBattleDraft, saveBattleDraft } from '../shared/battleDrafts.ts';
import { shareAuraChallenge } from '../shared/auraChallengeShare.ts';
import { BattleDownload, BattleMedia } from './BattleMedia.tsx';
import '../battle-finishers.css';

export interface BattleFinisherPanelProps extends AuthRouteState {
  capture: BattleCaptureDetail | null;
  battleId?: string;
  initialBattle?: SavedBattle;
  onSignIn?: () => void;
  onBuyCredits?: () => void;
  onBattleChange?: (battle: SavedBattle) => void;
}

/** All paid operations are deliberate clicks. Authentication, recovery and polling
 * never submit a new generation or make a private battle public. */
export function BattleFinisherPanel({ capture, battleId, initialBattle, authStatus, authSessionKey, onSignIn, onBuyCredits, onBattleChange }: BattleFinisherPanelProps) {
  const [stored, setStored] = useState<{ scope: string; battle: SavedBattle | null }>({ scope: authSessionKey, battle: initialBattle ?? null });
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [needsCredits, setNeedsCredits] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const active = useRef(false);
  const mounted = useRef(true);
  const callback = useRef(onBattleChange); callback.current = onBattleChange;
  const captureOwner = useRef({ id: capture?.clientBattleId, scope: authSessionKey });
  if (captureOwner.current.id !== capture?.clientBattleId) captureOwner.current = { id: capture?.clientBattleId, scope: authSessionKey };
  const captureAllowed = !capture || captureOwner.current.scope === authSessionKey || ['signed-out', 'loading', 'local'].includes(captureOwner.current.scope);
  const battle = stored.scope === authSessionKey ? stored.battle : null;
  const finisher = battle?.finisher;
  const pending = finisher?.status === 'queued' || finisher?.status === 'generating';
  const signedIn = authStatus === 'signed-in';
  const id = battle?.id ?? battleId ?? initialBattle?.id;
  const request = useRef<{ battleId: string; id: string } | null>(null);
  const observedRefund = useRef<string | null>(null);
  const update = (value: SavedBattle) => { if (!mounted.current) return; setStored({ scope: authSessionKey, battle: value }); callback.current?.(value); };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (initialBattle) setStored({ scope: authSessionKey, battle: initialBattle });
  }, [initialBattle, authSessionKey]);
  useEffect(() => { setConsent(false); setMessage(null); setError(false); setNeedsCredits(false); setShareLink(null); request.current = null; }, [authSessionKey, capture?.clientBattleId]);
  useEffect(() => {
    if (capture && captureAllowed) void saveBattleDraft(captureOwner.current.scope, capture, battle?.id);
  }, [capture, authSessionKey, battle?.id, captureAllowed]);
  useEffect(() => {
    if (finisher?.creditRefunded && observedRefund.current !== finisher.id) {
      observedRefund.current = finisher.id;
      window.dispatchEvent(new Event('insert-player-billing-changed'));
    }
  }, [finisher?.id, finisher?.creditRefunded]);
  useEffect(() => {
    if (!id || !signedIn) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const value = await getSavedBattle(id, controller.signal);
        if (controller.signal.aborted) return;
        setStored({ scope: authSessionKey, battle: value }); callback.current?.(value);
        if (value.finisher?.status === 'queued' || value.finisher?.status === 'generating') timer = setTimeout(() => void refresh(), 2_500);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(true); setMessage(reason instanceof Error ? reason.message : 'Could not check this finisher.');
      }
    };
    void refresh();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [id, signedIn, authSessionKey, retry, pending]);

  const preserve = async () => {
    if (!capture) return true;
    const saved = await saveBattleDraft(authSessionKey, capture, battle?.id);
    if (!saved) { setError(true); setMessage('This browser could not preserve your battle for sign-in. Keep this page open; your current recording is still available.'); }
    return saved;
  };
  const signIn = async () => { if (await preserve()) onSignIn?.(); };
  const withAction = async (action: () => Promise<void>) => {
    if (active.current) return;
    active.current = true; setBusy(true); setError(false); setMessage(null);
    try { await action(); }
    catch (reason) {
      if (!mounted.current) return;
      setError(true); setMessage(reason instanceof Error ? reason.message : 'This action could not finish. Try again.');
      setNeedsCredits(reason instanceof BattleFinisherError && reason.status === 402);
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  };
  const save = async (context: ApiRequestContext = captureApiRequestContext()): Promise<SavedBattle> => {
    if (!captureAllowed || (battle && !battle.isOwner)) throw new Error('Open this battle from the account that played it.');
    if (battle && (!capture?.recording || battle.recordingUrl)) return battle;
    if (!capture) throw new Error('The battle is still loading. Try again in a moment.');
    const value = await saveBattleCapture(capture, context);
    assertApiRequestContextCurrent(context);
    captureOwner.current = { id: capture.clientBattleId, scope: authSessionKey };
    update(value);
    await saveBattleDraft(authSessionKey, capture, value.id);
    if (signedIn) await removeBattleDraft('signed-out', capture.clientBattleId);
    return value;
  };
  const generate = () => withAction(async () => {
    if (!signedIn || !consent) return;
    const context = captureApiRequestContext();
    const value = await save(context);
    if (value.finisher && value.finisher.status !== 'failed') { update(value); setRetry(count => count + 1); return; }
    if (!request.current || request.current.battleId !== value.id) {
      request.current = { battleId: value.id, id: battleFinisherRequestId(authSessionKey, value.id, value.finisher?.status === 'failed') };
    }
    const generated = await generateBattleFinisher(value.id, request.current.id, currentGenerationLegalAttestation(), context);
    assertApiRequestContextCurrent(context);
    update(generated);
    window.dispatchEvent(new Event('insert-player-billing-changed'));
    setConsent(false); setNeedsCredits(false); setRetry(count => count + 1);
  });
  const share = (finisherOnly: boolean) => withAction(async () => {
    const context = captureApiRequestContext();
    let value = await save(context);
    if (!value.published) value = await publishSavedBattle(value.id, context);
    assertApiRequestContextCurrent(context);
    update(value);
    const data = savedBattleShareData(value, finisherOnly);
    const result = await shareAuraChallenge(data);
    if (!mounted.current) return;
    setShareLink(result === 'manual' ? data.url : null);
    setMessage(result === 'shared' ? 'Insert Player link handed to your sharing app.' : result === 'copied' ? 'Insert Player link copied.'
      : result === 'cancelled' ? 'Your link is ready whenever you want to share it.' : 'Select and copy your Insert Player link below.');
  });
  if ((!capture && !id) || !captureAllowed) return null;
  const compactLabel = busy ? 'Preparing fatality…' : finisher?.status === 'queued' ? 'Fatality queued'
    : finisher?.status === 'generating' ? 'Creating fatality…' : finisher?.status === 'ready' ? 'Watch fatality'
      : finisher?.status === 'failed' ? `Retry fatality · ${BATTLE_FINISHER_CREDIT_COST} credit` : `Fatality · ${BATTLE_FINISHER_CREDIT_COST} credit`;
  const compactNote = pending ? 'Keep playing. Your finale will be in My battles.' : finisher?.status === 'ready' ? 'Ready to watch and share.'
    : finisher?.status === 'failed' ? finisher.creditRefunded ? 'Generation failed. Your credit was returned.' : 'Generation failed. Open for details.'
      : '5-second AI finale · saved with this battle';
  if (!expanded) return <section className="battle-finisher battle-finisher--compact" aria-label="Battle finisher">
    <button className="asf-btn asf-btn--primary battle-finisher__offer" type="button" aria-expanded={false} onClick={() => setExpanded(true)}>{compactLabel}</button>
    <p className="battle-finisher__offer-note" role={finisher ? 'status' : undefined}>{compactNote}</p>
  </section>;
  return <section className="battle-finisher" aria-label="Battle finisher">
    <div className="battle-finisher__heading"><h3>{finisher?.status === 'ready' ? 'Your fatality is ready.' : 'Fatality'}</h3>
      <button className="battle-text-button" type="button" aria-label="Close fatality details" onClick={() => setExpanded(false)}>Close</button></div>
    <p className="battle-finisher__notice">A five-second AI finale with sound, starring your winner and rival.</p>
    {!finisher && capture ? <details className="battle-finisher__frame"><summary>View the final frame</summary><img className="battle-finisher__source" src={`data:image/jpeg;base64,${capture.stillBase64.replace(/^data:image\/jpeg;base64,/, '')}`} alt="The final frame used to create your fatality" /></details> : null}
    {finisher?.status === 'ready' && battle ? <><div className="battle-finisher__preview"><BattleMedia battle={battle} kind="finisher" sessionKey={authSessionKey} /></div><BattleDownload battle={battle} kind="finisher" /></> : null}
    {pending ? <div className="battle-finisher__pending" role="status"><span className="battle-finisher__pulse" aria-hidden="true" /><strong>{finisher.status === 'queued' ? 'Your fatality is queued.' : 'Creating your fatality…'}</strong><p>Keep playing. Find it in My battles when it is ready.</p></div> : null}
    {finisher?.status === 'failed' ? <p className="battle-finisher__notice is-error" role="status">{finisher.error || 'This finale could not be made.'} {finisher.creditRefunded ? 'Your credit was returned.' : 'Check your credit balance before trying again.'}</p> : null}
    {!signedIn ? <div className="battle-finisher__actions"><button className="asf-btn asf-btn--primary" type="button" disabled={authStatus === 'loading' || !onSignIn} onClick={() => void signIn()}>{authStatus === 'loading' ? 'Checking your account…' : 'Sign in for your fatality'}</button><p className="battle-finisher__notice">Your frame stays saved here. Sign-in is free; generation costs 1 credit.</p></div> : null}
    {signedIn && (!finisher || finisher.status === 'failed') ? <>
      <label className="battle-finisher__consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>I am 18+ and have the rights to process the pictured characters. I agree to the <a href="/terms" target="_blank" rel="noreferrer">Terms</a> and <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>, request immediate AI generation and acknowledge the <a href="/refunds" target="_blank" rel="noreferrer">digital-content cancellation terms</a>. Keep it private until I choose Share.</span></label>
      <div className="battle-finisher__actions"><button className="asf-btn asf-btn--primary" type="button" disabled={busy || !consent} onClick={() => void generate()}>{busy ? 'Preparing fatality…' : `${finisher ? 'Try a new fatality' : 'Generate fatality'} · ${BATTLE_FINISHER_CREDIT_COST} credit`}</button>
        {!battle ? <button className="asf-btn" type="button" disabled={busy} onClick={() => void withAction(async () => { await save(); setMessage('Battle saved privately in My battles.'); })}>Save battle free</button> : null}
      </div>
    </> : null}
    {needsCredits && onBuyCredits ? <button className="asf-btn" type="button" onClick={() => void preserve().then(saved => { if (saved) onBuyCredits(); })}>Get credits</button> : null}
    {battle?.isOwner ? <div className="battle-finisher__sharing"><p className="battle-finisher__notice">{battle.published ? 'Anyone with the link can watch this battle and its finisher.' : 'Private in your account. Sharing makes the battle and its finisher public.'}</p>
      <div className="battle-finisher__actions"><button className="asf-btn" type="button" disabled={busy} onClick={() => void share(false)}>{battle.published ? 'Share battle' : 'Publish & share battle'}</button>
        {finisher?.status === 'ready' ? <button className="asf-btn" type="button" disabled={busy} onClick={() => void share(true)}>{battle.published ? 'Share finisher only' : 'Publish & share finisher'}</button> : null}
        <a className="battle-text-button" href={`/battles/${battle.id}`}>Open saved battle</a></div>
    </div> : null}
    {message ? <p className={`battle-finisher__notice${error ? ' is-error' : ''}`} role="status">{message}{error && pending ? <button className="battle-text-button" type="button" onClick={() => setRetry(count => count + 1)}>Check again</button> : null}</p> : null}
    {shareLink ? <label className="battle-finisher__copy">Share link<input readOnly value={shareLink} onFocus={event => event.currentTarget.select()} /></label> : null}
  </section>;
}
