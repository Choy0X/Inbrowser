/**
 * WebLLM engine host.
 *
 * Model weights are compiled and executed here rather than on the main thread,
 * for the same reason Pyodide and the JS runner get their own workers: a local
 * model saturates the thread it runs on, and doing that on the UI thread would
 * freeze the app for the whole of every reply.
 */
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();

self.onmessage = (msg: MessageEvent) => {
  handler.onmessage(msg);
};
