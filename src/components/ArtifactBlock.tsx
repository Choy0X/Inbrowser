import { Code2, FileCode2, FileText, Loader2 } from "lucide-react";
import type { GeneratedArtifact } from "../lib/types";

function artifactIcon(type: GeneratedArtifact["type"]) {
  if (type === "code") return FileCode2;
  if (type === "html" || type === "svg") return Code2;
  return FileText;
}

const TYPE_LABEL: Record<GeneratedArtifact["type"], string> = {
  code: "Code",
  markdown: "Document",
  html: "HTML",
  svg: "SVG",
  document: "Document",
};

/** Compact card list for the file artifacts a message produced — sits beside MediaBlock. */
export function ArtifactBlock({
  artifacts,
  activeArtifactId,
  onOpen,
}: {
  artifacts: GeneratedArtifact[];
  activeArtifactId?: string;
  onOpen: (artifactId: string) => void;
}) {
  return (
    <div className="mt-3 space-y-1.5">
      {artifacts.map((artifact) => {
        const Icon = artifactIcon(artifact.type);
        const active = artifact.id === activeArtifactId;
        return (
          <button
            key={artifact.id}
            type="button"
            onClick={() => onOpen(artifact.id)}
            className={`flex w-full max-w-sm items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
              active
                ? "border-accent bg-accent/10"
                : "border-border-subtle bg-bg-elevated/60 hover:bg-bg-hover"
            }`}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-canvas text-fg-dim">
              <Icon size={15} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{artifact.title}</span>
              <span className="flex items-center gap-1.5 text-xs text-fg-faint">
                {artifact.status === "streaming" ? (
                  <>
                    <Loader2 size={10} className="animate-spin" /> Writing…
                  </>
                ) : artifact.status === "truncated" ? (
                  <span className="text-amber">Incomplete</span>
                ) : (
                  TYPE_LABEL[artifact.type]
                )}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
