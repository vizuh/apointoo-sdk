import { randomBytes } from 'node:crypto'

import type { RefreshToken, User } from './types.js'
import type { RefreshTokenStore, UsersStore } from './stores.js'

export function memoryUsersStore(): UsersStore {
  const byId = new Map<string, User>()
  const byEmail = new Map<string, string>()

  return {
    async findByEmail(email) {
      const id = byEmail.get(email.toLowerCase())
      return id ? (byId.get(id) ?? null) : null
    },
    async findById(id) {
      return byId.get(id) ?? null
    },
    async firstByRole(role) {
      for (const u of byId.values()) {
        if (u.role === role) return u
      }
      return null
    },
    async insert(input) {
      const id = `usr_${randomBytes(8).toString('hex')}`
      const now = new Date()
      const user: User = { ...input, id, createdAt: now, updatedAt: now }
      byId.set(id, user)
      byEmail.set(user.email.toLowerCase(), id)
      return user
    },
    async updatePassword(id, passwordHash) {
      const u = byId.get(id)
      if (!u) return
      byId.set(id, { ...u, passwordHash, updatedAt: new Date() })
    },
    async updateStatus(id, status) {
      const u = byId.get(id)
      if (!u) return
      const now = new Date()
      const updated: User = { ...u, status, updatedAt: now }
      if (status === 'suspended') {
        updated.suspendedAt = now
      } else {
        delete updated.suspendedAt
      }
      byId.set(id, updated)
    },
  }
}

export function memoryRefreshTokenStore(): RefreshTokenStore {
  const byId = new Map<string, RefreshToken>()
  const byHash = new Map<string, string>()

  return {
    async findByHash(tokenHash) {
      const id = byHash.get(tokenHash)
      return id ? (byId.get(id) ?? null) : null
    },
    async insert(input) {
      const id = `rt_${randomBytes(8).toString('hex')}`
      const token: RefreshToken = { ...input, id }
      byId.set(id, token)
      byHash.set(token.tokenHash, id)
      return token
    },
    async revoke(id) {
      const t = byId.get(id)
      if (!t) return
      byId.set(id, { ...t, revokedAt: new Date() })
    },
    async revokeIfActive(id) {
      const t = byId.get(id)
      if (!t) return false
      if (t.revokedAt !== null) return false
      byId.set(id, { ...t, revokedAt: new Date() })
      return true
    },
    async revokeFamily(family) {
      const now = new Date()
      for (const [id, t] of byId) {
        if (t.family === family && !t.revokedAt) byId.set(id, { ...t, revokedAt: now })
      }
    },
    async hasActiveInFamily(family) {
      const now = Date.now()
      for (const t of byId.values()) {
        if (t.family === family && t.revokedAt === null && t.expiresAt.getTime() > now) {
          return true
        }
      }
      return false
    },
    async touch(id) {
      const t = byId.get(id)
      if (!t) return
      byId.set(id, { ...t, lastUsedAt: new Date() })
    },
  }
}
