import { createHash, randomBytes } from 'node:crypto'

import { ACCESS_TOKEN_TTL_SECONDS, issueAccessToken, verifyAccessToken } from './jwt.js'
import { hashPassword, verifyPassword } from './password.js'
import type { RefreshTokenStore, UsersStore } from './stores.js'
import {
  type AccessClaims,
  AuthError,
  type RefreshToken,
  type RequestContext,
  type Role,
  type TokenPair,
  type User,
} from './types.js'

const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * Grace window after a rotation-revocation during which reuse of the old
 * refresh token is treated as a benign concurrent race (e.g. a mobile browser
 * restoring a backgrounded tab fans out N parallel refreshes with the same
 * cookie) rather than theft. Only applies while the family still has a live
 * token — family revokes (logout, suspension, theft response) are never
 * resurrectable. See ADR-022.
 */
export const REFRESH_REUSE_GRACE_MS = 60_000

export interface AuthServiceConfig {
  jwtSecret: Uint8Array
  /**
   * Access-token lifetime. Defaults to ADR-015's 5 minutes; deployments
   * trade revocation latency for fewer refresh round trips by raising it.
   */
  accessTtlSeconds?: number
  refreshTtlSeconds?: number
  users: UsersStore
  refreshTokens: RefreshTokenStore
}

export class AuthService {
  private readonly jwtSecret: Uint8Array
  private readonly accessTtl: number
  private readonly refreshTtl: number
  private readonly users: UsersStore
  private readonly refreshTokens: RefreshTokenStore

  constructor(cfg: AuthServiceConfig) {
    if (cfg.jwtSecret.byteLength < 32) {
      throw new Error('jwtSecret must be at least 32 bytes')
    }
    this.jwtSecret = cfg.jwtSecret
    this.accessTtl = cfg.accessTtlSeconds ?? ACCESS_TOKEN_TTL_SECONDS
    this.refreshTtl = cfg.refreshTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS
    this.users = cfg.users
    this.refreshTokens = cfg.refreshTokens
  }

  /** Effective access-token TTL in seconds — align cookie maxAge with this. */
  get accessTtlSeconds(): number {
    return this.accessTtl
  }

  /**
   * Self-registration for tenant operators. Role is hardcoded to `'operator'`;
   * tenantId is required. The user's `authorizedTenants` is set to `[tenantId]`
   * — exactly one tenant in scope. Public signup routes must wire ONLY this
   * method. Privileged provisioning goes through `provisionUser`; the initial
   * admin uses `provisionFirstAdmin`.
   *
   * Fixes SECURITY-001 mass-assignment: callers can no longer set arbitrary
   * `role` / `permissions` / multi-tenant scope to escalate.
   *
   * ## Email enumeration warning (kit #82)
   *
   * This library is honest with its caller: a duplicate email throws
   * `AuthError('EMAIL_TAKEN', ...)`. Callers wiring this into a **public**
   * HTTP signup route MUST NOT forward that error code (or any timing
   * difference) to the client — doing so lets an attacker enumerate which
   * emails have an account.
   *
   * Recommended HTTP-route mitigation:
   *
   *   1. Catch `AuthError('EMAIL_TAKEN')` and return the **same** generic
   *      response shape as a successful signup ("if this email is new,
   *      we sent a verification link"), or a generic 400 ("could not
   *      complete signup; check your input").
   *   2. Log the actual `EMAIL_TAKEN` server-side (it's useful for ops +
   *      abuse detection) but never echo it in the response body or
   *      response time.
   *   3. Keep the work the route does on the dup-email path roughly the
   *      same shape as the happy path (run argon2 on a throwaway password
   *      or insert an artificial delay) to prevent timing-side-channel
   *      enumeration. Argon2 dominates the path's latency, so a real
   *      hash on the dup branch is the simplest mitigation.
   *
   * Admin-only `provisionUser` / `provisionFirstAdmin` callers are *not*
   * subject to this guidance — those routes already require authenticated
   * privileged callers, so `EMAIL_TAKEN` is operational feedback, not an
   * enumeration oracle.
   */
  async signup(input: {
    email: string
    password: string
    tenantId: string
  }): Promise<User> {
    const email = input.email.trim().toLowerCase()
    const existing = await this.users.findByEmail(email)
    // EMAIL_TAKEN is an honest library error; the public HTTP signup route
    // MUST collapse it to a generic response. See JSDoc above (kit #82).
    if (existing) throw new AuthError('EMAIL_TAKEN', 'email already in use')
    const passwordHash = await hashPassword(input.password)
    return this.users.insert({
      email,
      passwordHash,
      authorizedTenants: [input.tenantId],
      role: 'operator',
    })
  }

