# Vendored third-party sources

These are compiled **by the user's own browser**, by the in-browser Clang
toolchain, and linked into the program they run. They are not part of this app's
bundle logic - see `../gmpSources.ts` for how they are loaded and
`../clangToolchain.ts` for where they are compiled.

## mini-gmp (`mini-gmp.h`, `mini-gmp.c`)

- **Upstream:** the GNU Multiple Precision Arithmetic Library (GMP), `mini-gmp/`
  subdirectory. Vendored unmodified.
- **Copyright:** 2011-2015, 2017, 2019-2020 Free Software Foundation, Inc.
- **Licence:** dual, at your option - **LGPL v3 or later**, or **GPL v2 or
  later**. The full notice is at the top of each file and must stay there.
- **Why vendored:** the wasi sysroot ships no third-party libraries, and the one
  existing wasm build of GMP targets Emscripten, whose ABI `wasm-ld` cannot link
  into a WASI command. mini-gmp is upstream GMP's own assembly-free, dependency-
  free subset, written to be dropped into a project exactly like this.
- **Not** a full GMP: mpz_* integers only. No mpq_, no mpf_, no `gmp_printf`,
  and none of GMP's assembly fast paths.

To update, take the two files from a GMP release's `mini-gmp/` directory
verbatim. Do not edit them locally - anything this app needs to add belongs in
`gmp.h` / `gmp-shim.c` below, so the next update stays a straight copy.

## `gmp.h`, `gmp-shim.c`

Written for this project (and covered by this repository's own licence). They
map `#include <gmp.h>` onto mini-gmp and supply the entry points mini-gmp omits
but that ordinary GMP code uses immediately: `mpz_inits`/`mpz_clears`,
`mpz_nextprime`, and the `gmp_randstate_t` random API including `mpz_urandomb`.

The RNG is a seeded xoshiro256**, **not** a cryptographic generator. A key
generated with it is not safe to use; `GMP_NOTICE` in `../gmpSources.ts` says so
on every run that links this.
