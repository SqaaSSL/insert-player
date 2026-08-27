import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  className?: string;
  children?: ReactNode;
  actions?: ReactNode;
}

export function EmptyState({ title, className, children, actions }: EmptyStateProps) {
  return (
    <div className={['asf-empty', className ?? ''].filter(Boolean).join(' ')}>
      <h2>{title}</h2>
      {children}
      {actions}
    </div>
  );
}
