const DEFAULT_PUBLIC_APP_NAME = 'Insert Player';
const DEFAULT_PUBLIC_APP_SHORT_NAME = 'P1';

function cleanBrandValue(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || /replace_me/i.test(text)) return fallback;
  return text;
}

export const PUBLIC_APP_NAME = cleanBrandValue(
  import.meta.env.VITE_PUBLIC_APP_NAME,
  DEFAULT_PUBLIC_APP_NAME,
);

export const PUBLIC_APP_SHORT_NAME = cleanBrandValue(
  import.meta.env.VITE_PUBLIC_APP_SHORT_NAME,
  DEFAULT_PUBLIC_APP_SHORT_NAME,
);
