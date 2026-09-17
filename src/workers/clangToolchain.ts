/// <reference lib="webworker" />
import {
  ConsoleStdout,
  Fd,
  PreopenDirectory,
  WASI,
  wasi as wasiDefs,
} from "@bjorn3/browser_wasi_shim";
import { requestInputSync } from "../lib/codeRunners/interactiveStdin";
import { lineSplitter } from "./lineSplitter";
import { GMP_NOTICE, loadGmpSources, usesGmp, type GmpSources } from "./gmpSources";
import { installCacheFirstFetch } from "./runtimeCacheFetch";

/**
 * C and C++, via a real Clang/LLVM 20 toolchain compiled to WebAssembly
 * (browsercc). Shared by cWorker.ts and cppWorker.ts, which differ only in the
 * dialect they bind. Both belong to one C / C++ store plugin.
 *
 * Unlike every other runtime here, a run is compile + link + execute: clang
 * emits a wasm32-wasi object, wasm-ld links it into a WASI command module, and
 * @bjorn3/browser_wasi_shim executes that in this same worker.
 *
 * Must be first: the Emscripten glue fetches clang.wasm/lld.wasm itself, and
 * index.js fetches sysroot.tar/stdc++.h.pch, all by URL relative to /cpp/.
 * This points every one of those at the bucket the plugin's install()
 * populated, which is what makes "installed" mean anything offline.
 */
installCacheFirstFetch("fachoy-plugin-clang");

const BASE = "/cpp/";

/* ------------------------------------------------------------------ *
 * The slice of browsercc this file actually uses.
 *
 * Typed here rather than as `typeof import("browsercc")` because the package
 * is loaded by URL, never as a bundled specifier (see loadToolchain), so the
 * bundler must not see a real import of it at all. Keeping the surface
 * explicit also documents exactly how much of it we depend on.
 * ------------------------------------------------------------------ */

interface EmscriptenFS {
  writeFile(path: string, data: string | Uint8Array): void;
  readFile(path: string, opts: { encoding: "binary" }): Uint8Array<ArrayBuffer>;
  mkdirTree(path: string): void;
  analyzePath(path: string): { exists: boolean };
}

interface Program {
  FS: EmscriptenFS;
  /**
   * Returns the process exit code. NOTE: Emscripten's callMain does
   * `args.unshift(thisProgram)` - it MUTATES the array it is handed - so every
   * call site below passes a fresh copy. Reusing a cached argv directly makes
   * the first run succeed and every later one fail with `unknown argument:
   * '-cc1'` (clang) or `cannot open wasm-ld` (the linker), because argv[0]
   * accumulates inside the cached array.
   */
  callMain(args: string[]): number;
}

type ProgramFactory = (options: {
  thisProgram: string;
  noInitialRun: boolean;
  printErr: (text: string) => void;
  print: (text: string) => void;
  instantiateWasm: (
    imports: WebAssembly.Imports,
    success: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
  ) => WebAssembly.Exports;
}) => Promise<Program>;

interface Toolchain {
  Clang: ProgramFactory;
  LLD: ProgramFactory;
  tarContents(contents: ArrayBuffer): Generator<{ name: string; content: Uint8Array }>;
}

export type Dialect = "c" | "c++";

interface DialectSpec {
  /**
   * argv[0]. This, not a `-x` flag, is what picks clang's driver mode: the
   * driver reads a "++" suffix off its own program name. `-x c` cannot be used
   * instead, because the probe passes flags AFTER the input filename and `-x`
   * only applies to inputs that follow it.
   */
  program: string;
  fileName: string;
  flags: string[];
  /** stdc++.h.pch is built for exactly `-O2 -std=c++20 -fno-exceptions`. */
  usePch: boolean;
}

