import { tierLabel } from '../shared/fighterPreview.ts';

interface TierBadgeProps {
  tier: string | null | undefined;
  className?: string;
}

const TIER_CLASS: Record<string, string> = {
  rookie: 'asf-badge--tier-rookie',
  contender: 'asf-badge--tier-contender',
  champion: 'asf-badge--tier-champion',
};

export function TierBadge({ tier, className }: TierBadgeProps) {
  if (!tier) return null;
  const classes = ['asf-badge', TIER_CLASS[tier] ?? '', className ?? ''].filter(Boolean).join(' ');
  return <span className={classes}>{tierLabel(tier)}</span>;
}
