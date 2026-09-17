import type { GeneratedArtifact } from "./types";

/** Suggested download filename for the current artifact/phase. */
export function downloadFilename(artifact: GeneratedArtifact): string {
  if (artifact.type === "document") {
    const base = artifact.title.replace(/\.[^./\\]+$/, "");
    return `${base || "document"}.md`;
  }
  return artifact.title || "file.txt";
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadText(filename: string, text: string): void {
  downloadBlob(filename, new Blob([text], { type: "text/plain;charset=utf-8" }));
}

/** Downloads an artifact's current (edited, if any) content as a file — the same
 *  action ArtifactPanel's own Download button performs, shared here so a
 *  message-level quick-download (no need to open the panel first) uses
 *  identical filename/content logic. */
export function downloadArtifact(artifact: GeneratedArtifact): void {
  downloadText(downloadFilename(artifact), artifact.editedContent ?? artifact.content);
}