const DIALECTS: Record<Dialect, DialectSpec> = {
  c: { program: "clang", fileName: "main.c", flags: ["-std=c17", "-O1"], usePch: false },
  "c++": {
    program: "clang++",
    fileName: "main.cpp",
    // -fno-exceptions is not a preference: this sysroot's libc++.a contains no
    // __cxa_throw/__cxa_begin_catch at all, so it was built without exception
    // support. Pinning the flag turns a `throw` into an honest compiler
    // diagnostic ("cannot use 'throw' with exceptions disabled") instead of an
    // unreadable link failure.
    flags: ["-std=c++20", "-O2", "-fno-exceptions"],
    usePch: true,
  },
};

const PCH_PATH = "/stdc++.h.pch";

/* ------------------------------------------------------------------ *
 * Module-scope caches. workerRunner.ts keeps a worker warm between runs, so
 * everything here is paid once per worker rather than once per run. A timeout
 * or a Stop terminates the worker, which discards all of it - the run after a
 * hard stop is cold again, by design.
 * ------------------------------------------------------------------ */

let toolchainPromise: Promise<Toolchain> | null = null;

function loadToolchain(): Promise<Toolchain> {
  if (!toolchainPromise) {
    // By URL, not by package specifier, and deliberately not statically
    // analysable. Loading /cpp/index.js means `import.meta.url` inside the
    // Emscripten glue resolves to /cpp/, so its own locateFile("clang.wasm")
    // and `new URL("sysroot.tar", import.meta.url)` land on this app's own
    // origin - which is the whole reason the package is self-hosted rather
    // than bundled.
    const url = `${BASE}index.js`;
    toolchainPromise = import(/* @vite-ignore */ url) as Promise<Toolchain>;
  }
  return toolchainPromise;
}

const wasmModules = new Map<string, Promise<WebAssembly.Module>>();

function compiledModule(name: string): Promise<WebAssembly.Module> {
  let cached = wasmModules.get(name);
  if (!cached) {
    const url = `${BASE}${name}`;
    // compileStreaming needs an application/wasm Content-Type. That holds for
    // the dev server, for the app server in `server/` and for a Cache Storage replay
    // - but a response restored from a host that typed it differently would
    // throw, and losing the whole runtime to a header is not worth it.
    cached = WebAssembly.compileStreaming(fetch(url)).catch(async () =>
      WebAssembly.compile(await (await fetch(url)).arrayBuffer())
    );
    wasmModules.set(name, cached);
  }
  return cached;
}

type SysrootFile = { name: string; content: Uint8Array };

let sysrootPromise: Promise<SysrootFile[]> | null = null;

/**
 * ~1500 files, ~27MB, parsed once and then written into each fresh Emscripten
 * MEMFS. The tar parse is cacheable; the per-instance write is not (MEMFS
 * cannot be snapshotted), but it only costs tens of milliseconds.
 */
function getSysroot(toolchain: Toolchain): Promise<SysrootFile[]> {
  if (!sysrootPromise) {
    sysrootPromise = (async () => {
      const tar = await (await fetch(`${BASE}sysroot.tar`)).arrayBuffer();
      return [...toolchain.tarContents(tar)].filter((f) => !f.name.endsWith("/"));
    })();
  }
  return sysrootPromise;
}

let pchPromise: Promise<Uint8Array> | null = null;

function getPch(): Promise<Uint8Array> {
  if (!pchPromise) {
    pchPromise = (async () => new Uint8Array(await (await fetch(`${BASE}stdc++.h.pch`)).arrayBuffer()))();
  }
  return pchPromise;
}

function writeSysroot(program: Program, files: SysrootFile[], extra?: Record<string, Uint8Array>): void {
  for (const { name, content } of files) {
    const slash = name.lastIndexOf("/");
    const dir = slash === -1 ? "" : name.slice(0, slash);
    if (dir && !program.FS.analyzePath(dir).exists) program.FS.mkdirTree(dir);
    program.FS.writeFile(name, content);
  }
  for (const [name, content] of Object.entries(extra ?? {})) program.FS.writeFile(name, content);
}

