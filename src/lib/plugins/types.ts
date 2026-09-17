import type { CodeRunner } from "../codeRunners/types";

export interface InstallProgress {
  loaded: number;
  total: number;
  /** The asset being fetched right now, if the installer reports one. */
  file?: string;
  /** Human label for the current step; the store renders it in place of "n / m". */
  text?: string;
}

export interface Plugin {
  id: string;
  name: string;
  description: string;
  estimatedSizeMB: number;
  /** No download step at all — nothing to install/uninstall (e.g. JavaScript). */
  builtin?: boolean;
  /** Language ids (case-insensitive, aliases included) this plugin's runner handles. */
  languages: string[];
  /**
   * Overrides DEFAULT_RUN_TIMEOUT_MS for this runtime, for both the runner and
   * the run_code tool's own abort timer. Only set it where the default is
   * genuinely wrong - the C/C++ toolchain compiles and links inside the same
   * call it runs in, which does not fit in 20 seconds.
   */
  runTimeoutMs?: number;
  install(onProgress: (p: InstallProgress) => void, signal: AbortSignal): Promise<void>;
  uninstall(): Promise<void>;
  createRunner(): CodeRunner;
}
