/**
 * Inline vector of the P1 start-button mark (same art as
 * public/assets/app-icon.svg, without the cabinet background).
 */
export function BrandMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      role="img"
      aria-label="P1"
      className={className}
      focusable="false"
    >
      <circle cx="256" cy="262" r="206" fill="#050507" />
      <circle cx="256" cy="256" r="196" fill="#f4f0dd" />
      <circle cx="256" cy="256" r="168" fill="#6a0a0a" />
      <circle cx="256" cy="250" r="160" fill="#d22727" />
      <ellipse cx="256" cy="172" rx="104" ry="34" fill="#ff5347" opacity="0.75" />
      <g fill="#5a0808">
        <path d="M136 168h90v30h-90zM136 198h30v30h-30zM226 198h30v30h-30zM136 228h30v30h-30zM226 228h30v30h-30zM136 258h90v30h-90zM136 288h30v30h-30zM136 318h30v30h-30z" />
        <path d="M316 168h30v30h-30zM286 198h60v30h-60zM316 228h30v30h-30zM316 258h30v30h-30zM316 288h30v30h-30zM286 318h90v30h-90z" />
      </g>
      <g fill="#fff4d6">
        <path d="M136 160h90v30h-90zM136 190h30v30h-30zM226 190h30v30h-30zM136 220h30v30h-30zM226 220h30v30h-30zM136 250h90v30h-90zM136 280h30v30h-30zM136 310h30v30h-30z" />
        <path d="M316 160h30v30h-30zM286 190h60v30h-60zM316 220h30v30h-30zM316 250h30v30h-30zM316 280h30v30h-30zM286 310h90v30h-90z" />
      </g>
    </svg>
  );
}
