import { useEffect, useState } from 'react';
import {
  loadBillingProfile,
  loadCreditPacks,
  startCreditCheckout,
  verifyCreditCheckoutSession,
  type BillingProfile,
  type CreditPack,
} from '../../services/Billing.ts';
import {
  getLeaderboard,
  getMyStats,
  type LeaderboardEntry,
  type PlayerStats,
  type RecentMatch,
} from '../../services/Leaderboard.ts';
import type { AuthRouteState } from '../authState.ts';
import {
  clearPendingCheckout,
  clearPendingCheckoutForSession,
  checkoutReturnFromUrl,
  checkoutStatusMessage,
  checkoutVerificationMessage,
  consumeCheckoutReturn,
  readPendingCheckout,
  rememberPendingCheckout,
} from '../shared/checkoutStatus.ts';
import { PUBLIC_APP_NAME } from '../publicBrand.ts';
import { captureApiRequestContext } from '../../services/ApiClient.ts';
import { CheckoutConsent } from '../components/LegalConsent.tsx';
import { Button } from '../components/Button.tsx';
import type { LegalRoute } from '../components/LegalFooter.tsx';
import { currentCheckoutLegalAttestation } from '../legal.ts';
import { includedRookieStatus } from '../shared/rookieEntitlement.ts';

interface HomePageProps extends AuthRouteState {
  onCreateFighter: () => void;
  onOpenArcade: () => void;
  onNavigateLegal: (route: LegalRoute) => void;
  onOpenGallery: () => void;
  onOpenCommunity: () => void;
  onOpenWatchMode: () => void;
  onOpenVsCpu: () => void;
  onOpenVsPlayer: () => void;
  onOpenOnlineVersus: () => void;
  onOpenModeration: () => void;
}

const CHECKOUT_SESSION_REFRESH_DELAYS_MS = [0, 1_500, 3_500, 7_000, 12_000];

function recordLabel(wins: number, losses: number): string {
  return `${wins}W ${losses}L`;
}

function recentResultLabel(match: RecentMatch, playerId: string): string {
  if (!match.winnerId) return 'DRAW';
  return match.winnerId === playerId ? 'WIN' : 'LOSS';
}

