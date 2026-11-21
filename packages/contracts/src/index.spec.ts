import { describe, expect, it } from 'vitest';

import * as api from './api/index.js';
import * as auth from './auth/index.js';
import * as domain from './domain/index.js';
import * as events from './events/index.js';
import * as root from './index.js';
import * as realtime from './realtime/index.js';
import * as references from './references/index.js';

const SUBPATHS = { api, auth, domain, events, realtime, references } as const;

describe('public entry points', () => {
  it('re-exports every subpath member from the root with the same identity', () => {
    const rootExports = root as Record<string, unknown>;
    for (const [name, module] of Object.entries(SUBPATHS)) {
      for (const [member, value] of Object.entries(module)) {
        expect(rootExports[member], `${name}.${member}`).toBe(value);
      }
    }
  });

  it('exports each runtime member from exactly one subpath', () => {
    const owners = new Map<string, string[]>();
    for (const [name, module] of Object.entries(SUBPATHS)) {
      for (const member of Object.keys(module)) {
        owners.set(member, [...(owners.get(member) ?? []), name]);
      }
    }
    const duplicates = [...owners].filter(([, names]) => names.length > 1);
    expect(duplicates).toEqual([]);
    expect(Object.keys(root).sort()).toEqual([...owners.keys()].sort());
  });

  it('keeps internal helpers private', () => {
    expect(root).not.toHaveProperty('eventFailure');
    expect(root).not.toHaveProperty('encodeBase64Url');
    expect(root).not.toHaveProperty('openVocabularySchema');
    expect(root).not.toHaveProperty('isKnownValue');
  });
});
