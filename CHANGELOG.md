# Changelog

Notable public changes to `@vizuh/apointoo-sdk` are recorded here.

## [Unreleased]

## [0.12.2] - 2026-07-09

First public source release.

### Included

- Headless booking pipeline and adapter contracts
- BLVD, Recal, direct-confirm, memory, and OpenDental scaffold adapters
- Durable state, queue, outbox, audit, ledger, and idempotency surfaces
- JWT authentication with refresh-token rotation
- Attribution and conversion-reporting contracts
- Reserve with Google feed building and publishing

### Security

- Audit payloads use a strict allow-list before persistence
- Suspended users cannot rotate refresh-token families
- Conversion action names and payloads are validated at runtime

### Fixed

- Reserve with Google service descriptions avoid duplicate name values
- Conversion selection recognizes `gclid`, `gbraid`, and `wbraid`

Earlier private development history was intentionally excluded from the public
repository because it contained operational and tenant-specific planning.
