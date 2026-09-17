/**
 * Progress channel for local models.
 *
 * A local model's first use downloads one to several GB of weights. The
 * ChatAdapter interface has no slot for that - it only knows about tokens - so
 * progress is published here instead and the UI subscribes. Without it the app
 * would look frozen for minutes on the first message to a local model.
 */

export interface LocalModelProgress {
  /** Fully-qualified model id being prepared, e.g. "local/Llama-3.2-1B-Instruct-q4f32_1-MLC". */
  modelId: string;
  /** 0..1 where known; undefined while the runtime reports text only. */
  progress?: number;
  /** Human-readable stage, straight from the runtime ("Fetching param cache..."). */
  text: string;
  /** True once the model is loaded and generation has begun. */
  done: boolean;
}

type Listener = (p: LocalModelProgress | null) => void;

const listeners = new Set<Listener>();
let current: LocalModelProgress | null = null;

export function publishLocalProgress(p: LocalModelProgress | null): void {
  current = p;
  for (const listener of listeners) {
    try {
      listener(p);
    } catch {
      /* a broken subscriber must never break generation */
    }
  }
}

/** Subscribe to load progress. Returns an unsubscribe function. */
export function onLocalProgress(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

export function currentLocalProgress(): LocalModelProgress | null {
  return current;
}
