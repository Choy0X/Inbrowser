/* Implementations of the GMP entry points mini-gmp omits. See gmp.h. */
#include "gmp.h"

#include <stdarg.h>
#include <stdlib.h>

void mpz_inits(mpz_ptr x, ...) {
  va_list ap;
  va_start(ap, x);
  while (x != NULL) {
    mpz_init(x);
    x = va_arg(ap, mpz_ptr);
  }
  va_end(ap);
}

void mpz_clears(mpz_ptr x, ...) {
  va_list ap;
  va_start(ap, x);
  while (x != NULL) {
    mpz_clear(x);
    x = va_arg(ap, mpz_ptr);
  }
  va_end(ap);
}

void mpz_nextprime(mpz_ptr rop, mpz_srcptr op) {
  mpz_t n;
  /* Through a temporary, so rop and op may alias - mpz_nextprime(p, p) is the
     usual way this gets called. */
  mpz_init_set(n, op);
  if (mpz_cmp_ui(n, 2) < 0) {
    mpz_set_ui(rop, 2);
    mpz_clear(n);
    return;
  }
  /* Step to the next odd number, then walk odds only. */
  if (mpz_even_p(n)) {
    mpz_add_ui(n, n, 1);
  } else {
    mpz_add_ui(n, n, 2);
  }
  while (mpz_probab_prime_p(n, 25) == 0) {
    mpz_add_ui(n, n, 2);
  }
  mpz_set(rop, n);
  mpz_clear(n);
}

/* --- xoshiro256**, seeded through splitmix64 --- */

static unsigned long long rotl64(unsigned long long x, int k) {
  return (x << k) | (x >> (64 - k));
}

static unsigned long long next_u64(gmp_randstate_t state) {
  unsigned long long *s = state->s;
  const unsigned long long result = rotl64(s[1] * 5ULL, 7) * 9ULL;
  const unsigned long long t = s[1] << 17;
  s[2] ^= s[0];
  s[3] ^= s[1];
  s[1] ^= s[2];
  s[0] ^= s[3];
  s[2] ^= t;
  s[3] = rotl64(s[3], 45);
  return result;
}

void gmp_randseed_ui(gmp_randstate_t state, unsigned long seed) {
  unsigned long long z = (unsigned long long)seed + 0x9E3779B97F4A7C15ULL;
  for (int i = 0; i < 4; i++) {
    z += 0x9E3779B97F4A7C15ULL;
    unsigned long long x = z;
    x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ULL;
    x = (x ^ (x >> 27)) * 0x94D049BB133111EBULL;
    state->s[i] = x ^ (x >> 31);
  }
  /* An all-zero state is a fixed point of xoshiro; seed 0 must not break it. */
  if ((state->s[0] | state->s[1] | state->s[2] | state->s[3]) == 0ULL) {
    state->s[0] = 0x853C49E6748FEA9BULL;
  }
}

void gmp_randinit_default(gmp_randstate_t state) { gmp_randseed_ui(state, 0); }

void gmp_randinit_mt(gmp_randstate_t state) { gmp_randseed_ui(state, 0); }

void gmp_randclear(gmp_randstate_t state) { (void)state; }

void mpz_urandomb(mpz_ptr rop, gmp_randstate_t state, mp_bitcnt_t bits) {
  if (bits == 0) {
    mpz_set_ui(rop, 0);
    return;
  }
  size_t nbytes = (size_t)((bits + 7) / 8);
  unsigned char *buf = (unsigned char *)malloc(nbytes);
  if (buf == NULL) {
    mpz_set_ui(rop, 0);
    return;
  }
  size_t i = 0;
  while (i < nbytes) {
    unsigned long long r = next_u64(state);
    for (int b = 0; b < 8 && i < nbytes; b++, i++) {
      buf[i] = (unsigned char)(r & 0xFFU);
      r >>= 8;
    }
  }
  mpz_import(rop, nbytes, 1, 1, 0, 0, buf);
  free(buf);
  /* import rounds up to whole bytes; clear anything above the requested width. */
  for (mp_bitcnt_t bit = bits; bit < (mp_bitcnt_t)nbytes * 8; bit++) {
    mpz_clrbit(rop, bit);
  }
}

void mpz_urandomm(mpz_ptr rop, gmp_randstate_t state, mpz_srcptr n) {
  if (mpz_sgn(n) <= 0) {
    mpz_set_ui(rop, 0);
    return;
  }
  /* Rejection-free enough for general use: draw a comfortably wider value and
     reduce. The bias is below 2^-64 of the modulus. */
  mp_bitcnt_t bits = (mp_bitcnt_t)mpz_sizeinbase(n, 2) + 64;
  mpz_t r;
  mpz_init(r);
  mpz_urandomb(r, state, bits);
  mpz_mod(rop, r, n);
  mpz_clear(r);
}
