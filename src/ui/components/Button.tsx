import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'lg';
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'asf-btn asf-btn--primary',
  secondary: 'asf-btn',
  danger: 'asf-btn asf-btn--danger',
  ghost: 'asf-btn asf-btn--ghost',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  const classes = [VARIANT_CLASS[variant], size === 'lg' ? 'asf-btn--lg' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <button type={type} className={classes} {...rest} />;
}
