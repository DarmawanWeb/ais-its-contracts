import { createHash, webcrypto } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  API_KEY_HASH_ALGORITHM,
  API_KEY_ID_LENGTH,
  API_KEY_PATTERN,
  API_KEY_SCOPES,
  API_KEY_SECRET_LENGTH,
  ApiKeyIntrospectionResultSchema,
  apiKeyPrefix,
  ApiKeySchema,
  BASE62_ALPHABET,
  formatApiKey,
  hashApiKey,
  isApiKey,
  isApiKeyScope,
  maskApiKey,
  parseScopes,
  parseApiKey,
} from './api-key.js';

const ID = '3fK9xQ2LmZ';
const SECRET = 'Vb7Tq0nW4yR8sJ2kL6pD1cH9gF3aX5zE';
const KEY = `sk_${ID}_${SECRET}`;

describe('API key format', () => {
  it('formats sk_<10 base62 id>_<32 base62 secret>', () => {
    expect(ID).toHaveLength(API_KEY_ID_LENGTH);
    expect(SECRET).toHaveLength(API_KEY_SECRET_LENGTH);
    expect(formatApiKey({ id: ID, secret: SECRET })).toBe(KEY);
    expect(KEY).toHaveLength(3 + 10 + 1 + 32);
    expect(API_KEY_PATTERN.test(KEY)).toBe(true);
  });

  it('round-trips through parseApiKey', () => {
    expect(parseApiKey(KEY)).toEqual({
      id: ID,
      secret: SECRET,
      prefix: `sk_${ID}`,
    });
    expect(apiKeyPrefix(ID)).toBe(`sk_${ID}`);
  });

  it.each([
    ['wrong prefix', `pk_${ID}_${SECRET}`],
    ['short id', `sk_${ID.slice(1)}_${SECRET}`],
    ['long secret', `sk_${ID}_${SECRET}a`],
    ['non base62 secret', `sk_${ID}_${SECRET.slice(1)}-`],
    ['extra segment', `${KEY}_x`],
    ['surrounding whitespace', ` ${KEY} `],
    ['empty', ''],
  ])('rejects %s', (_, candidate) => {
    expect(parseApiKey(candidate)).toBeNull();
    expect(isApiKey(candidate)).toBe(false);
    expect(ApiKeySchema.safeParse(candidate).success).toBe(false);
  });

  it('refuses to format invalid parts', () => {
    expect(() => formatApiKey({ id: 'short', secret: SECRET })).toThrow(
      RangeError,
    );
    expect(() =>
      formatApiKey({ id: ID, secret: `${SECRET.slice(1)}_` }),
    ).toThrow(RangeError);
  });

  it('uses a 62 character alphabet', () => {
    expect(new Set(BASE62_ALPHABET).size).toBe(62);
    expect(BASE62_ALPHABET).toMatch(/^[0-9A-Za-z]{62}$/);
  });

  it('masks keys for logs', () => {
    expect(maskApiKey(KEY)).toBe(`sk_${ID}_…`);
    expect(maskApiKey(KEY)).not.toContain(SECRET);
    expect(maskApiKey('garbage')).toBe('[redacted]');
  });
});

describe('API key scopes and introspection', () => {
  it('declares the scopes of spec 8.4', () => {
    expect(API_KEY_SCOPES).toEqual([
      'ais:ingest',
      'telemetry:ingest',
      'ais:read',
    ]);
    expect(isApiKeyScope('ais:ingest')).toBe(true);
    expect(isApiKeyScope('vessel:write')).toBe(false);
  });

  it('parses active and inactive introspection results', () => {
    const active = {
      active: true,
      keyId: '01a1f8c2-54d8-71c4-95cf-ab5eb8908e00',
      orgId: '01a1f8c2-54d9-7223-9107-543e8d90de1c',
      scopes: ['ais:ingest'],
      name: 'Batam AIS pusher',
    };
    expect(ApiKeyIntrospectionResultSchema.parse(active)).toEqual(active);
    expect(ApiKeyIntrospectionResultSchema.parse({ active: false })).toEqual({
      active: false,
    });
    // Unknown scopes are dropped (forward compatible), malformed ones refused.
    expect(
      ApiKeyIntrospectionResultSchema.parse({ ...active, scopes: ['root'] }),
    ).toEqual({ ...active, scopes: [] });
    expect(
      ApiKeyIntrospectionResultSchema.safeParse({ ...active, scopes: [1] })
        .success,
    ).toBe(false);
    expect(
      ApiKeyIntrospectionResultSchema.safeParse({ active: true }).success,
    ).toBe(false);
  });
});

describe('API key introspection forward compatibility', () => {
  it('drops scopes this contracts version does not know', () => {
    const parsed = ApiKeyIntrospectionResultSchema.safeParse({
      active: true,
      keyId: '018f2b5e-0000-7000-8000-000000000001',
      orgId: '018f2b5e-0000-7000-8000-000000000002',
      scopes: ['ais:ingest', 'fleet:sync', 'ais:ingest'],
      name: 'pusher',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.active && parsed.data.scopes).toEqual([
      'ais:ingest',
    ]);
    expect(parseScopes(['telemetry:ingest', 'future:scope'])).toEqual([
      'telemetry:ingest',
    ]);
  });
});

describe('API key hash (api_keys.key_hash)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is the lowercase hex SHA-256 of the full key', async () => {
    expect(API_KEY_HASH_ALGORITHM).toBe('SHA-256');
    await expect(hashApiKey(KEY)).resolves.toBe(
      'b9d4a32b18ed458acbedf7be772c2c12b48db7dbb72d63d238e719d6ab095bcc',
    );
    const zeros = `sk_${'0'.repeat(10)}_${'0'.repeat(32)}`;
    await expect(hashApiKey(zeros)).resolves.toBe(
      '38b57d5dfad133532eb4c3cf7313f8991ee160514e7a96572218665fd8ac8b95',
    );
  });

  it('equals the node:crypto hash used by the auth service and the kit', async () => {
    for (let index = 0; index < 50; index += 1) {
      const pick = (length: number): string =>
        Array.from(
          { length },
          (_, position) =>
            BASE62_ALPHABET[
              (index * 31 + position * 7) % BASE62_ALPHABET.length
            ],
        ).join('');
      const key = formatApiKey({ id: pick(10), secret: pick(32) });
      const hash = await hashApiKey(key);
      expect(hash).toBe(createHash('sha256').update(key, 'utf8').digest('hex'));
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it.each([
    ['malformed', 'sk_short_secret'],
    ['surrounding whitespace', ` ${KEY}`],
    ['empty', ''],
  ])('rejects a %s value with a TypeError that hides it', async (_, value) => {
    const rejection = hashApiKey(value);
    await expect(rejection).rejects.toThrow(TypeError);
    await expect(rejection).rejects.not.toThrow(value === '' ? /^$/ : value);
  });

  it('only needs the WebCrypto global of browsers (crypto.subtle)', async () => {
    const digest = vi.fn((algorithm: string, data: Uint8Array) =>
      webcrypto.subtle.digest(algorithm, data),
    );
    vi.stubGlobal('crypto', { subtle: { digest } });
    await expect(hashApiKey(KEY)).resolves.toBe(
      'b9d4a32b18ed458acbedf7be772c2c12b48db7dbb72d63d238e719d6ab095bcc',
    );
    expect(digest).toHaveBeenCalledWith('SHA-256', expect.any(Uint8Array));
  });
});
