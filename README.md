# seemp-contracts

Shared libraries of the **SEEMP platform v2** (AIS-ITS-CII-SEEMP), published to GitHub Packages
under the `@darmawanweb` scope. This repository is a pnpm workspace and is checked out as the
`packages/seemp-contracts` submodule of the central repository; the normative engineering
specification lives there in `docs/PLATFORM_SPEC.md`.

| Package                                              | Purpose                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@darmawanweb/seemp-contracts`](packages/contracts) | Isomorphic contracts (Node.js and browser): event envelope and payload schemas, NATS streams / consumers / subjects, roles and permissions, realtime protocol, RFC 9457 problem details and domain constants. |
| `@darmawanweb/seemp-platform` (`packages/platform`)  | NestJS 12 service platform (configuration, logging, auth guards, NATS, database, health, metrics); added next.                                                                                                |

## Architecture

```text
packages/
  contracts/            @darmawanweb/seemp-contracts — zod 4 + uuid only, no Node.js APIs
    src/events          envelope, event types, payloads, STREAMS, CONSUMERS, subjects
    src/auth            roles, permissions, API keys, token claims, tenancy
    src/domain          AIS, EWS, alerts, zones, CII, geodesy, units, ids
    src/realtime        socket.io events, schemas, rooms, tile math
    src/api             problem details, error codes, pagination, timestamps
    schemas/            generated JSON Schemas (committed)
    asyncapi.json       generated AsyncAPI 3.0 document (committed)
  platform/             @darmawanweb/seemp-platform — depends on contracts (workspace:^)
```

Every service and the web app import the contracts instead of re-declaring event shapes,
permissions or subjects, so a contract change is a reviewed, versioned change in one place.

## Requirements

- Node.js 24 (`.nvmrc`; `engines.node >= 22.12`)
- pnpm 10.28.0 (`corepack enable` picks it up from `packageManager`)

## Development

```bash
pnpm install
pnpm build          # every package (topological order)
pnpm test           # vitest in every package
pnpm lint           # ESLint (flat config, type-aware)
pnpm typecheck      # tsc --noEmit
pnpm format         # Prettier (format:check in CI)
pnpm schemas        # regenerate JSON Schemas, asyncapi.json and README catalogs
pnpm clean
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org) (commitlint in the
`commit-msg` hook); the `pre-commit` hook runs ESLint and Prettier on staged files (lint-staged).
Hooks are installed by `pnpm install` (`prepare: husky`); set `HUSKY=0` to skip them.

## Consuming the packages

Inside the central repository the packages resolve through the pnpm workspace. Elsewhere, map the
scope to GitHub Packages in `~/.npmrc` with a token that has `read:packages`:

```ini
@darmawanweb:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

The repository `.npmrc` intentionally holds pnpm settings only — never registry URLs or tokens.

## Releasing

1. Bump the version of every publishable package (they are released together) and move the
   `Unreleased` notes of [CHANGELOG.md](CHANGELOG.md) under the new version.
2. Regenerate the artifacts: `pnpm schemas` (the AsyncAPI document carries the version).
3. Commit, then tag `vX.Y.Z` and push the tag. The `release` workflow verifies that the tag matches
   the package versions, builds, tests and publishes every package to GitHub Packages.

Versioning is semantic; event types are versioned by their `.vN` suffix and never changed
incompatibly (see [packages/contracts/README.md](packages/contracts/README.md#versioning)).

## License

UNLICENSED — private, see [LICENSE](LICENSE). Use and modification are restricted to authorized
users only.
