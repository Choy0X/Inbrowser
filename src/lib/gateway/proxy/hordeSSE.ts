/** Adapt AI Horde's proxied SSE line endings without buffering whole events or
 * responses. Direct requests keep the original shared stream parser. */
export function normalizeHordeSSE(response: Response): Response {
  if (!response.body) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let skipLeadingLf = false;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      let text = decoder.decode(bytes, { stream: true });
      if (!text) return;
      const followsCr = skipLeadingLf;
      skipLeadingLf = text.endsWith("\r");
      if (followsCr && text.startsWith("\n")) text = text.slice(1);
      if (text) controller.enqueue(encoder.encode(text.replace(/\r\n?/g, "\n")));
    },
    flush(controller) {
      const text = decoder.decode();
      if (text) controller.enqueue(encoder.encode(text));
    },
  }));
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
