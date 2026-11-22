/**
 * Test helpers of the platform: containers, schema provisioning, a JWT
 * issuer, fake API key introspection, test applications, envelopes,
 * payload builders (zones, vessels, alerts) and polling. They import
 * `testcontainers` and `@nestjs/testing`, which resolve from the service's
 * own devDependencies (both are in the service template); they are not
 * dependencies of the kit, so production installs do not contain them.
 *
 * @packageDocumentation
 */
export {
  type FakeApiKey,
  FakeApiKeyIntrospector,
  type FakeIntrospectionServer,
  generateTestApiKey,
  startFakeApiKeyIntrospection,
} from './api-key-introspection.js';
export {
  makeTestAlertRaised,
  makeTestAlertResolved,
  makeTestVesselSnapshot,
  makeTestZone,
  type TestZoneInput,
} from './fixtures.js';
export {
  makeTestEnvelope,
  type TestEnvelopeOptions,
  waitFor,
  type WaitForOptions,
} from './helpers.js';
export {
  DEFAULT_TEST_NATS_MAX_PAYLOAD,
  reapOrphanedTestContainers,
  type StartedTestInfra,
  startTestInfra,
  TEST_CONTAINER_LABELS,
  TEST_DATABASE,
  TEST_IMAGES,
  TEST_S3_CREDENTIALS,
  type TestInfraOptions,
  type TestNats,
  testNatsConfig,
  type TestNatsOptions,
  type TestPostgres,
  type TestRedis,
  type TestS3,
  type TestServices,
  type TestSmtp,
} from './infra.js';
export {
  createTestJwtIssuer,
  type IssuedTestToken,
  type TestJwksServer,
  type TestJwtIssuer,
  type TestJwtIssuerOptions,
  type TestTokenClaims,
} from './jwt-issuer.js';
export {
  SHARED_TEST_INFRA_ENV,
  type SharedTestInfra,
  SharedTestInfraError,
  testInfra,
  testInfraGlobalSetup,
  uniqueName,
} from './shared-infra.js';
export {
  dropServiceSchema,
  type ProvisionSchemaOptions,
  provisionServiceSchema,
} from './postgres.js';
export {
  buildTestApp,
  type BuildTestAppOptions,
  createTestConfig,
  type ProviderOverride,
  TEST_ENV,
  TEST_SERVICE_NAME,
} from './test-app.js';
