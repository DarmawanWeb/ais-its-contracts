import { Injectable } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';

/**
 * A dependency checked by `GET /health/ready`. Providers implementing it and
 * decorated with {@link ReadinessCheck} are discovered automatically: the
 * database, NATS and Redis modules register theirs when they are imported.
 */
export interface ReadinessIndicator {
  /** Key of the result, e.g. `database`. */
  readonly healthKey: string;
  /** Runs the check with terminus' indicator service (time-boxed by the implementation). */
  check(health: HealthIndicatorService): PromiseLike<HealthIndicatorResult>;
}

/**
 * Class decorator marking a {@link ReadinessIndicator} provider for discovery.
 *
 * @example
 * @ReadinessCheck()
 * @Injectable()
 * export class S3HealthIndicator implements ReadinessIndicator { … }
 */
export const ReadinessCheck = DiscoveryService.createDecorator<void>();

function isReadinessIndicator(value: unknown): value is ReadinessIndicator {
  return (
    typeof value === 'object' &&
    value !== null &&
    'healthKey' in value &&
    typeof value.healthKey === 'string' &&
    'check' in value &&
    typeof value.check === 'function'
  );
}

/** Finds the {@link ReadinessCheck} providers of the application (once). */
@Injectable()
export class ReadinessRegistry {
  private indicators: readonly ReadinessIndicator[] | undefined;

  constructor(private readonly discovery: DiscoveryService) {}

  /** Every discovered indicator, in discovery order, unique by key. */
  all(): readonly ReadinessIndicator[] {
    this.indicators ??= this.discover();
    return this.indicators;
  }

  private discover(): readonly ReadinessIndicator[] {
    const byKey = new Map<string, ReadinessIndicator>();
    for (const wrapper of this.discovery.getProviders({ metadataKey: ReadinessCheck.KEY })) {
      const instance: unknown = wrapper.instance;
      if (isReadinessIndicator(instance) && !byKey.has(instance.healthKey)) {
        byKey.set(instance.healthKey, instance);
      }
    }
    return [...byKey.values()];
  }
}
