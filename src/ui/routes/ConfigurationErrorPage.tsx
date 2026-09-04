import { Button } from '../components/Button.tsx';

interface ConfigurationErrorPageProps {
  message: string;
  onOpenCommunity: () => void;
  onOpenLegal: () => void;
}

export function ConfigurationErrorPage({
  message,
  onOpenCommunity,
  onOpenLegal,
}: ConfigurationErrorPageProps) {
  return (
    <section className="configuration-error" role="alert">
      <p className="configuration-error__code">AUTH CONFIG</p>
      <h1>Player accounts are unavailable</h1>
      <p>{message}</p>
      <div className="configuration-error__actions">
        <Button variant="primary" onClick={onOpenCommunity}>Browse Community</Button>
        <Button onClick={onOpenLegal}>Read Legal Notice</Button>
      </div>
    </section>
  );
}
