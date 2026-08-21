import { LEGAL_OPERATOR, SUPPORT_EMAIL } from '../legal.ts';

export type LegalRoute = '/legal' | '/privacy' | '/terms' | '/refunds';

interface LegalFooterProps {
  onNavigate: (route: LegalRoute) => void;
}

export function LegalFooter({ onNavigate }: LegalFooterProps) {
  const navigate = (event: React.MouseEvent<HTMLAnchorElement>, route: LegalRoute) => {
    event.preventDefault();
    onNavigate(route);
  };

  return (
    <footer className="legal-footer">
      <p>Insert Player is operated by {LEGAL_OPERATOR.name}.</p>
      <nav aria-label="Legal">
        <a href="/legal" onClick={(event) => navigate(event, '/legal')}>Legal Notice</a>
        <a href="/privacy" onClick={(event) => navigate(event, '/privacy')}>Privacy</a>
        <a href="/terms" onClick={(event) => navigate(event, '/terms')}>Terms</a>
        <a href="/refunds" onClick={(event) => navigate(event, '/refunds')}>Refunds</a>
        <a href={`mailto:${SUPPORT_EMAIL}`}>Contact</a>
      </nav>
    </footer>
  );
}