  /**
   * Privileged user provisioning. Only callable from a route handler that has
   * already verified the caller's access claims belong to a platform_admin.
   * Allows full `authorizedTenants` (including `['*']`) + role + permissions
   * assignment per ADR-018 §9.
   */
  async provisionUser(
    input: {
      email: string
      password: string
      authorizedTenants: string[]
      role: Role
      permissions?: string[]
    },
    callerClaims: AccessClaims,
  ): Promise<User> {
    if (callerClaims.role !== 'platform_admin') {
      throw new AuthError('FORBIDDEN', 'provisionUser requires platform_admin caller')
    }
    if (!Array.isArray(input.authorizedTenants) || input.authorizedTenants.length === 0) {
      throw new AuthError('FORBIDDEN', 'authorizedTenants must be a non-empty string[]')
    }
    const email = input.email.trim().toLowerCase()
    const existing = await this.users.findByEmail(email)
    if (existing) throw new AuthError('EMAIL_TAKEN', 'email already in use')
    const passwordHash = await hashPassword(input.password)
    return this.users.insert({
      email,
      passwordHash,
      authorizedTenants: input.authorizedTenants,
      role: input.role,
      ...(input.permissions !== undefined && { permissions: input.permissions }),
    })
  }

  /**
   * One-shot bootstrap for the initial platform admin. Only succeeds when no
   * platform_admin exists in the store — re-running throws `BOOTSTRAP_NOT_ALLOWED`.
   * Intended for seed scripts (e.g. `bin/seed-platform-admin.ts`) where there
   * is no logged-in caller yet. Issues `authorizedTenants: ['*']` (cross-tenant
   * platform-admin scope per ADR-018 §9).
   */
  async provisionFirstAdmin(input: {
    email: string
    password: string
  }): Promise<User> {
    const existing = await this.users.firstByRole('platform_admin')
    if (existing) {
      throw new AuthError(
        'BOOTSTRAP_NOT_ALLOWED',
        'a platform_admin already exists; use provisionUser with a platform_admin caller',
      )
    }
    const email = input.email.trim().toLowerCase()
    const duplicateEmail = await this.users.findByEmail(email)
    if (duplicateEmail) throw new AuthError('EMAIL_TAKEN', 'email already in use')
    const passwordHash = await hashPassword(input.password)
    return this.users.insert({
      email,
      passwordHash,
      authorizedTenants: ['*'],
      role: 'platform_admin',
    })
  }

  async login(email: string, password: string, ctx?: RequestContext): Promise<TokenPair> {
    const user = await this.users.findByEmail(email.trim().toLowerCase())
    if (!user) throw new AuthError('INVALID_CREDENTIALS', 'invalid email or password')
    const ok = await verifyPassword(password, user.passwordHash)
    if (!ok) throw new AuthError('INVALID_CREDENTIALS', 'invalid email or password')
    // Status check after credential verify — only reveal suspension to someone
    // who knows the correct password (avoids leaking user existence via error code).
    if (user.status === 'suspended') {
      throw new AuthError('ACCOUNT_SUSPENDED', 'account suspended; contact support')
    }
    const family = `fam_${randomBytes(16).toString('hex')}`
    return this.mintPair(user, family, ctx)
  }

