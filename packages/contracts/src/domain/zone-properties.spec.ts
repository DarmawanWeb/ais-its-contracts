import { describe, expect, it } from 'vitest';

import { ZONE_PROPERTY_SCHEMAS, zoneProperties } from './zone-properties.js';
import { ZONE_KINDS } from './zones.js';

describe('zone properties per kind', () => {
  it('defines a schema for every zone kind', () => {
    expect(Object.keys(ZONE_PROPERTY_SCHEMAS).sort()).toEqual(
      [...ZONE_KINDS].sort(),
    );
  });

  it('reads typed properties of a kind and keeps unknown keys', () => {
    const shallow = zoneProperties({
      kind: 'shallow_water',
      properties: { depthM: 7.5, surveyedBy: 'Pushidrosal' },
    });
    expect(shallow.depthM).toBe(7.5);
    expect(shallow).toMatchObject({ surveyedBy: 'Pushidrosal' });

    const pipeline = zoneProperties({
      kind: 'pipeline',
      properties: {
        markers: [
          { name: 'KP 29.200', lat: -6.87197219605424, lon: 112.719384869178 },
        ],
        source: 'legacy data/pipeline.json',
      },
    });
    expect(pipeline.markers?.[0]?.name).toBe('KP 29.200');
  });

  it('drops invalid known keys instead of failing (forward and backward compatible)', () => {
    expect(
      zoneProperties({
        kind: 'shallow_water',
        properties: { depthM: '7 m', note: 'ok' },
      }),
    ).toEqual({ note: 'ok' });
    expect(
      zoneProperties({
        kind: 'tss_lane',
        properties: { directionDeg: 400, maxSpeedKn: 12 },
      }),
    ).toEqual({ maxSpeedKn: 12 });
  });
});
