import type { ReactNode } from 'react';

export type StatusSeverity = 'info' | 'progress' | 'success' | 'warn' | 'error';

interface StatusMessageProps {
  severity?: StatusSeverity;
  className?: string;
  children: ReactNode;
}

const SEVERITY_CLASS: Record<StatusSeverity, string> = {
  info: '',
  progress: '',
  success: 'asf-status--success',
  warn: 'asf-status--warn',
  error: 'asf-status--error',
};

export function StatusMessage({ severity = 'info', className, children }: StatusMessageProps) {
  const classes = ['asf-status', SEVERITY_CLASS[severity], className ?? '']
    .filter(Boolean)
    .join(' ');
  if (severity === 'error') {
    return (
      <p role="alert" className={classes}>
        {children}
      </p>
    );
  }
  return (
    <p role="status" aria-live="polite" aria-busy={severity === 'progress'} className={classes}>
      {children}
    </p>
  );
}