  /**
   * External-identity login (e.g. "Sign in with Google") for an EXISTING user.
   *
   * ## Trust boundary — READ BEFORE WIRING (ADR-023)
   *
   * This method performs NO credential verification of any kind. The CALLER
   * MUST have already, in its own route layer:
   *
   *   1. AUTHENTICATED the user with the external identity provider — e.g.
   *      completed the Google OAuth authorization-code exchange and validated
   *      the `id_token` (signature, issuer, audience, expiry), and
   *   2. VERIFIED that the provider attests ownership of the email — e.g.
   *      Google `id_token` payload has `email_verified === true`.
   *
   * Calling this with an email that has not passed BOTH checks hands a
   * session for that account to whoever supplied the email. NEVER wire it to
   * unauthenticated or unverified input.
   *
   * Behavior mirrors `login()` exactly, minus the password check:
   * - email is normalized the same way (`trim().toLowerCase()`)
   * - unknown email → `INVALID_CREDENTIALS`. NO auto-signup — external
   *   identities only map onto already-provisioned users (ADR-023), and the
   *   error code matches a wrong password so a public route that forwards
   *   codes leaks no account-existence signal it wasn't already leaking
   * - suspended account → `ACCOUNT_SUSPENDED`, same as `login()`
   * - success mints a fresh pair with a NEW token family + sessionId via the
   *   same private mint path — rotation/revocation semantics are identical to
   *   a password login
   *
   * The stored password hash is never read — accounts with or without a
   * password (future passwordless provisioning) both work. Like `login()`,
   * this method emits no audit events itself; the consumer's route layer owns
   * audit logging and SHOULD record a distinguishable action (e.g.
   * `'login_external'` vs `'login'`).
   */
  async loginExternal(input: { email: string }, ctx?: RequestContext): Promise<TokenPair> {
    const user = await this.users.findByEmail(input.email.trim().toLowerCase())
    if (!user) throw new AuthError('INVALID_CREDENTIALS', 'invalid credentials')
    if (user.status === 'suspended') {
      throw new AuthError('ACCOUNT_SUSPENDED', 'account suspended; contact support')
    }
    const family = `fam_${randomBytes(16).toString('hex')}`
    return this.mintPair(user, family, ctx)
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    return verifyAccessToken(token, this.jwtSecret)
  }

  async refresh(rawRefreshToken: string, ctx?: RequestContext): Promise<TokenPair> {
    const tokenHash = sha256(rawRefreshToken)
    const stored = await this.refreshTokens.findByHash(tokenHash)
    if (!stored) throw new AuthError('INVALID_REFRESH', 'refresh token not recognized')
    if (stored.revokedAt) {
      // Token was already rotated (or its family revoked). A benign late race
      // — concurrent refreshes with the same cookie, the winner rotated first
      // — gets a sibling pair inside the grace window (ADR-022). Anything
      // else keeps the full theft response: revoke entire family.
      if (await this.isBenignLateRace(stored)) {
        const user = await this.requireActiveUser(stored)
        return this.mintPair(user, stored.family, ctx, stored.sessionId)
      }
      await this.refreshTokens.revokeFamily(stored.family)
      throw new AuthError('REUSED_REFRESH', 'refresh token reused; family revoked')
    }
    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new AuthError('EXPIRED_REFRESH', 'refresh token expired')
    }
    const user = await this.requireActiveUser(stored)

