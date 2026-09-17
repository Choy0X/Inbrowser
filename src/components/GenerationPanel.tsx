import { useMemo, useState } from "react";
import {
  Film,
  Image as ImageIcon,
  Loader2,
  ScanLine,
  Sparkles,
  X,
} from "lucide-react";
import type { OmniModel } from "../lib/types";
import type { CapabilityIndex } from "../lib/capabilities";
import { modelCapabilities, providerLabel } from "../lib/capabilities";

export type GenerationMode = "image" | "edit" | "video";

const MODE_META: Record<
  GenerationMode,
  { title: string; icon: typeof ImageIcon; hint: string; button: string }
> = {
  image: {
    title: "Generate image",
    icon: ImageIcon,
    hint: "165 image models",
    button: "Generate",
  },
  edit: {
    title: "Edit image",
    icon: ScanLine,
    hint: "165 image models",
    button: "Edit",
  },
  video: {
    title: "Generate video",
    icon: Film,
    hint: "4 video models",
    button: "Generate",
  },
};

interface GenerationPanelProps {
  mode: GenerationMode;
  models: OmniModel[];
  index: CapabilityIndex;
  initialPrompt?: string;
  initialImage?: AttachmentLike | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: {
    mode: GenerationMode;
    prompt: string;
    model: string;
    image: string | File | null;
  }) => void;
}

type AttachmentLike = { dataUrl?: string; name?: string };

export function GenerationPanel({
  mode,
  models,
  index,
  initialPrompt,
  initialImage,
  busy,
  onClose,
  onSubmit,
}: GenerationPanelProps) {
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [model, setModel] = useState("auto");
  const [image, setImage] = useState<{ dataUrl: string; name: string } | null>(() =>
    initialImage?.dataUrl
      ? { dataUrl: initialImage.dataUrl, name: initialImage.name ?? "image" }
      : null
  );

  const isEdit = mode === "edit";

  // Models usable for the selected mode, by heuristic capability: image gen/edit
  // models are vision-capable; video models report `video`.
  const usable = useMemo(() => {
    const scored: { model: OmniModel; score: number }[] = [];
    for (const m of models) {
      const caps = modelCapabilities(m.id, index);
      let score = 0;
      if (mode === "video") {
        if (caps.video) score = 2;
        else if (/video|veo|kling|runway|sora|pixverse|wan/i.test(m.id)) score = 1;
      } else {
        if (caps.vision) score = 2;
        else if (/image|dall|flux|midjourney|stable|imagen|sdxl|sana|qwen-image|graphic|illustration/i.test(m.id)) score = 1;
      }
      if (score > 0) scored.push({ model: m, score });
    }
    scored.sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));
    // Always allow "auto" so the gateway routes.
    if (!scored.some((s) => s.model.id === "auto")) scored.unshift({ model: { id: "auto" }, score: 0 });
    return scored.map((s) => s.model);
  }, [models, index, mode]);

  const handleImageFile = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () =>
      setImage({ dataUrl: reader.result as string, name: file.name });
    reader.readAsDataURL(file);
  };

  const canSubmit = prompt.trim().length > 0 && (!isEdit || !!image) && !busy;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      mode,
      prompt: prompt.trim(),
      model,
      image: isEdit && image ? image.dataUrl : null,
    });
  };

  const Icon = MODE_META[mode].icon;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto">
      <div className="fixed inset-0 bg-overlay/60" onClick={busy ? undefined : onClose} />
      <div className="relative z-10 mt-16 mb-16 w-full max-w-xl rounded-2xl border border-border bg-bg-elevated shadow-lift">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-base font-medium">
            <Icon size={17} className="text-accent" />
            {MODE_META[mode].title}
            <span className="rounded-full border border-border-subtle bg-canvas px-2 py-0.5 text-[11px] text-fg-faint">
              {MODE_META[mode].hint}
            </span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-full border border-border bg-canvas p-1.5 text-fg-dim hover:bg-bg-hover hover:text-fg disabled:opacity-40"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {isEdit && (
            <div>
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-fg-faint">
                Source image
              </div>
              <div className="flex items-center gap-3">
                {image ? (
                  <img
                    src={image.dataUrl}
                    alt={image.name}
                    className="h-20 w-20 rounded-lg border border-border object-cover"
                  />
                ) : (
                  <div className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-border text-fg-faint">
                    <ImageIcon size={20} />
                  </div>
                )}
                <label className="cursor-pointer rounded-lg border border-border bg-canvas px-3 py-1.5 text-sm text-fg-dim hover:bg-bg-hover">
                  {image ? "Change image" : "Choose image"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => handleImageFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                {image && (
                  <button
                    type="button"
                    onClick={() => setImage(null)}
                    className="text-xs text-fg-faint hover:text-fg"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          )}

          <div>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-fg-faint">
              Prompt
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                mode === "edit"
                  ? "Describe the edit to apply to the image…"
                  : "Describe the image or video you want to create…"
              }
              rows={3}
              className="w-full resize-none rounded-lg border border-border bg-canvas px-3 py-2 text-sm outline-none placeholder:text-fg-faint focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-fg-faint">
              Model
            </div>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
            >
              {usable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id === "auto"
                    ? "auto (gateway routes)"
                    : `${m.id}${providerLabel(m.id.split("/")[0] ?? "", index) !== (m.id.split("/")[0] ?? "") ? " · " + providerLabel(m.id.split("/")[0] ?? "", index) : ""}`}
                </option>
              ))}
              {usable.length === 1 && (
                <option value="auto">auto (gateway routes)</option>
              )}
            </select>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-border bg-canvas px-3 py-1.5 text-sm hover:bg-bg-hover disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-sm text-on-accent hover:bg-accent-hover disabled:opacity-40 disabled:hover:bg-accent"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {busy
              ? mode === "video"
                ? "Generating…"
                : "Working…"
              : MODE_META[mode].button}
          </button>
        </div>

        {mode === "video" && (
          <p className="border-t border-border-subtle px-5 py-2.5 text-[11px] leading-4 text-fg-faint">
            Video generation can take a while. Some providers queue a job that returns
            asynchronously rather than a finished file.
          </p>
        )}
      </div>
    </div>
  );
}