async function boot(
  factory: ProgramFactory,
  wasmName: string,
  thisProgram: string,
  onDiagnostic: (text: string) => void
): Promise<Program> {
  const module = await compiledModule(wasmName);
  return factory({
    thisProgram,
    // The glue would otherwise run main() with an empty argv at startup; every
    // invocation here is an explicit callMain instead.
    noInitialRun: true,
    printErr: onDiagnostic,
    print: onDiagnostic,
    // Instantiating from a cached WebAssembly.Module is what makes a warm run
    // cheap: the 42.5MB clang.wasm is compiled once per worker, not once per
    // run. A Module is immutable and stateless, so each instance still gets its
    // own fresh linear memory. Passing `wasmBinary` instead would copy 42.5MB
    // *and* recompile on every instantiation.
    instantiateWasm(imports, success) {
      const instance = new WebAssembly.Instance(module, imports);
      success(instance, module);
      return instance.exports;
    },
  });
}

/* ------------------------------------------------------------------ *
 * The compiler driver probe.
 * ------------------------------------------------------------------ */

interface Invocation {
  compilerArgs: string[];
  compilerArtifact: string;
  linkerArgs: string[];
  linkerArtifact: string;
}

const probes = new Map<Dialect, Promise<Invocation>>();

/**
 * Runs `clang <file> <flags> -###` once and scrapes the real -cc1 and wasm-ld
 * command lines out of its stderr, so the actual compile can skip the driver
 * entirely. Cached per dialect: the flags and the filename are fixed, so the
 * answer never changes within a worker.
 *
 * Deliberately uses a *dummy* sysroot (four empty paths), not the real one -
 * the driver only stats these while assembling the link line, so this costs
 * ~150ms rather than a full untar.
 */
function getInvocation(toolchain: Toolchain, dialect: Dialect): Promise<Invocation> {
  let cached = probes.get(dialect);
  if (!cached) {
    cached = (async (): Promise<Invocation> => {
      const spec = DIALECTS[dialect];
      let diagnostics = "";
      const program = await boot(toolchain.Clang, "clang.wasm", spec.program, (text) => {
        diagnostics += text + "\n";
      });
      program.FS.writeFile(spec.fileName, "int main(){return 0;}");
      program.FS.mkdirTree("/lib/wasm32-wasi");
      program.FS.mkdirTree("/include/c++/v1");
      program.FS.writeFile("/lib/wasm32-wasi/crt1-command.o", new Uint8Array(0));
      program.FS.writeFile("/lib/wasm32-wasi/crt1-reactor.o", new Uint8Array(0));

      const code = program.callMain([spec.fileName, ...spec.flags, "-###"]);
      if (code !== 0) throw new Error(`The C/C++ compiler driver failed to start.\n${diagnostics}`);

      const lines = diagnostics.split("\n");
      const scrape = (needle: string) => {
        const line = lines.find((l) => l.includes(needle)) ?? "";
        // Every token on a -### line is quoted; the first is the program
        // itself, which callMain supplies as argv[0].
        const args = (line.match(/"([^"]*)"/g) ?? []).map((s) => s.slice(1, -1)).slice(1);
        return { args, out: args[args.findIndex((a) => a === "-o") + 1] ?? "" };
      };
      const compile = scrape("-cc1");
      const link = scrape("wasm-ld");
      if (!compile.args.length || !compile.out || !link.args.length || !link.out) {
        throw new Error(`Could not read the compiler's own command line.\n${diagnostics}`);
      }
      // The driver mode is the only thing selecting the language, so assert it
      // actually took rather than silently compiling C as C++.
      const selected = compile.args[compile.args.indexOf("-x") + 1];
      const expected = dialect === "c" ? "c" : "c++";
      if (selected !== expected) {
        throw new Error(`Expected the compiler to build ${expected}, but it chose "${selected}".`);
      }

      return {
        compilerArgs: compile.args,
        compilerArtifact: compile.out,
        linkerArgs: link.args,
        linkerArtifact: link.out,
      };
    })();
    probes.set(dialect, cached);
  }
  return cached;
}

/* ------------------------------------------------------------------ *
 * The stdio prelude.
 * ------------------------------------------------------------------ */

