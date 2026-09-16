import { useEffect, useState, type ReactNode } from 'react';
import { acceptCrewInviteLink, loadReferralLanding, type ReferralLanding } from '../../services/Crews.ts';
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
  onBack,
}: CrewJoinPageProps) {
  const [invitation, setInvitation] = useState<ReferralLanding | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  const joinAndContinue = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!referralId) throw new Error('Invitation not found.');
      if (!membership && !crewIsActive) await acceptCrewInviteLink(referralId);
      if (!crewIsActive) {
        if (!onSelectCrew) throw new Error('Crew selection is unavailable right now.');
        await onSelectCrew(invitation.organizationId);
      }
      setJoined(true);
      onCreateRookie();
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
          <p>Join {invitation.crewName}. You can play the Crew's shared characters and create your own included Rookie.</p>
          {authStatus !== 'signed-in' ? (
            <>
              {onSignUp ? <Button variant="primary" size="lg" onClick={onSignUp}>Create Account & Join</Button> : authSlot}
              {onSignIn ? <Button variant="ghost" onClick={onSignIn}>I Already Have An Account</Button> : null}
              <p className="product-entry__pricing-note">Use a real Google, Apple, or Microsoft account. Your account is verified before any referral reward unlocks.</p>
            </>
          ) : (
            <>
              <Button variant="primary" size="lg" disabled={busy} onClick={() => void joinAndContinue()}>
                {busy ? 'Joining Crew…' : crewIsActive || membership ? 'Continue To My Free Rookie' : 'Join Crew & Create My Free Rookie'}
              </Button>
              <p className="product-entry__pricing-note">One tap claims the link and adds you directly to the Crew.</p>
            </>
          )}
          {error ? <StatusMessage severity="error">{error}</StatusMessage> : null}
        </div>
        <div className="product-entry__pricing">
          <p className="product-entry__pricing-context">Your Crew run</p>
          <dl>
            <div><dt>1 · Join {invitation.crewName}</dt><dd>{joined || membership || crewIsActive ? 'Done' : 'Next'}</dd></div>
            <div><dt>2 · Create your Rookie <span>Your first Rookie is included</span></dt><dd>Next</dd></div>
            <div><dt>3 · Make your Aura debut <span>Then share your Rookie with the Crew</span></dt><dd>Locked</dd></div>
          </dl>
        </div>
      </section>
    </div>
  );
}
