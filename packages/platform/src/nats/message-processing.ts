import {
  type AnyEventEnvelope,
  type EventFailure,
  type EventType,
  parseEnvelope,
} from '@darmawanweb/seemp-contracts/events';
import type { JsMsg } from '@nats-io/jetstream';

import { extractTraceContext, SpanKind, withSpan } from '../telemetry/trace-context.js';
import type { EventContext } from './event-handler.decorator.js';

/** A handler bound to its provider instance. */
export type BoundEventHandler = (event: AnyEventEnvelope, context: EventContext) => void | Promise<void>;

/** Runs `fn` in a logging context carrying `bindings` (nestjs-pino `runInContext`). */
export type LogContextRunner = <T>(fn: () => T, bindings: Readonly<Record<string, unknown>>) => T;

/** Classification of a received message. */
export type ReadDelivery =
  | { readonly kind: 'event'; readonly envelope: AnyEventEnvelope }
  | { readonly kind: 'invalid'; readonly failure: EventFailure }
  | { readonly kind: 'skipped'; readonly type: string | null; readonly reason: string };

/**
 * Parses a message (JSON → envelope → payload, contracts `parseEnvelope`)
 * and checks that the consumer handles its type. Unknown types (a newer
 * producer) and types of other consumers are skipped, not rejected.
 */
export function readDelivery(message: Pick<JsMsg, 'data'>, eventTypes: readonly EventType[]): ReadDelivery {
  const parsed = parseEnvelope(message.data);
  if (!parsed.success) {
    if (parsed.reason === 'unknown_type') {
      return { kind: 'skipped', type: parsed.type, reason: parsed.message };
    }
    return { kind: 'invalid', failure: parsed };
  }
  if (!eventTypes.includes(parsed.envelope.type)) {
    return {
      kind: 'skipped',
      type: parsed.envelope.type,
      reason: `Event type ${parsed.envelope.type} is not handled by this consumer`,
    };
  }
  return { kind: 'event', envelope: parsed.envelope };
}

/** Delivery facts of a JetStream message. */
export function eventContextOf(message: JsMsg, consumer: string, signal: AbortSignal): EventContext {
  return {
    subject: message.subject,
    stream: message.info.stream,
    consumer,
    streamSequence: message.seq,
    deliveryCount: message.info.deliveryCount,
    headers: message.headers,
    storedAt: message.time,
    signal,
    working: () => {
      message.working();
    },
  };
}

/**
 * Invokes a handler inside a CONSUMER span whose parent is the producer's
 * trace context (message headers, else the envelope `traceparent`), and
 * inside a logging context with the event id/type, consumer and delivery.
 */
export async function invokeHandler(
  handler: BoundEventHandler,
  envelope: AnyEventEnvelope,
  context: EventContext,
  runInLogContext: LogContextRunner,
): Promise<void> {
  const fromEnvelope = new Map<string, string>(
    envelope.traceparent === undefined ? [] : [['traceparent', envelope.traceparent]],
  );
  const headers = context.headers;
  const parent = extractTraceContext({
    get: (name) => {
      const value = headers?.get(name);
      return value === undefined || value === '' ? fromEnvelope.get(name) : value;
    },
    set: () => undefined,
  });
  await withSpan(
    `${context.stream} process`,
    {
      kind: SpanKind.CONSUMER,
      parent,
      attributes: {
        'messaging.system': 'nats',
        'messaging.destination.name': context.subject,
        'messaging.consumer.group.name': context.consumer,
        'messaging.message.id': envelope.id,
        'seemp.event.type': envelope.type,
        'seemp.delivery.count': context.deliveryCount,
      },
    },
    async () => {
      await runInLogContext(async () => handler(envelope, context), {
        eventId: envelope.id,
        eventType: envelope.type,
        consumer: context.consumer,
        deliveryCount: context.deliveryCount,
      });
    },
  );
}