export function HomePage({
  authStatus,
  authSessionKey,
  onCreateFighter,
  onOpenArcade,
  onNavigateLegal,
  onOpenGallery,
  onOpenCommunity,
  onOpenWatchMode,
  onOpenVsCpu,
  onOpenVsPlayer,
  onOpenOnlineVersus,
  onOpenModeration,
}: HomePageProps) {
  const [creditPacks, setCreditPacks] = useState<CreditPack[]>([]);
  const [billingProfile, setBillingProfile] = useState<BillingProfile | null>(null);
  const [billingStatus, setBillingStatus] = useState('Loading credits...');
  const [checkoutPackId, setCheckoutPackId] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [playerStats, setPlayerStats] = useState<PlayerStats | null>(null);
  const [arenaStatus, setArenaStatus] = useState('Loading fight records...');
  const [checkoutConsentAccepted, setCheckoutConsentAccepted] = useState(false);

  useEffect(() => {
    const apiContext = captureApiRequestContext();
    let cancelled = false;
    let refreshTimer: number | null = null;
    let latestProfile: BillingProfile | null = null;
    let verifiedBalance: number | null = null;
    const loadBilling = () => {
      if (authStatus === 'loading') {
        setBillingStatus('Loading credits...');
        return;
      }
      const checkoutReturn = authStatus === 'signed-in'
        ? consumeCheckoutReturn(authSessionKey)
        : checkoutReturnFromUrl(window.location.href);
      const pendingCheckout = readPendingCheckout(authSessionKey);
      const checkoutMessage = checkoutReturn ? checkoutStatusMessage(checkoutReturn.status) : null;
      const returnedSuccess = checkoutReturn?.status === 'success';
      const checkoutSessionId = returnedSuccess
        ? checkoutReturn.sessionId
        : checkoutReturn
          ? null
          : pendingCheckout?.sessionId ?? null;
      const exactVerificationActive = Boolean(checkoutSessionId && authStatus === 'signed-in');

      void Promise.all([
        loadCreditPacks(apiContext),
        loadBillingProfile(apiContext),
      ]).then(([packsResult, profileResult]) => {
        if (cancelled) return;
        latestProfile = profileResult.profile;
        setCreditPacks(packsResult.packs);
        setBillingProfile(profileResult.profile && verifiedBalance !== null
          ? { ...profileResult.profile, creditsBalance: verifiedBalance }
          : profileResult.profile);
        if (exactVerificationActive || returnedSuccess) return;
        if (checkoutMessage) {
          setBillingStatus(checkoutMessage);
        } else if (packsResult.status === 'local') {
          setBillingStatus('Credit packs are disabled in local development');
        } else if (packsResult.status === 'unavailable') {
          setBillingStatus('Credit packs unavailable. Try again later.');
        } else if (profileResult.status === 'unavailable' && authStatus === 'signed-in') {
          setBillingStatus('Credit balance unavailable. Try again later.');
        } else if (profileResult.profile) {
          setBillingStatus(`${profileResult.profile.creditsBalance} credits ready`);
        } else if (profileResult.status === 'signed-out' && authStatus === 'signed-in') {
          setBillingStatus('Sign in again to load your credit balance');
        } else if (packsResult.packs.length === 0) {
          setBillingStatus('No credit packs are available');
        } else {
          setBillingStatus('Sign in for cloud credits');
        }
      });

      if (returnedSuccess && !checkoutSessionId) {
        setBillingStatus('Checkout returned without a valid Stripe session. No credit success was assumed.');
        return;
      }
      if (exactVerificationActive && checkoutSessionId) {
        setBillingStatus('Confirming the exact Stripe session...');
        const pollCheckout = async (index: number) => {
          const verification = await verifyCreditCheckoutSession(checkoutSessionId, apiContext);
          if (cancelled) return;
          const checkout = verification.checkout;
          if (checkout) {
            verifiedBalance = checkout.creditsBalance;
            setBillingProfile((current) => (
              current ? { ...current, creditsBalance: checkout.creditsBalance } : current
            ));
            if (checkout.state === 'complete') {
              clearPendingCheckoutForSession(authSessionKey, checkoutSessionId);
              setBillingStatus(checkoutVerificationMessage(checkout));
              return;
            }
            if (checkout.state === 'failed') {
              clearPendingCheckoutForSession(authSessionKey, checkoutSessionId);
              setBillingStatus(checkoutVerificationMessage(checkout));
              return;
            }
          }

          const hasNextAttempt = index < CHECKOUT_SESSION_REFRESH_DELAYS_MS.length - 1;
          const shouldRetry = checkout?.state === 'pending' || (!checkout && verification.retryable === true);
          if (hasNextAttempt && shouldRetry) {
            const currentDelay = CHECKOUT_SESSION_REFRESH_DELAYS_MS[index];
            const nextDelay = CHECKOUT_SESSION_REFRESH_DELAYS_MS[index + 1];
            refreshTimer = window.setTimeout(
              () => { void pollCheckout(index + 1); },
              Math.max(0, nextDelay - currentDelay),
            );
            return;
          }

          if (checkout?.state === 'pending') {
            setBillingStatus(`${checkoutVerificationMessage(checkout)} Refresh to retry this exact session.`);
          } else {
            const balance = latestProfile ? ` Current balance: ${latestProfile.creditsBalance}.` : '';
            setBillingStatus(
              `This Stripe session could not be verified; no credit success was assumed.${balance}` +
              (verification.error ? ` ${verification.error}` : ''),
            );
          }
        };
        void pollCheckout(0);
        return;
      }
      if (returnedSuccess) {
        setBillingStatus('Sign in to the purchasing account to verify this Stripe session.');
        return;
      }
    };
    loadBilling();
    return () => {
      cancelled = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [authStatus, authSessionKey]);

  useEffect(() => {
    let cancelled = false;
    const loadArenaStats = async () => {
      const [board, stats] = await Promise.all([
        getLeaderboard(5),
        authStatus === 'signed-in' ? getMyStats() : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setLeaderboard(board);
      setPlayerStats(stats);
      if (stats) {
        setArenaStatus(`${recordLabel(stats.player.wins, stats.player.losses)} synced`);
      } else if (board.length > 0) {
        setArenaStatus(`${board.length} challengers on board`);
      } else if (authStatus === 'signed-in') {
        setArenaStatus('No recorded fights yet');
      } else {
        setArenaStatus('Sign in to keep a record');
      }
    };
    void loadArenaStats();
    return () => {
      cancelled = true;
    };
  }, [authStatus, authSessionKey]);

  const buyCredits = async (pack: CreditPack) => {
    if (authStatus !== 'signed-in') {
      setBillingStatus('Sign in to buy credits');
      return;
    }
    if (!checkoutConsentAccepted) {
      setBillingStatus('Accept the purchase terms to continue');
      return;
    }
    setCheckoutPackId(pack.id);
    setBillingStatus(`Opening ${pack.label}...`);
    const checkout = await startCreditCheckout(
      pack.id,
      currentCheckoutLegalAttestation(),
      captureApiRequestContext(),
    );
    if (checkout.checkoutUrl && checkout.sessionId) {
      rememberPendingCheckout({
        sessionId: checkout.sessionId,
        packId: pack.id,
        credits: pack.credits,
      }, authSessionKey);
      window.location.assign(checkout.checkoutUrl);
      return;
    }
    clearPendingCheckout(authSessionKey);
    setBillingStatus(checkout.error ?? 'Checkout unavailable');
    setCheckoutPackId(null);
  };

  const rookieStatus = includedRookieStatus(authStatus, billingProfile);
  const heroNote = rookieStatus === 'included'
    ? 'Your first fighter is free in Rookie quality. Upgrade anytime to bring out the detail.'
    : rookieStatus === 'credits'
      ? 'Forge new challengers with credits. Every generated version stays yours.'
      : 'Upload a photo, get a playable fighter. Your first Rookie is free.';
  const arcadeModeHint = rookieStatus === 'included'
    ? 'Your Rookie is included. Climb the machine roster.'
    : rookieStatus === 'credits'
      ? 'Climb the ladder: 13 challengers, 3 continues.'
      : 'Create a fighter and climb the machine roster.';

  return (
    <div className="home-app">
      <div className="home-hero">
        <h1>{PUBLIC_APP_NAME}</h1>
        <p className="home-hero__copy">
          Insert yourself into the game. Upload a photo, build a playable fighter, and sync your roster across devices.
        </p>
        <div className="home-hero__cta">
          <Button variant="primary" size="lg" onClick={onCreateFighter}>
            Create Fighter
          </Button>
          <p className="home-hero__note">{heroNote}</p>
        </div>
      </div>

      <div className="home-menu">
        <button type="button" className="home-menu__action is-primary" onClick={onOpenArcade}>
          <span>Arcade Mode</span>
          <small>{arcadeModeHint}</small>
        </button>
        <button type="button" className="home-menu__action" onClick={onOpenVsCpu}>
          <span>CPU Match</span>
          <small>Pick The Matchup. Fight!</small>
        </button>
        <button type="button" className="home-menu__action" onClick={onOpenVsPlayer}>
          <span>Versus</span>
          <small>Local 1P vs 2P Showdown</small>
        </button>
        <button type="button" className="home-menu__action" onClick={onOpenOnlineVersus}>
          <span>Online Versus</span>
          <small>Room Code · Play From Home (Beta)</small>
        </button>
        <button type="button" className="home-menu__action" onClick={onOpenWatchMode}>
          <span>Attract Mode</span>
          <small>Watch The CPUs Fight</small>
        </button>
        <button type="button" className="home-menu__action is-secondary" onClick={onOpenGallery}>
          <span>Roster Lab</span>
          <small>Browse Your Roster</small>
        </button>
        <button type="button" className="home-menu__action" onClick={onOpenCommunity}>
          <span>Community</span>
          <small>Clone Public Fighters</small>
        </button>
        {billingProfile?.planTier === 'admin' ? (
          <button type="button" className="home-menu__action" onClick={onOpenModeration}>
            <span>Moderation</span>
            <small>Review Community Reports</small>
          </button>
        ) : null}
      </div>

      <section className="home-credits" aria-label="Credits">
        <div className="home-credits__header">
          <h2>
            Credits
            {billingProfile ? <em className="home-credits__balance">{billingProfile.creditsBalance}</em> : null}
          </h2>
          <span role="status" aria-live="polite">{billingStatus}</span>
        </div>

        {creditPacks.length > 0 ? (
          <>
            <CheckoutConsent
              checked={checkoutConsentAccepted}
              disabled={checkoutPackId !== null}
              onChange={setCheckoutConsentAccepted}
              onNavigate={onNavigateLegal}
            />
            <div className="home-credits__grid">
              {creditPacks.map((pack) => (
                <button
                  type="button"
                  key={pack.id}
                  className="home-credit-pack"
                  disabled={checkoutPackId !== null || !checkoutConsentAccepted}
                  onClick={() => void buyCredits(pack)}
                >
                  <span>{pack.label}</span>
                  <strong>{pack.credits} credits</strong>
                  <small>{new Intl.NumberFormat(undefined, {
                    style: 'currency',
                    currency: pack.currency.toUpperCase(),
                  }).format(pack.amountCents / 100)}</small>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </section>

      <section className="home-dashboard" aria-label="Arena records">
        <div className="home-board">
          <div className="home-board__header">
            <h2>Your Record</h2>
            <span role="status" aria-live="polite">{arenaStatus}</span>
          </div>

          {playerStats ? (
            <>
              <div className="home-stat-grid">
                <div className="home-stat-tile">
                  <strong>{recordLabel(playerStats.player.wins, playerStats.player.losses)}</strong>
                  <span>Record</span>
                </div>
                <div className="home-stat-tile">
                  <strong>{playerStats.player.winRate.toFixed(1)}%</strong>
                  <span>Win Rate</span>
                </div>
                <div className="home-stat-tile">
                  <strong>{playerStats.player.winStreak}</strong>
                  <span>Streak</span>
                </div>
              </div>

              <div className="home-results">
                {playerStats.recentMatches.slice(0, 3).map((match) => (
                  <div className="home-result-row" key={match.id}>
                    <strong>{recentResultLabel(match, playerStats.player.id)}</strong>
                    <span>{match.player1Name} vs {match.player2Name}</span>
                    <em>{match.roundsWonP1}-{match.roundsWonP2}</em>
                  </div>
                ))}
                {playerStats.recentMatches.length === 0 ? (
                  <p className="home-board__empty">No recent fight history.</p>
                ) : null}
              </div>
            </>
          ) : (
            <p className="home-board__empty">No cloud record loaded.</p>
          )}
        </div>

        <div className="home-board">
          <div className="home-board__header">
            <h2>Fight Board</h2>
          </div>

          <div className="home-board__rows">
            {leaderboard.map((entry, index) => (
              <div className="home-board__row" key={entry.id}>
                <span className="home-board__rank">#{index + 1}</span>
                <div className="home-board__main">
                  <strong>{entry.displayName}</strong>
                  <span>{recordLabel(entry.wins, entry.losses)} - {entry.winRate.toFixed(1)}%</span>
                </div>
                <span className="home-board__metric">{entry.eloRating}</span>
              </div>
            ))}
            {leaderboard.length === 0 ? (
              <p className="home-board__empty">No recorded challengers yet.</p>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
