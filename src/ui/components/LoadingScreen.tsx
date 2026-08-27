import { BrandMark } from './BrandMark.tsx';

interface LoadingScreenProps {
  label?: string;
}

export function LoadingScreen({ label = 'Loading...' }: LoadingScreenProps) {
  return (
    <div className="asf-loading" role="status" aria-live="polite">
      <BrandMark size={56} />
      <p>{label}</p>
      <span className="preview-loading__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}
