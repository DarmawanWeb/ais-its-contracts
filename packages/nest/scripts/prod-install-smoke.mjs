#!/usr/bin/env node
/**
 * Verifies the production dependency weight of the kit as a service gets it:
 * both packages are packed, installed with `pnpm install --prod` into a new
 * scratch project that declares the kit's required peers (like a service),
 * and the install must contain none of the test or heavy tracing packages
 * (testcontainers and its Docker/SSH tree, @nestjs/testing, pino-pretty, the
 * OpenTelemetry NodeSDK and its gRPC/protobuf exporters). Every public entry
 * point except `./testing` is then imported from the production install, and
 * tracing is started against an OTLP endpoint, so a dependency the kit uses
 * but does not declare fails here too.
 *
 *   node scripts/prod-install-smoke.mjs [targetDir] [--keep] [--du]
 *
 * `--keep` leaves the scratch project in place, `--du` prints the size of its
 * node_modules. Requires `pnpm build` of both packages first. Exit code 1 on
 * any failure.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Packages a production install of a service must never contain. */
const FORBIDDEN_PRODUCTION_PACKAGES = [
  'testcontainers',
  'dockerode',
  'ssh2',
  'cpu-features',
  '@nestjs/testing',
  'pino-pretty',
  '@grpc/grpc-js',
  'protobufjs',
  '@opentelemetry/sdk-node',
];

/** devDependencies of a service that uses ./testing (and pretty logs). */
const TEST_DEV_DEPENDENCIES = [
  'testcontainers',
  '@nestjs/testing',
  'pino-pretty',
];

/**
 * The `.pnpmfile.cjs` of a service generated from the template: optional
 * peers of `@nestjs/swagger` (its CLI plugin's TypeScript) and of
 * `@nestjs/terminus` (gRPC health checks, satisfied by testcontainers'
 * dockerode in the dev tree) are dropped, so `pnpm install --prod` does not
 * link the dev packages that would satisfy them.
 */
const SERVICE_PNPMFILE = `'use strict';
const PEERS = {
  '@nestjs/swagger': ['typescript'],
  '@nestjs/terminus': ['@grpc/grpc-js', '@grpc/proto-loader'],
};
const without = (record, names) =>
  record === undefined
    ? undefined
    : Object.fromEntries(Object.entries(record).filter(([name]) => !names.includes(name)));
module.exports = {
  hooks: {
    readPackage(manifest) {
      const peers = PEERS[manifest.name];
      if (peers === undefined) return manifest;
      return {
        ...manifest,
        peerDependencies: without(manifest.peerDependencies, peers),
        peerDependenciesMeta: without(manifest.peerDependenciesMeta, peers),
      };
    },
  },
};
`;

/** Public entry points that must load from a production install. */
const PRODUCTION_ENTRY_POINTS = [
  '.',
  './http',
  './db',
  './nats',
  './redis',
  './auth',
  './audit',
  './health',
  './metrics',
  './telemetry',
  './internal-http',
  './analytics',
  './internal',
];

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractsDir = resolve(packageDir, '..', 'contracts');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const du = args.includes('--du');
const explicitTarget = args.find((arg) => !arg.startsWith('--'));
const target =
  explicitTarget === undefined
    ? mkdtempSync(join(tmpdir(), 'kit-prod-smoke-'))
    : resolve(explicitTarget);

function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

/** Packs a workspace package into `<target>/.packs` and returns its `file:` spec. */
function pack(dir) {
  const destination = join(target, '.packs');
  mkdirSync(destination, { recursive: true });
  execFileSync('pnpm', ['pack', '--pack-destination', destination], {
    cwd: dir,
    stdio: 'ignore',
  });
  const { name, version } = readManifest(dir);
  const tarball = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
  if (!existsSync(join(destination, tarball)))
    throw new Error(`pnpm pack of ${dir} did not write ${tarball}`);
  return `file:./.packs/${tarball}`;
}

