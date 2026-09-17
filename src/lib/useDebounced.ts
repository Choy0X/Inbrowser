import { useEffect, useState } from "react";

/**
 * Debounced mirror of a value.
 *
 * Extracted from ModelPickerModal, which needed it so filtering a huge model
 * list didn't run on every keystroke. The same problem turned up on every list
 * screen (plugins, skills, the skill store), so it lives here now.
 */
export function useDebounced<T>(value: T, delayMs = 120): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
