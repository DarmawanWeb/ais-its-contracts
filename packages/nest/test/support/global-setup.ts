import { testInfraGlobalSetup } from '../../src/testing/index.js';

/**
 * Starts PostgreSQL (TimescaleDB + PostGIS), NATS and Valkey once for every
 * integration test file (the kit's own `testInfraGlobalSetup`, as services use it).
 */
export const setup = testInfraGlobalSetup({
  postgres: true,
  nats: true,
  redis: true,
});
