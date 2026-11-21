/**
 * Smoke test of the built package (`dist/`) through its own `exports` map,
 * loaded exactly like consumers do: ESM `import` and CommonJS `require`.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const NAME = '@darmawanweb/ais-its-contracts';
const SUBPATHS = [
  '',
  '/events',
  '/auth',
  '/domain',
  '/realtime',
  '/api',
  '/references',
];

for (const subpath of SUBPATHS) {
  const specifier = `${NAME}${subpath}`;
  const esm = await import(specifier);
  const cjs = require(specifier);
  assert.deepEqual(
    Object.keys(cjs).sort(),
    Object.keys(esm).sort(),
    `${specifier}: ESM and CJS builds export the same members`,
  );
  assert.ok(Object.keys(esm).length > 0, `${specifier}: exports members`);
}

const esm = await import(NAME);
const cjs = require(NAME);
for (const [format, contracts] of [
  ['esm', esm],
  ['cjs', cjs],
]) {
  const envelope = contracts.makeEnvelope({
    type: contracts.EVENT_TYPES.FLEET_VESSEL_DELETED,
    source: 'fleet',
    data: {
      id: '01a1f8c2-54d9-7223-9107-543e8d90de1c',
      mmsi: 525005223,
      orgId: null,
    },
  });
  const parsed = contracts.parseEnvelope(contracts.encodeEnvelope(envelope));
  assert.equal(parsed.success, true, `${format}: envelope round trip`);
  assert.match(envelope.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/, `${format}: UUID v7`);
  assert.equal(
    contracts.subjects.aisPosition(525005223),
    'ais.position.v1.7.525005223',
    `${format}: subjects`,
  );
  assert.equal(
    contracts.assignCiiGrade(1, { d1: 0.86, d2: 0.94, d3: 1.06, d4: 1.18 }),
    'C',
    `${format}: CII grade`,
  );
  assert.equal(
    contracts.permissionsForRoles(['viewer']).has('vessel:write'),
    false,
    `${format}: permissions`,
  );
  assert.equal(
    contracts.tileRoomForPosition(106.8456, -6.2088),
    'tile:6:50:33',
  );
  assert.equal(
    contracts.subjects.safetyState(525005223),
    'safety.state.v1.525005223',
    `${format}: safety subject`,
  );
  assert.equal(
    contracts.ALERT_TYPES.collision.domain,
    'safety',
    `${format}: alert type registry`,
  );
  assert.ok(Array.isArray(contracts.METHODS), `${format}: methodology catalog`);
  assert.equal(
    contracts.validateCatalog({
      references: contracts.REFERENCES,
      methods: contracts.METHODS,
    }).success,
    true,
    `${format}: shipped catalog is valid`,
  );
}

console.log(
  `dist smoke test passed: ${SUBPATHS.length} entry points, ESM and CJS`,
);
