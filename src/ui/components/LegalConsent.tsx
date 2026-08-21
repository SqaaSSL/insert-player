import { rememberCurrentGenerationConsent } from '../legal.ts';

interface ConsentProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

function LegalLinks() {
  return (
    <span className="legal-consent__links">
      <a href="/terms">Terms</a>
      <a href="/privacy">Privacy</a>
      <a href="/refunds">Refunds</a>
    </span>
  );
}

export function GenerationConsent({ checked, disabled, onChange }: ConsentProps) {
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
          I am 18+, have permission to use this photo, agree to the Terms and AI processing,
          request immediate generation, and understand that starting it ends the 14-day
          withdrawal right for that digital content, except where law requires a remedy.
        </span>
      </label>
      <LegalLinks />
    </div>
  );
}

export function CheckoutConsent({ checked, disabled, onChange }: ConsentProps) {
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
          I am 18+, agree to the Terms and Refund Policy, request immediate credit delivery,
          and understand that using credits can end the withdrawal right for the used digital service.
        </span>
      </label>
      <LegalLinks />
    </div>
  );
}
