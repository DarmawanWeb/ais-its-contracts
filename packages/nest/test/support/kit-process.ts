import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import type { DurableConsumerDefinition } from '@darmawanweb/ais-its-contracts/events';
import { type Options, transformFile } from '@swc/core';

/** The package root. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Where `src/` and the instance script are compiled for a separate process:
 * inside `node_modules` (ignored everywhere), so bare imports resolve to the
 * package's dependencies; `dist/` is never touched.
 */
const OUT = join(ROOT, 'node_modules', '.cache', 'kit-test-process');

/** Legacy decorators with metadata, as the vitest SWC plugin compiles them. */
const SWC_OPTIONS: Options = {
  swcrc: false,
  sourceMaps: false,
  module: { type: 'es6' },
  jsc: {
    target: 'es2023',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    keepClassNames: true,
  },
};

/** Prefix of the lines an instance writes for the test (the rest are logs). */
export const INSTANCE_EVENT_MARKER = '@@instance ';

/** Configuration of an exclusive consumer instance process (`KIT_INSTANCE`, JSON). */
export interface InstanceConfig {
  readonly natsUrl: string;
  readonly definition: DurableConsumerDefinition;
  readonly pinnedTtlMs: number;
  /** Time the handler of the given minutes takes, ms. */
  readonly slowMinutes?: Readonly<Record<string, number>> | undefined;
}

/** What an instance process reports. */
export type InstanceEvent =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'handled';
      readonly minute: number;
      readonly deliveryCount: number;
    }
  | { readonly kind: 'state'; readonly state: string }
  | {
      readonly kind: 'activating' | 'activated';
      readonly pinId: string | null;
      readonly previous: string | null;
    }
  | {
      readonly kind: 'deactivated';
      readonly reason: string;
      readonly pinId: string | null;
    }
  | { readonly kind: 'consumed'; readonly outcome: string }
  | { readonly kind: 'tick' };

let compiled: Promise<void> | undefined;

/** Compiles `src/` (without specs) and the instance script once per run. */
function compile(): Promise<void> {
  compiled ??= (async () => {
    await rm(OUT, { recursive: true, force: true });
    const sources = (await readdir(join(ROOT, 'src'), { recursive: true }))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .map((file) => join('src', file));
    sources.push(join('test', 'support', 'exclusive-instance.ts'));
    await Promise.all(
      sources.map(async (file) => {
        const { code } = await transformFile(join(ROOT, file), SWC_OPTIONS);
        const target = join(OUT, file.replace(/\.ts$/, '.js'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, code);
      }),
    );
    await writeFile(join(OUT, 'package.json'), '{ "type": "module" }\n');
  })();
  return compiled;
}

/** A running instance process. */
export interface InstanceProcess {
  readonly child: ChildProcess;
  /** Everything it reported so far, in order. */
  readonly events: InstanceEvent[];
  /** Its log lines (for failure messages). */
  readonly logs: string[];
  /** Resolves once an event matches (rejects after `timeoutMs`). */
  waitFor(
    predicate: (event: InstanceEvent) => boolean,
    timeoutMs?: number,
  ): Promise<InstanceEvent>;
  /** SIGTERM, then SIGKILL after `timeoutMs`. */
  stop(timeoutMs?: number): Promise<void>;
}

/** Starts `test/support/exclusive-instance.ts` in its own Node process. */
export async function startInstanceProcess(
  config: InstanceConfig,
): Promise<InstanceProcess> {
  await compile();
  const child = spawn(
    process.execPath,
    [join(OUT, 'test', 'support', 'exclusive-instance.js')],
    {
      env: { ...process.env, KIT_INSTANCE: JSON.stringify(config) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const events: InstanceEvent[] = [];
  const logs: string[] = [];
  const listeners = new Set<() => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (line.startsWith(INSTANCE_EVENT_MARKER)) {
      events.push(
        JSON.parse(line.slice(INSTANCE_EVENT_MARKER.length)) as InstanceEvent,
      );
      for (const listener of listeners) listener();
    } else logs.push(line);
  });
  createInterface({ input: child.stderr }).on('line', (line) => {
    logs.push(line);
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });

  const waitFor = (
    predicate: (event: InstanceEvent) => boolean,
    timeoutMs = 15_000,
  ): Promise<InstanceEvent> =>
    new Promise((resolve, reject) => {
      const check = (): void => {
        const found = events.find(predicate);
        if (found === undefined) return;
        listeners.delete(check);
        clearTimeout(timer);
        resolve(found);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(
          new Error(
            `instance event not seen within ${timeoutMs} ms; events: ${JSON.stringify(events)}; logs:\n${logs.slice(-30).join('\n')}`,
          ),
        );
      }, timeoutMs);
      listeners.add(check);
      check();
    });

  const instance: InstanceProcess = {
    child,
    events,
    logs,
    waitFor,
    stop: async (timeoutMs = 5000) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGCONT');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      await exited;
      clearTimeout(timer);
    },
  };
  await waitFor((event) => event.kind === 'ready', 30_000);
  return instance;
}
