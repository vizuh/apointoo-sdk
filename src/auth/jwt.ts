import { jwtVerify, SignJWT } from 'jose'

import { type AccessClaims, AuthError, type Role } from './types.js'

const ISSUER = 'apointoo'
const ACCESS_TTL_SECONDS = 5 * 60 // ADR-015: 5-minute access TTL
const ROLES: readonly Role[] = ['platform_admin', 'tenant_admin', 'operator']

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

export async function issueAccessToken(
  claims: AccessClaims,
  secret: Uint8Array,
  ttlSeconds: number = ACCESS_TTL_SECONDS,
): Promise<string> {
  return new SignJWT({ tids: claims.tids, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret)
}

export async function verifyAccessToken(token: string, secret: Uint8Array): Promise<AccessClaims> {
  let payload: Record<string, unknown>
  try {
    const result = await jwtVerify(token, secret, { issuer: ISSUER, algorithms: ['HS256'] })
    payload = result.payload as Record<string, unknown>
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name
    if (name === 'JWTExpired') throw new AuthError('EXPIRED_TOKEN', 'access token expired')
    throw new AuthError('INVALID_TOKEN', 'access token invalid')
  }
  const sub = payload.sub
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new AuthError('INVALID_TOKEN', 'access token invalid')
  }
  const tids = payload.tids
  if (!isStringArray(tids) || tids.length === 0) {
    throw new AuthError('INVALID_TOKEN', 'access token invalid')
  }
  const role = payload.role
  if (typeof role !== 'string' || !ROLES.includes(role as Role)) {
    throw new AuthError('INVALID_TOKEN', 'access token invalid')
  }
  return {
    sub,
    tids,
    role: role as Role,
  }
}

export const ACCESS_TOKEN_TTL_SECONDS = ACCESS_TTL_SECONDS
