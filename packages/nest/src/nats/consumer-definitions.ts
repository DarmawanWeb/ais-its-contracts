import {
  CONSUMERS,
  type DurableConsumerDefinition,
  type DurableConsumerName,
  type EventType,
  ORDERED_CONSUMERS,
  type OrderedConsumerDefinition,
  type OrderedConsumerName,
  type TypedEventEnvelope,
} from '@darmawanweb/ais-its-contracts/events';

/** A durable consumer: a contracts `CONSUMERS` key or an explicit definition. */
export type DurableConsumerRef =
  DurableConsumerName | DurableConsumerDefinition;

/** An ordered consumer: a contracts `ORDERED_CONSUMERS` key or an explicit definition. */
export type OrderedConsumerRef =
  OrderedConsumerName | OrderedConsumerDefinition;

/** Event types delivered to a (durable or ordered) consumer reference. */
export type ConsumerEventType<Ref> = Ref extends DurableConsumerName
  ? (typeof CONSUMERS)[Ref]['eventTypes'][number]
  : Ref extends OrderedConsumerName
    ? (typeof ORDERED_CONSUMERS)[Ref]['eventTypes'][number]
    : Ref extends { readonly eventTypes: readonly (infer Type)[] }
      ? Type extends EventType
        ? Type
        : never
      : EventType;

/**
 * The envelope a handler of `Ref` receives: a union discriminated by `type`
 * (narrow with `switch (event.type)`).
 */
export type ConsumerEnvelope<Ref> =
  ConsumerEventType<Ref> extends infer Type
    ? Type extends EventType
      ? TypedEventEnvelope<Type>
      : never
    : never;

/** Thrown for unknown consumer names. */
export class UnknownConsumerError extends Error {
  override readonly name = 'UnknownConsumerError';
}

/** The definition of a durable consumer reference. */
export function resolveDurableConsumer(
  ref: DurableConsumerRef,
): DurableConsumerDefinition {
  if (typeof ref !== 'string') return ref;
  const definition: DurableConsumerDefinition | undefined = (
    CONSUMERS as Readonly<Record<string, DurableConsumerDefinition>>
  )[ref];
  if (definition === undefined)
    throw new UnknownConsumerError(`Unknown durable consumer "${ref}"`);
  return definition;
}

/** The definition of an ordered consumer reference. */
export function resolveOrderedConsumer(
  ref: OrderedConsumerRef,
): OrderedConsumerDefinition {
  if (typeof ref !== 'string') return ref;
  const definition: OrderedConsumerDefinition | undefined = (
    ORDERED_CONSUMERS as Readonly<Record<string, OrderedConsumerDefinition>>
  )[ref];
  if (definition === undefined)
    throw new UnknownConsumerError(`Unknown ordered consumer "${ref}"`);
  return definition;
}
