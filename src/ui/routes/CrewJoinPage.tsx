import { useEffect, useRef, useState, type ReactNode } from 'react';
import { acceptCrewInviteLink, loadReferralLanding, type ReferralLanding } from '../../services/Crews.ts';
import { loadBillingProfile, type BillingProfile } from '../../services/Billing.ts';
import { trackProductEvent } from '../../services/ProductEvents.ts';
import type { AuthStatus } from '../authState.ts';
import type { CrewMembershipSummary, CrewSummary } from '../crewState.ts';
import { Button } from '../components/Button.tsx';
import { LoadingScreen } from '../components/LoadingScreen.tsx';
import { StatusMessage } from '../components/StatusMessage.tsx';
import '../pages/product-entry.css';

interface CrewJoinPageProps {
  referralId: string | null;
  authStatus: AuthStatus;
  authSlot?: ReactNode;
  activeCrew: CrewSummary | null;
  crews: CrewMembershipSummary[];
  onSelectCrew?: (organizationId: string) => Promise<void>;
  onSignIn?: () => void;
  onSignUp?: () => void;
  onCreateRookie: () => void;
  onPlayCrew?: () => void;
  onBack: () => void;
}

export function CrewJoinPage({
  referralId,
  authStatus,
  authSlot,
  activeCrew,
  crews,
  onSelectCrew,
  onSignIn,
  onSignUp,
  onCreateRookie,
  onPlayCrew,
  onBack,
}: CrewJoinPageProps) {
  const [invitation, setInvitation] = useState<ReferralLanding | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [billing, setBilling] = useState<BillingProfile | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (authStatus !== 'signed-in') return;
    let cancelled = false;
    void loadBillingProfile().then((result) => {
      if (!cancelled) setBilling(result.profile);
    });
    return () => { cancelled = true; };
  }, [authStatus]);

  useEffect(() => {
    let cancelled = false;
    if (!referralId) {
      setError('Invitation not found.');
      setLoading(false);
      return () => { cancelled = true; };
    }
    void loadReferralLanding(referralId).then((next) => {
      if (!cancelled) setInvitation(next);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Invitation not found.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [referralId]);

  if (loading) return <LoadingScreen label="Loading Crew invitation…" />;
  if (!invitation) {
    return (
      <div className="product-entry">
        <section className="gallery-panel">
          <h1>Invitation Unavailable</h1>
          <StatusMessage severity="error">{error ?? 'Invitation not found.'}</StatusMessage>
          <Button onClick={onBack}>Back To Insert Player</Button>
        </section>
      </div>
    );
  }

  const membership = crews.find((crew) => crew.id === invitation.organizationId) ?? null;
  const crewIsActive = activeCrew?.id === invitation.organizationId;
  const hasIncludedRookie = billing !== null && (billing.freeRookieGenerationsUsed === 0 || billing.referralRookiePasses > 0);
  const joinAndContinue = async (createRookie = false) => {
    setBusy(true);
    setError(null);
    try {
      if (!referralId) throw new Error('Invitation not found.');
      if (invitation.inviteChannel !== 'email' || (!membership && !crewIsActive)) await acceptCrewInviteLink(referralId);
      if (!mounted.current) return;
      if (!crewIsActive) {
        if (!onSelectCrew) throw new Error('Crew selection is unavailable right now.');
        await onSelectCrew(invitation.organizationId);
      }
      if (!mounted.current) return;
      setJoined(true);
      trackProductEvent('invite_accepted', { game: 'aura', source: 'referral' });
      if (createRookie) onCreateRookie();
      else if (onPlayCrew) onPlayCrew();
      else onBack();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Your Crew could not be opened.');
      setBusy(false);
    }
  };

  return (
    <div className="product-entry">
      <section className="product-entry__identity">
        <div className="product-entry__identity-copy">
          <p className="product-entry__genre">Crew invitation</p>
          <h1>{invitation.inviterName} Wants You In</h1>
          <p>Join {invitation.crewName} and play the Crew's shared characters. New players get their first Rookie included; joining another Crew does not reset that gift.</p>
          {authStatus !== 'signed-in' ? (
            <>
              {onSignUp ? <Button variant="primary" size="lg" onClick={onSignUp}>Create Account & Join</Button> : authSlot}
              {onSignIn ? <Button variant="ghost" onClick={onSignIn}>I Already Have An Account</Button> : null}
              <p className="product-entry__pricing-note">Use a real Google, Apple, or Microsoft account. Your account is verified before any referral reward unlocks.</p>
            </>
          ) : (
            <>
              <Button variant="primary" size="lg" disabled={busy} onClick={() => void joinAndContinue(hasIncludedRookie)}>
                {busy ? 'Joining Crew…' : hasIncludedRookie ? 'Join Crew & Create My Included Rookie' : crewIsActive || membership ? 'Play With My Crew' : 'Join Crew & Play'}
              </Button>
              {hasIncludedRookie ? <Button variant="ghost" disabled={busy} onClick={() => void joinAndContinue(false)}>Play With The Crew First</Button> : null}
              <p className="product-entry__pricing-note">One tap claims the link and adds you directly to the Crew.</p>
            </>
          )}
          {error ? <StatusMessage severity="error">{error}</StatusMessage> : null}
        </div>
        <div className="product-entry__pricing">
          <p className="product-entry__pricing-context">Your Crew run</p>
          <dl>
            <div><dt>1 · Join {invitation.crewName}</dt><dd>{joined || membership || crewIsActive ? 'Done' : 'Next'}</dd></div>
            <div><dt>2 · Choose your character <span>Use the Crew's characters, or create your own</span></dt><dd>Next</dd></div>
            <div><dt>3 · Play Aura together <span>Your Crew's shared stage belongs to everyone</span></dt><dd>Next</dd></div>
          </dl>
        </div>
      </section>
    </div>
  );
}
