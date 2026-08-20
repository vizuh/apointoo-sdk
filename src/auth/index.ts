export { AuthService, type AuthServiceConfig, REFRESH_REUSE_GRACE_MS } from './service.js'
export { memoryRefreshTokenStore, memoryUsersStore } from './memory.js'
export {
  hashPassword,
  validatePassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from './password.js'
export { ACCESS_TOKEN_TTL_SECONDS, issueAccessToken, verifyAccessToken } from './jwt.js'
export type { RefreshTokenStore, UsersStore } from './stores.js'
export {
  type AccessClaims,
  AuthError,
  type AuthErrorCode,
  type RefreshToken,
  type RequestContext,
  type Role,
  type TokenPair,
  type User,
} from './types.js'
