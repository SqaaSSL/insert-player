import { LEGAL_OPERATOR, SUPPORT_EMAIL } from '../legal.ts';
import { PUBLIC_APP_NAME } from '../publicBrand.ts';

export type LegalRoute = '/legal' | '/privacy' | '/terms' | '/refunds';

interface LegalFooterProps {
  onNavigate: (route: LegalRoute) => void;
}

export interface NavigationClick {
  button: number;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function shouldUseSpaNavigation(event: NavigationClick): boolean {
  return !event.defaultPrevented && event.button === 0 &&
    !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function LegalFooter({ onNavigate }: LegalFooterProps) {
  const navigate = (event: React.MouseEvent<HTMLAnchorElement>, route: LegalRoute) => {
    if (!shouldUseSpaNavigation(event)) return;
    event.preventDefault();
    onNavigate(route);
  };

  return (
    <footer className="legal-footer">
      <p>{PUBLIC_APP_NAME} is operated by {LEGAL_OPERATOR.name}.</p>
      <nav aria-label="Legal">
        <a href="/legal" onClick={(event) => navigate(event, '/legal')}>Legal Notice</a>
        <a href="/privacy" onClick={(event) => navigate(event, '/privacy')}>Privacy</a>
        <a href="/terms" onClick={(event) => navigate(event, '/terms')}>Terms</a>
        <a href="/refunds" onClick={(event) => navigate(event, '/refunds')}>Cancellations</a>
        <a href={`mailto:${SUPPORT_EMAIL}`}>Contact</a>
      </nav>
    </footer>
  );
}
