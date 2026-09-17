/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Terminal Ink palette. Values are CSS variables (r g b triplets)
        // so the theme swaps via [data-theme].
        canvas: "rgb(var(--canvas) / <alpha-value>)",
        bg: {
          DEFAULT: "rgb(var(--bg) / <alpha-value>)", // canvas
          subtle: "rgb(var(--bg-subtle) / <alpha-value>)", // surface-soft
          elevated: "rgb(var(--bg-elevated) / <alpha-value>)", // surface-card
          hover: "rgb(var(--bg-hover) / <alpha-value>)", // surface-cream-strong
        },
        border: { DEFAULT: "rgb(var(--border) / <alpha-value>)", subtle: "rgb(var(--border-subtle) / <alpha-value>)" }, // hairline / hairline-soft
        fg: { DEFAULT: "rgb(var(--fg) / <alpha-value>)", dim: "rgb(var(--fg-dim) / <alpha-value>)", faint: "rgb(var(--fg-faint) / <alpha-value>)" }, // ink / body / muted-soft
        accent: { DEFAULT: "rgb(var(--accent) / <alpha-value>)", hover: "rgb(var(--accent-hover) / <alpha-value>)", disabled: "rgb(var(--accent-disabled) / <alpha-value>)" },
        "on-accent": "rgb(var(--on-accent) / <alpha-value>)",
        night: { DEFAULT: "rgb(var(--night) / <alpha-value>)", elevated: "rgb(var(--night-elevated) / <alpha-value>)", soft: "rgb(var(--night-soft) / <alpha-value>)" },
        "on-night": { DEFAULT: "rgb(var(--on-night) / <alpha-value>)", soft: "rgb(var(--on-night-soft) / <alpha-value>)" },
        overlay: "rgb(var(--overlay) / <alpha-value>)",
        teal: "rgb(var(--teal) / <alpha-value>)",
        amber: "rgb(var(--amber) / <alpha-value>)",
        success: "rgb(var(--success) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        error: "rgb(var(--error) / <alpha-value>)",
        "on-error": "rgb(var(--on-error) / <alpha-value>)",
        "code-bg": "rgb(var(--code-bg) / <alpha-value>)",
        "code-fg": "rgb(var(--code-fg) / <alpha-value>)",
        paper: {
          bg: "rgb(var(--paper-bg) / <alpha-value>)",
          surface: "rgb(var(--paper-surface) / <alpha-value>)",
          fg: "rgb(var(--paper-fg) / <alpha-value>)",
          "fg-dim": "rgb(var(--paper-fg-dim) / <alpha-value>)",
          border: "rgb(var(--paper-border) / <alpha-value>)",
          accent: "rgb(var(--paper-accent) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        display: ["var(--font-display)"],
        mono: ["var(--font-mono)"],
        paper: ["var(--font-paper)"],
      },
      borderRadius: {
        DEFAULT: "var(--radius-sm)",
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-2xl)",
        "3xl": "var(--radius-2xl)",
        full: "var(--radius-pill)",
      },
      boxShadow: {
        soft: "var(--shadow-soft)",
        lift: "var(--shadow-lift)",
      },
      keyframes: {
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        shake: {
          "10%, 90%": { transform: "translateX(-1px)" },
          "20%, 80%": { transform: "translateX(2px)" },
          "30%, 50%, 70%": { transform: "translateX(-4px)" },
          "40%, 60%": { transform: "translateX(4px)" },
        },
      },
      animation: {
        blink: "blink 1s step-start infinite",
        "fade-in": "fade-in 0.2s ease-out",
        shake: "shake 0.4s ease-in-out",
      },
    },
  },
  plugins: [],
};