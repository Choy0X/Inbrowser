import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

/**
 * Form controls.
 *
 * All 40px tall so they match Button `md` and clear the touch-target floor,
 * and all sharing one focus treatment - the app previously had three different
 * focus styles depending on which screen you were on.
 */

const BASE =
  "w-full rounded-lg border border-border bg-canvas text-fg placeholder:text-fg-faint outline-none transition-colors " +
  "focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-50";

export interface FieldProps {
  label?: string;
  /** Persistent guidance. A placeholder is not a label and does not survive typing. */
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

/** Label + control + hint/error, wired so the message sits next to its field. */
export function Field({ label, hint, error, required, children, className = "" }: FieldProps) {
  return (
    <label className={`block ${className}`}>
      {label && (
        <span className="mb-1 block text-xs font-medium text-fg">
          {label}
          {required && <span className="ml-0.5 text-error">*</span>}
        </span>
      )}
      {children}
      {error ? (
        <span role="alert" className="mt-1 block text-[11px] leading-4 text-error">
          {error}
        </span>
      ) : (
        hint && <span className="mt-1 block text-[11px] leading-4 text-fg-faint">{hint}</span>
      )}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className = "", invalid, ...rest }, ref) {
    return (
      <input
        ref={ref}
        data-ui="control"
        className={`${BASE} px-3 text-sm ${invalid ? "border-error" : ""} ${className}`}
        {...rest}
      />
    );
  }
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = "", rows = 4, ...rest }, ref) {
    return <textarea ref={ref} rows={rows} className={`${BASE} resize-y px-3 py-2 text-sm leading-5 ${className}`} {...rest} />;
  }
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = "", children, ...rest }, ref) {
    return (
      <select ref={ref} data-ui="control" className={`${BASE} px-2.5 text-sm ${className}`} {...rest}>
        {children}
      </select>
    );
  }
);

/** Search input with its magnifier, since every list screen needs the same one. */
export const SearchInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { icon: ReactNode }>(
  function SearchInput({ icon, className = "", ...rest }, ref) {
    return (
      <div className={`relative min-w-0 ${className}`}>
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint">{icon}</span>
        <input
          ref={ref}
          type="search"
          data-ui="control"
          className={`${BASE} pr-2.5 text-xs`}
          style={{ paddingInlineStart: "calc(var(--control-px) + 20px)" }}
          {...rest}
        />
      </div>
    );
  }
);
