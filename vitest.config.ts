// vitest.config.ts — see docs/testing-plan.md §1 for rationale.
import { defineConfig } from 'vitest/config'

const isLive = process.env.LIVE === '1'

export default defineConfig({
  resolve: {
    conditions: ['node'],
  },
  test: {
    environment: 'node',
    pool: 'forks', // NodeNext + node:crypto require fork pool, not vm
    include: ['tests/**/*.test.ts'],
    exclude: isLive ? [] : ['tests/live/**/*.test.ts'],
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        // Barrel / version / re-exports
        'src/index.ts',
        'src/core/index.ts',
        'src/core/version.ts',
        // Live adapters — excluded from gate; tested in live tier only
        'src/adapters/booking/blvd/**',
        'src/adapters/booking/opendental/**',
        'src/adapters/notification/brevo-rest/**',
        'src/adapters/notification/twilio-whatsapp/**',
        'src/adapters/persistence/sheets/**',
        'src/adapters/dedup/upstash.ts',
        'src/adapters/ratelimit/upstash.ts',
        'src/adapters/state/supabase.ts',
        'src/queue/supabase.ts',
        'src/queue/outbox.ts',
        'src/integration/rwg/publisher.ts',
        // Server entrypoints that require wired Hono + env
        'src/server/handler.ts',
        'src/server/admin/**',
        'src/server/health.ts',
        'src/server/tenant.ts',
        'src/server/logger.ts',
      ],
      thresholds: {
        lines: 50,
        branches: 45,
        functions: 45,
        statements: 50,
      },
    },
  },
})
