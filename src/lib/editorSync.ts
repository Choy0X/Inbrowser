/**
 * Guard for controlled code-editor change events.
 *
 * Monaco does not distinguish a user's keystroke from a programmatic
 * `setValue()`. `@monaco-editor/react` calls `setValue()` whenever the `value`
 * prop changes, and that fires the same content-change event a real edit does,
 * so the wrapper reports it back through `onChange`.
 *
 * That echo is what froze the artifact viewer during generation: each streamed
 * chunk updated `value`, Monaco echoed it back as an "edit", the panel stored
 * it as a local draft, and because the draft takes precedence over the incoming
 * artifact every later chunk was ignored. The view stuck at the first update
 * after opening, and only closing and reopening (which unmounts the draft)
 * showed the finished file.
 *
 * An echo is identifiable: its value is exactly what we just pushed in. A real
 * keystroke always differs.
 */
export function isUserEdit(next: string, incoming: string, readOnly: boolean): boolean {
  // A read-only editor cannot produce a user edit, so anything it reports is
  // either an echo or a stray event; never treat it as a draft.
  if (readOnly) return false;
  return next !== incoming;
}
