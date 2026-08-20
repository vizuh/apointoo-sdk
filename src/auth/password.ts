import { hash, verify, type Algorithm } from '@node-rs/argon2'

import { AuthError } from './types.js'

// OWASP 2023 argon2id recommendation: m=19456 (19 MiB), t=2, p=1.
// algorithm 2 = Argon2id (Algorithm enum is const so we can't reference members at runtime).
const PARAMS = {
  algorithm: 2 as Algorithm,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
}

/**
 * Password policy enforced at all hash entry points (signup, provisionUser,
 * provisionFirstAdmin, future password-reset). Closes #83 (`APOINTOO-AUTH-SEC-003`):
 *
 * - Min 8 chars — basic floor; OWASP recommends ≥8 for memorable passwords.
 * - Max 1024 chars — argon2id cost is independent of plaintext length once
 *   BLAKE2b digests it, but the bound caps CPU+memory the body parser will
 *   accept before hashing, blunts the DoS-via-huge-password vector, and
 *   matches what most password managers comfortably produce.
 *
 * Throws `AuthError('INVALID_PASSWORD', ...)` synchronously before any hash work.
 */
export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 1024

export function validatePassword(plain: unknown): void {
  if (typeof plain !== 'string') {
    throw new AuthError('INVALID_PASSWORD', 'password must be a string')
  }
  if (plain.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(
      'INVALID_PASSWORD',
      `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    )
  }
  if (plain.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError(
      'INVALID_PASSWORD',
      `password must be at most ${MAX_PASSWORD_LENGTH} characters`,
    )
  }
}

export async function hashPassword(plain: string): Promise<string> {
  validatePassword(plain)
  return hash(plain, PARAMS)
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  // Don't validate length on verify — the stored hash is what authenticates.
  // Validation runs at hash time (signup/provision) so users can't shorten
  // mid-flight. A wrong-length input here just fails the match silently.
  try {
    return await verify(stored, plain, PARAMS)
  } catch {
    return false
  }
}
