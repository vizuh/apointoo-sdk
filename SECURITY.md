# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's **Security → Report a vulnerability** form. If private
vulnerability reporting is unavailable, email `hugo@vizuh.com` with subject
`[apointoo-sdk] Security: <short description>`.

Include affected versions, impact, reproduction steps, and a minimal
proof-of-concept when practical. We aim to acknowledge reports within 48 hours.

## Supported versions

Only the latest minor release receives security fixes.

| Version | Status |
|---|---|
| `0.12.x` | Supported |
| `< 0.12.0` | Unsupported |

## Scope

In scope:

- SDK source and first-party adapters
- Hono server pipeline, auth, idempotency, queue, state, audit, and webhooks
- Build and GitHub Actions workflows

Out of scope:

- Vendor APIs and third-party dependencies
- Consumer code and deployment configuration
- Social engineering or attacks requiring physical access

## Deployment responsibility

This package includes server-side building blocks, not a managed security
boundary. Consumers must provide TLS, secret management, trusted tenant
resolution, CORS policy, rate limits, durable stores, vendor credential
rotation, and access control appropriate to their deployment.

Never expose service-role credentials or vendor secrets to browser code.
Multi-tenant consumers must scope every durable store and admin route by the
authenticated tenant.