/**
 * Linked into every executable. Its only job is to make stdout and stderr
 * unbuffered before main() runs.
 *
 * Without it, an interactive program is unusable here. wasi-libc is musl, which
 * line-buffers stdout and - unlike glibc - never flushes it when stdin is read.
 * So `printf("Choice: "); scanf(...)` leaves the prompt sitting inside the
 * module's own FILE buffer: measured against the real toolchain, stdout had
 * emitted NOTHING at the moment the program blocked for input, and the question
 * only surfaced after the program exited, below the answers already typed.
 *
 * A WASI command module runs __wasm_call_ctors before main, so this lands ahead
 * of any user I/O. Cost is close to nothing: 20k printf lines went 19ms -> 32ms
 * with an identical 40k fd_write calls, because musl was already writing once
 * per line - so it is applied unconditionally rather than only when a prompt is
 * possible.
 *
 * Linked as its own object rather than force-included into the user's file, so
 * that clang's diagnostics still refer to their code at their line numbers.
 */
const PRELUDE_SOURCE = "#include <stdio.h>\n__attribute__((constructor)) static void fachoy_unbuffer(void) {\n  setvbuf(stdout, NULL, _IONBF, 0);\n  setvbuf(stderr, NULL, _IONBF, 0);\n}\n";

const PRELUDE_SOURCE_PATH = "prelude.c";
const PRELUDE_OBJECT_PATH = "/tmp/fachoy-prelude.o";

const preludeObjects = new Map<Dialect, Promise<Uint8Array<ArrayBuffer>>>();

/**
 * Compiled once per worker with the dialect's own cached -cc1 line, so it
 * matches the target exactly. The input/output names are swapped in, and
 * -include-pch is never added: a five-line file has no use for a 19MB
 * precompiled STL header.
 */
function getPreludeObject(
  toolchain: Toolchain,
  dialect: Dialect,
  sysroot: SysrootFile[],
  invocation: Invocation
): Promise<Uint8Array<ArrayBuffer>> {
  let cached = preludeObjects.get(dialect);
  if (!cached) {
    cached = (async () => {
      const spec = DIALECTS[dialect];
      let diagnostics = "";
      const program = await boot(toolchain.Clang, "clang.wasm", spec.program, (text) => {
        diagnostics += text + "\n";
      });
      program.FS.writeFile(PRELUDE_SOURCE_PATH, PRELUDE_SOURCE);
      writeSysroot(program, sysroot);
      const args = invocation.compilerArgs.map((arg) =>
        arg === spec.fileName ? PRELUDE_SOURCE_PATH : arg === invocation.compilerArtifact ? PRELUDE_OBJECT_PATH : arg
      );
      if (program.callMain([...args]) !== 0) {
        throw new Error(`Could not build the stdio prelude.
${diagnostics}`);
      }
      return program.FS.readFile(PRELUDE_OBJECT_PATH, { encoding: "binary" });
    })();
    preludeObjects.set(dialect, cached);
  }
  return cached;
}

/* ------------------------------------------------------------------ *
 * GMP (mini-gmp). See gmpSources.ts for why this exists.
 * ------------------------------------------------------------------ */

const GMP_OBJECTS = [
  { source: "mini-gmp.c", object: "/tmp/fachoy-mini-gmp.o" },
  { source: "gmp-shim.c", object: "/tmp/fachoy-gmp-shim.o" },
] as const;

/** Puts gmp.h / mini-gmp.h where an `#include <gmp.h>` will find them. */
function stageGmpHeaders(program: Program, sources: GmpSources): void {
  program.FS.mkdirTree("/include");
  program.FS.writeFile("/include/mini-gmp.h", sources.miniHeader);
  program.FS.writeFile("/include/gmp.h", sources.gmpHeader);
}

let gmpObjectsPromise: Promise<{ path: string; bytes: Uint8Array<ArrayBuffer> }[]> | null = null;

/**
 * Compiles mini-gmp and the shim once per worker.
 *
 * Always with the C invocation, even inside the C++ worker: mini-gmp is C, and
 * building it as C++ would mangle its symbols away from the extern "C"
 * declarations its own header hands the including program.
 */
