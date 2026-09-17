import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { isUserEdit } from "../lib/editorSync";

/**
 * The app's one Monaco mount. Extracted from ArtifactPanel so the inline code
 * blocks in chat prose (InlineCodeFile.tsx) share the same lazy loader, the
 * same options and the same echo guard - two copies would mean two chunks and
 * two chances to get the setValue echo wrong.
 */
const MonacoEditor = lazy(() =>
  Promise.all([import("@monaco-editor/react"), import("monaco-editor")]).then(
    ([{ Editor, loader }, monaco]) => {
      loader.config({ monaco });
      return { default: Editor };
    }
  )
);

export const monacoOptions = {
  minimap: { enabled: false },
  fontSize: 13,
  fontFamily: "'Cascadia Code', 'Fira Code', Consolas, Menlo, monospace",
  scrollBeyondLastLine: false,
  wordWrap: "on" as const,
  automaticLayout: true,
  padding: { top: 8, bottom: 8 },
};

export function CodeEditor({
  language,
  value,
  readOnly,
  onChange,
  height = "100%",
}: {
  language: string;
  value: string;
  readOnly: boolean;
  onChange: (v: string) => void;
  /** Panels pass "100%" and let the flex parent bound them; an inline block in
   *  chat prose has no bounded parent and passes an explicit pixel height. */
  height?: string | number;
}) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center gap-2 text-fg-faint">
          <Loader2 size={16} className="animate-spin" /> Loading editor…
        </div>
      }
    >
      <MonacoEditor
        height={height}
        language={language}
        value={value}
        // Monaco reports a programmatic `setValue()` - which is how the `value`
        // prop is applied - through the same change event as a keystroke. That
        // echo used to be stored as a local draft, which then took precedence
        // over the artifact and froze the view mid-generation.
        onChange={(v) => {
          const next = v ?? "";
          if (isUserEdit(next, value, readOnly)) onChange(next);
        }}
        theme="vs-dark"
        options={{ ...monacoOptions, readOnly }}
      />
    </Suspense>
  );
}
