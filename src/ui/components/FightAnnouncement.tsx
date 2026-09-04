import { useEffect, useRef, useState } from 'react';
import { ANNOUNCE_EVENT, type AnnounceDetail, type AnnounceKind } from '../../game/match/MatchConfig.ts';

const ANNOUNCE_DURATION_MS: Record<AnnounceKind, number> = {
  round: 1200,
  fight: 800,
  ko: 2000,
  double_ko: 2000,
  draw: 2000,
  wins: 2600,
};

function announceText(detail: AnnounceDetail): string {
  switch (detail.kind) {
    case 'round':
      return `ROUND ${detail.roundNumber ?? 1}`;
    case 'fight':
      return 'FIGHT!';
    case 'ko':
      return 'K.O.!';
    case 'double_ko':
      return 'DOUBLE K.O.!';
    case 'draw':
      return 'DRAW';
    case 'wins':
      return `${detail.winnerName ?? 'WINNER'} WINS!`;
  }
}

export interface FightAnnouncementProps {
  /** Test/SSR seed; live announcements arrive via the asf-announce window event. */
  initialDetail?: AnnounceDetail | null;
}

export function FightAnnouncement({ initialDetail = null }: FightAnnouncementProps) {
  const [current, setCurrent] = useState<{ detail: AnnounceDetail; seq: number } | null>(
    initialDetail ? { detail: initialDetail, seq: 0 } : null,
  );
  const seqRef = useRef(0);

  useEffect(() => {
    let hideTimer: number | undefined;
    const onAnnounce = (event: WindowEventMap[typeof ANNOUNCE_EVENT]) => {
      seqRef.current += 1;
      const seq = seqRef.current;
      setCurrent({ detail: event.detail, seq });
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        setCurrent((prev) => (prev?.seq === seq ? null : prev));
      }, ANNOUNCE_DURATION_MS[event.detail.kind]);
    };
    window.addEventListener(ANNOUNCE_EVENT, onAnnounce);
    return () => {
      window.removeEventListener(ANNOUNCE_EVENT, onAnnounce);
      window.clearTimeout(hideTimer);
    };
  }, []);

  if (!current) return null;

  return (
    <div className="fight-announce" role="status" key={current.seq}>
      <span className={`fight-announce__text fight-announce__text--${current.detail.kind}`}>
        {announceText(current.detail)}
      </span>
    </div>
  );
}