function getGmpObjects(
  toolchain: Toolchain,
  sysroot: SysrootFile[]
): Promise<{ path: string; bytes: Uint8Array<ArrayBuffer> }[]> {
  if (!gmpObjectsPromise) {
    gmpObjectsPromise = (async () => {
      const sources = await loadGmpSources();
      const invocation = await getInvocation(toolchain, "c");
      const text: Record<string, string> = {
        "mini-gmp.c": sources.miniImpl,
        "gmp-shim.c": sources.shimImpl,
      };
      const built: { path: string; bytes: Uint8Array<ArrayBuffer> }[] = [];
      for (const { source, object } of GMP_OBJECTS) {
        let diagnostics = "";
        const program = await boot(toolchain.Clang, "clang.wasm", DIALECTS.c.program, (line) => {
          diagnostics += line + "\n";
        });
        writeSysroot(program, sysroot);
        stageGmpHeaders(program, sources);
        program.FS.writeFile(source, text[source]);
        const args = invocation.compilerArgs.map((arg) =>
          arg === DIALECTS.c.fileName ? source : arg === invocation.compilerArtifact ? object : arg
        );
        if (program.callMain([...args]) !== 0) {
          throw new Error(`Could not build the bundled GMP (${source}).\n${diagnostics}`);
        }
        built.push({ path: object, bytes: program.FS.readFile(object, { encoding: "binary" }) });
      }
      return built;
    })();
  }
  return gmpObjectsPromise;
}

/* ------------------------------------------------------------------ *
 * Worker protocol
 * ------------------------------------------------------------------ */

type InMessage =
  | { kind: "run"; runId: string; code: string; interactive?: boolean; buffer?: SharedArrayBuffer }
  | { kind: "input-answer"; runId: string; value: string | null };

type OutMessage =
  | { kind: "ready"; runId: string }
  | { kind: "stdout" | "stderr"; runId: string; line: string }
  | { kind: "done"; runId: string }
  | { kind: "error"; runId: string; message: string }
  | { kind: "input-request"; runId: string; prompt: string };

function post(msg: OutMessage): void {
  (self as unknown as Worker).postMessage(msg);
}

/**
 * Read, never closed over: a warm worker outlives any single run, and a closure
 * would tag this run's output with a previous run's id, which workerRunner.ts
 * then silently drops.
 */
let currentRunId = "";

/**
 * stdin backed by the main thread's interactive prompt.
 *
 * WASI's fd_read is synchronous, and requestInputSync blocks this worker on
 * Atomics.wait until someone answers - so scanf() and std::cin genuinely wait
 * for a human, exactly as Python's input() already does. Without a
 * SharedArrayBuffer (the run_code tool-call path, which has no UI to prompt
 * anyone) it reports EOF immediately, matching every other runtime here.
 */
/**
 * Turns trailing stdout into something that reads well as the input field's
 * placeholder (CodeRunOutput falls back to a generic string when it is empty).
 * Only the last line, and capped, so a program that prints a banner immediately
 * before reading does not drop a paragraph into the box.
 */
function promptLabel(pending: string): string {
  const lastLine = pending.split("\n").pop() ?? "";
  const trimmed = lastLine.trim();
  return trimmed.length > 120 ? trimmed.slice(-120) : trimmed;
}

class PromptingStdin extends Fd {
  private queue = new Uint8Array(0);
  private eof = false;

  /**
   * @param buffer   absent on the run_code tool path, which has no UI to ask anyone.
   * @param beforeRead flushes whatever stdout/stderr are still holding and returns
   *   the pending stdout text. Called before the request is posted, never after:
   *   the prompt has to be in the log by the time the input box appears.
   * @param onCancel  the program is about to be told stdin ended.
   */
  constructor(
    private readonly buffer: SharedArrayBuffer | undefined,
    private readonly beforeRead: () => string,
    private readonly onCancel: () => void
  ) {
    super();
  }

