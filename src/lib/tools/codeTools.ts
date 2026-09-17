import type { ToolHandler } from "./types";
import { stringArg } from "./types";
import { getPluginForLanguage, PLUGINS } from "../plugins/registry";
import { getPluginState, loadPluginStates } from "../pluginStore";
import { DEFAULT_RUN_TIMEOUT_MS } from "../codeRunners/types";

/**
 * Lets the model actually execute code instead of only writing it, using the
 * same in-browser runtimes the artifact panel uses (a real Worker per run, so a
 * runaway program cannot lock the UI).
 *
 * Only installed and enabled runtimes are offered, and the tool description is
 * generated from that list, so the model is never told it can run a language
 * the user has not installed.
 */

const OUTPUT_LIMIT = 8000;

function availableLanguages(): string[] {
  const states = loadPluginStates();
  return PLUGINS.filter((p) => {
    const state = getPluginState(states, p.id);
    return p.builtin || (state.installed && state.enabled);
  }).flatMap((p) => p.languages);
}

const runCode: ToolHandler = {
  id: "run_code",
  group: "code",
  applies: () => availableLanguages().length > 0,
  // A getter, not a literal: the registry reads this when building each turn's
  // toolset, so the language list reflects what is installed *now*. As a plain
  // property it was frozen at module-import time, i.e. always empty.
  get def() {
    return {
    type: "function" as const,
    function: {
      name: "run_code",
      // Built from what is actually installed: a static list made the model
      // guess at a language that was not there and waste a turn.
      description:
        "Execute a snippet of code in this browser and return whatever it prints. Use it to compute results, " +
        "check your own work, or process data - never guess at arithmetic or parsing you could just run. " +
        `Installed languages: ${availableLanguages().join(", ") || "none"}. ` +
        "The code runs sandboxed with no file system, and is killed after a timeout. " +
        (availableLanguages().includes("python")
          ? "Python can reach the real network via urllib or requests, subject to normal browser CORS rules " +
            "(only CORS-enabled endpoints are reachable) - the first network call in a session may take a few " +
            "seconds while the HTTP backend installs. "
          : "") +
        "No other language here has network access. There is no interactive input either - never call input() " +
        "or read from stdin; take any values the program needs as hardcoded constants or function arguments " +
        "instead. There is also no command line: argv is always empty, so never write a script that checks " +
        "len(sys.argv)/argparse and exits or prints a usage message when nothing was passed - call your " +
        "function directly with real example values in the code itself instead of gating on arguments.",
      parameters: {
        type: "object",
        properties: {
          language: {
            type: "string",
            description: "Language to run, e.g. 'python' or 'javascript'. Must be an installed runtime.",
          },
          code: {
            type: "string",
            description: "The complete program to run. Print results to stdout; nothing else is returned.",
          },
        },
        required: ["language", "code"],
      },
    },
    };
  },
  async run(args, ctx) {
    const language = stringArg(args, "language").toLowerCase();
    const code = typeof args.code === "string" ? args.code : "";
    if (!language) return "Provide a language.";
    if (!code.trim()) return "Provide code to run.";

    const installed = availableLanguages();
    const plugin = getPluginForLanguage(language);
    if (!plugin || !installed.includes(language)) {
      return `No runtime for "${language}" is installed. Available: ${installed.join(", ") || "none"}. The user can add more from the Plugins page.`;
    }

    const runner = plugin.createRunner();
    const controller = new AbortController();
    // This abort is independent of the runner's own timeout, so it has to use
    // the same budget or it silently cuts the run short - a C/C++ program gets
    // compiled and linked inside this call, which does not fit in 20 seconds.
    const timeoutMs = plugin.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (ctx.signal) ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });

    const out: string[] = [];
    const err: string[] = [];
    try {
      const outcome = await runner.run(code, {
        onStdout: (line) => out.push(line),
        onStderr: (line) => err.push(line),
        signal: controller.signal,
      });

      const stdout = out.join("\n").slice(0, OUTPUT_LIMIT);
      const stderr = err.join("\n").slice(0, OUTPUT_LIMIT);
      const parts: string[] = [];
      if (stdout) parts.push(`stdout:\n${stdout}`);
      if (stderr) parts.push(`stderr:\n${stderr}`);

      if (outcome.kind === "error") parts.push(`error: ${outcome.message}`);
      if (outcome.kind === "aborted") {
        parts.push(`aborted: the program exceeded ${timeoutMs / 1000}s and was stopped.`);
      }
      if (parts.length === 0) return "The program ran and produced no output. Print something to see a result.";
      return parts.join("\n\n");
    } finally {
      clearTimeout(timer);
      runner.dispose();
    }
  },
};

export const CODE_TOOL_HANDLERS: ToolHandler[] = [runCode];

// Shown as its own system message whenever run_code is offered for a turn,
// separate from the ~650-token artifact contract. Without this, nothing in
// the prompt ever mentions run_code by name - it only exists as an API-level
// function schema - while the artifact contract hands the model a vivid,
// literal template it directly attends to. A model with imperfect native
// tool-calling then defaults to the one concrete contract it was actually
// shown in text (the artifact tag) instead of calling the tool. This prompt
// is itself subject to promptScale.ts's small-model gating (see App.tsx) -
// a model too weak for the artifact contract is equally prone to latching
// onto a dense paragraph that names <fachoy-artifact>, so it is withheld
// from it the same way.
// The no-stdin/no-argv rules below already live in the tool's own function-
// schema `description` above, but models have repeatedly written input()- or
// sys.argv-gated scripts anyway (a schema `description` is not always
// attended to as strongly as a system message) - restated here as the same
// kind of belt-and-suspenders duplication.
//
// input() specifically now has a real exception, and it matters that the
// model knows it: the manual "Run" button in the artifact panel supports
// live interactive stdin (see codeRunners/interactiveStdin.ts) - only the
// run_code TOOL CALL itself never can (no UI is shown to anyone mid-tool-
// call). An unqualified "never call input()" told the model to avoid the
// one pattern that would ever exercise that feature, so a script the user
// explicitly wants to be interactive needs a different instruction than a
// script the model wants run_code to execute and return an answer from.
export const RUN_CODE_SYSTEM_PROMPT =
  "When the user wants code actually executed - to see real output, test it, fetch live data, or check an " +
  "answer - call the run_code tool instead of just writing the code and telling them to run it themselves. " +
  "A <fachoy-artifact> file or a code fence only shows or saves code; neither one runs it. " +
  "Only fall back to writing the code for them if run_code truly can't do what they need " +
  "(e.g. no matching language is installed). The run_code TOOL CALL itself has no console and no command line: " +
  "never call input() or check sys.argv/argparse in code you pass to run_code - that call will always fail " +
  "there with EOF, no matter how many times it's run; call your function directly with a concrete example " +
  "value instead (e.g. get_weather(\"Tokyo\")). If the user specifically wants an interactive, " +
  "ask-a-question-and-wait script, input() is fine there - just don't call run_code with it. Write it as a " +
  "normal <fachoy-artifact> file instead and tell them they can click Run in the code panel to answer its " +
  "prompts live; that manual Run button, unlike the run_code tool call, can actually wait for a typed answer.";
