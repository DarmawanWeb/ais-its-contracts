import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildLoggerOptions, resolvePinoPretty } from './logger.js';

describe('resolvePinoPretty (CORE-14)', () => {
  let service: string;
  let bare: string;

  beforeAll(async () => {
    service = await realpath(await mkdtemp(join(tmpdir(), 'kit-pretty-')));
    await writeFile(join(service, 'package.json'), '{"name":"svc"}');
    const pretty = join(service, 'node_modules', 'pino-pretty');
    await mkdir(pretty, { recursive: true });
    await writeFile(
      join(pretty, 'package.json'),
      '{"name":"pino-pretty","version":"0.0.0","main":"index.js"}',
    );
    await writeFile(join(pretty, 'index.js'), 'module.exports = () => {};');
    bare = await realpath(await mkdtemp(join(tmpdir(), 'kit-bare-')));
  });

  afterAll(async () => {
    await rm(service, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  });

  it('prefers the service’s own pino-pretty (its devDependency)', () => {
    expect(resolvePinoPretty(service)).toBe(
      join(service, 'node_modules', 'pino-pretty', 'index.js'),
    );
  });

  it('falls back to the copy next to the kit', () => {
    const resolved = resolvePinoPretty(bare);
    expect(resolved).toMatch(/pino-pretty/);
    expect(resolved?.startsWith(bare)).toBe(false);
  });

  it('uses the resolved module as the pretty transport', () => {
    const { options, prettyUnavailable } = buildLoggerOptions({
      service: 'svc',
      pretty: true,
    });
    expect(prettyUnavailable).toBe(false);
    expect(options.transport).toMatchObject({
      target: resolvePinoPretty(),
    });
  });
});
