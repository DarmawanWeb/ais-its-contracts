import { describe, expect, it } from 'vitest';

import { DEFAULT_EXPOSED_HEADERS, exposedHeadersOf } from './configure-app.js';

describe('exposedHeadersOf (CORE-6)', () => {
  it('exposes ETag and Location by default', () => {
    expect(DEFAULT_EXPOSED_HEADERS).toEqual([
      'X-Request-Id',
      'Retry-After',
      'WWW-Authenticate',
      'ETag',
      'Location',
    ]);
    expect(exposedHeadersOf()).toEqual([...DEFAULT_EXPOSED_HEADERS]);
  });

  it('appends the configured headers without duplicates', () => {
    expect(
      exposedHeadersOf([
        'X-Total-Count',
        'etag',
        ' X-Truncated ',
        'x-total-count',
      ]),
    ).toEqual([...DEFAULT_EXPOSED_HEADERS, 'X-Total-Count', 'X-Truncated']);
  });

  it('refuses lists, wildcards and invalid names', () => {
    for (const header of ['A, B', '*', '', 'X Header', 'X-Ü'])
      expect(() => exposedHeadersOf([header])).toThrow(RangeError);
  });
});