  override fd_fdstat_get(): { ret: number; fdstat: wasiDefs.Fdstat } {
    const fdstat = new wasiDefs.Fdstat(wasiDefs.FILETYPE_CHARACTER_DEVICE, 0);
    fdstat.fs_rights_base = BigInt(wasiDefs.RIGHTS_FD_READ);
    return { ret: 0, fdstat };
  }

  override fd_read(size: number): { ret: number; data: Uint8Array } {
    if (this.queue.length === 0) {
      if (this.eof || !this.buffer) return { ret: 0, data: new Uint8Array() };
      post({ kind: "input-request", runId: currentRunId, prompt: promptLabel(this.beforeRead()) });
      const answer = requestInputSync(this.buffer);
      if (answer === null) {
        this.eof = true;
        this.onCancel();
        return { ret: 0, data: new Uint8Array() };
      }
      this.queue = new TextEncoder().encode(answer + "\n");
    }
    // Sliced as bytes, so a multi-byte character split across two reads is
    // reassembled by the program rather than corrupted here.
    const take = Math.min(size, this.queue.length);
    const data = this.queue.slice(0, take);
    this.queue = this.queue.slice(take);
    return { ret: 0, data };
  }
}

/**
 * Emscripten reports a wasm32 heap exhaustion in several shapes, none of them
 * useful to read. clang needs a lot of memory for heavy templates.
 */
function outOfMemory(err: unknown): boolean {
  if (err instanceof RangeError) return true;
  const text = err instanceof Error ? err.message : String(err);
  return /out of memory|OOM|Cannot enlarge memory|Array buffer allocation failed/i.test(text);
}

