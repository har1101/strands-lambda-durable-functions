# Contributing

Issues and pull requests are welcome. For anything larger than a bug fix, open an issue first so that we can agree on the approach.

## Development

```bash
npm ci
npm run typecheck
npm test        # LocalDurableTestRunner; no AWS access needed
npm run build
```

Tests run agents on the durable SDK's `LocalDurableTestRunner` with a scripted, provider-independent model (`test/helpers.ts`). A test that depends on the invocation ending (suspension and replay) must use real timers (`realTime: true`). The SDK ends an idle invocation after a 20 ms cooldown, and with skipped time a short wait can finish before that happens.

Guidelines:

- Keep changes focused. A behavior change needs a test that fails without it.
- Changes to the public API or to the checkpoint format need a CHANGELOG entry. Checkpoint records are versioned (`schemaVersion`); old versions must still be read.
- Use [Conventional Commits](https://www.conventionalcommits.org) for commit messages.

## Releasing

1. Update `version` in `package.json` and `CHANGELOG.md`.
2. Tag the commit `v<version>` and push the tag. The Release workflow attaches the packed tarball to a GitHub release and, when the `NPM_TOKEN` secret is set, publishes it to npm with provenance.
