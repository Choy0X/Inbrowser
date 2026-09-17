import { createJavaScriptRunner } from "../codeRunners/javascript";
import type { Plugin } from "./types";

export const javascriptPlugin: Plugin = {
  id: "javascript",
  name: "JavaScript",
  description: "Run JavaScript in an isolated worker. Built in — nothing to download.",
  estimatedSizeMB: 0,
  builtin: true,
  languages: ["javascript", "js", "node", "nodejs", "mjs"],
  async install() {
    /* nothing to fetch */
  },
  async uninstall() {
    /* nothing to remove */
  },
  createRunner: createJavaScriptRunner,
};