async function compileAndRun(
  dialect: Dialect,
  code: string,
  buffer: SharedArrayBuffer | undefined,
  runId: string
): Promise<void> {
  const spec = DIALECTS[dialect];
  const toolchain = await loadToolchain();
  const [sysroot, invocation] = await Promise.all([
    getSysroot(toolchain),
    getInvocation(toolchain, dialect),
  ]);
  // Needs the scraped -cc1 line, so it cannot join the Promise.all above.
  const prelude = await getPreludeObject(toolchain, dialect, sysroot, invocation);

  // Only paid for by programs that ask for it: the vendored sources are a lazy
  // chunk, and building them costs a couple of seconds once per worker.
  const needsGmp = usesGmp(code);
  const gmpSources = needsGmp ? await loadGmpSources() : null;
  const gmpObjects = needsGmp ? await getGmpObjects(toolchain, sysroot) : [];

  const diagnostics = lineSplitter((line) => post({ kind: "stderr", runId, line }));
  const encoder = new TextEncoder();
  const collectDiagnostic = (text: string) => diagnostics.push(encoder.encode(text + "\n"));

  // --- compile
  let clang: Program | null = await boot(toolchain.Clang, "clang.wasm", spec.program, collectDiagnostic);
  clang.FS.writeFile(spec.fileName, code);
  const extra: Record<string, Uint8Array> = {};
  let compilerArgs = invocation.compilerArgs;
  if (spec.usePch) {
    extra[PCH_PATH] = await getPch();
    compilerArgs = [...compilerArgs, "-include-pch", PCH_PATH];
  }
  writeSysroot(clang, sysroot, extra);
  if (gmpSources) stageGmpHeaders(clang, gmpSources);

  const compiled = clang.callMain([...compilerArgs]);
  if (compiled !== 0) {
    diagnostics.flush();
    throw new Error("Compilation failed.");
  }
  const object = clang.FS.readFile(invocation.compilerArtifact, { encoding: "binary" });
  // Dropped before the linker boots: holding both keeps two multi-hundred-MB
  // linear memories alive at once, which is what tips a big compile into OOM.
  clang = null;

  // --- link. Deliberately not started until the compile has succeeded: an
  // eagerly booted linker costs a 23MB instantiation and a second full sysroot
  // write on every compile error, for nothing.
  const lld: Program = await boot(toolchain.LLD, "lld.wasm", "wasm-ld", collectDiagnostic);
  lld.FS.writeFile(invocation.compilerArtifact, object);
  lld.FS.writeFile(PRELUDE_OBJECT_PATH, prelude);
  for (const { path, bytes } of gmpObjects) lld.FS.writeFile(path, bytes);
  writeSysroot(lld, sysroot);
  // Appended as extra input objects; the scraped link line already carries
  // crt1, the user's object, -lc and the builtins archive.
  const linked = lld.callMain([
    ...invocation.linkerArgs,
    PRELUDE_OBJECT_PATH,
    ...gmpObjects.map((o) => o.path),
  ]);
  if (linked !== 0) {
    diagnostics.flush();
    throw new Error("Linking failed.");
  }
  const executable = lld.FS.readFile(invocation.linkerArtifact, { encoding: "binary" });

  // Anything the toolchain said that was only a warning still belongs in the
  // output, but it must not be mistaken for the program's own stderr.
  diagnostics.flush();

  // --- run
  const module = await WebAssembly.compile(executable);
  // Posted here rather than before the compile: ArtifactPanel maps `ready` to
  // "Loading runtime..." -> "Running...", so this is what stops a multi-second
  // compile looking like a dead button.
  post({ kind: "ready", runId });

  const stdout = lineSplitter((line) => post({ kind: "stdout", runId, line }));
  const stderr = lineSplitter((line) => post({ kind: "stderr", runId, line }));
  if (needsGmp) post({ kind: "stderr", runId, line: GMP_NOTICE });
  // stderr first, so an error printed just before a prompt is not left sitting
  // underneath the question it explains.
  const flushPending = (): string => {
    stderr.flush();
    return stdout.flush();
  };
  const wasi = new WASI(
    [spec.fileName],
    [],
    [
      new PromptingStdin(buffer, flushPending, () =>
        // Cancelling feeds permanent EOF. A program that loops on getchar()
        // until a newline will then spin until the timeout, so say what
        // happened rather than leaving the panel silently "Running...".
        post({ kind: "stderr", runId, line: "(input cancelled - stdin is now at end of file)" })
      ),
      new ConsoleStdout((bytes) => stdout.push(bytes)),
      new ConsoleStdout((bytes) => stderr.push(bytes)),
      // One writable directory, so fopen() works instead of failing with
      // ENOTCAPABLE. In memory only, and gone when the run ends.
      new PreopenDirectory("/tmp", new Map()),
    ]
  );

  try {
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasi.wasiImport as unknown as WebAssembly.ModuleImports,
    });
    const exit = wasi.start(
      instance as unknown as { exports: { memory: WebAssembly.Memory; _start: () => unknown } }
    );
    // Flush BEFORE the exit-code note, or a final write with no trailing
    // newline is reported after it - a program ending in printf("Bye: ")
    // otherwise shows "(exit code 1)" above its own last words.
    stdout.flush();
    stderr.flush();
    if (exit !== 0) post({ kind: "stderr", runId, line: `(exit code ${exit})` });
  } finally {
    // Idempotent, and the only flush that runs if wasi.start threw. Without it
    // a program whose last write has no trailing newline prints nothing at all.
    stdout.flush();
    stderr.flush();
  }
}

export function createClangWorker(dialect: Dialect): void {
  self.onmessage = async (event: MessageEvent<InMessage>) => {
    const incoming = event.data;
    // input-answer is delivered for workers that cannot block their own thread;
    // this one reads the SharedArrayBuffer instead, so it is ignored.
    if (incoming.kind !== "run") return;
    const { runId, code, interactive, buffer } = incoming;
    currentRunId = runId;
    try {
      await compileAndRun(dialect, code, interactive ? buffer : undefined, runId);
      post({ kind: "done", runId });
    } catch (err) {
      const message = outOfMemory(err)
        ? "The compiler ran out of memory. Try a smaller program, fewer headers, or a simpler template."
        : err instanceof Error
          ? err.message
          : String(err);
      post({ kind: "error", runId, message });
    }
  };
}
