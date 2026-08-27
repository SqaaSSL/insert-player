import { rememberCurrentGenerationConsent } from '../legal.ts';
import type { LegalRoute } from './LegalFooter.tsx';

interface ConsentProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  /** SPA navigation for the policy links; plain hrefs (full reload) when omitted. */
  onNavigate?: (route: LegalRoute) => void;
}

function LegalLinks({ onNavigate }: { onNavigate?: (route: LegalRoute) => void }) {
  const links: ReadonlyArray<readonly [LegalRoute, string]> = [
    ['/terms', 'Terms'],
    ['/privacy', 'Privacy'],
    ['/refunds', 'Cancellations'],
  ];
  return (
    <span className="legal-consent__links">
      {links.map(([route, label]) => (
        <a
          key={route}
          href={route}
          onClick={onNavigate
            ? (event) => {
                event.preventDefault();
                onNavigate(route);
              }
            : undefined}
        >
          {label}
        </a>
      ))}
    </span>
  );
}

export function GenerationConsent({ checked, disabled, onChange, onNavigate }: ConsentProps) {
  return (
    <div className="legal-consent">
      <label>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => {
            const accepted = event.target.checked;
            if (accepted) rememberCurrentGenerationConsent();
            onChange(accepted);
          }}
        />
        <span>
          <strong>Process this photo only for my private fighter.</strong>{' '}
          I am 18+ and confirm I own the photo or have the pictured adult's permission. I authorize
          Insert Player and the processors named in Privacy to process it solely to create and
          privately store this fighter in my Insert Player account. Neither my photo nor generated
          fighter will be visible to other players unless I later choose Publish. Publishing is a
          separate action and makes only the clean generated assets of that fighter public, never my
          original photo, Clerk account identity, RAW files, or private generation history. This is
          not a licence to reuse my photo or private fighter. Insert Player will not sell them, use
          them in advertising, or use them to train models. I agree to the Terms and Privacy Policy,
          request immediate generation, acknowledge that digital performance starts immediately,
          and understand that the displayed credits are consumed once external AI processing begins.
          They are not automatically restored if a provider fails or an output needs remediation.
          Mandatory consumer remedies still apply.
        </span>
      </label>
      <LegalLinks onNavigate={onNavigate} />
    </div>
  );
}

export function CheckoutConsent({ checked, disabled, onChange, onNavigate }: ConsentProps) {
  return (
    <div className="legal-consent legal-consent--checkout">
      <label>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          I am 18+, agree to the Terms and Cancellations &amp; Remedies Policy, request immediate credit
          delivery, and acknowledge that used credits and generations whose external AI processing
          has begun are not voluntarily refundable. Mandatory consumer rights still apply.
        </span>
      </label>
      <LegalLinks onNavigate={onNavigate} />
    </div>
  );
}
