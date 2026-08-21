import { useEffect, useState } from 'react';
import {
  getBillingProfile,
  listCreditPacks,
  startCreditCheckout,
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
  checkoutStatusMessage,
  consumePendingCheckout,
  consumeCheckoutStatus,
  rememberPendingCheckout,
} from '../shared/checkoutStatus.ts';
import { PUBLIC_APP_NAME } from '../publicBrand.ts';
import { captureApiRequestContext } from '../../services/ApiClient.ts';
import { CheckoutConsent } from '../components/LegalConsent.tsx';
import { currentCheckoutLegalAttestation } from '../legal.ts';

interface HomePageProps extends AuthRouteState {
  onOpenGallery: () => void;
  onOpenCommunity: () => void;
  onOpenWatchMode: () => void;
  onOpenVsCpu: () => void;
  onOpenVsPlayer: () => void;
  onOpenModeration: () => void;
}

const CHECKOUT_PROFILE_REFRESH_DELAYS_MS = [1_500, 3_500, 7_000, 12_000];

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
  onOpenGallery,
  onOpenCommunity,
  onOpenWatchMode,
  onOpenVsCpu,
  onOpenVsPlayer,
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
    let refreshTimers: number[] = [];
    const loadBilling = async () => {
      if (authStatus === 'loading') {
        setBillingStatus('Loading credits...');
        return;
      }
      const checkoutStatus = consumeCheckoutStatus();
      const pendingCheckout = checkoutStatus === 'success' ? consumePendingCheckout() : null;
      const checkoutMessage = checkoutStatus ? checkoutStatusMessage(checkoutStatus) : null;
      const [packs, profile] = await Promise.all([
        listCreditPacks(apiContext),
        getBillingProfile(apiContext),
      ]);
      if (cancelled) return;
      setCreditPacks(packs);
      setBillingProfile(profile);
      const expectedBalance = pendingCheckout && pendingCheckout.balanceBefore !== null
        ? pendingCheckout.balanceBefore + pendingCheckout.credits
        : null;
      if (checkoutStatus === 'success' && authStatus === 'signed-in') {
        if (profile && expectedBalance !== null && profile.creditsBalance >= expectedBalance) {
          setBillingStatus(`${profile.creditsBalance} credits ready`);
          return;
        }
        setBillingStatus('Checkout complete. Confirming credits...');
        refreshTimers = CHECKOUT_PROFILE_REFRESH_DELAYS_MS.map((delay, index) => window.setTimeout(async () => {
          const refreshed = await getBillingProfile(apiContext);
          if (cancelled) return;
          if (refreshed) setBillingProfile(refreshed);
          const credited = refreshed && expectedBalance !== null && refreshed.creditsBalance >= expectedBalance;
          if (credited) {
            setBillingStatus(`${refreshed.creditsBalance} credits ready`);
            refreshTimers.forEach((timer) => window.clearTimeout(timer));
            refreshTimers = [];
            return;
          }
          if (index === CHECKOUT_PROFILE_REFRESH_DELAYS_MS.length - 1) {
            setBillingStatus(refreshed ? 'Credits ready' : checkoutStatusMessage('success'));
          }
        }, delay));
        return;
      }
      if (packs.length === 0) {
        setBillingStatus(checkoutMessage ?? 'Credits offline in local mode');
      } else if (profile) {
        setBillingStatus(checkoutMessage ?? 'Credits ready');
      } else if (authStatus === 'signed-in') {
        setBillingStatus(checkoutMessage ?? 'Cloud profile unavailable');
      } else {
        setBillingStatus(checkoutMessage ?? 'Sign in for cloud credits');
      }
    };
    void loadBilling();
    return () => {
      cancelled = true;
      refreshTimers.forEach((timer) => window.clearTimeout(timer));
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
    setCheckoutPackId(pack.id);
    setBillingStatus(`Opening ${pack.label}...`);
    if (!checkoutConsentAccepted) {
      setBillingStatus('Accept the purchase terms to continue');
      return;
    }
    const checkout = await startCreditCheckout(
      pack.id,
      currentCheckoutLegalAttestation(),
      captureApiRequestContext(),
    );
    if (checkout.checkoutUrl) {
      rememberPendingCheckout({
        packId: pack.id,
        credits: pack.credits,
        balanceBefore: billingProfile?.creditsBalance ?? null,
      });
      window.location.assign(checkout.checkoutUrl);
      return;
    }
    clearPendingCheckout();
    setBillingStatus(checkout.error ?? 'Checkout unavailable');
    setCheckoutPackId(null);
  };

  return (
    <div className="home-app">
      <div className="home-hero">
        <p className="gallery-eyebrow">Insert Coin</p>
        <h1>{PUBLIC_APP_NAME}</h1>
        <p className="home-hero__copy">
          Insert yourself into the game. Upload a photo, build a playable fighter, and sync your roster across devices.
        </p>
      </div>

      <div className="home-menu">
        <button className="home-menu__action is-primary" onClick={onOpenVsCpu}>
          <span>Arcade Mode</span>
          <small>Take Your Fighter Into The CPU Ladder</small>
        </button>
        <button className="home-menu__action" onClick={onOpenVsPlayer}>
          <span>Versus</span>
          <small>Local 1P vs 2P Showdown</small>
        </button>
        <button className="home-menu__action" onClick={onOpenWatchMode}>
          <span>Attract Mode</span>
          <small>Watch The CPUs Fight</small>
        </button>
        <button className="home-menu__action is-secondary" onClick={onOpenGallery}>
          <span>Roster Lab</span>
          <small>Browse Your Roster</small>
        </button>
        <button className="home-menu__action" onClick={onOpenCommunity}>
          <span>Community</span>
          <small>Clone Public Fighters</small>
        </button>
        {billingProfile?.planTier === 'admin' ? (
          <button className="home-menu__action" onClick={onOpenModeration}>
            <span>Moderation</span>
            <small>Review Community Reports</small>
          </button>
        ) : null}
      </div>

      <section className="home-credits" aria-label="Credits">
        <div className="home-credits__header">
          <div>
            <p className="gallery-eyebrow">Credits</p>
            <h2>
              {billingProfile
                ? `${billingProfile.creditsBalance} Ready`
                : 'Cloud Wallet'}
            </h2>
          </div>
          <span role="status" aria-live="polite">{billingStatus}</span>
        </div>

        {creditPacks.length > 0 ? (
          <>
            <CheckoutConsent
              checked={checkoutConsentAccepted}
              disabled={checkoutPackId !== null}
              onChange={setCheckoutConsentAccepted}
            />
            <div className="home-credits__grid">
              {creditPacks.map((pack) => (
                <button
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
            <div>
              <p className="gallery-eyebrow">Arena</p>
              <h2>Your Record</h2>
            </div>
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
            <div>
              <p className="gallery-eyebrow">Rankings</p>
              <h2>Fight Board</h2>
            </div>
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