/** Names of the packages in the project's virtual store (`node_modules/.pnpm`). */
function installedPackages() {
  const store = join(target, 'node_modules', '.pnpm');
  const names = new Set();
  for (const entry of readdirSync(store)) {
    if (entry === 'node_modules' || entry.startsWith('lock')) continue;
    // `<name with / as +>@<version>[_<peers>]`; scoped names start with '@'.
    const at = entry.indexOf('@', entry.startsWith('@') ? 1 : 0);
    if (at > 0) names.add(entry.slice(0, at).replace('+', '/'));
  }
  return names;
}

function run(command, commandArgs, options = {}) {
  const shown = commandArgs.map((arg) =>
    arg.includes('\n') ? '<script>' : arg,
  );
  console.log(`$ ${command} ${shown.join(' ')}`);
  return execFileSync(command, commandArgs, {
    cwd: target,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    ...options,
  });
}

const kit = readManifest(packageDir);
const contracts = readManifest(contractsDir);
let failed = false;
try {
  mkdirSync(target, { recursive: true });
  const local = {
    [contracts.name]: pack(contractsDir),
    [kit.name]: pack(packageDir),
  };
  writeFileSync(
    join(target, 'package.json'),
    `${JSON.stringify(
      {
        name: 'kit-prod-install-smoke',
        private: true,
        type: 'module',
        // A service declares the kit, contracts and the kit's required peers,
        // and the test packages of ./testing as devDependencies: none of them
        // may reach the production install through the kit.
        dependencies: { ...local, ...kit.peerDependencies },
        devDependencies: Object.fromEntries(
          TEST_DEV_DEPENDENCIES.map((name) => [
            name,
            kit.devDependencies[name],
          ]),
        ),
        pnpm: { overrides: { [contracts.name]: local[contracts.name] } },
      },
      null,
      2,
    )}\n`,
  );
  // The pnpm hook services keep (see the README, "Production images"): it
  // drops optional peers of other packages that the test tree would satisfy.
  writeFileSync(join(target, '.pnpmfile.cjs'), SERVICE_PNPMFILE);
  run('pnpm', [
    'install',
    '--prod',
    '--prefer-offline',
    '--reporter=silent',
    '--config.auto-install-peers=true',
  ]);

  const installed = installedPackages();
  const forbidden = FORBIDDEN_PRODUCTION_PACKAGES.filter((name) =>
    installed.has(name),
  );
  if (forbidden.length > 0) {
    failed = true;
    console.error(
      `Production install contains forbidden packages: ${forbidden.join(', ')}`,
    );
  } else {
    console.log(
      `Production install has ${installed.size} packages and none of: ${FORBIDDEN_PRODUCTION_PACKAGES.join(', ')}`,
    );
  }

  // Every production entry point loads, and tracing starts with an endpoint
  // (it imports the trace SDK, exporter and instrumentations lazily).
  const script = `
    import 'reflect-metadata';
    for (const entry of ${JSON.stringify(PRODUCTION_ENTRY_POINTS)}) {
      await import(entry === '.' ? '${kit.name}' : '${kit.name}' + entry.slice(1));
    }
    const { startTelemetry, shutdownTelemetry } = await import('${kit.name}/telemetry');
    const handle = await startTelemetry({
      serviceName: 'kit-prod-smoke',
      serviceVersion: '${kit.version}',
      endpoint: 'http://127.0.0.1:9',
      esmLoaderHook: false,
    });
    if (!handle.enabled) throw new Error('telemetry did not start');
    await shutdownTelemetry();
    let testing = 'loaded';
    try {
      await import('${kit.name}/testing');
    } catch (error) {
      testing = error.code ?? error.message;
    }
    console.log('entry points loaded; ./testing without devDependencies: ' + testing);
  `;
  process.stdout.write(run('node', ['--input-type=module', '-e', script]));

  if (du) {
    const size = run('du', ['-sh', 'node_modules']).trim().split(/\s+/)[0];
    console.log(`node_modules of the production install: ${size}`);
  }
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  if (keep) console.log(`Kept ${target}`);
  else rmSync(target, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log('Production install smoke passed.');
