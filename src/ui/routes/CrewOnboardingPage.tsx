import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  createCrewInviteLink,
  loadOnboardingStatus,
  shareFighterWithActiveCrew,
  syncOnboardingProgress,
  type CrewInviteLink,
  type OnboardingStatus,
} from '../../services/Crews.ts';
import { listCloudFighters } from '../../services/CloudFighters.ts';
import { withApiRequestTimeout } from '../../services/ApiClient.ts';
import { trackProductEvent } from '../../services/ProductEvents.ts';
import type { AuthStatus } from '../authState.ts';
import type { CrewMembershipSummary, CrewSummary } from '../crewState.ts';
import { Button } from '../components/Button.tsx';
import { StatusMessage } from '../components/StatusMessage.tsx';
import '../pages/product-entry.css';

interface CrewOnboardingPageProps {
  authStatus: AuthStatus;
  authSessionKey?: string;
  authSlot?: ReactNode;
  playerName: string;
  activeCrew: CrewSummary | null;
  crews: CrewMembershipSummary[];
  fighterId?: string | null;
  fighterPhotoHash?: string | null;
  onCreateCrew?: (name: string) => Promise<CrewSummary>;
  onSelectCrew?: (organizationId: string) => Promise<void>;
  onCreateFighter: () => void;
  onPlayTrial?: () => void;
  onPlayDebut?: (photoHash: string) => void;
  onCreateStage: () => void;
  onSignIn?: () => void;
  onComplete: () => void;
}

type MissionStep = 'create' | 'debut' | 'crew' | 'stage' | 'invite' | 'complete';

export function resolveCrewMissionStep({
  shared,
  canInviteCrew,
  crewStageReady,
  invitationAccepted,
  serverComplete = false,
  hasFighter = true,
  debutComplete = true,
}: {
  shared: boolean;
  canInviteCrew: boolean;
  crewStageReady: boolean;
  invitationAccepted: boolean;
  serverComplete?: boolean;
  hasFighter?: boolean;
  debutComplete?: boolean;
}): MissionStep {
  if (serverComplete) return 'complete';
  if (!hasFighter) return 'create';
  if (!debutComplete) return 'debut';
  if (!shared) return 'crew';
  if (!canInviteCrew) return 'complete';
  if (!invitationAccepted) return 'invite';
  return crewStageReady ? 'complete' : 'stage';
}

