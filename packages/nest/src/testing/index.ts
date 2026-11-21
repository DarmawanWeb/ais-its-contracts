/**
 * Test helpers of the platform (requires the optional peers `testcontainers`
 * and `@nestjs/testing`): containers, schema provisioning, a JWT issuer, fake
 * API key introspection, test applications, envelopes and polling.
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
  makeTestEnvelope,
  type TestEnvelopeOptions,
  waitFor,
  type WaitForOptions,
} from './helpers.js';
export {
  type StartedTestInfra,
  startTestInfra,
  TEST_DATABASE,
  TEST_IMAGES,
  TEST_S3_CREDENTIALS,
  type TestInfraOptions,
  type TestNats,
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
