/* <gmp.h> for InBrowser's in-browser C/C++ runtime.
 *
 * Maps the GMP API onto the vendored mini-gmp (upstream GMP's own assembly-free
 * subset, LGPLv3+/GPLv2+ - see mini-gmp.h) and adds the handful of entry points
 * mini-gmp leaves out but that ordinary GMP code reaches for straight away:
 * the variadic init/clear helpers, next-prime search, and the random-state API.
 *
 * This is NOT full GMP. It is the mpz_* integer layer only: no mpq_*, no mpf_*,
 * no gmp_printf, and none of GMP's assembly fast paths, so it is correct but
 * considerably slower on large operands. Anything it does not declare will fail
 * to compile rather than silently misbehave.
 */
#ifndef FACHOY_GMP_H
#define FACHOY_GMP_H

#include "mini-gmp.h"   /* carries its own extern "C" guards */

#include <stdio.h>

#if defined(__cplusplus)
extern "C" {
#endif

/* --- variadic helpers (mini-gmp has only the single-operand forms) --- */
void mpz_inits(mpz_ptr, ...);
void mpz_clears(mpz_ptr, ...);

/* Smallest prime strictly greater than op. Built on mini-gmp's
   mpz_probab_prime_p, so it is probabilistic in exactly the same sense. */
void mpz_nextprime(mpz_ptr rop, mpz_srcptr op);

/* --- random state ---
 * GMP's generators are not reproduced; this is a seeded xoshiro256**. It is
 * deterministic for a given seed and perfectly adequate for exercises, but it
 * is NOT a cryptographic RNG - do not ship keys generated with it.
 */
typedef struct {
  unsigned long long s[4];
} __gmp_randstate_struct;
typedef __gmp_randstate_struct gmp_randstate_t[1];

void gmp_randinit_default(gmp_randstate_t);
void gmp_randinit_mt(gmp_randstate_t);
void gmp_randseed_ui(gmp_randstate_t, unsigned long);
void gmp_randclear(gmp_randstate_t);

void mpz_urandomb(mpz_ptr rop, gmp_randstate_t, mp_bitcnt_t bits);
void mpz_urandomm(mpz_ptr rop, gmp_randstate_t, mpz_srcptr n);

#if defined(__cplusplus)
}
#endif

#endif /* FACHOY_GMP_H */
