import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Tooltip } from "../Tooltip";

/**
 * The one button.
 *
 * Before this existed every screen hand-rolled its own from raw Tailwind,
 * which is how the app accumulated nine visual variants of the same control
 * and 24 places that assumed a white label on the accent fill. Variants live
 * here so a theme change reaches all of them, and so "primary" means one thing.
 *
 * Sizes are floors, not suggestions: `md` is 40px tall, the minimum
 * comfortable touch target.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover",
  secondary: "border border-border bg-canvas text-fg-dim hover:bg-bg-hover hover:text-fg",
  ghost: "text-fg-dim hover:bg-bg-hover hover:text-fg",
  danger: "bg-error text-on-error hover:brightness-95",
};

const SIZES: Record<ButtonSize, string> = {
  // sm stays reachable: it is used inside dense rows, never as a lone target.
  sm: "h-9 gap-1.5 px-2.5 text-xs",
  md: "h-10 gap-1.5 px-3.5 text-sm",
  lg: "h-11 gap-2 px-5 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Rendered before the label. */
  icon?: ReactNode;
  /** Replaces the icon with a spinner and disables the button. */
  loading?: boolean;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, loading, fullWidth, className = "", children, disabled, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      data-ui="control"
      data-variant={variant}
      disabled={disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center font-mono font-medium
        uppercase tracking-[0.06em] transition-colors
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
        disabled:cursor-not-allowed disabled:opacity-50
        ${VARIANTS[variant]} ${SIZES[size]} ${fullWidth ? "w-full" : ""} ${className}`}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});

function Spinner() {
  return (
    <span
      aria-hidden
      className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon alone tells a screen reader nothing. */
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/**
 * A square icon-only button. Keeps the full touch target even though the glyph
 * inside is small, which is the usual failure with icon buttons.
 *
 * The label doubles as its hover tooltip, shown through the app's own
 * `Tooltip` component rather than the browser-native `title` attribute, so it
 * matches every other tooltip in the app instead of looking (and behaving,
 * and themeing) like a leftover default.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = "ghost", size = "md", className = "", disabled, ...rest },
  ref
) {
  const box = size === "sm" ? "h-9 w-9" : size === "lg" ? "h-11 w-11" : "h-10 w-10";
  const button = (
    <button
      ref={ref}
      type="button"
      data-ui="icon-button"
      data-variant={variant}
      aria-label={label}
      disabled={disabled}
      className={`inline-flex shrink-0 items-center justify-center transition-colors
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
        disabled:cursor-not-allowed disabled:opacity-50
        ${VARIANTS[variant]} ${box} ${className}`}
      {...rest}
    >
      {icon}
    </button>
  );
  // A disabled <button> doesn't fire the mouse events Tooltip listens for, so
  // hovering a disabled icon button would silently show nothing. Give Tooltip
  // a plain (non-disabled) span to attach to instead, in that case only.
  return (
    <Tooltip label={label}>
      {disabled ? <span className={`inline-flex ${box}`}>{button}</span> : button}
    </Tooltip>
  );
});
