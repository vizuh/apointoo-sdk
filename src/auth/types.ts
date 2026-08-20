export type Role = 'platform_admin' | 'tenant_admin' | 'operator'

export type UserStatus = 'active' | 'suspended'

export interface User {
  id: string
  email: string
  passwordHash: string
  /**
   * Tenant access scope per ADR-018 §9.
   * - `['*']` = platform admin (cross-tenant access)
   * - `['acme-1', 'acme-2']` = agency / multi-tenant operator
   * - `['example-tenant']` = single-tenant operator
   * Replaces the prior scalar `tenantId: string | null` model.
   */
  authorizedTenants: string[]
  role: Role
  /**
   * Account lifecycle status (kit #84). Absent = `'active'` on rows created
   * before this field was introduced — backwards compatible.
   * Suspended users cannot log in or refresh tokens.
   */
  status?: UserStatus
  /** Populated when `status` transitions to `'suspended'`. */
  suspendedAt?: Date
  permissions?: string[]
  createdAt: Date
  updatedAt: Date
}

export interface RefreshToken {
  id: string
  sessionId: string
  userId: string
  /**
   * Snapshot of the user's `authorizedTenants` at token mint time. Stored on
   * the refresh row so future access-token issues reuse the original scope —
   * if the user's tenant access is later revoked, those changes only take
   * effect at next login (when a fresh refresh-token family is established).
   */
  authorizedTenants: string[]
  tokenHash: string
  family: string
  revokedAt: Date | null
  lastUsedAt: Date
  expiresAt: Date
  ip?: string
  userAgent?: string
}

export interface AccessClaims {
  sub: string
  /** Tenant access scope, mirrors `User.authorizedTenants`. `['*']` = cross-tenant. */
  tids: string[]
  role: Role
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  accessExpiresAt: Date
  refreshExpiresAt: Date
}

export interface RequestContext {
  ip?: string
  userAgent?: string
}

export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'INVALID_TOKEN'
  | 'EXPIRED_TOKEN'
  | 'INVALID_REFRESH'
  | 'EXPIRED_REFRESH'
  | 'REUSED_REFRESH'
  | 'USER_GONE'
  | 'EMAIL_TAKEN'
  | 'FORBIDDEN'
  | 'ACCOUNT_SUSPENDED'
  | 'BOOTSTRAP_NOT_ALLOWED'
  | 'INVALID_PASSWORD'

export class AuthError extends Error {
  readonly code: AuthErrorCode

  constructor(code: AuthErrorCode, message: string) {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}
