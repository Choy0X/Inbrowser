/** The InBrowser brand mark - a tab outline holding a solid core, which is the
 *  product in one glyph: everything runs inside the one surface you already
 *  have open. Four straight edges and a centre square, so it stays legible at
 *  favicon size. Renders in the current text color.
 *
 *  Kept in the same geometry as scripts/generate-icons.mjs; change both
 *  together or the PWA icons drift from the in-app mark. */
export function Mark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden
    >
      <rect
        x="3.85"
        y="3.85"
        width="16.3"
        height="16.3"
        rx="3.4"
        stroke="currentColor"
        strokeWidth={1.7}
      />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1.1" fill="currentColor" />
    </svg>
  );
}
