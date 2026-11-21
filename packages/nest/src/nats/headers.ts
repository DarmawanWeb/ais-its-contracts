/** Header carrying the event `type` (routing and debugging without parsing). */
export const EVENT_TYPE_HEADER = 'Ais-Its-Event-Type';

/** Headers added to dead letters (`dlq.<stream>.<consumer>`), next to the original ones. */
export const DLQ_HEADERS = {
  /** Stream of the original message. */
  STREAM: 'Ais-Its-Dlq-Stream',
  /** Durable consumer that gave up. */
  CONSUMER: 'Ais-Its-Dlq-Consumer',
  /** Original subject. */
  SUBJECT: 'Ais-Its-Dlq-Subject',
  /** Stream sequence of the original message. */
  SEQUENCE: 'Ais-Its-Dlq-Stream-Sequence',
  /** Deliveries made before dead-lettering. */
  DELIVERY_COUNT: 'Ais-Its-Dlq-Delivery-Count',
  /** Message of the last handler error (single line, truncated). */
  ERROR: 'Ais-Its-Dlq-Error',
  /** Name of the last handler error class. */
  ERROR_NAME: 'Ais-Its-Dlq-Error-Name',
  /** ISO-8601 time of dead-lettering. */
  FAILED_AT: 'Ais-Its-Dlq-Failed-At',
  /** `SERVICE_NAME` of the consumer. */
  SERVICE: 'Ais-Its-Dlq-Service',
} as const;

/** Largest header value written by the platform. */
export const MAX_HEADER_VALUE_LENGTH = 1024;

/** Makes a value safe for a NATS header: one line, bounded length. */
export function headerValue(value: string): string {
  const singleLine = value.replace(/[\r\n]+/g, ' ').trim();
  return singleLine.length > MAX_HEADER_VALUE_LENGTH
    ? `${singleLine.slice(0, MAX_HEADER_VALUE_LENGTH - 1)}…`
    : singleLine;
}
