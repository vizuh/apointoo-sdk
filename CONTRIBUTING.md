# Contributing

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
```

Use a focused branch and include a regression test for non-trivial behavior.
Keep adapters free of hard-coded tenant data and credentials.

Before opening a pull request:

```bash
npm run build
npm run test:coverage
npm pack --dry-run
```

Report security issues through the private process in [SECURITY.md](./SECURITY.md),
not through public issues.
