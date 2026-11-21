# ais-its-contracts

Shared libraries of **AIS Maritime Intelligence** v2, published to GitHub Packages under the
`@darmawanweb` scope. This repository is a pnpm workspace and is checked out as the
`packages/ais-its-contracts` submodule of the central repository
[`ais-its-platform`](https://github.com/DarmawanWeb/ais-its-platform); the normative engineering
specification lives there in `docs/PLATFORM_SPEC.md`.

| Package                                                | Purpose                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@darmawanweb/ais-its-contracts`](packages/contracts) | Isomorphic contracts (Node.js and browser): event envelope and payload schemas, NATS streams / consumers / subjects, roles and permissions, realtime protocol, RFC 9457 problem details, domain vocabulary (alert type registry, zones) and the methodology catalog.                                                                    |
| [`@darmawanweb/ais-its-nest`](packages/nest)           | NestJS 12 service kit (ESM): configuration, logging, HTTP bootstrap + RFC 9457 problem details, PostgreSQL + SQL migrator + PostGIS helpers, NATS JetStream publisher and consumer framework, Valkey + rate limiters, auth guards, audit, health, metrics, tracing, internal HTTP client, the Detector SDK (spec §18) and test helpers. |

## Architecture

```text
packages/
  contracts/            @darmawanweb/ais-its-contracts — zod 4 + uuid only, no Node.js APIs
    src/events          envelope, event types, payloads, STREAMS, CONSUMERS, subjects
    src/auth            roles, permissions, API keys, token claims, tenancy
    src/domain          AIS, EWS, collision risk, ALERT_TYPES, zones, GeoJSON, CII, geodesy, units, ids
    src/realtime        socket.io events, schemas, rooms, tile math
    src/api             problem details, error codes, pagination, timestamps
    src/references      methodology catalog model, REFERENCES / METHODS (synced), lookups
    schemas/            generated JSON Schemas (committed)
    asyncapi.json       generated AsyncAPI 3.0 document (committed)
  nest/                 @darmawanweb/ais-its-nest — NestJS kit + Detector SDK, depends on contracts (workspace:^)
    src/<module>        one subpath export per module (http, db, nats, redis, auth, audit, health,
                        metrics, telemetry, internal-http, analytics, testing)
    test/               integration tests against TimescaleDB/PostGIS, NATS, Valkey, RustFS, Mailpit
```

Every service and the web app import the contracts instead of re-declaring event shapes,
permissions or subjects, so a contract change is a reviewed, versioned change in one place.

## Requirements

- Node.js 24 (`.nvmrc`; `engines.node >= 22.12`)
- pnpm 10.28.0 (`corepack enable` picks it up from `packageManager`)

## Development

```bash
pnpm install
pnpm build            # every package (topological order)
pnpm test             # vitest in every package
pnpm lint             # ESLint (flat config, type-aware)
pnpm typecheck        # tsc --noEmit
pnpm format           # Prettier (format:check in CI)
pnpm schemas          # regenerate JSON Schemas, asyncapi.json and README catalogs
pnpm references:sync  # copy the methodology catalog of the central repository (docs/references)
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
2. Regenerate the artifacts: `pnpm schemas` (the AsyncAPI document carries the version) and, in the
   central repository, `pnpm references:sync`.
3. Commit, then tag `vX.Y.Z` and push the tag. The `release` workflow verifies that the tag matches
   the package versions, builds, tests and publishes every package to GitHub Packages.

Versioning is semantic; event types are versioned by their `.vN` suffix and never changed
incompatibly (see [packages/contracts/README.md](packages/contracts/README.md#versioning)).

## License

UNLICENSED — private, see [LICENSE](LICENSE). Use and modification are restricted to authorized
users only.
