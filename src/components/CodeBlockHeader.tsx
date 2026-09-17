import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** Language label + copy action for a fenced code block in chat prose. */
export function CodeBlockHeader({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard API unavailable (e.g. insecure context) — nothing to fall back to. */
    }
  };

  return (
    <div className="flex items-center justify-between gap-2 border-b border-on-night-soft/15 px-3 py-1.5">
      <span data-ui="meta" className="text-[11px] text-on-night-soft">
        {language}
      </span>
      <button
        type="button"
        onClick={onCopy}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-on-night-soft transition-colors hover:bg-night-elevated hover:text-on-night"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
