import { describe, expect, it } from 'vitest';

import { clientIp } from './client-ip.js';

describe('clientIp (CORE-9, audit ip in inet columns)', () => {
  it('keeps plain IPv4 and IPv6 addresses', () => {
    expect(clientIp('203.0.113.5')).toBe('203.0.113.5');
    expect(clientIp('::1')).toBe('::1');
    expect(clientIp('2001:db8::1')).toBe('2001:db8::1');
    expect(clientIp('::ffff:198.51.100.7')).toBe('::ffff:198.51.100.7');
    expect(clientIp(' 203.0.113.5 ')).toBe('203.0.113.5');
  });

  it('strips ports, brackets and IPv6 zone ids', () => {
    expect(clientIp('1.2.3.4:5678')).toBe('1.2.3.4');
    expect(clientIp('[2001:db8::1]')).toBe('2001:db8::1');
    expect(clientIp('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(clientIp('fe80::1%eth0')).toBe('fe80::1');
  });

  it('reads the ip of a request', () => {
    expect(clientIp({ ip: '[2001:db8::1]:443' })).toBe('2001:db8::1');
    expect(clientIp({ ip: undefined })).toBeNull();
    expect(clientIp({})).toBeNull();
  });

  it('turns everything that is not an address into null', () => {
    for (const value of [
      'foo',
      'bar',
      '',
      '   ',
      'unknown',
      '1.2.3.256',
      '01.2.3.4',
      '1.2.3.4:99999999',
      '[foo]',
      '203.0.113.5, bar',
      'a'.repeat(200),
      undefined,
      null,
    ]) {
      expect(clientIp(value)).toBeNull();
    }
  });
});
