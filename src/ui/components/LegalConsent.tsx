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
          <strong>Process this photo only for my private fighter.</strong>{' '}
          I am 18+ and confirm I own the photo or have the pictured adult's permission. I authorize
          Insert Player and the processors named in Privacy to process it solely to create and
          privately store this fighter in my Insert Player account. Neither my photo nor generated
          fighter will be visible to other players unless I later choose Publish. Publishing is a
          separate action and makes only the clean generated assets of that fighter public, never my
          original photo, Clerk account identity, RAW files, or private generation history. This is
          not a licence to reuse my photo or private fighter. Insert Player will not sell them, use
          them in advertising, or use them to train models. I agree to the Terms and Privacy Policy,
          request immediate generation, and understand that starting it ends the 14-day withdrawal
          right for that digital content, except where law requires a remedy.
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
