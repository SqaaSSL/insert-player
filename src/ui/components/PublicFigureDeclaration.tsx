interface PublicFigureDeclarationProps {
  value: boolean | null;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

/** A user's declaration, not face recognition or a provider-routing decision. */
export function PublicFigureDeclaration({ value, disabled, onChange }: PublicFigureDeclarationProps) {
  return (
    <fieldset className="creation-identity" disabled={disabled} aria-describedby="creation-identity-help">
      <legend>Is this a famous person?</legend>
      <p id="creation-identity-help">Choose one. This includes public figures such as actors, musicians, athletes and creators.</p>
      <div className="creation-identity__choices">
        {([false, true] as const).map((answer) => (
          <label key={String(answer)} className={value === answer ? 'is-selected' : undefined}>
            <input
              type="radio"
              name="fighter-public-figure"
              value={String(answer)}
              checked={value === answer}
              required
              onChange={() => onChange(answer)}
            />
            <span>{answer ? 'Yes' : 'No'}</span>
          </label>
        ))}
      </div>
      <div aria-live="polite" aria-atomic="true">
        {value === true ? (
          <div className="creation-identity__notice" role="note">
            <strong>Famous people may not generate</strong>
            <p>Image providers can reject public figures, even after generation has started. A result is not guaranteed.</p>
            <p>Any credits in your quote are consumed once external AI processing begins and are not automatically restored if generation fails. The photo and permission requirements below still apply.</p>
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}
