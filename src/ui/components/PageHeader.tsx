import type { ReactNode } from 'react';
import { Button } from './Button.tsx';

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  copy?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  actions?: ReactNode;
}

/** Standard page header: eyebrow + title on the left, back/actions on the right. */
export function PageHeader({ eyebrow, title, copy, onBack, backLabel = 'Back', actions }: PageHeaderProps) {
  return (
    <header className="asf-page-head">
      <div>
        <p className="asf-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {copy}
      </div>
      {(onBack || actions) && (
        <div className="asf-toolbar">
          {actions}
          {onBack && <Button onClick={onBack}>{backLabel}</Button>}
        </div>
      )}
    </header>
  );
}
