import { describe, expect, it } from 'vitest';

import {
  API_KEY_ID_LENGTH,
  API_KEY_PATTERN,
  API_KEY_SCOPES,
  API_KEY_SECRET_LENGTH,
  ApiKeyIntrospectionResultSchema,
  apiKeyPrefix,
  ApiKeySchema,
  BASE62_ALPHABET,
  formatApiKey,
  isApiKey,
  isApiKeyScope,
  maskApiKey,
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
    expect(
      ApiKeyIntrospectionResultSchema.safeParse({ ...active, scopes: ['root'] })
        .success,
    ).toBe(false);
    expect(
      ApiKeyIntrospectionResultSchema.safeParse({ active: true }).success,
    ).toBe(false);
  });
});
