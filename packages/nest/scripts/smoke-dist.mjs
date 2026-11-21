/**
 * Smoke test of the built package (`dist/`) through its own `exports` map, as
 * consumers load it: every subpath imports and exposes its main members.
 */
import assert from 'node:assert/strict';

const NAME = '@darmawanweb/ais-its-nest';
const EXPECTED = {
  '': [
    'bootstrapService',
    'exportOpenApi',
    'defineConfig',
    'loadConfig',
    'ConfigModule',
    'DomainError',
    'createLogger',
  ],
  '/http': [
    'ProblemDetailsFilter',
    'createValidationPipe',
    'configureApp',
    'buildOpenApiDocument',
    'GLOBAL_PREFIX',
  ],
  '/db': [
    'DatabaseModule',
    'InjectPool',
    'InjectDb',
    'runMigrations',
    'runMigrationsCli',
    'withTransaction',
    'pointGeography',
  ],
  '/nats': [
    'NatsModule',
    'EventPublisher',
    'EventHandler',
    'OrderedEventHandler',
    'OrderedConsumers',
    'RetryableError',
    'NonRetryableError',
    'StreamReplayer',
  ],
  '/redis': [
    'RedisModule',
    'InjectRedis',
    'FixedWindowRateLimiter',
    'SlidingWindowRateLimiter',
  ],
  '/auth': [
    'AuthModule',
    'Public',
    'RequirePermissions',
    'AllowApiKey',
    'Internal',
    'CurrentPrincipal',
    'verifyAccessToken',
    'assertOrgAccess',
  ],
  '/audit': ['AuditModule', 'AuditService'],
  '/health': ['HealthModule', 'ReadinessCheck'],
  '/metrics': ['MetricsModule', 'MetricsService'],
  '/telemetry': [
    'startTelemetry',
    'injectTraceContext',
    'extractTraceContext',
    'currentTraceparent',
  ],
  '/internal-http': ['InternalHttpClient', 'InternalHttpError'],
  '/analytics': [
    'RegisterDetector',
    'DetectorRegistry',
    'DetectorRunnerModule',
    'VesselStateStore',
    'TrackBuffer',
    'PairSearch',
    'ZoneIndex',
    'AlertEmitter',
    'DetectorTestHarness',
  ],
  '/testing': [
    'startTestInfra',
    'provisionServiceSchema',
    'createTestJwtIssuer',
    'buildTestApp',
    'makeTestEnvelope',
    'waitFor',
  ],
};

for (const [subpath, members] of Object.entries(EXPECTED)) {
  const module = await import(`${NAME}${subpath}`);
  for (const member of members) {
    assert.ok(member in module, `${NAME}${subpath} exports ${member}`);
  }
}

const { defineConfig, loadConfig } = await import(NAME);
const config = loadConfig(defineConfig({}), {
  env: { SERVICE_NAME: 'smoke', DATABASE_SCHEMA: 'fleet' },
});
assert.equal(
  config.DATABASE_URL,
  'postgres://fleet_svc:fleet_svc@localhost:5432/aisits',
);
assert.equal(config.LOG_PRETTY, true);
assert.ok(Object.isFrozen(config));

process.stdout.write(
  `${NAME}: ${Object.keys(EXPECTED).length} entry points OK\n`,
);
