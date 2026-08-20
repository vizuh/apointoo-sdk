import type { RefreshToken, Role, User, UserStatus } from './types.js'

export interface UsersStore {
  findByEmail(email: string): Promise<User | null>
  findById(id: string): Promise<User | null>
  /** Used by `AuthService.provisionFirstAdmin` to enforce the zero-platform-admin bootstrap guard. */
  firstByRole(role: Role): Promise<User | null>
  insert(user: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User>
  updatePassword(id: string, passwordHash: string): Promise<void>
  /**
   * Change account lifecycle status (kit #84). `suspendedAt` is set
   * automatically when transitioning to `'suspended'`, cleared on `'active'`.
   * No-op if `id` does not exist.
   */
  updateStatus(id: string, status: UserStatus): Promise<void>
}

export interface RefreshTokenStore {
  findByHash(tokenHash: string): Promise<RefreshToken | null>
  insert(token: Omit<RefreshToken, 'id'>): Promise<RefreshToken>
  /** Unconditional revoke. Used for theft-detection family revokes where idempotency is required. */
  revoke(id: string): Promise<void>
  /**
   * Atomic conditional revoke — succeeds only if the token is currently live.
   * Returns true if this caller won the rotation race, false if already revoked.
   * Underlies `AuthService.refresh` safety: two concurrent refreshes from the
   * same token will produce at most one successful rotation.
   */
  revokeIfActive(id: string): Promise<boolean>
  revokeFamily(family: string): Promise<void>
  /**
   * True if the family still contains at least one active (non-revoked,
   * non-expired) token. `AuthService.refresh` uses this to distinguish a
   * rotation-revocation (a live successor exists → benign concurrent race,
   * grace applies) from a family-revocation (logout / suspension / theft
   * response leave no live token → no grace, ever). See ADR-022.
   *
   * Compatibility: the call site FEATURE-DETECTS this method
   * (`typeof store.hasActiveInFamily === 'function'`) and falls back to the
   * strict pre-ADR-022 behavior (every reuse → `revokeFamily` +
   * `REUSED_REFRESH`) when a store implementation predates it. Downstream
   * stores (e.g. the dashboard's Mongo implementation) keep old semantics
   * until they implement this — never a crash.
   */
  hasActiveInFamily(family: string): Promise<boolean>
  touch(id: string): Promise<void>
}
