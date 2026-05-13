interface PipelineProgressProps {
  percent: number;
}

export function PipelineProgress({ percent }: PipelineProgressProps) {
  const clamped = Math.max(0, Math.min(1, percent));
  const width = clamped * 100;

  return (
    <div className="create-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(width)}>
      <svg className="create-progress__bar" viewBox="0 0 100 6" preserveAspectRatio="none">
        <defs>
          <linearGradient id="asfProgressFill" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#ff2a2a" />
            <stop offset="1" stopColor="#ffce3a" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width={width} height="6" fill="url(#asfProgressFill)" />
      </svg>
    </div>
  );
}
