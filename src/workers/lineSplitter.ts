/**
 * Worker-scoped: turns a raw byte stream into the line-at-a-time messages
 * workerRunner.ts's protocol expects.
 *
 * WASI's fd_write hands over arbitrary Uint8Array chunks with no regard for
 * line boundaries (and a multi-byte character can straddle two of them, hence
 * the streaming TextDecoder). Extracted from wasiShellWorker.ts, which was the
 * only caller before clangToolchain.ts needed exactly the same thing.
 *
 * `flush()` is not optional: without it the final line of any program that
 * doesn't end in a newline - `printf("%d", x)` being the obvious case - is
 * still sitting in `pending` when the run ends, and is silently lost.
 */
export function lineSplitter(onLine: (line: string) => void) {
  const decoder = new TextDecoder();
  let pending = "";
  const push = (bytes: Uint8Array) => {
    pending += decoder.decode(bytes, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };
  /**
   * Emits whatever is still buffered and returns that text (empty if there was
   * none). The return value is what lets an interactive runtime turn a prompt
   * written without a trailing newline - `printf("Choice: ")` - into the label
   * on the input box, instead of leaving the box blank.
   */
  const flush = (): string => {
    const tail = pending;
    pending = "";
    if (tail) onLine(tail);
    return tail;
  };
  return { push, flush };
}
