/**
 * GMP support for the in-browser C/C++ runtime.
 *
 * `#include <gmp.h>` is the first thing a lot of real C reaches for, and the
 * wasi sysroot ships no third-party libraries at all - only libc and libc++. A
 * full GMP would mean a wasi-sdk build outside this repo's npm-only pipeline
 * (and the one wasm GMP fork that exists is an Emscripten build, so wasm-ld
 * cannot link it into a WASI command).
 *
 * Upstream GMP solves this for us: it ships `mini-gmp`, its own assembly-free,
 * two-file implementation of the mpz_* subset, written to be dropped straight
 * into a project. It compiles with the very clang already running here, so GMP
 * support costs one extra compile rather than a new toolchain.
 *
 * The four files are vendored under ./vendor and loaded with `?raw` through a
 * dynamic import, so they become their own lazy chunk: a program that never
 * mentions GMP pays nothing for this.
 *
 * Licensing: mini-gmp is part of GNU MP, LGPLv3+ / GPLv2+ (see the headers in
 * vendor/mini-gmp.h). It is redistributed here as unmodified source that the
 * user's own browser compiles - the same annotation discipline as the busybox
 * note on the Shell runtime.
 */

/** Matches an include of gmp.h or mini-gmp.h, in either bracket form. */
const GMP_INCLUDE = /^[ \t]*#[ \t]*include[ \t]*[<"](?:mini-)?gmp\.h[>"]/m;

export function usesGmp(code: string): boolean {
  return GMP_INCLUDE.test(code);
}

export interface GmpSources {
  miniHeader: string;
  miniImpl: string;
  gmpHeader: string;
  shimImpl: string;
}

let sourcesPromise: Promise<GmpSources> | null = null;

export function loadGmpSources(): Promise<GmpSources> {
  if (!sourcesPromise) {
    sourcesPromise = (async () => {
      const [miniHeader, miniImpl, gmpHeader, shimImpl] = await Promise.all([
        import("./vendor/mini-gmp.h?raw"),
        import("./vendor/mini-gmp.c?raw"),
        import("./vendor/gmp.h?raw"),
        import("./vendor/gmp-shim.c?raw"),
      ]);
      return {
        miniHeader: miniHeader.default,
        miniImpl: miniImpl.default,
        gmpHeader: gmpHeader.default,
        shimImpl: shimImpl.default,
      };
    })();
  }
  return sourcesPromise;
}

/**
 * Shown once per run that links GMP. The RNG point is not pedantry: the
 * canonical thing people write against GMP is a key generator, and mini-gmp has
 * no random API at all - ours is a seeded PRNG, so a user could otherwise
 * believe they had produced usable keys.
 */
export const GMP_NOTICE =
  "(gmp.h here is mini-gmp, GMP's own mpz_* subset - no mpq_/mpf_/gmp_printf, " +
  "and gmp_rand* is a seeded PRNG, not a cryptographic RNG)";
