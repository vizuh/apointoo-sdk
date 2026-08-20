import { randomBytes } from 'node:crypto'
import { SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'

import {
  type AccessClaims,
  AuthError,
  AuthService,
  memoryRefreshTokenStore,
  memoryUsersStore,
  REFRESH_REUSE_GRACE_MS,
  type RefreshTokenStore,
  type TokenPair,
} from '../../src/auth/index.js'

function makeService() {
  const users = memoryUsersStore()
  const refreshTokens = memoryRefreshTokenStore()
  const svc = new AuthService({
    jwtSecret: randomBytes(32),
    users,
    refreshTokens,
  })
  return { svc, users, refreshTokens }
}

const PLATFORM_ADMIN_CLAIMS: AccessClaims = { sub: 'usr_admin', tids: ['*'], role: 'platform_admin' }
const OPERATOR_CLAIMS: AccessClaims = { sub: 'usr_op', tids: ['tenant-x'], role: 'operator' }

describe('AuthService', () => {
  it('provisionFirstAdmin → login → verify happy path', async () => {
    const { svc } = makeService()
    await svc.provisionFirstAdmin({ email: 'Admin@Example.com', password: 'pw_correct_horse_battery' })
    const pair = await svc.login('admin@example.com', 'pw_correct_horse_battery')
    expect(pair.accessToken).toMatch(/^eyJ/)
    expect(pair.refreshToken).toMatch(/^[A-Za-z0-9_-]+$/)
    const claims = await svc.verifyAccess(pair.accessToken)
    expect(claims.tids).toEqual(['*'])
    expect(claims.role).toBe('platform_admin')
  })

  it('rejects wrong password with INVALID_CREDENTIALS', async () => {
    const { svc } = makeService()
    await svc.provisionFirstAdmin({ email: 'a@b.c', password: 'good-password' })
    await expect(svc.login('a@b.c', 'wrong')).rejects.toMatchObject({
      name: 'AuthError',
      code: 'INVALID_CREDENTIALS',
    })
  })

  it('refresh rotates tokens; replay after the grace window revokes the family', async () => {
    const { svc } = makeService()
    await svc.provisionFirstAdmin({ email: 'a@b.c', password: 'good-password' })
    const first = await svc.login('a@b.c', 'good-password')
    const second = await svc.refresh(first.refreshToken)
    expect(second.refreshToken).not.toBe(first.refreshToken)

    // Past the ADR-022 grace window the reuse is treated as theft again.
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + REFRESH_REUSE_GRACE_MS + 1000)
      await expect(svc.refresh(first.refreshToken)).rejects.toMatchObject({
        code: 'REUSED_REFRESH',
      })
      // The theft response revoked the entire family — the rotated pair dies too,
      // and its own revocation is a family-revoke, so grace does not resurrect it.
      await expect(svc.refresh(second.refreshToken)).rejects.toMatchObject({
        code: 'REUSED_REFRESH',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('refresh of a suspended user is rejected and revokes the family', async () => {
    const { svc, users } = makeService()
    await svc.provisionFirstAdmin({ email: 'a@b.c', password: 'good-password' })
    const pair = await svc.login('a@b.c', 'good-password')
    const { sub } = await svc.verifyAccess(pair.accessToken)

    // Suspend the user who is already logged in.
    await users.updateStatus(sub, 'suspended')

    // The active session can no longer mint fresh access tokens...
    await expect(svc.refresh(pair.refreshToken)).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' })
    // ...and the whole refresh family is revoked, so a retry fails closed too.
    await expect(svc.refresh(pair.refreshToken)).rejects.toMatchObject({ code: 'REUSED_REFRESH' })
  })

  it('rejects expired refresh', async () => {
    const users = memoryUsersStore()
    const refreshTokens = memoryRefreshTokenStore()
    const svc = new AuthService({
      jwtSecret: randomBytes(32),
      refreshTtlSeconds: 1,
      users,
      refreshTokens,
    })
    await svc.provisionFirstAdmin({ email: 'a@b.c', password: 'good-password' })
    const pair = await svc.login('a@b.c', 'good-password')
    await new Promise((r) => setTimeout(r, 1100))
    await expect(svc.refresh(pair.refreshToken)).rejects.toMatchObject({ code: 'EXPIRED_REFRESH' })
  })

  it('accessTtlSeconds config stretches the access expiry and the issued JWT', async () => {
    const users = memoryUsersStore()
    const refreshTokens = memoryRefreshTokenStore()
    const svc = new AuthService({
      jwtSecret: randomBytes(32),
      accessTtlSeconds: 30 * 60,
      users,
      refreshTokens,
    })
    expect(svc.accessTtlSeconds).toBe(30 * 60)
    await svc.provisionFirstAdmin({ email: 'a@b.c', password: 'good-password' })
    const before = Date.now()
    const pair = await svc.login('a@b.c', 'good-password')
    const ttlMs = pair.accessExpiresAt.getTime() - before
    expect(ttlMs).toBeGreaterThan(29 * 60 * 1000)
    expect(ttlMs).toBeLessThanOrEqual(30 * 60 * 1000 + 5000)
    // The JWT itself carries the longer exp (not just the wrapper date).
    const payload = JSON.parse(Buffer.from(pair.accessToken.split('.')[1]!, 'base64url').toString())
    expect(payload.exp - payload.iat).toBe(30 * 60)
  })

  it('signup with duplicate email throws EMAIL_TAKEN', async () => {
    const { svc } = makeService()
    await svc.signup({ email: 'a@b.c', password: 'good-password', tenantId: 'tenant-x' })
    await expect(
      svc.signup({ email: 'A@B.C', password: 'other-password', tenantId: 'tenant-x' }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' })
  })

  it('verifyAccess rejects malformed token', async () => {
    const { svc } = makeService()
    await expect(svc.verifyAccess('not.a.jwt')).rejects.toBeInstanceOf(AuthError)
  })

  it('rejects insufficient jwtSecret', () => {
    expect(() => new AuthService({
      jwtSecret: new Uint8Array(16),
      users: memoryUsersStore(),
      refreshTokens: memoryRefreshTokenStore(),
    })).toThrow(/at least 32 bytes/)
  })

  it('verifyAccess rejects token with missing sub claim', async () => {
    const secret = randomBytes(32)
    const svc = new AuthService({ jwtSecret: secret, users: memoryUsersStore(), refreshTokens: memoryRefreshTokenStore() })
    const token = await new SignJWT({ tids: ['tenant-x'], role: 'operator' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('apointoo')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret)
    await expect(svc.verifyAccess(token)).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('verifyAccess rejects token with unsupported role', async () => {
    const secret = randomBytes(32)
    const svc = new AuthService({ jwtSecret: secret, users: memoryUsersStore(), refreshTokens: memoryRefreshTokenStore() })
    const token = await new SignJWT({ tids: ['tenant-x'], role: 'superuser' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('apointoo')
      .setSubject('usr_x')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret)
    await expect(svc.verifyAccess(token)).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('verifyAccess rejects token with non-array tids', async () => {
    const secret = randomBytes(32)
    const svc = new AuthService({ jwtSecret: secret, users: memoryUsersStore(), refreshTokens: memoryRefreshTokenStore() })
    const token = await new SignJWT({ tids: 'tenant-x', role: 'operator' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('apointoo')
      .setSubject('usr_x')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret)
    await expect(svc.verifyAccess(token)).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('verifyAccess rejects token with empty tids', async () => {
    const secret = randomBytes(32)
    const svc = new AuthService({ jwtSecret: secret, users: memoryUsersStore(), refreshTokens: memoryRefreshTokenStore() })
    const token = await new SignJWT({ tids: [], role: 'operator' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('apointoo')
      .setSubject('usr_x')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret)
    await expect(svc.verifyAccess(token)).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  // ── SECURITY-001: signup cannot escalate via caller-supplied scope ─────────

  it('signup hardcodes role to operator and authorizedTenants to [tenantId]', async () => {
    const { svc, users } = makeService()
    const user = await svc.signup({ email: 'op@example.com', password: 'pw_long_enough', tenantId: 'tenant-x' })
    expect(user.role).toBe('operator')
    expect(user.authorizedTenants).toEqual(['tenant-x'])
    const fetched = await users.findByEmail('op@example.com')
    expect(fetched?.role).toBe('operator')
    expect(fetched?.authorizedTenants).toEqual(['tenant-x'])
  })

  it('provisionUser rejects non-platform_admin caller with FORBIDDEN', async () => {
    const { svc } = makeService()
    await expect(
      svc.provisionUser(
        { email: 'evil@example.com', password: 'pw_long_enough', authorizedTenants: ['*'], role: 'platform_admin' },
        OPERATOR_CLAIMS,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('provisionUser allows platform_admin caller to create privileged users with multi-tenant scope', async () => {
    const { svc } = makeService()
    const created = await svc.provisionUser(
      {
        email: 'agency@example.com',
        password: 'pw_long_enough',
        authorizedTenants: ['acme-1', 'acme-2'],
        role: 'tenant_admin',
      },
      PLATFORM_ADMIN_CLAIMS,
    )
    expect(created.role).toBe('tenant_admin')
    expect(created.authorizedTenants).toEqual(['acme-1', 'acme-2'])
  })

  it('provisionUser rejects empty authorizedTenants', async () => {
    const { svc } = makeService()
    await expect(
      svc.provisionUser(
        { email: 'a@b.c', password: 'pw_long_enough', authorizedTenants: [], role: 'operator' },
        PLATFORM_ADMIN_CLAIMS,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('provisionFirstAdmin issues platform_admin with [*] scope', async () => {
    const { svc, users } = makeService()
    const user = await svc.provisionFirstAdmin({ email: 'admin@example.com', password: 'pw_long_enough' })
    expect(user.role).toBe('platform_admin')
    expect(user.authorizedTenants).toEqual(['*'])
    const fetched = await users.findByEmail('admin@example.com')
    expect(fetched?.authorizedTenants).toEqual(['*'])
  })

  it('provisionFirstAdmin fails after a platform_admin already exists', async () => {
    const { svc } = makeService()
    await svc.provisionFirstAdmin({ email: 'first@example.com', password: 'pw_long_enough' })
    await expect(
      svc.provisionFirstAdmin({ email: 'second@example.com', password: 'pw_long_enough' }),
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_NOT_ALLOWED' })
  })

  // ── #83 password length validation ────────────────────────────────────────

  it('signup rejects passwords shorter than 8 chars with INVALID_PASSWORD', async () => {
    const { svc } = makeService()
    await expect(
      svc.signup({ email: 'short@example.com', password: 'short7c', tenantId: 'tenant-x' }),
    ).rejects.toMatchObject({ code: 'INVALID_PASSWORD' })
  })

  it('signup rejects passwords longer than 1024 chars', async () => {
    const { svc } = makeService()
    const tooLong = 'a'.repeat(1025)
    await expect(
      svc.signup({ email: 'long@example.com', password: tooLong, tenantId: 'tenant-x' }),
    ).rejects.toMatchObject({ code: 'INVALID_PASSWORD' })
  })

  it('provisionFirstAdmin also enforces password length', async () => {
    const { svc } = makeService()
    await expect(
      svc.provisionFirstAdmin({ email: 'a@b.c', password: 'short7c' }),
    ).rejects.toMatchObject({ code: 'INVALID_PASSWORD' })
  })

  // ── SECURITY-002 + ADR-022: concurrent races survive; genuine replay still burns ──

  it('concurrent refreshes on the same token both get valid pairs; family is NOT revoked', async () => {
    const { svc } = makeService()
    await svc.provisionFirstAdmin({ email: 'a@b.c', password: 'good-password' })
    const pair = await svc.login('a@b.c', 'good-password')

    // Mobile tab restore: the dashboard middleware fans out parallel refreshes
    // with the same cookie. The loser of the rotation race must not kill the
    // winner's session (ADR-022).
    const results = await Promise.allSettled([
      svc.refresh(pair.refreshToken),
      svc.refresh(pair.refreshToken),
    ])
    const successes = results.filter(
      (r): r is PromiseFulfilledResult<TokenPair> => r.status === 'fulfilled',
    )
    expect(successes).toHaveLength(2)
    expect(successes[0]!.value.refreshToken).not.toBe(successes[1]!.value.refreshToken)

    // Both pairs are fully live: access tokens verify, refresh tokens rotate.
    for (const { value } of successes) {
      await expect(svc.verifyAccess(value.accessToken)).resolves.toMatchObject({
        role: 'platform_admin',
      })
      await expect(svc.refresh(value.refreshToken)).resolves.toBeDefined()
    }
  })

  it('grace replay shortly after a rotation mints a sibling pair in the same family', async () => {
    const { svc } = makeService()
    await svc.provisionFirstAdmin({ email: 'a@b.c', password: 'good-password' })
    const first = await svc.login('a@b.c', 'good-password')
    const winner = await svc.refresh(first.refreshToken)

    // Sequential late race: the rotation already completed, but the second
    // request carrying the old cookie lands within the grace window.
    const sibling = await svc.refresh(first.refreshToken)
    expect(sibling.refreshToken).not.toBe(winner.refreshToken)
    // Family intact — the winner's pair still works.
    await expect(svc.refresh(winner.refreshToken)).resolves.toBeDefined()
  })

  it('logout then immediate replay of the refresh token is NOT resurrected by grace', async () => {
    const { svc } = makeService()
    await svc.provisionFirstAdmin({ email: 'a@b.c', password: 'good-password' })
    const pair = await svc.login('a@b.c', 'good-password')

    await svc.revokeSession(pair.refreshToken)

    // revokeSession is a family-revoke: no live token remains in the family,
    // so the grace path must not apply even though revokedAt is seconds old.
    await expect(svc.refresh(pair.refreshToken)).rejects.toMatchObject({ code: 'REUSED_REFRESH' })
    await expect(svc.refresh(pair.refreshToken)).rejects.toMatchObject({ code: 'REUSED_REFRESH' })
  })

  it('suspended user gets no grace mint on a late race', async () => {
    const { svc, users } = makeService()
    await svc.provisionFirstAdmin({ email: 'a@b.c', password: 'good-password' })
    const first = await svc.login('a@b.c', 'good-password')
    const winner = await svc.refresh(first.refreshToken)
    const { sub } = await svc.verifyAccess(winner.accessToken)

    await users.updateStatus(sub, 'suspended')

    // The family still has a live token (grace-eligible shape), but the
    // suspension check runs before any mint — including the grace mint.
    await expect(svc.refresh(first.refreshToken)).rejects.toMatchObject({
      code: 'ACCOUNT_SUSPENDED',
    })
    // And the whole family is revoked, so the live sibling dies too.
    await expect(svc.refresh(winner.refreshToken)).rejects.toMatchObject({
      code: 'REUSED_REFRESH',
    })
  })

  // ── ADR-023: external-identity login (verified-email → session, no auto-signup) ──

  it('loginExternal mints a working pair for an existing user, normalizing email like login()', async () => {
    const { svc } = makeService()
    await svc.provisionFirstAdmin({ email: 'admin@example.com', password: 'pw_long_enough' })
    // The consumer has already verified the Google identity + email_verified;
    // mixed case and padding must resolve to the same user login() would hit.
    const pair = await svc.loginExternal({ email: '  Admin@Example.com ' })
    expect(pair.accessToken).toMatch(/^eyJ/)
    expect(pair.refreshToken).toMatch(/^[A-Za-z0-9_-]+$/)
    const claims = await svc.verifyAccess(pair.accessToken)
    expect(claims.role).toBe('platform_admin')
    expect(claims.tids).toEqual(['*'])
  })

  it('loginExternal with an unknown email throws INVALID_CREDENTIALS and does NOT auto-signup', async () => {
    const { svc, users } = makeService()
    await expect(svc.loginExternal({ email: 'ghost@example.com' })).rejects.toMatchObject({
      name: 'AuthError',
      code: 'INVALID_CREDENTIALS',
    })
    // No user row was created as a side effect.
    await expect(users.findByEmail('ghost@example.com')).resolves.toBeNull()
  })

  it('loginExternal on a suspended account throws ACCOUNT_SUSPENDED like login()', async () => {
    const { svc, users } = makeService()
    const user = await svc.provisionFirstAdmin({ email: 'a@b.c', password: 'good-password' })
    await users.updateStatus(user.id, 'suspended')
    await expect(svc.loginExternal({ email: 'a@b.c' })).rejects.toMatchObject({
      code: 'ACCOUNT_SUSPENDED',
    })
    // Parity check: the password path responds identically.
    await expect(svc.login('a@b.c', 'good-password')).rejects.toMatchObject({
      code: 'ACCOUNT_SUSPENDED',
    })
  })

  it('refresh token minted by loginExternal rotates with normal family semantics', async () => {
    const { svc } = makeService()
    await svc.provisionFirstAdmin({ email: 'a@b.c', password: 'good-password' })
    const first = await svc.loginExternal({ email: 'a@b.c' })
    const second = await svc.refresh(first.refreshToken)
    expect(second.refreshToken).not.toBe(first.refreshToken)
    await expect(svc.verifyAccess(second.accessToken)).resolves.toMatchObject({
      role: 'platform_admin',
    })
    // The rotated pair keeps rotating — same family lifecycle as a password login.
    await expect(svc.refresh(second.refreshToken)).resolves.toBeDefined()
  })

  // ── ADR-022 fallback: stores without hasActiveInFamily keep strict semantics ──

  function legacyRefreshTokenStore(): RefreshTokenStore {
    // Simulates a downstream store implementation (e.g. the dashboard's Mongo
    // store) compiled before hasActiveInFamily was added to the interface.
    const store = memoryRefreshTokenStore()
    delete (store as { hasActiveInFamily?: unknown }).hasActiveInFamily
    return store
  }

  it('store without hasActiveInFamily: replay after rotation is strict REUSED_REFRESH', async () => {
    const svc = new AuthService({
      jwtSecret: randomBytes(32),
      users: memoryUsersStore(),
      refreshTokens: legacyRefreshTokenStore(),
    })
    await svc.provisionFirstAdmin({ email: 'a@b.c', password: 'good-password' })
    const first = await svc.login('a@b.c', 'good-password')
    const second = await svc.refresh(first.refreshToken)

    // Immediate replay would be grace-eligible on a capable store; the legacy
    // store falls back to the pre-ADR-022 theft response.
    await expect(svc.refresh(first.refreshToken)).rejects.toMatchObject({ code: 'REUSED_REFRESH' })
    await expect(svc.refresh(second.refreshToken)).rejects.toMatchObject({ code: 'REUSED_REFRESH' })
  })

  it('store without hasActiveInFamily: concurrent refresh yields exactly one rotation', async () => {
    const svc = new AuthService({
      jwtSecret: randomBytes(32),
      users: memoryUsersStore(),
      refreshTokens: legacyRefreshTokenStore(),
    })
    await svc.provisionFirstAdmin({ email: 'a@b.c', password: 'good-password' })
    const pair = await svc.login('a@b.c', 'good-password')

    const [a, b] = await Promise.allSettled([
      svc.refresh(pair.refreshToken),
      svc.refresh(pair.refreshToken),
    ])

    const successes = [a, b].filter(
      (r): r is PromiseFulfilledResult<TokenPair> => r.status === 'fulfilled',
    )
    const failures = [a, b].filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect((failures[0]!.reason as AuthError).code).toBe('REUSED_REFRESH')
    await expect(svc.refresh(pair.refreshToken)).rejects.toMatchObject({ code: 'REUSED_REFRESH' })
  })
})