export function buildWhatsAppInviteUrl(inviteUrl: string, crewName: string): string {
  const message = [
    `PLAYER TWO WANTED — Join my Crew${crewName ? ` ${crewName}` : ''} in Insert Player.`,
    'Your first Rookie is included. Join us and help choose our home stage:',
    inviteUrl,
  ].join('\n');
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

async function copyInviteUrl(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.className = 'product-entry__copy-target';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Copy is unavailable in this browser.');
}

function suggestedCrewName(playerName: string): string {
  const clean = playerName.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${clean || 'Player'}'s Crew`.slice(0, 50);
}

export function CrewOnboardingPage({
  authStatus,
  authSessionKey,
  authSlot,
  playerName,
  activeCrew,
  crews,
  fighterId,
  fighterPhotoHash,
  onCreateCrew,
  onSelectCrew,
  onCreateFighter,
  onPlayTrial,
  onPlayDebut,
  onCreateStage,
  onSignIn,
  onComplete,
}: CrewOnboardingPageProps) {
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [shared, setShared] = useState(false);
  const [canInviteCrew, setCanInviteCrew] = useState(false);
  const [crewStageReady, setCrewStageReady] = useState(false);
  const [crewStageState, setCrewStageState] = useState<OnboardingStatus['crewStageState']>('unavailable');
  const [invitationSent, setInvitationSent] = useState(false);
  const [invitationAccepted, setInvitationAccepted] = useState(false);
  const [inviteLink, setInviteLink] = useState<CrewInviteLink | null>(null);
  const [crewName, setCrewName] = useState(() => suggestedCrewName(playerName));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const liveScope = useRef({ mounted: true, account: authSessionKey, crewId: activeCrew?.id ?? null });
  liveScope.current.account = authSessionKey;
  liveScope.current.crewId = activeCrew?.id ?? null;
  useEffect(() => {
    liveScope.current.mounted = true;
    return () => { liveScope.current.mounted = false; };
  }, []);

  const target = useMemo(() => ({
    id: fighterId ?? onboarding?.fighter?.id ?? null,
    photoHash: fighterPhotoHash ?? onboarding?.fighter?.photoHash ?? null,
    name: onboarding?.fighter?.name ?? 'your Rookie',
  }), [fighterId, fighterPhotoHash, onboarding?.fighter]);

  const applyOnboardingStatus = useCallback((status: OnboardingStatus) => {
    if (!liveScope.current.mounted || (status.activeCrew?.id ?? null) !== liveScope.current.crewId) return;
    setOnboarding(status);
    setCanInviteCrew(status.canInviteCrew);
    setCrewStageReady(status.crewStageReady);
    setCrewStageState(status.crewStageState);
    setInvitationSent(status.invitesSent > 0);
    setInvitationAccepted(status.invitesAccepted > 0);
    setInviteLink(status.pendingInvite);
    if ((!fighterId && !fighterPhotoHash) || status.fighter?.id === fighterId || status.fighter?.photoHash === fighterPhotoHash) {
      setShared(status.sharedWithActiveCrew);
    }
  }, [fighterId, fighterPhotoHash]);

  useEffect(() => {
    if (authStatus !== 'signed-in') return;
    let cancelled = false;
    setError(null);
    setOnboarding(null);
    setShared(false);
    const load = async () => {
      if (authSessionKey) {
        try { await syncOnboardingProgress(authSessionKey); }
        catch { if (!cancelled) setError('Your latest progress has not synced yet. You can retry without replaying your debut.'); }
      }
      const status = await loadOnboardingStatus();
      if (cancelled) return;
      applyOnboardingStatus(status);
      const statusFighterMatchesTarget = Boolean(status.fighter) && (
        (!fighterId && !fighterPhotoHash)
        || status.fighter?.id === fighterId
        || status.fighter?.photoHash === fighterPhotoHash
      );
      if (!statusFighterMatchesTarget && (fighterId || fighterPhotoHash)) {
        const fighters = await withApiRequestTimeout((signal) => listCloudFighters(undefined, { signal }));
        if (cancelled) return;
        const selected = fighters.find((fighter) => (fighterId && fighter.id === fighterId) || (fighterPhotoHash && fighter.photoHash === fighterPhotoHash));
        setShared(Boolean(activeCrew && selected?.access?.scope === 'crew' && selected.access.crewIds.includes(activeCrew.id)));
      }
    };
    void load().catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Crew progress could not be loaded.');
    });
    return () => { cancelled = true; };
  }, [activeCrew, applyOnboardingStatus, authStatus, authSessionKey, fighterId, fighterPhotoHash, loadAttempt]);

  const refreshCrewProgress = useCallback(async (announce = false) => {
    const scope = { ...liveScope.current };
    const status = await loadOnboardingStatus();
    if (!liveScope.current.mounted || scope.account !== liveScope.current.account || scope.crewId !== liveScope.current.crewId) return;
    applyOnboardingStatus(status);
    if (announce) {
      setMessage(status.crewMembershipVerificationUnavailable
        ? 'Crew verification is temporarily unavailable. Try again shortly; your progress is safe.'
        : status.invitesAccepted > 0
        ? 'Player Two joined. The Crew can choose its one included home stage.'
        : 'The link is still waiting for Player Two.');
    }
  }, [applyOnboardingStatus]);

  useEffect(() => {
    if (authStatus !== 'signed-in') return;
    const refreshOnReturn = () => { void refreshCrewProgress().catch(() => { /* keep current mission state */ }); };
    window.addEventListener('focus', refreshOnReturn);
    return () => window.removeEventListener('focus', refreshOnReturn);
  }, [authStatus, refreshCrewProgress]);

  const step = resolveCrewMissionStep({
    shared,
    canInviteCrew,
    crewStageReady,
    invitationAccepted,
    serverComplete: Boolean(onboarding?.complete),
    hasFighter: Boolean(target.id || target.photoHash),
    debutComplete: Boolean(onboarding?.debutComplete),
  });

  const selectAndShare = async (crew: CrewSummary | null, createName?: string) => {
    if (!target.id && !target.photoHash) {
      setError('Create your Rookie before building its Crew.');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    const account = authSessionKey;
    try {
      let selected = crew;
      if (createName) {
        if (!onCreateCrew) throw new Error('Crew creation is unavailable right now.');
        selected = await onCreateCrew(createName);
        trackProductEvent('crew_created', { game: 'aura', source: 'onboarding' });
        setCanInviteCrew(true);
      } else if (selected && selected.id !== activeCrew?.id) {
        if (!onSelectCrew) throw new Error('Crew selection is unavailable right now.');
        await onSelectCrew(selected.id);
      }
      if (!selected) throw new Error('Choose or create a Crew first.');
      if (!liveScope.current.mounted || liveScope.current.account !== account) return;
      const selectedStatus = await loadOnboardingStatus();
      if (selectedStatus.activeCrew?.id !== selected.id) throw new Error('Your active Crew changed. Select the intended Crew and try again.');
      await shareFighterWithActiveCrew(target);
      if (!liveScope.current.mounted || liveScope.current.account !== account || liveScope.current.crewId !== selected.id) return;
      setShared(true);
      void loadOnboardingStatus().then((status) => {
        applyOnboardingStatus(status);
      }).catch(() => { /* the local mission state remains usable */ });
      setMessage(`${target.name} is now available to ${selected.name}.`);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Your Rookie could not be shared with the Crew.');
    } finally {
      setBusy(false);
    }
  };

  const ensureInviteLink = async (): Promise<CrewInviteLink> => {
    // The previous one-use link may have been claimed while this tab stayed open.
    // The server reuses only a still-valid pending link, otherwise creates a new one.
    const scope = { ...liveScope.current };
    const next = await createCrewInviteLink();
    if (!liveScope.current.mounted || scope.account !== liveScope.current.account || scope.crewId !== liveScope.current.crewId) throw new Error('Your Crew changed. Open an invitation from the current Crew.');
    if (next.id !== inviteLink?.id) trackProductEvent('invite_created', { source: 'onboarding' });
    setInviteLink(next);
    setInvitationSent(true);
    return next;
  };

  const openWhatsAppInvite = async () => {
    const shareWindow = window.open('about:blank', '_blank');
    if (shareWindow) shareWindow.opener = null;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const invitation = await ensureInviteLink();
      const whatsappUrl = buildWhatsAppInviteUrl(invitation.url, activeCrew?.name ?? '');
      if (shareWindow) shareWindow.location.replace(whatsappUrl);
      else window.location.assign(whatsappUrl);
      setMessage('WhatsApp opened. The first verified friend to use this link joins the Crew.');
    } catch (cause: unknown) {
      shareWindow?.close();
      setError(cause instanceof Error ? cause.message : 'The invite link could not be created.');
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    setBusy(true);
    setError(null);
    try {
      const invitation = await ensureInviteLink();
      await copyInviteUrl(invitation.url);
      setMessage('Invite link copied. Send it to Player Two.');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'The invite link could not be copied.');
    } finally {
      setBusy(false);
    }
  };

  if (authStatus !== 'signed-in') {
    return (
      <div className="product-entry">
        <section className="product-entry__identity">
          <div className="product-entry__identity-copy">
            <h1>Your First Aura Run</h1>
            <p>Learn the beat, create your own Rookie, then bring your friends and choose a home stage together.</p>
            {onPlayTrial ? <Button variant="primary" size="lg" onClick={onPlayTrial}>Try Aura First</Button> : null}
            {onSignIn ? <Button variant={onPlayTrial ? 'ghost' : 'primary'} onClick={onSignIn}>Sign In To Continue</Button> : authSlot}
          </div>
          <div className="gallery-panel">
            <h2>Next Mission</h2>
            <p className="roster-hero__copy">Create a Crew · Invite Player Two · Choose one shared stage together</p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="product-entry">
      <div className="product-entry__page-heading">
        <div>
          <p className="product-entry__genre">Aura onboarding</p>
          <h1>{step === 'create' || step === 'debut' ? 'Your First Aura Run' : 'Build Your Crew'}</h1>
        </div>
        <Button variant="ghost" onClick={onComplete}>Finish Later</Button>
      </div>

      <section className="product-entry__identity" aria-label="Crew missions">
        <div className="product-entry__identity-copy">
          {!onboarding ? (
            <>
              <h2>Loading your next mission…</h2>
              <p>Your progress is saved to your account.</p>
            </>
          ) : <>
          <h2>{step === 'create' ? 'Make it your game' : step === 'debut' ? 'Take your Rookie on stage' : step === 'crew'
            ? 'Share your Rookie'
            : step === 'stage'
              ? "Choose your Crew's home stage"
              : step === 'invite'
                ? 'Bring in Player Two'
                : 'Crew Ready'}</h2>
          {step === 'create' ? <>
            <p>Turn one photo into your own playable character. Your first Rookie is included.</p>
            <Button variant="primary" size="lg" onClick={onCreateFighter}>Create My Rookie</Button>
            {!onboarding.trialComplete && onPlayTrial ? <Button variant="ghost" onClick={onPlayTrial}>Try Aura First</Button> : null}
          </> : null}
          {step === 'debut' ? <>
            <p>Play one Aura match as {target.name}. Then bring your friends into the Crew.</p>
            {target.photoHash && onPlayDebut ? <Button variant="primary" size="lg" onClick={() => onPlayDebut(target.photoHash!)}>Play My Aura Debut</Button> : <Button onClick={onComplete}>Choose My Character</Button>}
          </> : null}
          {step === 'crew' ? (
            <>
              <p>Crew members can select each other's characters in the roster. Your original photo and raw files stay out of the shared copy.</p>
              {activeCrew ? (
                <Button variant="primary" size="lg" disabled={busy} onClick={() => void selectAndShare(activeCrew)}>
                  {busy ? 'Sharing…' : `Share With ${activeCrew.name}`}
                </Button>
              ) : null}
              {!activeCrew && crews.length > 0 ? (
                <div className="gallery-actions" aria-label="Your Crews">
                  {crews.map((crew) => (
                    <Button key={crew.id} disabled={busy} onClick={() => void selectAndShare(crew)}>
                      Select {crew.name}
                    </Button>
                  ))}
                </div>
              ) : null}
              {!activeCrew && crews.length === 0 ? (
                <form className="create-form" onSubmit={(event) => {
                  event.preventDefault();
                  if (crewName.trim()) void selectAndShare(null, crewName.trim());
                }}>
                  <label className="create-form__field">
                    <span>Crew name</span>
                    <input type="text" maxLength={50} required value={crewName} onChange={(event) => setCrewName(event.target.value)} />
                  </label>
                  <Button type="submit" variant="primary" size="lg" disabled={busy || !crewName.trim()}>
                    {busy ? 'Creating Crew…' : 'Create Crew & Share Rookie'}
                  </Button>
                </form>
              ) : null}
              {!target.id && !target.photoHash ? <Button onClick={onCreateFighter}>Create My Rookie</Button> : null}
            </>
          ) : null}

          {step === 'stage' ? (
            <>
              <p>
                Your Crew gets exactly one shared stage included—not one per player. Pick the bar,
                park, football pitch, or corner that belongs to the whole Crew.
              </p>
              <p className="product-entry__pricing-note">
                Wait until everyone who should have a say has joined. Once the stage is locked, every Crew member
                can use it and the included Crew slot is spent.
              </p>
              <Button variant="primary" size="lg" onClick={onCreateStage}>
                {crewStageState === 'reserved' ? 'Finish Choosing Crew Stage' : 'Choose Crew Stage · Included'}
              </Button>
              <div className="create-form">
                <p>Still assembling the Crew? Send another one-time link before you lock the stage.</p>
                <Button disabled={busy} onClick={() => void openWhatsAppInvite()}>
                  {busy ? 'Preparing Link…' : 'Invite Another Player on WhatsApp'}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => void copyLink()}>
                  Copy Invite Link
                </Button>
              </div>
            </>
          ) : null}

          {step === 'invite' ? (
            <div className="create-form">
              {onboarding.crewMembershipVerificationUnavailable ? <StatusMessage severity="error">We could not verify who has joined right now. Retry in a moment; no stage has been spent.</StatusMessage> : null}
              <p>Send Player Two a one-time link. Once they join, decide your Crew's one included home stage together.</p>
              <Button variant="primary" size="lg" disabled={busy} onClick={() => void openWhatsAppInvite()}>
                {busy ? 'Preparing Link…' : 'Invite Player Two on WhatsApp'}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void copyLink()}>
                Copy Invite Link
              </Button>
              {invitationSent ? (
                <Button disabled={busy} onClick={() => void refreshCrewProgress(true).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Crew progress could not be refreshed.'))}>
                  Check If Player Two Joined
                </Button>
              ) : null}
              {invitationSent ? <p className="product-entry__pricing-note">Link ready · waiting for Player Two</p> : null}
              <p className="product-entry__pricing-note">Your bonus Rookie unlocks only after your friend accepts with a verified Google, Apple, or Microsoft account, creates their Rookie, and completes their Aura debut. Up to 3 bonus Rookies.</p>
            </div>
          ) : null}

          {step === 'complete' ? (
            <>
              <p>{crewStageReady
                  ? 'Your Rookie and home stage are shared with the Crew.'
                  : 'Your Rookie is shared. A Crew admin will choose the one included home stage.'} New Crew fighters and the Crew stage appear automatically in character select.</p>
              <Button variant="primary" size="lg" onClick={onComplete}>Enter Insert Player</Button>
              {canInviteCrew ? <div className="create-form">
                <p>The Crew can keep growing. Each link is for one friend; your shared stage stays the same.</p>
                <Button disabled={busy} onClick={() => void openWhatsAppInvite()}>{busy ? 'Preparing Link…' : 'Invite Another Player on WhatsApp'}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => void copyLink()}>Copy Invite Link</Button>
              </div> : null}
            </>
          ) : null}
          </>}

          {error ? <><StatusMessage severity="error">{error}</StatusMessage><Button disabled={busy} onClick={() => setLoadAttempt((value) => value + 1)}>Retry Progress</Button></> : null}
          {message ? <StatusMessage severity="success">{message}</StatusMessage> : null}
        </div>

        <div className="product-entry__pricing">
          <p className="product-entry__pricing-context">Your first run</p>
          <dl>
            <div>
              <dt>1 · Learn Aura <span>Play the guided trial</span></dt>
              <dd>{onboarding?.trialComplete ? 'Done' : 'Optional'}</dd>
            </div>
            <div>
              <dt>2 · Create your Rookie <span>One photo · first Rookie included</span></dt>
              <dd>{target.id || target.photoHash ? 'Done' : 'Next'}</dd>
            </div>
            <div>
              <dt>3 · Aura debut <span>Play once as your own character</span></dt>
              <dd>{onboarding?.debutComplete ? 'Done' : target.id || target.photoHash ? 'Next' : 'Locked'}</dd>
            </div>
            <div>
              <dt>4 · Build a Crew <span>Share your Rookie with friends</span></dt>
              <dd>{shared ? 'Done' : 'Next'}</dd>
            </div>
            <div>
              <dt>5 · Invite Player Two <span>{canInviteCrew ? 'Assemble the Crew' : 'Crew admin mission'}</span></dt>
              <dd>{!canInviteCrew && shared ? 'Not needed' : invitationAccepted ? 'Done' : invitationSent ? 'Waiting' : shared ? 'Next' : 'Locked'}</dd>
            </div>
            <div>
              <dt>6 · Choose a home stage <span>One included per Crew · decide together</span></dt>
              <dd>{crewStageReady ? 'Done' : !canInviteCrew && shared ? 'Crew admin' : invitationAccepted ? 'Next' : 'Locked'}</dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  );
}
