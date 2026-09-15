interface PipelineProgressProps {
  percent: number | null;
  label?: string;
}

export function PipelineProgress({ percent, label = 'Creation progress' }: PipelineProgressProps) {
  const known = percent !== null && Number.isFinite(percent);
  const clamped = known ? Math.max(0, Math.min(1, percent)) : 0;
  const width = clamped * 100;

  return (
    <div className="create-progress" role="progressbar" aria-label={label} aria-valuetext={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.round(width) : undefined}>
      <svg className="create-progress__bar" viewBox="0 0 100 6" preserveAspectRatio="none">
        <defs>
          <linearGradient id="asfProgressFill" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" className="create-progress__stop-start" />
            <stop offset="1" className="create-progress__stop-end" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width={width} height="6" fill="url(#asfProgressFill)" />
      </svg>
    </div>
  );
}
