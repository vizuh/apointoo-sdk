# @vizuh/apointoo-sdk

[![CI](https://github.com/vizuh/apointoo-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/vizuh/apointoo-sdk/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.12.2-blue)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

Headless TypeScript SDK for booking, intake, attribution, auth, queues,
notifications, and conversion workflows. Consumers own the UI and select the
adapters required by their deployment.

## Status

The SDK is pre-1.0. APIs may change between minor releases. The package is not
yet published to npm; install the tagged GitHub release:

```bash
npm install git+https://github.com/vizuh/apointoo-sdk.git#v0.12.2 hono zod
```

Node.js 18.17 or newer is required.

## Quick start

```ts
import { memoryStateStore } from '@vizuh/apointoo-sdk'
import { directConfirmAdapter } from '@vizuh/apointoo-sdk/adapters/booking/direct-confirm'
import { brevoRestAdapter } from '@vizuh/apointoo-sdk/adapters/notification/brevo-rest'
import { createBookingHandler } from '@vizuh/apointoo-sdk/server'

export const app = createBookingHandler({
  config: {
    projectKey: 'example-studio',
    businessName: 'Example Studio',
    locale: 'en',
    timezone: 'Europe/Lisbon',
    services: [{ id: 'consultation', name: 'Consultation', isActive: true }],
    scheduling: {
      availableDays: [1, 2, 3, 4, 5],
      timeSlots: [{ label: '10:00', value: '10:00' }],
      minAdvanceDays: 1,
      maxAdvanceDays: 30,
    },
  },
  booking: directConfirmAdapter(),
  state: memoryStateStore(),
  notification: brevoRestAdapter({
    apiKey: process.env.BREVO_API_KEY!,
    from: process.env.LEAD_FROM_EMAIL!,
    defaultTo: process.env.LEAD_NOTIFICATION_TO!.split(','),
  }),
})
```

`createBookingHandler` returns a Hono app. Mount it under a server route in
Next.js, Cloudflare Workers, Node.js, or another Hono-compatible runtime.

## Included surfaces

- Core booking types, validation schemas, scheduling, events, and idempotency
- Booking adapters for BLVD, Recal, direct-confirm, memory, and an OpenDental scaffold
- State, persistence, deduplication, rate-limit, audit, and ledger adapters
- Brevo and Twilio notification adapters
- JWT authentication and refresh-token rotation
- Queue, outbox, retry worker, webhooks, health checks, and tenant resolution
- Attribution classification and conversion reporting contracts
- Reserve with Google feed building and publishing

Memory adapters are intended for tests and local development. Production
deployments should use durable state, queue, deduplication, and idempotency
implementations.

## Documentation

- [Getting started](./docs/getting-started.md)
- [Architecture](./docs/architecture.md)
- [Pipeline](./docs/pipeline.md)
- [Adapters](./docs/adapters.md)
- [Attribution](./docs/attribution.md)
- [Glossary](./docs/glossary.md)

## Security

Do not commit credentials or log booking PII. Read [SECURITY.md](./SECURITY.md)
before deploying a public or multi-tenant endpoint.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

Apache License 2.0. See [LICENSE](./LICENSE).