    // SECURITY-002: atomic claim — only one concurrent refresh wins the rotation.
    const claimed = await this.refreshTokens.revokeIfActive(stored.id)
    if (!claimed && !this.storeSupportsGrace()) {
      // Legacy stores (no hasActiveInFamily) keep the strict pre-ADR-022
      // semantics: a lost rotation race is treated as reuse.
      await this.refreshTokens.revokeFamily(stored.family)
      throw new AuthError('REUSED_REFRESH', 'concurrent refresh rotation detected; family revoked')
    }
    // If the claim was lost, another in-flight refresh holding the same token
    // won the rotation between our findByHash and the claim — by definition a
    // concurrent race, not a replay. The loser mints a sibling pair in the
    // same family instead of nuking the session (ADR-022); the family stays
    // intact either way, and a later family revoke still kills all siblings.
    return this.mintPair(user, stored.family, ctx, stored.sessionId)
  }

  /**
   * A revoked token qualifies for the ADR-022 grace mint only when ALL hold:
   * the store supports family liveness checks, the revocation is fresher than
   * `REFRESH_REUSE_GRACE_MS`, the token itself has not expired, and the
   * family still has an active token. The last condition is the load-bearing
   * one — rotation leaves a live successor; revokeFamily (logout, suspension,
   * theft response) leaves none, so those revocations are never resurrected.
   */
  private async isBenignLateRace(stored: RefreshToken): Promise<boolean> {
    if (!this.storeSupportsGrace()) return false
    if (!stored.revokedAt) return false
    if (Date.now() - stored.revokedAt.getTime() > REFRESH_REUSE_GRACE_MS) return false
    if (stored.expiresAt.getTime() <= Date.now()) return false
    return this.refreshTokens.hasActiveInFamily(stored.family)
  }

  /**
   * Runtime feature detection: `hasActiveInFamily` is required on the
   * `RefreshTokenStore` interface, but downstream implementations (e.g. the
   * dashboard's Mongo store) may predate it. Without it, refresh falls back
   * to the strict pre-ADR-022 behavior — old consumers keep old semantics.
   */
  private storeSupportsGrace(): boolean {
    return (
      typeof (this.refreshTokens as { hasActiveInFamily?: unknown }).hasActiveInFamily ===
      'function'
    )
  }

  private async requireActiveUser(stored: RefreshToken): Promise<User> {
    const user = await this.users.findById(stored.userId)
    if (!user) throw new AuthError('USER_GONE', 'user no longer exists')
    // Suspension must end an active session, not just block new logins. Without
    // this, suspending an already-logged-in user lets them keep rotating their
    // refresh token (and minting fresh 5-min access tokens) for the full 30-day
    // refresh window. Mirror login()'s check and revoke the whole family so the
    // suspended user is capped at one remaining access-token TTL. This runs
    // before EVERY mint path — including the ADR-022 grace mint.
    if (user.status === 'suspended') {
      await this.refreshTokens.revokeFamily(stored.family)
      throw new AuthError('ACCOUNT_SUSPENDED', 'account suspended; contact support')
    }
    return user
  }

  async revokeSession(rawRefreshToken: string): Promise<void> {
    const stored = await this.refreshTokens.findByHash(sha256(rawRefreshToken))
    if (!stored) return
    await this.refreshTokens.revokeFamily(stored.family)
  }

  private async mintPair(
    user: User,
    family: string,
    ctx: RequestContext | undefined,
    sessionId?: string,
  ): Promise<TokenPair> {
    const claims: AccessClaims = {
      sub: user.id,
      tids: user.authorizedTenants,
      role: user.role,
    }
    const accessToken = await issueAccessToken(claims, this.jwtSecret, this.accessTtl)
    const accessExpiresAt = new Date(Date.now() + this.accessTtl * 1000)
    const refreshExpiresAt = new Date(Date.now() + this.refreshTtl * 1000)
    const rawRefresh = randomBytes(32).toString('base64url')
    await this.refreshTokens.insert({
      sessionId: sessionId ?? `sess_${randomBytes(12).toString('hex')}`,
      userId: user.id,
      authorizedTenants: user.authorizedTenants,
      tokenHash: sha256(rawRefresh),
      family,
      revokedAt: null,
      lastUsedAt: new Date(),
      expiresAt: refreshExpiresAt,
      ...(ctx?.ip !== undefined && { ip: ctx.ip }),
      ...(ctx?.userAgent !== undefined && { userAgent: ctx.userAgent }),
    })
    return {
      accessToken,
      refreshToken: rawRefresh,
      accessExpiresAt,
      refreshExpiresAt,
    }
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}
